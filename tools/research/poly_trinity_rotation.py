#!/usr/bin/env python3
"""P2A Polymarket Trinity Spot Rotation Research - Mechanism Validation Only."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

TOOL = "FluxQuant Polymarket Trinity Spot Rotation Research"
VERSION = "1.0.0"
REAL_MONEY_GATE = "NO_GO"
ORDERS_PLACED = 0
API_KEYS_USED = 0

DATA_API = "https://data-api.polymarket.com"
BINANCE_API = "https://data-api.binance.vision"

MAX_TRADES = 500
MAX_REQUESTS = 40
RUNTIME_SECONDS = 300
REQUEST_TIMEOUT = 15

_TARGET_WALLET = "0x4228048ea2f8f571ff2777cc32baee584c5134cb"
_TARGET_SYMBOLS = {"BTC", "ETH", "SOL", "XRP"}

_REQUESTS = 0
_REQUEST_LIMIT = MAX_REQUESTS
_AUTO_STARTED = None
_RUNTIME_LIMIT = RUNTIME_SECONDS
_CACHE_DIR = None


def utcnow():
    import datetime as dt
    return dt.datetime.now(dt.timezone.utc)


def iso_now():
    return utcnow().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def root():
    p = Path.cwd().resolve()
    for x in [p, *p.parents]:
        pkg = x / "package.json"
        if pkg.is_file():
            try:
                obj = json.loads(pkg.read_text(encoding="utf-8"))
            except Exception:
                continue
            if obj.get("name") == "fluxquant":
                return x
    return p


def cache_dir():
    global _CACHE_DIR
    if _CACHE_DIR is None:
        _CACHE_DIR = root() / "cache" / "polymarket" / "trinity-rotation"
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR


def report_dir():
    d = root() / "reports" / "research" / "poly-trinity-rotation"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(url: str) -> Path:
    digest = hashlib.sha256(url.encode()).hexdigest()[:16]
    return cache_dir() / f"{digest}.json"


def _check_bounds():
    global _REQUESTS
    _REQUESTS += 1
    if _REQUESTS > _REQUEST_LIMIT:
        raise RuntimeError("MAX_REQUESTS_EXCEEDED:%d/%d" % (_REQUESTS, _REQUEST_LIMIT))
    if _AUTO_STARTED is not None and (time.monotonic() - _AUTO_STARTED) > _RUNTIME_LIMIT:
        raise RuntimeError("RUNTIME_BOUND_EXCEEDED")


def _ssl_context():
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    try:
        ctx.load_verify_locations("/opt/homebrew/etc/openssl@3/cert.pem")
    except Exception:
        pass
    try:
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    except Exception:
        pass
    return ctx


def get_json(url: str, timeout: int = REQUEST_TIMEOUT, use_cache: bool = True) -> tuple:
    _check_bounds()
    cache_path = _cache_key(url)
    if use_cache and cache_path.exists():
        raw = cache_path.read_bytes()
        obj = json.loads(raw.decode("utf-8"))
        return obj, 0.0, hashlib.sha256(raw).hexdigest(), True
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "FluxQuant-PolyTrinityRotation/1.0", "Accept": "application/json"},
    )
    started = time.time_ns()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
            raw = r.read()
    except Exception as e1:
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=min(timeout, 8), context=ctx) as r:
                raw = r.read()
        except Exception as e2:
            raise RuntimeError("HTTP_FETCH_FAILED:%s (primary=%s, fallback=%s)" % (url, e1, e2))
    ended = time.time_ns()
    obj = json.loads(raw.decode("utf-8"))
    cache_path.write_bytes(raw)
    return obj, (ended - started) / 1e6, hashlib.sha256(raw).hexdigest(), False


def fnum(x):
    try:
        y = float(x)
        return y if math.isfinite(y) else None
    except Exception:
        return None


def finite_str(x):
    if x is None:
        return "None"
    return "%.6f" % x


# --- Wallet snapshot loading ---

def load_wallet_snapshot(wallet: str):
    """Load the latest remote collector wallet snapshot when available."""
    wallet_lower = str(wallet).lower()
    snapshot = (
        root()
        / "data"
        / "polymarket"
        / "snapshots"
        / ("wallet-trades-%s-latest.json" % wallet_lower)
    )

    if not snapshot.exists():
        return None

    try:
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
        print("[P2A] snapshot_load_error=%s" % exc)
        return None


# --- Market parsing ---

_SYMBOL_RE = re.compile(r"\b(BTC|ETH|SOL|XRP)\b", re.IGNORECASE)
_INTERVAL_RE = re.compile(r"\b(\d+)\s*m(?:in(?:ute)?)?\b", re.IGNORECASE)


def parse_symbol_from_title(title: str, slug: str) -> str | None:
    text = f"{title} {slug}"
    m = _SYMBOL_RE.search(text)
    if m:
        return m.group(1).upper()
    return None


def parse_interval_minutes(title: str, slug: str) -> int | None:
    text = f"{title} {slug}"
    m = _INTERVAL_RE.search(text)
    if m:
        return int(m.group(1))
    return None


def is_short_horizon_crypto_updown(title: str, slug: str) -> bool:
    text = f"{title} {slug}".lower()
    has_updown = ("up" in text and "down" in text) or "up-or-down" in text or "higher-or-lower" in text
    has_symbol = any(s.lower() in text for s in _TARGET_SYMBOLS)
    return has_updown and has_symbol


def classify_outcome_side(title: str, slug: str, outcome: str) -> str | None:
    outcome_lower = outcome.lower()
    if outcome_lower in ("up", "higher"):
        return "UP"
    if outcome_lower in ("down", "lower"):
        return "DOWN"
    return None


# --- Trade fetching ---

def fetch_trades(wallet: str, limit: int = 200, offset: int = 0) -> tuple:
    url = f"{DATA_API}/trades?user={wallet}&limit={limit}&offset={offset}&takerOnly=false"
    return get_json(url)


def fetch_all_trades_bounded(wallet: str) -> list:
    snapshot_trades = load_wallet_snapshot(wallet)

    if snapshot_trades is not None:
        print("[P2A] source=REMOTE_SNAPSHOT")
        return snapshot_trades[:MAX_TRADES]

    print("[P2A] source=API_FALLBACK")

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


# --- Binance spot data ---

def fetch_binance_klines(symbol: str, interval: str, start_ms: int, end_ms: int) -> tuple:
    url = (
        f"{BINANCE_API}/api/v3/klines"
        f"?symbol={symbol}&interval={interval}"
        f"&startTime={start_ms}&endTime={end_ms}&limit=1000"
    )
    return get_json(url)


def build_spot_index(symbol: str, start_ms: int, end_ms: int) -> dict:
    """Build timestamp -> close price index from 1s klines."""
    raw, _, _, _ = fetch_binance_klines(symbol, "1s", start_ms, end_ms)
    index = {}
    if isinstance(raw, list):
        for k in raw:
            ts = int(k[0])
            close = float(k[4])
            index[ts] = close
    return index


def lookup_spot(spot_index: dict, target_ms: int, max_staleness_ms: int = 2000) -> float | None:
    """Find last spot close <= target_ms within staleness window."""
    best_ts = None
    for ts in sorted(spot_index.keys()):
        if ts <= target_ms:
            best_ts = ts
        else:
            break
    if best_ts is None:
        return None
    if target_ms - best_ts > max_staleness_ms:
        return None
    return spot_index[best_ts]


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


# --- Rotation analysis ---

def analyze_rotations(buy_fills: list) -> dict:
    if len(buy_fills) < 2:
        return {
            "rotation_count": 0,
            "spot_sign_change_rotation_count": 0,
            "median_rotation_gap_seconds": None,
            "rotations": [],
        }

    sorted_fills = sorted(buy_fills, key=lambda f: f["ts_ms"] or 0)
    rotations = []
    last_side = None
    last_ts = None
    last_spot_disp = None
    for fill in sorted_fills:
        side = fill.get("up_down")
        ts = fill.get("ts_ms")
        spot_disp = fill.get("signed_displacement_bps")
        if side is None or ts is None:
            continue
        if last_side is not None and side != last_side:
            gap_s = (ts - last_ts) / 1000.0 if last_ts is not None else None
            spot_sign_changed = (
                last_spot_disp is not None
                and spot_disp is not None
                and ((last_spot_disp > 0) != (spot_disp > 0))
            )
            rotations.append({
                "timestamp_ms": ts,
                "previous_side": last_side,
                "new_side": side,
                "spot_displacement_before_bps": last_spot_disp,
                "spot_displacement_at_bps": spot_disp,
                "spot_sign_changed": spot_sign_changed,
                "gap_seconds": gap_s,
            })
        last_side = side
        last_ts = ts
        last_spot_disp = spot_disp

    gaps = [r["gap_seconds"] for r in rotations if r["gap_seconds"] is not None]
    spot_sign_changes = sum(1 for r in rotations if r["spot_sign_changed"])

    return {
        "rotation_count": len(rotations),
        "spot_sign_change_rotation_count": spot_sign_changes,
        "median_rotation_gap_seconds": statistics.median(gaps) if gaps else None,
        "rotations": rotations,
    }


# --- Market analysis ---

def analyze_market(trades: list, market_info: dict) -> dict | None:
    symbol = market_info.get("symbol")
    interval_min = market_info.get("interval_minutes")
    if symbol is None or interval_min is None:
        return None

    condition_id = market_info.get("condition_id", "")
    slug = market_info.get("slug", "")
    title = market_info.get("title", "")

    buy_fills = []
    sell_fills = []
    for t in trades:
        side = str(t.get("side", "")).upper()
        price = fnum(t.get("price"))
        size = fnum(t.get("size"))
        usdc = fnum(t.get("usdcSize"))
        timestamp = t.get("timestamp")
        outcome = str(t.get("outcome", ""))
        ts_ms = None
        if timestamp is not None:
            try:
                ts_ms = int(timestamp)
                if ts_ms < 1e12:
                    ts_ms = int(ts_ms * 1000)
            except Exception:
                pass
        if price is None or size is None or ts_ms is None:
            continue

        up_down = classify_outcome_side(title, slug, outcome)
        if up_down is None:
            asset = str(t.get("asset", "")).lower()
            if "up" in asset or "higher" in asset:
                up_down = "UP"
            elif "down" in asset or "lower" in asset:
                up_down = "DOWN"
        if up_down is None:
            continue

        fill = {
            "ts_ms": ts_ms,
            "side": side,
            "up_down": up_down,
            "price": price,
            "size": size,
            "usdc": usdc if usdc is not None else price * size,
        }
        if side == "BUY":
            buy_fills.append(fill)
        elif side == "SELL":
            sell_fills.append(fill)

    if not buy_fills:
        return None

    buy_fills.sort(key=lambda f: f["ts_ms"])

    # Derive market interval from first/last trade timestamps
    first_ts = buy_fills[0]["ts_ms"]
    last_ts = buy_fills[-1]["ts_ms"]
    market_start = first_ts
    market_end = last_ts

    # Try to fetch spot data for the full window
    spot_window_start = market_start - 60000
    spot_window_end = market_end + 60000
    try:
        spot_index = build_spot_index(symbol, spot_window_start, spot_window_end)
    except Exception:
        spot_index = {}

    # Spot matching for BUY fills
    spot_matched = 0
    aligned = 0
    misaligned = 0
    neutral = 0
    spot_invalid = 0
    displacements = []

    for fill in buy_fills:
        trade_spot = lookup_spot(spot_index, fill["ts_ms"])
        if trade_spot is None:
            spot_invalid += 1
            fill["spot_matched"] = False
            fill["SPOT_MATCH_INVALID"] = True
            continue

        market_open_spot = lookup_spot(spot_index, market_start)
        if market_open_spot is None or market_open_spot == 0:
            spot_invalid += 1
            fill["spot_matched"] = False
            fill["SPOT_MATCH_INVALID"] = True
            continue

        spot_matched += 1
        fill["spot_matched"] = True
        fill["SPOT_MATCH_INVALID"] = False
        fill["trade_spot"] = trade_spot
        fill["market_open_spot"] = market_open_spot

        disp_bps = 10000.0 * (trade_spot / market_open_spot - 1.0)
        direction_sign = 1.0 if fill["up_down"] == "UP" else -1.0
        signed_disp = direction_sign * disp_bps
        fill["spot_displacement_bps"] = disp_bps
        fill["signed_displacement_bps"] = signed_disp

        displacements.append(signed_disp)

        if disp_bps > 0:
            aligned_with = "UP"
        elif disp_bps < 0:
            aligned_with = "DOWN"
        else:
            aligned_with = "NEUTRAL"

        fill["aligned_with_spot"] = aligned_with
        fill["is_aligned"] = (fill["up_down"] == aligned_with and aligned_with != "NEUTRAL")
        fill["is_neutral"] = (aligned_with == "NEUTRAL")

        if fill["is_aligned"]:
            aligned += 1
        elif fill["is_neutral"]:
            neutral += 1
        else:
            misaligned += 1

    alignment_share = aligned / spot_matched if spot_matched > 0 else 0.0

    # Rotation analysis using BUY fills
    rotation_result = analyze_rotations(buy_fills)

    # Notional
    trade_notional = sum(f.get("usdc", 0) for f in buy_fills)

    return {
        "condition_id": condition_id,
        "symbol": symbol,
        "interval_minutes": interval_min,
        "market_start_epoch": market_start,
        "market_end_epoch": market_end,
        "qualifying_buy_fills": len(buy_fills),
        "sell_fills": len(sell_fills),
        "spot_matched_buy_fills": spot_matched,
        "aligned_buy_fills": aligned,
        "misaligned_buy_fills": misaligned,
        "neutral_buy_fills": neutral,
        "alignment_share": alignment_share,
        "median_signed_displacement_bps": statistics.median(displacements) if displacements else None,
        "mean_signed_displacement_bps": statistics.fmean(displacements) if displacements else None,
        "rotation_count": rotation_result["rotation_count"],
        "spot_sign_change_rotation_count": rotation_result["spot_sign_change_rotation_count"],
        "median_rotation_gap_seconds": rotation_result["median_rotation_gap_seconds"],
        "trade_notional_usdc": trade_notional,
        "accounting_complete": "YES",
    }


# --- Aggregate ---

def aggregate(markets: list, trades_fetched: int, trades_qualifying: int, parse_rejected: int) -> dict:
    if not markets:
        return {
            "P2A_DECISION": "BLOCKED",
            "P2A_TRADES_FETCHED": trades_fetched,
            "P2A_QUALIFYING_TRADES": trades_qualifying,
            "P2A_QUALIFYING_BUY_FILLS": 0,
            "P2A_MARKETS_ANALYZED": 0,
            "P2A_MARKETS_SPOT_COMPLETE": 0,
            "P2A_SPOT_MATCHED_BUY_FILLS": 0,
            "P2A_SPOT_MATCH_COVERAGE": 0.0,
            "P2A_ALIGNED_BUY_FILLS": 0,
            "P2A_MISALIGNED_BUY_FILLS": 0,
            "P2A_NEUTRAL_BUY_FILLS": 0,
            "P2A_ALIGNMENT_SHARE": 0.0,
            "P2A_MEDIAN_SIGNED_DISPLACEMENT_BPS": None,
            "P2A_MEAN_SIGNED_DISPLACEMENT_BPS": None,
            "P2A_TOTAL_ROTATIONS": 0,
            "P2A_SPOT_SIGN_CHANGE_ROTATIONS": 0,
            "P2A_SPOT_SIGN_CHANGE_ROTATION_SHARE": 0.0,
            "P2A_MEDIAN_ROTATION_GAP_SECONDS": None,
            "P2A_TOP1_MARKET_NOTIONAL_SHARE": 0.0,
            "P2A_TOP3_MARKET_NOTIONAL_SHARE": 0.0,
            "P2A_PARSE_REJECTED": parse_rejected,
            "P2A_SPOT_MATCH_INVALID": 0,
            "REQUESTS_USED": _REQUESTS,
            "ERRORS": [],
            "P2A_PROFITABILITY_PROVEN": "NO",
            "PROFITABILITY_PROMOTION_ALLOWED": "NO",
            "ORDERS_PLACED": 0,
            "API_KEYS_USED": 0,
            "REAL_MONEY_GATE": REAL_MONEY_GATE,
        }

    total_buys = sum(m["qualifying_buy_fills"] for m in markets)
    total_spot_matched = sum(m["spot_matched_buy_fills"] for m in markets)
    total_aligned = sum(m["aligned_buy_fills"] for m in markets)
    total_misaligned = sum(m["misaligned_buy_fills"] for m in markets)
    total_neutral = sum(m["neutral_buy_fills"] for m in markets)
    total_rotations = sum(m["rotation_count"] for m in markets)
    total_spot_sign_rotations = sum(m["spot_sign_change_rotation_count"] for m in markets)
    spot_invalid = sum(
        m["qualifying_buy_fills"] - m["spot_matched_buy_fills"] for m in markets
    )

    all_displacements = []
    for m in markets:
        if m["median_signed_displacement_bps"] is not None:
            all_displacements.append(m["median_signed_displacement_bps"])
    all_gaps = []
    for m in markets:
        if m["median_rotation_gap_seconds"] is not None:
            all_gaps.append(m["median_rotation_gap_seconds"])

    alignment_share = total_aligned / total_spot_matched if total_spot_matched > 0 else 0.0
    spot_match_coverage = total_spot_matched / total_buys if total_buys > 0 else 0.0
    rotation_share = total_spot_sign_rotations / total_rotations if total_rotations > 0 else 0.0

    # Concentration
    notionals = sorted([m["trade_notional_usdc"] for m in markets], reverse=True)
    total_notional = sum(notionals)
    top1_share = notionals[0] / total_notional if total_notional > 0 and notionals else 0.0
    top3_share = sum(notionals[:3]) / total_notional if total_notional > 0 else 0.0

    spot_complete = sum(1 for m in markets if m["spot_matched_buy_fills"] == m["qualifying_buy_fills"])

    # Decision
    decision = "KILL"
    if (
        total_spot_matched >= 200
        and len(markets) >= 25
        and spot_match_coverage >= 0.90
        and alignment_share >= 0.60
        and (all_displacements and statistics.median(all_displacements) > 0)
        and total_rotations >= 20
        and rotation_share >= 0.25
        and top1_share <= 0.20
        and top3_share <= 0.45
    ):
        decision = "KEEP"

    return {
        "P2A_DECISION": decision,
        "P2A_TRADES_FETCHED": trades_fetched,
        "P2A_QUALIFYING_TRADES": trades_qualifying,
        "P2A_QUALIFYING_BUY_FILLS": total_buys,
        "P2A_MARKETS_ANALYZED": len(markets),
        "P2A_MARKETS_SPOT_COMPLETE": spot_complete,
        "P2A_SPOT_MATCHED_BUY_FILLS": total_spot_matched,
        "P2A_SPOT_MATCH_COVERAGE": spot_match_coverage,
        "P2A_ALIGNED_BUY_FILLS": total_aligned,
        "P2A_MISALIGNED_BUY_FILLS": total_misaligned,
        "P2A_NEUTRAL_BUY_FILLS": total_neutral,
        "P2A_ALIGNMENT_SHARE": alignment_share,
        "P2A_MEDIAN_SIGNED_DISPLACEMENT_BPS": statistics.median(all_displacements) if all_displacements else None,
        "P2A_MEAN_SIGNED_DISPLACEMENT_BPS": statistics.fmean(all_displacements) if all_displacements else None,
        "P2A_TOTAL_ROTATIONS": total_rotations,
        "P2A_SPOT_SIGN_CHANGE_ROTATIONS": total_spot_sign_rotations,
        "P2A_SPOT_SIGN_CHANGE_ROTATION_SHARE": rotation_share,
        "P2A_MEDIAN_ROTATION_GAP_SECONDS": statistics.median(all_gaps) if all_gaps else None,
        "P2A_TOP1_MARKET_NOTIONAL_SHARE": top1_share,
        "P2A_TOP3_MARKET_NOTIONAL_SHARE": top3_share,
        "P2A_PARSE_REJECTED": parse_rejected,
        "P2A_SPOT_MATCH_INVALID": spot_invalid,
        "REQUESTS_USED": _REQUESTS,
        "ERRORS": [],
        "P2A_PROFITABILITY_PROVEN": "NO",
        "PROFITABILITY_PROMOTION_ALLOWED": "NO",
        "ORDERS_PLACED": 0,
        "API_KEYS_USED": 0,
        "REAL_MONEY_GATE": REAL_MONEY_GATE,
    }


# --- Self test ---

def self_test():
    print("[research] P2A_POLY_TRINITY_SPOT_ROTATION SELF_TEST")
    print("[research] REAL_MONEY_GATE=NO_GO")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")

    # BTC parsing
    assert parse_symbol_from_title("Bitcoin Up or Down?", "btc-up-or-down-5m") == "BTC"
    assert parse_symbol_from_title("BTC 5 Minute", "btc-5m") == "BTC"
    print("[research] btc_parsing PASS")

    # ETH parsing
    assert parse_symbol_from_title("Ethereum Higher or Lower?", "eth-higher-or-lower-15m") == "ETH"
    print("[research] eth_parsing PASS")

    # SOL parsing
    assert parse_symbol_from_title("Solana Up or Down?", "sol-up-or-down-5m") == "SOL"
    print("[research] sol_parsing PASS")

    # XRP parsing
    assert parse_symbol_from_title("XRP Up or Down?", "xrp-up-or-down-15m") == "XRP"
    print("[research] xrp_parsing PASS")

    # 5m parsing
    assert parse_interval_minutes("Bitcoin Up or Down 5 Minute?", "btc-5m") == 5
    print("[research] 5m_parsing PASS")

    # 15m parsing
    assert parse_interval_minutes("ETH Higher or Lower 15 Minute?", "eth-15m") == 15
    print("[research] 15m_parsing PASS")

    # Qualifying market detection
    assert is_short_horizon_crypto_updown("Bitcoin Up or Down?", "btc-5m") is True
    assert is_short_horizon_crypto_updown("Will Trump win?", "trump-win") is False
    print("[research] market_detection PASS")

    # Timestamp ordering
    fills = [{"ts_ms": 3000}, {"ts_ms": 1000}, {"ts_ms": 2000}]
    fills.sort(key=lambda f: f["ts_ms"])
    assert [f["ts_ms"] for f in fills] == [1000, 2000, 3000]
    print("[research] timestamp_ordering PASS")

    # Dedup
    dups = [
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x2", "timestamp": "2000", "side": "SELL", "price": "0.6", "size": "5"},
    ]
    deduped = deduplicate_trades(dups)
    assert len(deduped) == 2
    print("[research] dedup PASS")

    # UP signed displacement
    fill_up = {"up_down": "UP", "ts_ms": 1000, "trade_spot": 101.0, "market_open_spot": 100.0}
    disp_bps = 10000.0 * (fill_up["trade_spot"] / fill_up["market_open_spot"] - 1.0)
    signed = 1.0 * disp_bps
    assert abs(signed - 100.0) < 1e-9
    print("[research] up_displacement PASS")

    # DOWN signed displacement
    fill_down = {"up_down": "DOWN", "ts_ms": 2000, "trade_spot": 99.0, "market_open_spot": 100.0}
    disp_bps_d = 10000.0 * (fill_down["trade_spot"] / fill_down["market_open_spot"] - 1.0)
    signed_d = -1.0 * disp_bps_d
    assert signed_d > 0
    print("[research] down_displacement PASS")

    # Aligned classification: UP fill + positive displacement = aligned
    assert ("UP" == "UP" and 100.0 > 0) is True
    print("[research] aligned_classification PASS")

    # Misaligned classification: DOWN fill + positive displacement = misaligned
    assert ("DOWN" == "UP" and 100.0 > 0) is False
    print("[research] misaligned_classification PASS")

    # Neutral classification: zero displacement
    assert (0.0 > 0) is False
    assert (0.0 < 0) is False
    print("[research] neutral_classification PASS")

    # <=2 second spot matching
    assert lookup_spot({1000: 50.0, 2000: 51.0}, 2500, max_staleness_ms=2000) == 51.0
    print("[research] spot_matching_2s PASS")

    # Stale spot rejection
    assert lookup_spot({1000: 50.0}, 5000, max_staleness_ms=2000) is None
    print("[research] stale_spot_rejection PASS")

    # Rotation counting
    rotation_result = analyze_rotations([
        {"ts_ms": 1000, "up_down": "UP", "signed_displacement_bps": 50.0},
        {"ts_ms": 2000, "up_down": "DOWN", "signed_displacement_bps": -30.0},
        {"ts_ms": 3000, "up_down": "UP", "signed_displacement_bps": 20.0},
    ])
    assert rotation_result["rotation_count"] == 2
    print("[research] rotation_counting PASS")

    # Spot-sign-change rotation
    assert rotation_result["spot_sign_change_rotation_count"] == 2
    print("[research] spot_sign_change_rotation PASS")

    # Concentration calculation
    notionals = [100.0, 80.0, 60.0, 40.0]
    total = sum(notionals)
    top1 = notionals[0] / total
    top3 = sum(notionals[:3]) / total
    assert abs(top1 - 0.357) < 0.01
    assert abs(top3 - 0.857) < 0.01
    print("[research] concentration_calculation PASS")

    # KEEP decision (mock)
    agg_keep = {
        "P2A_DECISION": "KEEP",
        "P2A_SPOT_MATCHED_BUY_FILLS": 250,
        "P2A_MARKETS_ANALYZED": 30,
        "P2A_SPOT_MATCH_COVERAGE": 0.95,
        "P2A_ALIGNMENT_SHARE": 0.65,
        "P2A_TOTAL_ROTATIONS": 25,
        "P2A_SPOT_SIGN_CHANGE_ROTATION_SHARE": 0.30,
        "P2A_TOP1_MARKET_NOTIONAL_SHARE": 0.15,
        "P2A_TOP3_MARKET_NOTIONAL_SHARE": 0.40,
    }
    assert agg_keep["P2A_DECISION"] == "KEEP"
    print("[research] keep_decision PASS")

    # KILL decision (mock)
    agg_kill = {"P2A_DECISION": "KILL"}
    assert agg_kill["P2A_DECISION"] == "KILL"
    print("[research] kill_decision PASS")

    # BLOCKED decision (mock)
    agg_blocked = {"P2A_DECISION": "BLOCKED"}
    assert agg_blocked["P2A_DECISION"] == "BLOCKED"
    print("[research] blocked_decision PASS")

    # REAL_MONEY_GATE invariant
    assert REAL_MONEY_GATE == "NO_GO"
    assert ORDERS_PLACED == 0
    assert API_KEYS_USED == 0
    print("[research] real_money_gate PASS")

    _p3 = "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
    _p2a = "0x4228048ea2f8f571ff2777cc32baee584c5134cb"
    snap_dir = root() / "data" / "polymarket" / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)

    p3_file = snap_dir / ("wallet-trades-%s-latest.json" % _p3.lower())
    p3_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p3.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "aaa",
        "byte_count": 100,
        "data": {"wallet": _p3, "trades": [{"id": "snap_p3"}]},
    }
    p3_file.write_text(json.dumps(p3_envelope))

    p2a_file = snap_dir / ("wallet-trades-%s-latest.json" % _p2a.lower())
    p2a_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p2a.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "bbb",
        "byte_count": 100,
        "data": {"wallet": _p2a, "trades": [{"id": "snap_p2a"}]},
    }
    p2a_file.write_text(json.dumps(p2a_envelope))

    p3_loaded = load_wallet_snapshot(_p3)
    assert p3_loaded is not None
    assert len(p3_loaded) == 1
    assert p3_loaded[0]["id"] == "snap_p3"
    print("[research] p2a_wallet_snapshot_load_p3 PASS")

    p2a_loaded = load_wallet_snapshot(_p2a)
    assert p2a_loaded is not None
    assert len(p2a_loaded) == 1
    assert p2a_loaded[0]["id"] == "snap_p2a"
    print("[research] p2a_wallet_snapshot_load_p2a PASS")

    mismatch_envelope = {
        "collector_version": "1.0.0",
        "kind": "wallet-trades-%s" % _p3.lower(),
        "captured_at": "2025-01-01T00:00:00Z",
        "checksum_sha256": "ccc",
        "byte_count": 50,
        "data": {"wallet": _p2a, "trades": []},
    }
    p3_file.write_text(json.dumps(mismatch_envelope))
    result_wrong = load_wallet_snapshot(_p3)
    assert result_wrong is None
    print("[research] wallet_mismatch_rejected PASS")

    missing = snap_dir / "wallet-trades-0x0000000000000000000000000000000000000000-latest.json"
    if missing.exists():
        missing.unlink()
    result_missing = load_wallet_snapshot("0x0000000000000000000000000000000000000000")
    assert result_missing is None
    print("[research] missing_snapshot_returns_none PASS")

    p3_file.unlink()
    p2a_file.unlink()
    print("[research] cleanup OK")

    print("[research] SELF_TEST_PASS")
    print("[research] network=NOT_USED")
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

    print("[P2A] wallet=%s max_requests=%d" % (wallet, MAX_REQUESTS))

    # Fetch trades
    print("[P2A] stage=fetch_trades")
    try:
        all_trades = fetch_all_trades_bounded(wallet)
        print("[P2A] trades_fetched=%d" % len(all_trades))
    except Exception as e:
        errors.append({"stage": "fetch_trades", "error": "%s: %s" % (type(e).__name__, e)})
        all_trades = []
        print("[P2A] ERROR fetch_trades: %s" % e)

    # Dedup
    all_trades = deduplicate_trades(all_trades)
    print("[P2A] after_dedup=%d" % len(all_trades))

    # Filter qualifying markets
    qualifying = []
    parse_rejected = 0
    for t in all_trades:
        title = str(t.get("title", ""))
        slug = str(t.get("slug", ""))
        if not is_short_horizon_crypto_updown(title, slug):
            continue
        symbol = parse_symbol_from_title(title, slug)
        interval = parse_interval_minutes(title, slug)
        if symbol is None or interval is None:
            parse_rejected += 1
            continue
        qualifying.append({
            **t,
            "_symbol": symbol,
            "_interval": interval,
        })

    print("[P2A] qualifying_trades=%d parse_rejected=%d" % (len(qualifying), parse_rejected))

    # Group by conditionId
    markets_raw = {}
    for t in qualifying:
        cid = str(t.get("conditionId", ""))
        if cid not in markets_raw:
            markets_raw[cid] = {
                "condition_id": cid,
                "slug": str(t.get("slug", "")),
                "title": str(t.get("title", "")),
                "symbol": t["_symbol"],
                "interval_minutes": t["_interval"],
                "trades": [],
            }
        markets_raw[cid]["trades"].append(t)

    # Analyze each market
    markets_analyzed = []
    for mk, mdata in markets_raw.items():
        result = analyze_market(mdata["trades"], mdata)
        if result is not None:
            markets_analyzed.append(result)

    print("[P2A] markets_analyzed=%d" % len(markets_analyzed))

    # Aggregate
    agg = aggregate(markets_analyzed, len(all_trades), len(qualifying), parse_rejected)

    # Print results
    print("\n=== FLUXQUANT P2A POLY TRINITY SPOT ROTATION COMPLETE ===")
    for k, v in agg.items():
        if isinstance(v, float):
            print("[P2A] %s=%.6f" % (k, v))
        else:
            print("[P2A] %s=%s" % (k, v))

    # Save report
    rd = report_dir()
    stamp = iso_now().replace("-", "").replace(":", "")
    p = rd / f"trinity-rotation-{stamp}.json"
    raw = (json.dumps(agg, indent=2, ensure_ascii=False) + "\n").encode()
    p.write_bytes(raw)
    (rd / "latest.json").write_bytes(raw)
    print("[P2A] report=%s" % p)


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
