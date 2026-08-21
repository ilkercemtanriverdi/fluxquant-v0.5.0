#!/usr/bin/env python3
"""P3 Polymarket Wallet DNA Research - Behavioral Fingerprinting Only."""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path

# --- Import shared Polymarket client ---
_root = Path(__file__).resolve().parent
_project_root = _root
for p in [_root, *_root.parents]:
    if (p / "package.json").is_file():
        try:
            pkg = json.loads((p / "package.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        if pkg.get("name") == "fluxquant":
            _project_root = p
            break
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from src.integrations.polymarket.client import get_json as _shared_get_json  # noqa: E402

TOOL = "FluxQuant Polymarket Wallet DNA Research"
VERSION = "1.0.0"
REAL_MONEY_GATE = "NO_GO"
ORDERS_PLACED = 0
API_KEYS_USED = 0

DATA_API = "https://data-api.polymarket.com"

MAX_TRADES = 500
MAX_REQUESTS = 40
RUNTIME_SECONDS = 300
REQUEST_TIMEOUT = 15

_TARGET_WALLET = "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
_TARGET_SYMBOLS = {"BTC", "ETH", "SOL", "XRP"}

_REQUESTS = 0
_REQUEST_LIMIT = MAX_REQUESTS
_AUTO_STARTED = None
_RUNTIME_LIMIT = RUNTIME_SECONDS


def utcnow():
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc)


def iso_now():
    return utcnow().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def report_dir():
    d = _project_root / "reports" / "research" / "wallet-dna"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_bounds():
    global _REQUESTS
    _REQUESTS += 1
    if _REQUESTS > _REQUEST_LIMIT:
        raise RuntimeError("MAX_REQUESTS_EXCEEDED:%d/%d" % (_REQUESTS, _REQUEST_LIMIT))
    if _AUTO_STARTED is not None and (time.monotonic() - _AUTO_STARTED) > _RUNTIME_LIMIT:
        raise RuntimeError("RUNTIME_BOUND_EXCEEDED")


def get_json(url: str, timeout: int = REQUEST_TIMEOUT, use_cache: bool = True) -> tuple:
    _check_bounds()
    obj, elapsed_ms, sha, cache_hit = _shared_get_json(
        url, timeout=timeout, use_cache=use_cache, retries=3,
    )
    return obj, elapsed_ms, sha, cache_hit


def fnum(x):
    try:
        y = float(x)
        return y if math.isfinite(y) else None
    except Exception:
        return None



# --- Snapshot loading ---

def load_wallet_snapshot(wallet: str):
    """Load the latest remote collector wallet snapshot when available."""
    wallet_lower = str(wallet).lower()
    snapshot = (
        _project_root
        / "data"
        / "polymarket"
        / "snapshots"
        / ("wallet-trades-%s-latest.json" % wallet_lower)
    )

    if not snapshot.exists():
        return None

    try:
        import json

        envelope = json.loads(snapshot.read_text())

        data = envelope.get("data", envelope) if isinstance(envelope, dict) else envelope

        if isinstance(data, dict):
            snapshot_wallet = str(data.get("wallet", "")).lower()
            requested_wallet = str(wallet).lower()

            if not snapshot_wallet:
                raise RuntimeError("SNAPSHOT_WALLET_MISSING")

            if snapshot_wallet != requested_wallet:
                raise RuntimeError(
                    "SNAPSHOT_WALLET_MISMATCH:%s!=%s"
                    % (snapshot_wallet, requested_wallet)
                )

        if isinstance(data, list):
            return data

        if isinstance(data, dict):
            for key in ("trades", "items", "results", "data"):
                value = data.get(key)
                if isinstance(value, list):
                    return value

        return None
    except Exception as exc:
        print("[P3-DNA] snapshot_load_error=%s" % exc)
        return None


# --- Trade fetching ---

def fetch_trades(wallet: str, limit: int = 200, offset: int = 0) -> tuple:
    url = f"{DATA_API}/trades?user={wallet}&limit={limit}&offset={offset}&takerOnly=false"
    return get_json(url)


def fetch_all_trades_bounded(wallet: str) -> list:
    snapshot_trades = load_wallet_snapshot(wallet)

    if snapshot_trades is not None:
        print("[P3-DNA] source=REMOTE_SNAPSHOT")
        return snapshot_trades[:MAX_TRADES]

    print("[P3-DNA] source=API_FALLBACK")

    all_trades = []
    offset = 0
    while len(all_trades) < MAX_TRADES:
        batch_size = min(200, MAX_TRADES - len(all_trades))
        raw, _, _, _ = fetch_trades(wallet, limit=batch_size, offset=offset)
        if not isinstance(raw, list) or len(raw) == 0:
            break
        all_trades.extend(raw)
        offset += len(raw)
        if len(raw) < batch_size:
            break
    return all_trades[:MAX_TRADES]


# --- Dedup ---

def deduplicate_trades(trades: list) -> list:
    seen = set()
    deduped = []
    for t in trades:
        key = (
            str(t.get("transactionHash", "")),
            str(t.get("timestamp", "")),
            str(t.get("side", "")),
            str(t.get("price", "")),
            str(t.get("size", "")),
        )
        if key not in seen:
            seen.add(key)
            deduped.append(t)
    return deduped


# --- Symbol extraction ---

import re
_SYMBOL_RE = re.compile(r"\b(BTC|ETH|SOL|XRP)\b", re.IGNORECASE)


def extract_symbol(title: str, slug: str) -> str | None:
    text = f"{title} {slug}"
    m = _SYMBOL_RE.search(text)
    if m:
        return m.group(1).upper()
    return None


# --- Outcome classification ---

def classify_outcome(outcome: str) -> str | None:
    o = outcome.lower()
    if o in ("up", "higher"):
        return "UP"
    if o in ("down", "lower"):
        return "DOWN"
    return None


# --- Wallet DNA analysis ---

def analyze_wallet_dna(trades: list) -> dict:
    if not trades:
        return {
            "total_trades": 0,
            "unique_condition_ids": 0,
            "up_count": 0,
            "down_count": 0,
            "up_share": 0.0,
            "down_share": 0.0,
            "symbol_counts": {},
            "mean_entry_price": None,
            "median_entry_price": None,
            "total_usdc_notional": 0.0,
            "median_trade_gap_seconds": None,
        }

    total_trades = len(trades)

    condition_ids = set()
    up_count = 0
    down_count = 0
    symbol_counts: dict[str, int] = {}
    prices = []
    total_usdc = 0.0
    timestamps_ms = []

    for t in trades:
        cid = str(t.get("conditionId", ""))
        if cid:
            condition_ids.add(cid)

        title = str(t.get("title", ""))
        slug = str(t.get("slug", ""))
        symbol = extract_symbol(title, slug)
        if symbol:
            symbol_counts[symbol] = symbol_counts.get(symbol, 0) + 1

        outcome = str(t.get("outcome", ""))
        direction = classify_outcome(outcome)
        if direction is None:
            asset = str(t.get("asset", "")).lower()
            if "up" in asset or "higher" in asset:
                direction = "UP"
            elif "down" in asset or "lower" in asset:
                direction = "DOWN"
        if direction == "UP":
            up_count += 1
        elif direction == "DOWN":
            down_count += 1

        price = fnum(t.get("price"))
        if price is not None:
            prices.append(price)

        usdc = fnum(t.get("usdcSize"))
        if usdc is not None:
            total_usdc += usdc
        elif price is not None:
            size = fnum(t.get("size"))
            if size is not None:
                total_usdc += price * size

        timestamp = t.get("timestamp")
        if timestamp is not None:
            try:
                ts_ms = int(timestamp)
                if ts_ms < 1e12:
                    ts_ms = int(ts_ms * 1000)
                timestamps_ms.append(ts_ms)
            except Exception:
                pass

    up_share = up_count / total_trades if total_trades > 0 else 0.0
    down_share = down_count / total_trades if total_trades > 0 else 0.0

    mean_price = statistics.fmean(prices) if prices else None
    median_price = statistics.median(prices) if prices else None

    median_gap = None
    if len(timestamps_ms) >= 2:
        sorted_ts = sorted(timestamps_ms)
        gaps = [(sorted_ts[i] - sorted_ts[i - 1]) / 1000.0 for i in range(1, len(sorted_ts))]
        median_gap = statistics.median(gaps) if gaps else None

    return {
        "total_trades": total_trades,
        "unique_condition_ids": len(condition_ids),
        "up_count": up_count,
        "down_count": down_count,
        "up_share": up_share,
        "down_share": down_share,
        "symbol_counts": symbol_counts,
        "mean_entry_price": mean_price,
        "median_entry_price": median_price,
        "total_usdc_notional": total_usdc,
        "median_trade_gap_seconds": median_gap,
    }


# --- Self test ---

def self_test():
    print("[research] P3_POLY_WALLET_DNA SELF_TEST")
    print("[research] REAL_MONEY_GATE=NO_GO")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")

    # Shared client import check
    from src.integrations.polymarket.client import get_json as _sg
    print("[research] shared_client_import OK")

    # Symbol extraction
    assert extract_symbol("Bitcoin Up or Down?", "btc-up-or-down-5m") == "BTC"
    assert extract_symbol("BTC 5 Minute", "btc-5m") == "BTC"
    assert extract_symbol("Ethereum Higher or Lower?", "eth-higher-or-lower-15m") == "ETH"
    assert extract_symbol("Solana Up or Down?", "sol-up-or-down-5m") == "SOL"
    assert extract_symbol("XRP Up or Down?", "xrp-up-or-down-15m") == "XRP"
    assert extract_symbol("Will Trump win?", "trump-win") is None
    print("[research] symbol_extraction PASS")

    # Outcome classification
    assert classify_outcome("up") == "UP"
    assert classify_outcome("higher") == "UP"
    assert classify_outcome("down") == "DOWN"
    assert classify_outcome("lower") == "DOWN"
    assert classify_outcome("yes") is None
    print("[research] outcome_classification PASS")

    # Dedup
    dups = [
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x2", "timestamp": "2000", "side": "SELL", "price": "0.6", "size": "5"},
    ]
    deduped = deduplicate_trades(dups)
    assert len(deduped) == 2
    print("[research] dedup PASS")

    # Empty trades
    dna_empty = analyze_wallet_dna([])
    assert dna_empty["total_trades"] == 0
    assert dna_empty["unique_condition_ids"] == 0
    print("[research] empty_trades PASS")

    # Single trade
    single = [{"conditionId": "0xabc", "title": "BTC Up or Down?", "slug": "btc-5m", "outcome": "up", "price": "0.65", "size": "100", "timestamp": "1700000000000"}]
    dna_single = analyze_wallet_dna(single)
    assert dna_single["total_trades"] == 1
    assert dna_single["unique_condition_ids"] == 1
    assert dna_single["up_count"] == 1
    assert dna_single["down_count"] == 0
    assert dna_single["symbol_counts"].get("BTC") == 1
    assert abs(dna_single["mean_entry_price"] - 0.65) < 1e-9
    print("[research] single_trade PASS")

    # Multi-trade DNA
    multi = [
        {"conditionId": "0x1", "title": "BTC Up or Down?", "slug": "btc-5m", "outcome": "up", "price": "0.60", "size": "50", "usdcSize": "30", "timestamp": "1700000000000"},
        {"conditionId": "0x1", "title": "BTC Up or Down?", "slug": "btc-5m", "outcome": "down", "price": "0.40", "size": "50", "usdcSize": "20", "timestamp": "1700000060000"},
        {"conditionId": "0x2", "title": "ETH Higher or Lower?", "slug": "eth-15m", "outcome": "higher", "price": "0.55", "size": "80", "usdcSize": "44", "timestamp": "1700000120000"},
    ]
    dna_multi = analyze_wallet_dna(multi)
    assert dna_multi["total_trades"] == 3
    assert dna_multi["unique_condition_ids"] == 2
    assert dna_multi["up_count"] == 2
    assert dna_multi["down_count"] == 1
    assert dna_multi["symbol_counts"]["BTC"] == 2
    assert dna_multi["symbol_counts"]["ETH"] == 1
    assert abs(dna_multi["mean_entry_price"] - statistics.fmean([0.60, 0.40, 0.55])) < 1e-9
    assert abs(dna_multi["total_usdc_notional"] - 94.0) < 1e-9
    assert dna_multi["median_trade_gap_seconds"] is not None
    print("[research] multi_trade_dna PASS")

    # Median trade gap (timestamps in ms)
    gap_trades = [
        {"conditionId": "0x1", "title": "BTC Up?", "slug": "btc-5m", "outcome": "up", "price": "0.5", "size": "10", "timestamp": "1700000000000"},
        {"conditionId": "0x1", "title": "BTC Up?", "slug": "btc-5m", "outcome": "up", "price": "0.6", "size": "10", "timestamp": "1700000003000"},
        {"conditionId": "0x1", "title": "BTC Up?", "slug": "btc-5m", "outcome": "up", "price": "0.7", "size": "10", "timestamp": "1700000010000"},
    ]
    dna_gap = analyze_wallet_dna(gap_trades)
    assert dna_gap["median_trade_gap_seconds"] == 5.0
    print("[research] median_trade_gap PASS")

    # Timestamp ordering
    fills = [{"ts_ms": 3000}, {"ts_ms": 1000}, {"ts_ms": 2000}]
    fills.sort(key=lambda f: f["ts_ms"])
    assert [f["ts_ms"] for f in fills] == [1000, 2000, 3000]
    print("[research] timestamp_ordering PASS")

    # REAL_MONEY_GATE invariant
    assert REAL_MONEY_GATE == "NO_GO"
    assert ORDERS_PLACED == 0
    assert API_KEYS_USED == 0
    print("[research] real_money_gate PASS")

    _p3 = "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
    _p2a = "0x4228048ea2f8f571ff2777cc32baee584c5134cb"
    snap_dir = _project_root / "data" / "polymarket" / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)

    p3_file = snap_dir / ("wallet-trades-%s-latest.json" % _p3.lower())
    p3_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p3.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "abc123",
        "byte_count": 100,
        "data": {"wallet": _p3, "trades": [{"id": "p3t1"}, {"id": "p3t2"}]},
    }
    p3_file.write_text(json.dumps(p3_envelope))

    p2a_file = snap_dir / ("wallet-trades-%s-latest.json" % _p2a.lower())
    p2a_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p2a.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "def456",
        "byte_count": 100,
        "data": {"wallet": _p2a, "trades": [{"id": "p2at1"}]},
    }
    p2a_file.write_text(json.dumps(p2a_envelope))

    p3_trades = load_wallet_snapshot(_p3)
    assert p3_trades is not None
    assert len(p3_trades) == 2
    assert p3_trades[0]["id"] == "p3t1"
    print("[research] p3_wallet_snapshot_load PASS")

    p2a_trades = load_wallet_snapshot(_p2a)
    assert p2a_trades is not None
    assert len(p2a_trades) == 1
    assert p2a_trades[0]["id"] == "p2at1"
    print("[research] p2a_wallet_snapshot_load PASS")

    mismatch_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p2a.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "xyz",
        "byte_count": 50,
        "data": {"wallet": _p2a, "trades": []},
    }
    p3_file.write_text(json.dumps(mismatch_envelope))
    result_wrong = load_wallet_snapshot(_p3)
    assert result_wrong is None
    print("[research] wallet_mismatch_rejected PASS")

    missing_file = snap_dir / "wallet-trades-0x0000000000000000000000000000000000000000-latest.json"
    if missing_file.exists():
        missing_file.unlink()
    result_missing = load_wallet_snapshot("0x0000000000000000000000000000000000000000")
    assert result_missing is None
    print("[research] missing_snapshot_returns_none PASS")

    p3_file.unlink()
    p2a_file.unlink()
    print("[research] cleanup OK")

    print("[research] SELF_TEST_PASS")
    print("[research] network=SHARED_CLIENT")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")
    print("[research] REAL_MONEY_GATE=NO_GO")


