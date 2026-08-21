#!/usr/bin/env python3
"""Export OpenMarket unified data into FluxQuant research JSONL.

Profiles:
- model: legacy coverage-qualified Binance + Polymarket export used by the probability model.
- pair: label-independent Polymarket-only export for pair research.

Public OpenMarket Parquet explicitly excludes raw JSON, so public archives normally
provide top-of-book prices without trustworthy executable depth. If recorder raw_json
is present in a private/local archive, the pair profile reconstructs recorded L2.
Otherwise it emits TOP_ONLY_UNTRUSTED snapshots with synthetic unit depth *only* so
price-dislocation research remains possible; execution validators reject that evidence
by default. The flattened `size` column is never reinterpreted as both top sides.
"""
from __future__ import annotations

import argparse
import bisect
import heapq
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

try:
    import pyarrow.parquet as pq
except Exception as exc:
    raise SystemExit("pyarrow is required: python3 -m pip install pyarrow") from exc

SAMPLE_SECONDS_TO_EXPIRY = [300, 240, 180, 120, 90, 60, 45, 30, 15]
DEFAULT_BINANCE_AGE_MS = 30_000
DEFAULT_POLYMARKET_AGE_MS = 60_000
DEFAULT_LABEL_TOLERANCE_MS = 30_000
PAIR_SORT_CHUNK = 50_000
CLOB_V2_CUTOVER_DATE = "2026-04-28"


def finite(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def integer(value: Any) -> int | None:
    x = finite(value)
    return None if x is None else int(x)


def parquet_files(root: Path, table: str, date: str | None = None) -> list[Path]:
    flat = root / f"{table}.parquet"
    if flat.exists():
        return [flat]
    table_dir = root / table
    if not table_dir.exists():
        return []
    if date:
        dated = table_dir / f"date={date}"
        if dated.exists():
            return sorted(dated.rglob("*.parquet"))
    return sorted(table_dir.rglob("*.parquet"))


def iter_rows(paths: Iterable[Path]) -> Iterable[dict[str, Any]]:
    for path in paths:
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=50_000):
            yield from batch.to_pylist()


def normalize_outcome(value: Any) -> str | None:
    text = str(value or "").strip().upper()
    if text in {"UP", "HIGHER", "YES"}:
        return "UP"
    if text in {"DOWN", "LOWER", "NO"}:
        return "DOWN"
    return None


def parse_market_times(row: dict[str, Any], slug: str, duration_ms: int) -> tuple[int, int] | None:
    end_iso = str(row.get("end_date_iso") or "")
    if end_iso:
        try:
            expiry_ms = int(datetime.fromisoformat(end_iso.replace("Z", "+00:00")).timestamp() * 1000)
            return expiry_ms - duration_ms, expiry_ms
        except Exception:
            pass
    try:
        start_sec = int(slug.rsplit("-", 1)[-1])
        start_ms = start_sec * 1000
        return start_ms, start_ms + duration_ms
    except Exception:
        return None


def utc_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def clob_regime(date: str) -> str:
    return "CLOB_V1_PRE_CUTOVER" if date < CLOB_V2_CUTOVER_DATE else "CLOB_V2_POST_CUTOVER"


def valid_binance_row(row: dict[str, Any]) -> bool:
    bid = finite(row.get("best_bid"))
    ask = finite(row.get("best_ask"))
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return True
    price = finite(row.get("price"))
    return price is not None and price > 0


def valid_pm_model_row(row: dict[str, Any]) -> bool:
    bid = finite(row.get("best_bid"))
    ask = finite(row.get("best_ask"))
    depth = finite(row.get("size"))
    return bid is not None and ask is not None and depth is not None and bid > 0 and ask > 0 and depth > 0


def has_at_or_after(times: list[int], target: int, tolerance_ms: int) -> bool:
    i = bisect.bisect_left(times, target)
    return i < len(times) and 0 <= times[i] - target <= tolerance_ms


def has_at_or_before(times: list[int], target: int, age_ms: int) -> bool:
    i = bisect.bisect_right(times, target) - 1
    return i >= 0 and 0 <= target - times[i] <= age_ms


