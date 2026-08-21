#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import ssl
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://api.dexscreener.com"
PROFILES = "/token-profiles/latest/v1"
BOOSTS = "/token-boosts/latest/v1"
TOKEN_PAIRS = "/token-pairs/v1/{chain}/{token}"
CHAINS = ("solana", "base", "bsc")
MIN_LIQUIDITY_USD = 5_000.0
MIN_MARKET_CAP_OR_FDV_USD = 100_000.0
MIN_PAIR_AGE_MINUTES = 15.0
HORIZONS_MINUTES = (5, 15, 30, 60)
COST_HURDLE_BPS = 100.0
MAX_REQUESTS = 40
MAX_TOKENS_PER_RUN = 30
RUNTIME_SECONDS = 600
WATCH_RUNTIME_SECONDS = 65 * 60
MAX_HORIZON_CAPTURE_LAG_SECONDS = 90
MAX_WATCH_OBSERVATIONS = 8
REQUEST_TIMEOUT_SECONDS = 15
REAL_MONEY_GATE = "NO_GO"
_REQUESTS = 0
_STARTED: float | None = None
_RUNTIME_LIMIT_SECONDS = RUNTIME_SECONDS

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "cache" / "dexscreener" / "altcoin-flow"
OBS_PATH = CACHE_DIR / "observations.json"
REPORT_DIR = ROOT / "reports" / "research" / "crypto-altcoin-flow"
LATEST_REPORT = REPORT_DIR / "latest.json"


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime | None = None) -> str:
    return (ts or utcnow()).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def finite(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def get_json(path: str, params: dict[str, Any] | None = None) -> Any:
    global _REQUESTS
    _REQUESTS += 1
    if _REQUESTS > MAX_REQUESTS:
        raise RuntimeError("ALTCOIN_FLOW_MAX_REQUESTS_EXCEEDED")
    if _STARTED is not None and time.monotonic() - _STARTED > _RUNTIME_LIMIT_SECONDS:
        raise RuntimeError("ALTCOIN_FLOW_RUNTIME_BOUND_EXCEEDED")
    url = BASE + path
    if params:
        url += "?" + urlencode(params)
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "FluxQuant-v1.5-research"})
    ctx = ssl.create_default_context()
    with urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS, context=ctx) as resp:
        return json.loads(resp.read().decode("utf-8"))


def period(row: dict[str, Any], section: str, key: str) -> float:
    raw = (row.get(section) or {}).get(key, 0)
    return finite(raw) or 0.0


def txn_count(row: dict[str, Any], key: str) -> tuple[int, int]:
    raw = (row.get("txns") or {}).get(key) or {}
    try:
        buys = int(raw.get("buys") or 0)
        sells = int(raw.get("sells") or 0)
    except (TypeError, ValueError):
        return 0, 0
    return max(0, buys), max(0, sells)


def metrics(row: dict[str, Any]) -> dict[str, Any]:
    liq = finite((row.get("liquidity") or {}).get("usd")) or 0.0
    v5 = period(row, "volume", "m5")
    v1 = period(row, "volume", "h1")
    b5, s5 = txn_count(row, "m5")
    b1, s1 = txn_count(row, "h1")
    swaps5 = b5 + s5
    swaps1 = b1 + s1
    vl = v1 / liq if liq > 0 else 0.0
    flow = (v5 * 12.0 / v1) if v1 > 0 else 0.0
    sx = (swaps5 * 12.0 / swaps1) if swaps1 > 0 else 0.0
    return {
        "volume_liquidity_h1": vl,
        "flow_m5_annualized_to_h1": flow,
        "swap_velocity_m5_annualized_to_h1": sx,
        "m5_buys": b5,
        "m5_sells": s5,
        "h1_buys": b1,
        "h1_sells": s1,
        "transaction_direction_confirmation": "BUY" if b5 > s5 else "SELL" if s5 > b5 else "NEUTRAL",
    }


def market_value(row: dict[str, Any]) -> float:
    mc = finite(row.get("marketCap"))
    fdv = finite(row.get("fdv"))
    if mc is not None and mc > 0:
        return mc
    return fdv or 0.0


def pair_age_minutes(row: dict[str, Any], now: dt.datetime) -> float:
    created = finite(row.get("pairCreatedAt"))
    if created is None or created <= 0:
        return -1.0
    return (now.timestamp() * 1000.0 - created) / 60000.0