# --- Run ---

def run_bounded():
    global _REQUESTS, _AUTO_STARTED, _REQUEST_LIMIT, _RUNTIME_LIMIT
    _REQUESTS = 0
    _AUTO_STARTED = time.monotonic()
    _REQUEST_LIMIT = MAX_REQUESTS
    _RUNTIME_LIMIT = RUNTIME_SECONDS

    wallet = _TARGET_WALLET
    errors = []

    print("[P3-DNA] wallet=%s max_requests=%d" % (wallet, MAX_REQUESTS))

    # Fetch trades
    print("[P3-DNA] stage=fetch_trades")
    try:
        all_trades = fetch_all_trades_bounded(wallet)
        print("[P3-DNA] trades_fetched=%d" % len(all_trades))
    except Exception as e:
        errors.append({"stage": "fetch_trades", "error": "%s: %s" % (type(e).__name__, e)})
        all_trades = []
        print("[P3-DNA] ERROR fetch_trades: %s" % e)

    # Dedup
    all_trades = deduplicate_trades(all_trades)
    print("[P3-DNA] after_dedup=%d" % len(all_trades))

    # DNA analysis
    dna = analyze_wallet_dna(all_trades)

    # Build report
    report = {
        "module": "wallet-dna",
        "version": VERSION,
        "wallet": wallet,
        "total_trades": dna["total_trades"],
        "unique_condition_ids": dna["unique_condition_ids"],
        "up_count": dna["up_count"],
        "down_count": dna["down_count"],
        "up_share": dna["up_share"],
        "down_share": dna["down_share"],
        "symbol_counts": dna["symbol_counts"],
        "mean_entry_price": dna["mean_entry_price"],
        "median_entry_price": dna["median_entry_price"],
        "total_usdc_notional": dna["total_usdc_notional"],
        "median_trade_gap_seconds": dna["median_trade_gap_seconds"],
        "requests_used": _REQUESTS,
        "errors": errors,
        "ORDERS_PLACED": 0,
        "API_KEYS_USED": 0,
        "REAL_MONEY_GATE": REAL_MONEY_GATE,
    }

    # Print results
    print("\n=== FLUXQUANT P3 WALLET DNA RESEARCH COMPLETE ===")
    for k, v in report.items():
        if isinstance(v, float):
            print("[P3-DNA] %s=%.6f" % (k, v))
        else:
            print("[P3-DNA] %s=%s" % (k, v))

    # Save report
    rd = report_dir()
    stamp = iso_now().replace("-", "").replace(":", "")
    p = rd / f"wallet-dna-{stamp}.json"
    raw = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode()
    p.write_bytes(raw)
    (rd / "latest.json").write_bytes(raw)
    print("[P3-DNA] report=%s" % p)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")
    sp.add_parser("run")
    args = ap.parse_args()

    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "run":
        run_bounded()
    else:
        raise ValueError("Unknown command: %s" % args.cmd)


if __name__ == "__main__":
    main()