def raw_json_object(row: dict[str, Any]) -> dict[str, Any] | None:
    raw = row.get("raw_json")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def normalize_levels(value: Any) -> list[dict[str, float]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, float]] = []
    for item in value:
        price: float | None = None
        size: float | None = None
        if isinstance(item, dict):
            price = finite(item.get("price"))
            size = finite(item.get("size"))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            price = finite(item[0])
            size = finite(item[1])
        if price is None or size is None or not (0 <= price <= 1) or size < 0:
            continue
        out.append({"price": price, "size": size})
    return out


def parse_pair_l2(row: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Return (kind, raw payload) using only recorder raw_json semantics."""
    raw = raw_json_object(row)
    if raw is None:
        return None
    kind = str(raw.get("type") or raw.get("event_type") or row.get("event_type") or "").strip().lower()
    if kind == "book":
        bids = normalize_levels(raw.get("bids"))
        asks = normalize_levels(raw.get("asks"))
        # Empty one-sided books are valid snapshots; fully empty snapshots carry no fill evidence.
        if not bids and not asks:
            return None
        return "book", {
            "bids": bids,
            "asks": asks,
            "historical_l2_reconstructed": True,
            "depth_provenance": "OPENMARKET_RECORDER_RAW_JSON_BOOK",
            "source_event_type": "book",
        }
    if kind == "price_change":
        side = str(raw.get("side") or "").strip().upper()
        price = finite(raw.get("price"))
        size = finite(raw.get("size"))
        if side not in {"BUY", "SELL"} or price is None or size is None or not (0 <= price <= 1) or size < 0:
            return None
        payload: dict[str, Any] = {
            "side": side,
            "price": price,
            "size": size,
            "historical_l2_reconstructed": True,
            "depth_provenance": "OPENMARKET_RECORDER_RAW_JSON_LEVEL_DELTA",
            "source_event_type": "price_change",
        }
        best_bid = finite(raw.get("best_bid"))
        best_ask = finite(raw.get("best_ask"))
        if best_bid is not None:
            payload["source_best_bid"] = best_bid
        if best_ask is not None:
            payload["source_best_ask"] = best_ask
        return "price_change", payload
    return None


def write_pair_events_sorted(
    output: Path,
    rows: Iterable[dict[str, Any]],
    token_meta: dict[str, dict[str, Any]],
    window_start: int,
    window_end: int,
) -> tuple[int, int, int]:
    """External received-time sort to keep memory bounded on multi-million-row days."""
    output.parent.mkdir(parents=True, exist_ok=True)
    seq = 0
    emitted = 0
    missing_raw = 0
    invalid_l2 = 0
    chunks: list[Path] = []
    buffer: list[tuple[tuple[int, int, str, int], str]] = []

    with tempfile.TemporaryDirectory(prefix="fluxquant-pair-sort-") as td:
        temp_root = Path(td)

        def flush() -> None:
            nonlocal buffer
            if not buffer:
                return
            buffer.sort(key=lambda item: item[0])
            path = temp_root / f"chunk-{len(chunks):05d}.txt"
            with path.open("w", encoding="utf-8") as fh:
                for (recv, event, instrument, order), payload in buffer:
                    fh.write(f"{recv}\t{event}\t{instrument}\t{order}\t{payload}\n")
            chunks.append(path)
            buffer = []

        for row in rows:
            token = str(row.get("asset_id") or "")
            meta = token_meta.get(token)
            if not meta:
                continue
            event_ms = integer(row.get("source_ts_ms"))
            recv_ms = integer(row.get("ingest_ts_ms")) or event_ms
            if event_ms is None or recv_ms is None or event_ms < window_start or event_ms > window_end:
                continue
            parsed = parse_pair_l2(row)
            if parsed is None:
                if raw_json_object(row) is None:
                    missing_raw += 1
                else:
                    invalid_l2 += 1
                bid = finite(row.get("best_bid"))
                ask = finite(row.get("best_ask"))
                if bid is None or ask is None or bid <= 0 or ask <= 0 or bid > 1 or ask > 1:
                    continue
                kind = "book"
                raw = {
                    "bids": [{"price": bid, "size": 1.0}],
                    "asks": [{"price": ask, "size": 1.0}],
                    "historical_top_only": True,
                    "depth_cap": 1.0,
                    "depth_provenance": "OPENMARKET_PUBLIC_PARQUET_TOP_ONLY_UNTRUSTED",
                    "source_event_type": str(row.get("event_type") or "top_of_book"),
                }
            else:
                kind, raw = parsed
            seq += 1
            event = {
                "venue": "polymarket",
                "kind": kind,
                "instrument": token,
                "eventTimeMs": event_ms,
                "receivedTimeMs": recv_ms,
                "sequence": integer(row.get("id")) or seq,
                "rawType": f"openmarket_raw_l2_{kind}",
                "polymarket": meta,
                "raw": raw,
            }
            payload = json.dumps(event, separators=(",", ":"), default=str)
            buffer.append(((recv_ms, event_ms, token, seq), payload))
            emitted += 1
            if len(buffer) >= PAIR_SORT_CHUNK:
                flush()
        flush()

        def chunk_iter(path: Path) -> Iterator[tuple[tuple[int, int, str, int], str]]:
            with path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    a, b, instrument, d, payload = line.rstrip("\n").split("\t", 4)
                    yield (int(a), int(b), instrument, int(d)), payload

        iterators = [chunk_iter(path) for path in chunks]
        with output.open("w", encoding="utf-8") as out:
            for _, payload in heapq.merge(*iterators, key=lambda item: item[0]):
                out.write(payload + "\n")

    return emitted, missing_raw, invalid_l2


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("root", type=Path, help="Local OpenMarket unified root (contains table directories)")
    p.add_argument("--date", default="2026-02-12")
    p.add_argument("--profile", choices=("model", "pair"), default="model")
    p.add_argument("--events", type=Path, default=Path("data/openmarket-events.jsonl"))
    p.add_argument("--markets", type=Path, default=Path("data/openmarket-markets.json"))
    p.add_argument("--max-markets", type=int, default=24)
    p.add_argument("--min-samples-per-market", type=int, default=2)
    p.add_argument("--market-duration-min", type=float, default=15.0)
    p.add_argument("--top-depth-cap", type=float, default=1.0, help="Model profile only; pair profile preserves recorded L2 sizes")
    p.add_argument("--sample-ms", type=int, default=500, help="Model profile PM downsample; pair profile requires 0")
    p.add_argument("--binance-age-ms", type=int, default=DEFAULT_BINANCE_AGE_MS)
    p.add_argument("--polymarket-age-ms", type=int, default=DEFAULT_POLYMARKET_AGE_MS)
    p.add_argument("--label-tolerance-ms", type=int, default=DEFAULT_LABEL_TOLERANCE_MS)
    args = p.parse_args()

    if args.max_markets < 3:
        raise SystemExit("--max-markets must be >= 3")
    if args.min_samples_per_market < 1:
        raise SystemExit("--min-samples-per-market must be >= 1")
    if args.market_duration_min <= 0 or args.top_depth_cap <= 0:
        raise SystemExit("duration/depth must be > 0")
    if args.profile == "model" and args.sample_ms <= 0:
        raise SystemExit("--sample-ms must be > 0 for model profile")
    if args.profile == "pair" and args.sample_ms != 0:
        raise SystemExit("Pair profile requires --sample-ms 0; execution research must retain every L2 update")
    if args.binance_age_ms <= 0 or args.polymarket_age_ms <= 0 or args.label_tolerance_ms <= 0:
        raise SystemExit("age/tolerance values must be > 0")

    market_files = parquet_files(args.root, "market_meta")
    pm_files = parquet_files(args.root, "polymarket_ticks_ms", args.date)
    btick_files = parquet_files(args.root, "binance_ticks_ms", args.date)
    if not market_files or not pm_files:
        raise SystemExit("Expected market_meta and polymarket_ticks_ms under unified root")
    if args.profile == "model" and not btick_files:
        raise SystemExit("Model profile also requires binance_ticks_ms under unified root")

    duration_ms = int(args.market_duration_min * 60_000)
    candidates: list[tuple[int, dict[str, Any]]] = []
    for row in iter_rows(market_files):
        slug = str(row.get("slug") or row.get("market_slug") or "")
        condition = str(row.get("condition_id") or slug)
        up_token = str(row.get("up_token_id") or "")
        down_token = str(row.get("down_token_id") or "")
        times = parse_market_times(row, slug, duration_ms)
        if not slug or not condition or not up_token or not down_token or not times:
            continue
        start_ms, expiry_ms = times
        if utc_date(start_ms) != args.date or utc_date(expiry_ms - 1) != args.date:
            continue
        common = {
            "marketId": condition,
            "conditionId": condition,
            "slug": slug,
            "question": str(row.get("question") or slug),
            "underlying": "BTC",
            "startTimeMs": start_ms,
            "expiryTimeMs": expiry_ms,
        }
        up = {"tokenId": up_token, "outcome": "UP", **common}
        down = {"tokenId": down_token, "outcome": "DOWN", **common}
        candidates.append((start_ms, {
            **common,
            "resolvedOutcome": normalize_outcome(row.get("resolved_outcome")),
            "tokens": [up, down],
        }))
    candidates.sort(key=lambda item: item[0])
    if len(candidates) < 3:
        raise SystemExit(f"Only {len(candidates)} metadata markets found for date={args.date}")

    candidate_tokens = {
        str(token["tokenId"])
        for _, market in candidates
        for token in market["tokens"]
    }

    binance_times: list[int] = []
    if args.profile == "model":
        for row in iter_rows(btick_files):
            ts = integer(row.get("source_ts_ms"))
            if ts is not None and valid_binance_row(row):
                binance_times.append(ts)
        binance_times.sort()

    pm_times_by_token: dict[str, list[int]] = {token: [] for token in candidate_tokens}
    pm_pair_counts: dict[str, int] = {token: 0 for token in candidate_tokens}
    raw_missing = 0
    raw_invalid = 0
    for row in iter_rows(pm_files):
        token = str(row.get("asset_id") or "")
        if token not in pm_times_by_token:
            continue
        ts = integer(row.get("source_ts_ms"))
        if ts is None:
            continue
        if args.profile == "model":
            if valid_pm_model_row(row):
                pm_times_by_token[token].append(ts)
        else:
            raw = raw_json_object(row)
            parsed_l2 = parse_pair_l2(row) if raw is not None else None
            if raw is None:
                raw_missing += 1
            elif parsed_l2 is None:
                raw_invalid += 1
            bid = finite(row.get("best_bid"))
            ask = finite(row.get("best_ask"))
            has_top = bid is not None and ask is not None and 0 < bid <= 1 and 0 < ask <= 1
            if parsed_l2 is None and not has_top:
                continue
            pm_times_by_token[token].append(ts)
            pm_pair_counts[token] += 1
    for times in pm_times_by_token.values():
        times.sort()

    qualified: list[tuple[int, int, dict[str, Any]]] = []
    rejected_label = 0
    rejected_pm = 0
    rejected_samples = 0
    for start_ms, market in candidates:
        expiry_ms = int(market["expiryTimeMs"])
        if args.profile == "model":
            if not has_at_or_after(binance_times, start_ms, args.label_tolerance_ms) or not has_at_or_before(
                binance_times, expiry_ms, args.label_tolerance_ms
            ):
                rejected_label += 1
                continue

        up_token = str(market["tokens"][0]["tokenId"])
        down_token = str(market["tokens"][1]["tokenId"])
        up_times = pm_times_by_token.get(up_token, [])
        down_times = pm_times_by_token.get(down_token, [])
        if not up_times or not down_times:
            rejected_pm += 1
            continue

        if args.profile == "pair":
            usable_samples = min(pm_pair_counts.get(up_token, 0), pm_pair_counts.get(down_token, 0))
        else:
            usable_samples = 0
            for seconds in SAMPLE_SECONDS_TO_EXPIRY:
                target = expiry_ms - seconds * 1000
                if target < start_ms:
                    continue
                if (
                    has_at_or_before(binance_times, target, args.binance_age_ms)
                    and has_at_or_before(up_times, target, args.polymarket_age_ms)
                    and has_at_or_before(down_times, target, args.polymarket_age_ms)
                ):
                    usable_samples += 1
        if usable_samples < args.min_samples_per_market:
            rejected_samples += 1
            continue
        qualified.append((start_ms, usable_samples, market))

    resolved_qualified = [q for q in qualified if q[2].get("resolvedOutcome")]
    selection_pool = (
        resolved_qualified if args.profile == "model" and len(resolved_qualified) >= args.max_markets
        else qualified
    )
    ranked = sorted(selection_pool, key=lambda q: (-q[1], q[0]))[: args.max_markets]
    ranked.sort(key=lambda q: q[0])
    selected = [market for _, _, market in ranked]

    print(
        f"[openmarket-export] profile={args.profile} coverage candidates={len(candidates)} qualified={len(qualified)} "
        f"rejected_label={rejected_label} rejected_pm={rejected_pm} rejected_samples={rejected_samples}"
    )
    if args.profile == "pair":
        print(f"[openmarket-export] pair_raw_index missing_raw={raw_missing} invalid_raw_l2={raw_invalid}")
    if len(selected) < 3:
        raise SystemExit(
            f"Only {len(selected)} coverage-qualified markets found for date={args.date}. "
            "Choose another archived date."
        )

    token_meta: dict[str, dict[str, Any]] = {}
    for market in selected:
        for token in market["tokens"]:
            token_meta[str(token["tokenId"])] = token

    window_start = min(int(m["startTimeMs"]) for m in selected) - (
        args.label_tolerance_ms if args.profile == "model" else args.polymarket_age_ms
    )
    window_end = max(int(m["expiryTimeMs"]) for m in selected) + 5_000

    binance_events = 0
    pm_events = 0
    missing_raw_output = 0
    invalid_raw_output = 0

    if args.profile == "pair":
        pm_events, missing_raw_output, invalid_raw_output = write_pair_events_sorted(
            args.events,
            iter_rows(pm_files),
            token_meta,
            window_start,
            window_end,
        )
    else:
        events: list[dict[str, Any]] = []
        last_emit: dict[str, int] = {}

        def should_emit(key: str, ts: int) -> bool:
            prev = last_emit.get(key)
            if prev is not None and ts - prev < args.sample_ms:
                return False
            last_emit[key] = ts
            return True

        for row in iter_rows(btick_files):
            ts = integer(row.get("source_ts_ms"))
            recv = integer(row.get("ingest_ts_ms")) or ts
            if ts is None or recv is None or ts < window_start or ts > window_end:
                continue
            bid = finite(row.get("best_bid"))
            ask = finite(row.get("best_ask"))
            raw_type = "openmarket_binance_bbo"
            if bid is None or ask is None:
                price = finite(row.get("price"))
                if price is None or price <= 0:
                    continue
                bid = ask = price
                raw_type = "openmarket_binance_price_proxy"
            if bid <= 0 or ask <= 0:
                continue
            events.append({
                "venue": "binance", "kind": "best_bid_ask", "instrument": "BTCUSDT",
                "eventTimeMs": ts, "receivedTimeMs": recv, "bid": bid, "ask": ask,
                "rawType": raw_type, "raw": {"date": str(row.get("date"))},
            })

        for row in iter_rows(pm_files):
            ts = integer(row.get("source_ts_ms"))
            recv = integer(row.get("ingest_ts_ms")) or ts
            token = str(row.get("asset_id") or "")
            meta = token_meta.get(token)
            if ts is None or recv is None or not meta or ts < window_start or ts > window_end:
                continue
            bid = finite(row.get("best_bid"))
            ask = finite(row.get("best_ask"))
            depth = finite(row.get("size"))
            if bid is None or ask is None or depth is None or bid <= 0 or ask <= 0 or depth <= 0:
                continue
            if not should_emit(f"pm:{token}", ts):
                continue
            capped = min(depth, args.top_depth_cap)
            events.append({
                "venue": "polymarket", "kind": "book", "instrument": token,
                "eventTimeMs": ts, "receivedTimeMs": recv,
                "rawType": "openmarket_top_book", "polymarket": meta,
                "raw": {
                    "bids": [{"price": bid, "size": capped}],
                    "asks": [{"price": ask, "size": capped}],
                    "historical_top_only": True,
                    "source_size": depth,
                    "depth_cap": args.top_depth_cap,
                    "source_event_type": row.get("event_type"),
                    "market_slug": row.get("market_slug"),
                },
            })

        events.sort(key=lambda e: (e["eventTimeMs"], e["receivedTimeMs"], e["venue"], e["instrument"]))
        args.events.parent.mkdir(parents=True, exist_ok=True)
        with args.events.open("w", encoding="utf-8") as fh:
            for event in events:
                fh.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
        binance_events = sum(1 for e in events if e["venue"] == "binance")
        pm_events = len(events) - binance_events

    snapshot = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "provenance": {
            "source": "gregyoung14/openmarket-btc-polymarket",
            "datasetVersion": "v0.4.3-unified",
            "exporterVersion": "fluxquant-v1.5.0",
            "exporterProfile": f"fluxquant-v1.5-{args.profile}",
            "researchProfile": args.profile,
            "date": args.date,
            "clobRegime": clob_regime(args.date),
            "clobV2CutoverDate": CLOB_V2_CUTOVER_DATE,
            "maxMarkets": args.max_markets,
            "minSamplesPerMarket": args.min_samples_per_market,
            "streamDownsampleMs": 0 if args.profile == "pair" else args.sample_ms,
            "binanceAgeMs": args.binance_age_ms if args.profile == "model" else None,
            "polymarketAgeMs": args.polymarket_age_ms,
            "labelToleranceMs": args.label_tolerance_ms if args.profile == "model" else None,
            "historicalBookModel": (
                "full recorded L2 snapshot + level-delta reconstruction from OpenMarket recorder raw_json"
                if args.profile == "pair"
                else "synthetic top-of-book; flattened source size capped for model/shadow compatibility"
            ),
            "depthEvidence": (
                "RECORDED_L2_LEVEL_SIZES_NOT_LIVE_FILL_PROOF"
                if args.profile == "pair"
                else "SYNTHETIC_TOP_ONLY"
            ),
            "feeMetadata": "not present historically; validators must receive explicit fee assumptions or fail closed",
            "marketRulesMetadata": "historical archive does not provide authoritative per-market V2 mos/mts; live gate must query getClobMarketInfo",
            "rawJsonRequiredForExecutablePairEvidence": args.profile == "pair",
            "publicParquetTopOnlyFallback": args.profile == "pair",
            "missingRawOutputRows": missing_raw_output if args.profile == "pair" else 0,
            "invalidRawL2OutputRows": invalid_raw_output if args.profile == "pair" else 0,
        },
        "markets": selected,
    }
    args.markets.parent.mkdir(parents=True, exist_ok=True)
    args.markets.write_text(json.dumps(snapshot, indent=2, default=str) + "\n", encoding="utf-8")

    resolved_count = sum(1 for m in selected if m.get("resolvedOutcome"))
    print(f"[openmarket-export] markets={len(selected)} resolved={resolved_count}")
    print(f"[openmarket-export] events={binance_events + pm_events} binance={binance_events} polymarket={pm_events}")
    if args.profile == "pair":
        print(f"[openmarket-export] pair_output missing_raw={missing_raw_output} invalid_raw_l2={invalid_raw_output} ordering=RECEIVED_TIME_FIRST")
    print(f"[openmarket-export] window={window_start}..{window_end} sample_ms={0 if args.profile == 'pair' else args.sample_ms}")
    print(f"[openmarket-export] events_file={args.events}")
    print(f"[openmarket-export] markets_file={args.markets}")


if __name__ == "__main__":
    main()