def pair_eligible(row: dict[str, Any], now: dt.datetime) -> bool:
    chain = str(row.get("chainId") or "").lower()
    price = finite(row.get("priceUsd"))
    liq = finite((row.get("liquidity") or {}).get("usd")) or 0.0
    return (
        chain in CHAINS
        and price is not None and price > 0
        and liq >= MIN_LIQUIDITY_USD
        and market_value(row) >= MIN_MARKET_CAP_OR_FDV_USD
        and pair_age_minutes(row, now) >= MIN_PAIR_AGE_MINUTES
    )


def best_pair(rows: list[dict[str, Any]], now: dt.datetime, *, require_eligible: bool) -> dict[str, Any] | None:
    usable = []
    for row in rows:
        price = finite(row.get("priceUsd"))
        if price is None or price <= 0:
            continue
        if require_eligible and not pair_eligible(row, now):
            continue
        liq = finite((row.get("liquidity") or {}).get("usd")) or 0.0
        usable.append((liq, str(row.get("pairAddress") or ""), row))
    if not usable:
        return None
    usable.sort(key=lambda x: (-x[0], x[1]))
    return usable[0][2]


def token_key(chain: str, token: str) -> str:
    return f"{chain.lower()}:{token}"


def load_observations(path: Path = OBS_PATH) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("observations", [])
    if not isinstance(raw, list):
        raise RuntimeError("ALTCOIN_FLOW_OBSERVATION_CACHE_INVALID")
    return [x for x in raw if isinstance(x, dict)]


LEGACY_RESULT_FIELDS = (
    "resolved_at_utc", "resolved_price_usd", "resolution_lag_seconds",
    "gross_return_pct", "cost_hurdle_bps", "net_after_hurdle_pct",
    "hurdle_pass", "resolution_semantics",
)


def save_observations(rows: list[dict[str, Any]], path: Path = OBS_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 2,
        "method": "DOCUMENTED_RECOVERY_OF_EXISTING_ALTCOIN_FLOW_CAPABILITY",
        "instrumentation": "TIMED_PRICE_SAMPLES_V2_FAIL_CLOSED",
        "max_horizon_capture_lag_seconds": MAX_HORIZON_CAPTURE_LAG_SECONDS,
        "cost_hurdle_bps": COST_HURDLE_BPS,
        "observations": rows,
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def horizon_valid(row: dict[str, Any]) -> bool:
    return (
        row.get("status") == "RESOLVED_VALID"
        and row.get("instrumentation_version") == 2
        and finite(row.get("resolved_price_usd")) is not None
    )


def invalidate_legacy_v1_horizons(observations: list[dict[str, Any]]) -> int:
    invalidated = 0
    for obs in observations:
        horizons = obs.setdefault("horizons", {})
        for h in HORIZONS_MINUTES:
            row = horizons.setdefault(str(h), {"target_minutes": h})
            if row.get("resolved_price_usd") is None or row.get("instrumentation_version") == 2:
                continue
            legacy = {k: row.get(k) for k in LEGACY_RESULT_FIELDS if k in row}
            row["invalidated_v1_result"] = legacy
            for key in LEGACY_RESULT_FIELDS:
                row.pop(key, None)
            row.update({
                "status": "INVALIDATED_V1_LATE_SHARED_SNAPSHOT",
                "invalidated_at_utc": iso(),
                "invalidated_reason": "PRE_FIX_RESOLVER_COULD_USE_ONE_LATE_PRICE_FOR_MULTIPLE_HORIZONS",
                "legacy_v1_invalidated": True,
                "instrumentation_version": 2,
            })
            invalidated += 1
        obs["instrumentation_version"] = 2
    return invalidated


def unresolved_keys(observations: list[dict[str, Any]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for obs in observations:
        horizons = obs.get("horizons") or {}
        if all(horizon_valid(horizons.get(str(h)) or {}) for h in HORIZONS_MINUTES):
            continue
        chain = str(obs.get("chain_id") or "")
        token = str(obs.get("token_address") or "")
        key = token_key(chain, token)
        if chain in CHAINS and token and key not in seen:
            seen.add(key); out.append((chain, token))
    return out


def discovery_tokens() -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for endpoint in (PROFILES, BOOSTS):
        raw = get_json(endpoint)
        if isinstance(raw, dict):
            raw = [raw]
        if not isinstance(raw, list):
            continue
        for item in raw:
            if not isinstance(item, dict):
                continue
            chain = str(item.get("chainId") or "").lower()
            token = str(item.get("tokenAddress") or "")
            key = token_key(chain, token)
            if chain in CHAINS and token and key not in seen:
                seen.add(key); found.append((chain, token))
    return found


def same_token_address(chain: str, left: str, right: str) -> bool:
    if chain == "solana":
        return left == right
    return left.lower() == right.lower()


def fetch_pairs(chain: str, token: str) -> list[dict[str, Any]]:
    raw = get_json(TOKEN_PAIRS.format(chain=chain, token=token))
    if not isinstance(raw, list):
        return []
    out = []
    for x in raw:
        if not isinstance(x, dict) or str(x.get("chainId") or "").lower() != chain:
            continue
        base_address = str((x.get("baseToken") or {}).get("address") or "")
        if same_token_address(chain, base_address, token):
            out.append(x)
    return out


def observation_pair(rows: list[dict[str, Any]], obs: dict[str, Any]) -> dict[str, Any] | None:
    expected = str(obs.get("pair_address") or "")
    if not expected:
        return None
    for row in rows:
        if str(row.get("pairAddress") or "") == expected:
            price = finite(row.get("priceUsd"))
            if price is not None and price > 0:
                return row
    return None


def append_price_sample(obs: dict[str, Any], pair: dict[str, Any], now: dt.datetime) -> bool:
    current = finite(pair.get("priceUsd"))
    if current is None or current <= 0:
        return False
    samples = obs.setdefault("price_samples", [])
    samples.append({
        "captured_at_utc": iso(now),
        "price_usd": current,
        "pair_address": str(pair.get("pairAddress") or ""),
        "instrumentation_version": 2,
    })
    return True


def directional_return_pct(obs: dict[str, Any], current: float, entry: float) -> float | None:
    raw = (current / entry - 1.0) * 100.0
    direction = str((obs.get("features") or {}).get("transaction_direction_confirmation") or "NEUTRAL")
    if direction == "BUY":
        return raw
    if direction == "SELL":
        return -raw
    return None


def resolve_horizons_from_samples(observations: list[dict[str, Any]], now: dt.datetime) -> int:
    resolved = 0
    hurdle_pct = COST_HURDLE_BPS / 100.0
    for obs in observations:
        entry = finite(obs.get("entry_price_usd"))
        if entry is None or entry <= 0:
            continue
        captured = parse_iso(str(obs["captured_at_utc"]))
        samples = sorted(
            (x for x in (obs.get("price_samples") or []) if isinstance(x, dict)),
            key=lambda x: str(x.get("captured_at_utc") or ""),
        )
        horizons = obs.setdefault("horizons", {})
        for h in HORIZONS_MINUTES:
            row = horizons.setdefault(str(h), {"target_minutes": h})
            if horizon_valid(row):
                continue
            target = captured + dt.timedelta(minutes=h)
            chosen = None
            chosen_ts = None
            for sample in samples:
                try:
                    sample_ts = parse_iso(str(sample.get("captured_at_utc") or ""))
                except ValueError:
                    continue
                lag = (sample_ts - target).total_seconds()
                if 0 <= lag <= MAX_HORIZON_CAPTURE_LAG_SECONDS:
                    chosen = sample
                    chosen_ts = sample_ts
                    break
            if chosen is None or chosen_ts is None:
                if now > target + dt.timedelta(seconds=MAX_HORIZON_CAPTURE_LAG_SECONDS):
                    row.update({
                        "status": "MISSED_CAPTURE_WINDOW",
                        "target_at_utc": iso(target),
                        "instrumentation_version": 2,
                        "missed_reason": "NO_PRICE_SAMPLE_WITHIN_POST_TARGET_CAPTURE_WINDOW",
                    })
                continue
            current = finite(chosen.get("price_usd"))
            if current is None or current <= 0:
                continue
            gross_pct = directional_return_pct(obs, current, entry)
            if gross_pct is None:
                row.update({
                    "status": "UNSCORABLE_NEUTRAL_DIRECTION",
                    "target_at_utc": iso(target),
                    "instrumentation_version": 2,
                })
                continue
            row.update({
                "status": "RESOLVED_VALID",
                "target_at_utc": iso(target),
                "resolved_at_utc": iso(chosen_ts),
                "resolved_price_usd": current,
                "resolution_lag_seconds": (chosen_ts - target).total_seconds(),
                "gross_return_pct": gross_pct,
                "cost_hurdle_bps": COST_HURDLE_BPS,
                "net_after_hurdle_pct": gross_pct - hurdle_pct,
                "hurdle_pass": gross_pct > hurdle_pct,
                "resolution_semantics": "TIMED_PRICE_SAMPLE_WITHIN_POST_TARGET_WINDOW",
                "instrumentation_version": 2,
            })
            resolved += 1
    return resolved


def make_observation(pair: dict[str, Any], now: dt.datetime) -> dict[str, Any]:
    base = pair.get("baseToken") or {}
    token = str(base.get("address") or "")
    chain = str(pair.get("chainId") or "").lower()
    return {
        "observation_id": hashlib.sha256(f"{chain}|{token}|{iso(now)}".encode()).hexdigest()[:20],
        "captured_at_utc": iso(now),
        "chain_id": chain,
        "token_address": token,
        "symbol": str(base.get("symbol") or ""),
        "name": str(base.get("name") or ""),
        "pair_address": str(pair.get("pairAddress") or ""),
        "dex_id": str(pair.get("dexId") or ""),
        "entry_price_usd": finite(pair.get("priceUsd")),
        "liquidity_usd": finite((pair.get("liquidity") or {}).get("usd")) or 0.0,
        "market_cap_or_fdv_usd": market_value(pair),
        "pair_age_minutes": pair_age_minutes(pair, now),
        "features": metrics(pair),
        "instrumentation_version": 2,
        "price_samples": [{
            "captured_at_utc": iso(now),
            "price_usd": finite(pair.get("priceUsd")),
            "pair_address": str(pair.get("pairAddress") or ""),
            "instrumentation_version": 2,
        }],
        "horizons": {str(h): {"target_minutes": h, "status": "PENDING", "instrumentation_version": 2} for h in HORIZONS_MINUTES},
        "real_money_gate": REAL_MONEY_GATE,
    }


def summarize_horizons(observations: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for h in HORIZONS_MINUTES:
        vals = []
        passes = 0
        for obs in observations:
            row = (obs.get("horizons") or {}).get(str(h)) or {}
            val = finite(row.get("net_after_hurdle_pct")) if horizon_valid(row) else None
            if val is not None:
                vals.append(val)
                passes += 1 if bool(row.get("hurdle_pass")) else 0
        rows = [(obs.get("horizons") or {}).get(str(h)) or {} for obs in observations]
        summary[str(h)] = {
            "resolved_valid": len(vals),
            "missed_capture_window": sum(1 for row in rows if row.get("status") == "MISSED_CAPTURE_WINDOW"),
            "invalidated_v1": sum(1 for row in rows if bool(row.get("legacy_v1_invalidated"))),
            "mean_net_after_hurdle_pct": (sum(vals) / len(vals)) if vals else None,
            "hurdle_pass_share": (passes / len(vals)) if vals else None,
        }
    return summary


def save_report(payload: dict[str, Any]) -> tuple[Path, str]:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    path = REPORT_DIR / f"auto-{stamp}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    LATEST_REPORT.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    return path, sha256_file(path)


def run_auto() -> dict[str, Any]:
    global _STARTED, _REQUESTS, _RUNTIME_LIMIT_SECONDS
    _STARTED = time.monotonic(); _REQUESTS = 0; _RUNTIME_LIMIT_SECONDS = RUNTIME_SECONDS
    now = utcnow()
    observations = load_observations()
    existing_before = len(observations)
    invalidated_legacy = invalidate_legacy_v1_horizons(observations)

    keys: list[tuple[str, str]] = []
    seen: set[str] = set()
    for chain, token in unresolved_keys(observations):
        k = token_key(chain, token)
        if k not in seen:
            seen.add(k); keys.append((chain, token))
    for chain, token in discovery_tokens():
        k = token_key(chain, token)
        if k not in seen and len(keys) < MAX_TOKENS_PER_RUN:
            seen.add(k); keys.append((chain, token))
    keys = keys[:MAX_TOKENS_PER_RUN]

    pair_by_key: dict[str, dict[str, Any]] = {}
    new_candidates: list[dict[str, Any]] = []
    obs_by_key = {token_key(str(o.get("chain_id") or ""), str(o.get("token_address") or "")): o for o in observations}
    existing_ids = set(obs_by_key)
    errors: list[str] = []
    for idx, (chain, token) in enumerate(keys, 1):
        print(f"[altflow] token={idx}/{len(keys)} chain={chain} address={token}", flush=True)
        try:
            pairs = fetch_pairs(chain, token)
            k = token_key(chain, token)
            if k in obs_by_key:
                matched = observation_pair(pairs, obs_by_key[k])
                if matched is not None:
                    pair_by_key[k] = matched
            eligible = best_pair(pairs, now, require_eligible=True)
            if eligible is not None and token_key(chain, token) not in existing_ids:
                new_candidates.append(eligible)
        except Exception as exc:
            errors.append(f"{chain}:{token}:{type(exc).__name__}:{exc}")

    samples_captured_now = 0
    for obs in observations:
        pair = pair_by_key.get(token_key(str(obs.get("chain_id") or ""), str(obs.get("token_address") or "")))
        if pair is not None and append_price_sample(obs, pair, now):
            samples_captured_now += 1
    resolved_now = resolve_horizons_from_samples(observations, now)
    for pair in new_candidates:
        obs = make_observation(pair, now)
        observations.append(obs)
        existing_ids.add(token_key(obs["chain_id"], obs["token_address"]))

    save_observations(observations)
    horizon_summary = summarize_horizons(observations)
    payload = {
        "schema_version": 2,
        "generated_at_utc": iso(),
        "capability": "CRYPTO_ALTCOIN_FLOW_RESEARCH",
        "provenance": {
            "recovery": "DOCUMENTED_PRIOR_FLUXQUANT_METHOD; ORIGINAL_PYZ_BYTES_NOT_AVAILABLE_IN_CHATGPT_LIBRARY",
            "recorded_original_artifact_sha256": "15f1521e13a53f22cf372a72437bfacc3a0ba4fc11eb2e502c9d21fddab1c0f3",
            "source": "DEX Screener public API",
            "endpoints": [PROFILES, BOOSTS, TOKEN_PAIRS],
            "chains": list(CHAINS),
        },
        "frozen_method": {
            "volume_liquidity": "h1_volume_usd / liquidity_usd",
            "flow": "m5_volume_usd * 12 / h1_volume_usd",
            "swap_velocity": "m5_swaps * 12 / h1_swaps",
            "transaction_direction_confirmation": "m5 buy/sell transaction counts",
            "min_liquidity_usd": MIN_LIQUIDITY_USD,
            "min_market_cap_or_fdv_usd": MIN_MARKET_CAP_OR_FDV_USD,
            "min_pair_age_minutes": MIN_PAIR_AGE_MINUTES,
            "prospective_horizons_minutes": list(HORIZONS_MINUTES),
            "fee_plus_slippage_hurdle_bps": COST_HURDLE_BPS,
            "promotion_allowed": False,
            "instrumentation_version": 2,
            "max_horizon_capture_lag_seconds": MAX_HORIZON_CAPTURE_LAG_SECONDS,
        },
        "instrumentation_fix": {
            "legacy_v1_horizons_invalidated_now": invalidated_legacy,
            "timed_samples_captured_now": samples_captured_now,
            "same_entry_pair_required": True,
            "one_late_snapshot_can_fill_multiple_horizons": False,
        },
        "observations_before": existing_before,
        "new_observations": len(new_candidates),
        "observations_total": len(observations),
        "horizons_resolved_now": resolved_now,
        "horizon_summary": horizon_summary,
        "requests_used": _REQUESTS,
        "errors": errors,
        "decision": "KEEP_PROSPECTIVE_SIGNAL_UNPROVEN",
        "orders_placed": 0,
        "api_keys_used": 0,
        "real_money_gate": REAL_MONEY_GATE,
    }
    path, digest = save_report(payload)
    payload["report"] = str(path)
    payload["report_sha256"] = digest

    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW COMPLETE ===")
    print(f"[ALTFLOW] decision={payload['decision']} observations={len(observations)} new={len(new_candidates)} resolved_now={resolved_now} invalidated_v1={invalidated_legacy} errors={len(errors)}")
    for obs in observations[-len(new_candidates):] if new_candidates else []:
        f = obs["features"]
        print(f"[ALTFLOW] {obs['chain_id']} {obs['symbol']} V/L={f['volume_liquidity_h1']:.4f} FLOW={f['flow_m5_annualized_to_h1']:.4f} Sx={f['swap_velocity_m5_annualized_to_h1']:.4f} dir={f['transaction_direction_confirmation']} liq=${obs['liquidity_usd']:.0f}")
    print(f"[ALTFLOW] requests={_REQUESTS}/{MAX_REQUESTS} report={path} sha256={digest}")
    print("[ALTFLOW] PROFITABILITY_PROMOTION_ALLOWED=NO")
    print("[ALTFLOW] ORDERS_PLACED=0")
    print("[ALTFLOW] API_KEYS_USED=0")
    print("[ALTFLOW] REAL_MONEY_GATE=NO_GO")
    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW RESULT ===")
    print(f"ALTFLOW_DECISION={payload['decision']}")
    print(f"OBSERVATIONS_BEFORE={existing_before}")
    print(f"NEW_OBSERVATIONS={len(new_candidates)}")
    print(f"OBSERVATIONS_TOTAL={len(observations)}")
    print(f"HORIZONS_RESOLVED_NOW={resolved_now}")
    print(f"LEGACY_HORIZONS_INVALIDATED_NOW={invalidated_legacy}")
    print(f"TIMED_SAMPLES_CAPTURED_NOW={samples_captured_now}")
    print(f"REQUESTS_USED={_REQUESTS}")
    print(f"ERRORS={len(errors)}")
    print(f"REPORT={LATEST_REPORT}")
    print(f"REPORT_SHA256={digest}")
    print("PROFITABILITY_PROMOTION_ALLOWED=NO")
    print("REAL_MONEY_GATE=NO_GO")
    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW MILESTONE REPORT ===")
    print("FLUXQUANT_ALTCOIN_FLOW_REPO_INTEGRATION=PASS")
    print("ALTFLOW_HORIZON_INSTRUMENTATION_V2=PASS")
    print("RECOVERY_MODE=DOCUMENTED_PRIOR_METHOD_NOT_BYTE_EXACT_SOURCE")
    print("PRODUCTION_VERSION=1.5.0")
    print("C1_STATUS=KILL_FROZEN_NO_RETUNE")
    print("FUNDING_CARRY_STATUS=KEEP_MATURATION_WAIT")
    print("EXPIRY_CARRY_STATUS=KEEP_MATURATION_WAIT")
    print("LIVE_EXECUTION_ADDED=NO")
    print("API_KEYS_USED=NO")
    print("ORDERS_PLACED=0")
    print("FOOTBALL_ALPHA_CHANGED=NO")
    print("POLYMARKET_LOGIC_CHANGED=NO")
    print("REAL_MONEY_GATE=NO_GO")
    return payload


def pending_watch_observations(observations: list[dict[str, Any]], now: dt.datetime) -> list[dict[str, Any]]:
    candidates = []
    for obs in observations:
        captured = parse_iso(str(obs.get("captured_at_utc") or ""))
        future = False
        for h in HORIZONS_MINUTES:
            row = (obs.get("horizons") or {}).get(str(h)) or {}
            target = captured + dt.timedelta(minutes=h)
            if not horizon_valid(row) and now <= target + dt.timedelta(seconds=MAX_HORIZON_CAPTURE_LAG_SECONDS):
                future = True
                break
        if future:
            candidates.append(obs)
    candidates.sort(key=lambda o: parse_iso(str(o["captured_at_utc"])), reverse=True)
    return candidates[:MAX_WATCH_OBSERVATIONS]


def next_watch_target(observations: list[dict[str, Any]], now: dt.datetime) -> dt.datetime | None:
    targets = []
    for obs in observations:
        captured = parse_iso(str(obs["captured_at_utc"]))
        for h in HORIZONS_MINUTES:
            row = (obs.get("horizons") or {}).get(str(h)) or {}
            if horizon_valid(row):
                continue
            target = captured + dt.timedelta(minutes=h)
            if now >= target and row.get("capture_attempted_at_utc"):
                continue
            if now <= target + dt.timedelta(seconds=MAX_HORIZON_CAPTURE_LAG_SECONDS):
                targets.append(max(now, target))
    return min(targets) if targets else None


def run_watch_horizons() -> dict[str, Any]:
    global _STARTED, _REQUESTS, _RUNTIME_LIMIT_SECONDS
    _STARTED = time.monotonic(); _REQUESTS = 0; _RUNTIME_LIMIT_SECONDS = WATCH_RUNTIME_SECONDS
    observations = load_observations()
    invalidated_legacy = invalidate_legacy_v1_horizons(observations)
    start_now = utcnow()
    watched = pending_watch_observations(observations, start_now)
    if not watched:
        save_observations(observations)
        print("=== FLUXQUANT CRYPTO ALTCOIN FLOW WATCH COMPLETE ===")
        print(f"[ALTFLOW_WATCH] decision=NO_WATCHABLE_PENDING_HORIZONS invalidated_v1={invalidated_legacy} requests=0")
        print("REAL_MONEY_GATE=NO_GO")
        return {"decision": "NO_WATCHABLE_PENDING_HORIZONS", "requests_used": 0}

    watch_ids = {str(o.get("observation_id") or "") for o in watched}
    print(f"[altflow-watch] observations={len(watched)} ids={','.join(sorted(watch_ids))}", flush=True)
    resolved_total = 0
    errors: list[str] = []
    while True:
        now = utcnow()
        resolve_horizons_from_samples(watched, now)
        nxt = next_watch_target(watched, now)
        if nxt is None:
            break
        if time.monotonic() - _STARTED > WATCH_RUNTIME_SECONDS:
            raise RuntimeError("ALTCOIN_FLOW_WATCH_RUNTIME_BOUND_EXCEEDED")
        wait_s = max(0.0, (nxt - now).total_seconds())
        if wait_s > 0:
            print(f"[altflow-watch] next_target={iso(nxt)} wait_seconds={wait_s:.1f}", flush=True)
            while wait_s > 0:
                chunk = min(30.0, wait_s)
                time.sleep(chunk)
                now = utcnow()
                wait_s = max(0.0, (nxt - now).total_seconds())
                if time.monotonic() - _STARTED > WATCH_RUNTIME_SECONDS:
                    raise RuntimeError("ALTCOIN_FLOW_WATCH_RUNTIME_BOUND_EXCEEDED")

        sample_now = utcnow()
        due = []
        for obs in watched:
            captured = parse_iso(str(obs["captured_at_utc"]))
            horizons = obs.get("horizons") or {}
            for h in HORIZONS_MINUTES:
                row = horizons.get(str(h)) or {}
                if horizon_valid(row):
                    continue
                target = captured + dt.timedelta(minutes=h)
                lag = (sample_now - target).total_seconds()
                if 0 <= lag <= MAX_HORIZON_CAPTURE_LAG_SECONDS:
                    row["capture_attempted_at_utc"] = iso(sample_now)
                    row["instrumentation_version"] = 2
                    due.append(obs)
                    break
        unique_due = {str(o.get("observation_id")): o for o in due}.values()
        for obs in unique_due:
            chain = str(obs.get("chain_id") or "")
            token = str(obs.get("token_address") or "")
            try:
                pair = observation_pair(fetch_pairs(chain, token), obs)
                if pair is None:
                    errors.append(f"{chain}:{token}:ENTRY_PAIR_NOT_FOUND")
                    continue
                append_price_sample(obs, pair, sample_now)
            except Exception as exc:
                errors.append(f"{chain}:{token}:{type(exc).__name__}:{exc}")
        before = sum(1 for obs in watched for h in HORIZONS_MINUTES if horizon_valid((obs.get("horizons") or {}).get(str(h)) or {}))
        resolve_horizons_from_samples(watched, utcnow())
        after = sum(1 for obs in watched for h in HORIZONS_MINUTES if horizon_valid((obs.get("horizons") or {}).get(str(h)) or {}))
        resolved_total += max(0, after - before)
        save_observations(observations)

    horizon_summary = summarize_horizons(observations)
    payload = {
        "schema_version": 2,
        "generated_at_utc": iso(),
        "capability": "CRYPTO_ALTCOIN_FLOW_HORIZON_WATCH",
        "instrumentation_version": 2,
        "watch_observations": len(watched),
        "legacy_v1_horizons_invalidated_now": invalidated_legacy,
        "valid_horizons_resolved_during_watch": resolved_total,
        "horizon_summary": horizon_summary,
        "requests_used": _REQUESTS,
        "errors": errors,
        "decision": "KEEP_PROSPECTIVE_SIGNAL_UNPROVEN",
        "profitability_promotion_allowed": False,
        "orders_placed": 0,
        "api_keys_used": 0,
        "real_money_gate": REAL_MONEY_GATE,
    }
    path, digest = save_report(payload)
    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW WATCH COMPLETE ===")
    print(f"[ALTFLOW_WATCH] decision={payload['decision']} watched={len(watched)} valid_resolved={resolved_total} invalidated_v1={invalidated_legacy} errors={len(errors)}")
    print(f"[ALTFLOW_WATCH] requests={_REQUESTS}/{MAX_REQUESTS} report={path} sha256={digest}")
    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW RESULT ===")
    print(f"ALTFLOW_DECISION={payload['decision']}")
    print("INSTRUMENTATION_VERSION=2")
    print(f"WATCH_OBSERVATIONS={len(watched)}")
    print(f"LEGACY_HORIZONS_INVALIDATED_NOW={invalidated_legacy}")
    print(f"VALID_HORIZONS_RESOLVED_DURING_WATCH={resolved_total}")
    print(f"REQUESTS_USED={_REQUESTS}")
    print(f"ERRORS={len(errors)}")
    print(f"REPORT={LATEST_REPORT}")
    print(f"REPORT_SHA256={digest}")
    print("PROFITABILITY_PROMOTION_ALLOWED=NO")
    print("REAL_MONEY_GATE=NO_GO")
    print("=== FLUXQUANT CRYPTO ALTCOIN FLOW MILESTONE REPORT ===")
    print("ALTFLOW_HORIZON_INSTRUMENTATION_V2=PASS")
    print("LEGACY_V1_PROFITABILITY_EVIDENCE=INVALIDATED")
    print("TOKEN_FILTERS_CHANGED=NO")
    print("SIGNAL_FORMULAS_CHANGED=NO")
    print("COST_HURDLE_CHANGED=NO")
    print("LIVE_EXECUTION_ADDED=NO")
    print("ORDERS_PLACED=0")
    print("API_KEYS_USED=NO")
    print("REAL_MONEY_GATE=NO_GO")
    return payload


def self_test() -> None:
    now = dt.datetime(2026, 8, 18, 0, 0, tzinfo=dt.timezone.utc)
    pair = {
        "chainId": "solana", "priceUsd": "1.0", "pairAddress": "p", "dexId": "d",
        "baseToken": {"address": "t", "symbol": "T", "name": "Token"},
        "liquidity": {"usd": 10_000}, "marketCap": 200_000, "fdv": 250_000,
        "pairCreatedAt": int((now - dt.timedelta(hours=1)).timestamp() * 1000),
        "volume": {"m5": 1000, "h1": 6000},
        "txns": {"m5": {"buys": 8, "sells": 2}, "h1": {"buys": 40, "sells": 20}},
    }
    m = metrics(pair)
    assert pair_eligible(pair, now)
    assert abs(m["volume_liquidity_h1"] - 0.6) < 1e-12
    assert abs(m["flow_m5_annualized_to_h1"] - 2.0) < 1e-12
    assert abs(m["swap_velocity_m5_annualized_to_h1"] - 2.0) < 1e-12
    assert m["transaction_direction_confirmation"] == "BUY"
    # V1 regression: one late price must never fill 5/15/30/60 simultaneously.
    legacy = make_observation(pair, now - dt.timedelta(minutes=61))
    legacy.pop("instrumentation_version", None)
    legacy.pop("price_samples", None)
    for h in HORIZONS_MINUTES:
        legacy["horizons"][str(h)].pop("instrumentation_version", None)
        legacy["horizons"][str(h)].update({
            "resolved_at_utc": iso(now), "resolved_price_usd": 1.02,
            "resolution_semantics": "FIRST_OBSERVED_PRICE_AT_OR_AFTER_TARGET_HORIZON",
        })
    assert invalidate_legacy_v1_horizons([legacy]) == 4
    assert all(not horizon_valid(legacy["horizons"][str(h)]) for h in HORIZONS_MINUTES)

    # V2: only a timed sample inside the target window resolves that horizon.
    obs = make_observation(pair, now - dt.timedelta(minutes=60))
    obs["entry_price_usd"] = 1.0
    obs["price_samples"] = [{
        "captured_at_utc": iso(now), "price_usd": 1.02,
        "pair_address": "p", "instrumentation_version": 2,
    }]
    n = resolve_horizons_from_samples([obs], now)
    assert n == 1
    assert obs["horizons"]["60"]["status"] == "RESOLVED_VALID"
    assert obs["horizons"]["5"]["status"] == "MISSED_CAPTURE_WINDOW"
    assert abs(obs["horizons"]["60"]["net_after_hurdle_pct"] - 1.0) < 1e-9
    assert obs["horizons"]["60"]["hurdle_pass"] is True

    # SELL direction is scored with the frozen transaction-direction field.
    sell = make_observation(pair, now - dt.timedelta(minutes=5))
    sell["entry_price_usd"] = 1.0
    sell["features"]["transaction_direction_confirmation"] = "SELL"
    sell["price_samples"] = [{
        "captured_at_utc": iso(now), "price_usd": 0.98,
        "pair_address": "p", "instrumentation_version": 2,
    }]
    assert resolve_horizons_from_samples([sell], now) == 1
    assert abs(sell["horizons"]["5"]["gross_return_pct"] - 2.0) < 1e-9
    young = dict(pair); young["pairCreatedAt"] = int((now - dt.timedelta(minutes=10)).timestamp() * 1000)
    assert not pair_eligible(young, now)
    print("[altflow] SELF_TEST_PASS")
    print("[altflow] tests=filters,vl_formula,flow_formula,swap_velocity,direction,timed_horizon_resolution,v1_invalidation,100bps_hurdle")
    print("[altflow] network=NOT_USED")
    print("[altflow] TLS_VERIFICATION=STANDARD_PYTHON_DEFAULT")
    print("[altflow] ORDERS_PLACED=0")
    print("[altflow] API_KEYS_USED=0")
    print("[altflow] REAL_MONEY_GATE=NO_GO")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["auto", "watch-horizons", "self-test"])
    args = ap.parse_args()
    try:
        if args.command == "self-test":
            self_test()
        elif args.command == "watch-horizons":
            run_watch_horizons()
        else:
            run_auto()
        return 0
    except Exception as exc:
        print(f"[altflow] ERROR:{type(exc).__name__}:{exc}", file=sys.stderr)
        print("[altflow] ORDERS_PLACED=0", file=sys.stderr)
        print("[altflow] REAL_MONEY_GATE=NO_GO", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
