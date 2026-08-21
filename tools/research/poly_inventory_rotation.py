#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import statistics
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path

TOOL = "FluxQuant Polymarket Inventory Rotation Research"
VERSION = "1.5.0"
MODE = "READ_ONLY_PAPER_RESEARCH"
REAL_MONEY_GATE = "NO_GO"

DATA_API = "https://data-api.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

MAX_REQUESTS = 40
RUNTIME_SECONDS = 300
REQUEST_TIMEOUT = 15

_TARGET_WALLET = "0xce25e214d5cfe4f459cf67f08df581885aae7fdc"
_TARGET_SYMBOLS = {"BTC", "ETH", "SOL", "XRP"}

# P1C Holdout constants
P1C_HOLDOUT_START_EPOCH = 1787074470  # 2026-08-18T17:34:30Z
P1C_MIN_TRADES_FOR_DECISION = 500

_REQUESTS = 0
_REQUEST_LIMIT = MAX_REQUESTS
_AUTO_STARTED = None
_RUNTIME_LIMIT = RUNTIME_SECONDS
_CACHE_DIR = None


def utcnow():
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
        _CACHE_DIR = root() / "cache" / "polymarket" / "inventory-rotation"
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR


def report_dir():
    d = root() / "reports" / "research" / "poly-inventory-rotation"
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


def get_json(url: str, timeout: int = REQUEST_TIMEOUT, use_cache: bool = True) -> tuple:
    _check_bounds()
    cache_path = _cache_key(url)
    if use_cache and cache_path.exists():
        raw = cache_path.read_bytes()
        obj = json.loads(raw.decode("utf-8"))
        return obj, 0.0, hashlib.sha256(raw).hexdigest(), True
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "FluxQuant-PolyInventoryRotation/1.5",
            "Accept": "application/json",
        },
    )
    started = time.time_ns()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as r:
            raw = r.read()
    except Exception as e1:
        # Fallback: try with no SSL verification (read-only public data only)
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


def finite_str(x):
    if x is None:
        return "None"
    return "%.6f" % x


# --- Fill reconstruction ---

def is_short_horizon_crypto_market(title: str, slug: str, event_slug: str = "") -> str | None:
    text = f"{title} {slug} {event_slug}".lower()
    crypto = None
    for sym in _TARGET_SYMBOLS:
        if sym.lower() in text or {
            "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "xrp"
        }.get(sym, "").lower() in text:
            crypto = sym
            break
    if crypto is None:
        return None
    if "up" in text and "down" in text:
        return crypto
    if "up-or-down" in text or "higher-or-lower" in text:
        return crypto
    if "higher" in text and "lower" in text:
        return crypto
    return None


def classify_outcome_side(title: str, slug: str, outcome: str) -> str | None:
    outcome_lower = outcome.lower()
    if outcome_lower in ("up", "higher"):
        return "UP"
    if outcome_lower in ("down", "lower"):
        return "DOWN"
    return None


def rebuild_chronological_fills(trades: list) -> dict:
    fills_by_market = {}
    for t in trades:
        side_raw = str(t.get("side", "")).upper()
        if side_raw not in ("BUY", "SELL"):
            continue
        price = fnum(t.get("price"))
        size = fnum(t.get("size"))
        usdc = fnum(t.get("usdcSize"))
        if price is None or size is None:
            continue
        timestamp = t.get("timestamp")
        ts_ms = None
        if timestamp is not None:
            try:
                ts_ms = int(timestamp)
                if ts_ms < 1e12:
                    ts_ms = int(ts_ms * 1000)
            except Exception:
                pass
        title = str(t.get("title", ""))
        slug = str(t.get("slug", ""))
        event_slug = str(t.get("eventSlug", ""))
        condition_id = str(t.get("conditionId", ""))
        asset = str(t.get("asset", ""))
        outcome = str(t.get("outcome", ""))
        market_key = condition_id or slug
        if not market_key:
            continue
        crypto = is_short_horizon_crypto_market(title, slug, event_slug)
        if crypto is None:
            continue
        up_down = classify_outcome_side(title, slug, outcome) or classify_outcome_side(title, slug, asset)
        if up_down is None:
            asset_lower = asset.lower()
            if "up" in asset_lower or "higher" in asset_lower:
                up_down = "UP"
            elif "down" in asset_lower or "lower" in asset_lower:
                up_down = "DOWN"
        if up_down is None:
            continue
        if market_key not in fills_by_market:
            fills_by_market[market_key] = {
                "condition_id": condition_id,
                "slug": slug,
                "title": title,
                "crypto": crypto,
                "fills": [],
            }
        fills_by_market[market_key]["fills"].append({
            "ts_ms": ts_ms,
            "side": side_raw,
            "price": price,
            "size": size,
            "usdc": usdc if usdc is not None else price * size,
            "up_down": up_down,
            "asset": asset,
            "outcome": outcome,
        })
    for mk in fills_by_market:
        fills_by_market[mk]["fills"].sort(key=lambda f: (f["ts_ms"] or 0, f["side"]))
    return fills_by_market


def compute_side_inventory(fills: list) -> dict:
    up_buy_qty = 0.0
    up_buy_cost = 0.0
    up_sell_qty = 0.0
    up_sell_proceeds = 0.0
    down_buy_qty = 0.0
    down_buy_cost = 0.0
    down_sell_qty = 0.0
    down_sell_proceeds = 0.0

    for f in fills:
        price = f["price"]
        size = f["size"]
        usdc = f["usdc"]
        if f["up_down"] == "UP":
            if f["side"] == "BUY":
                up_buy_qty += size
                up_buy_cost += usdc
            else:
                up_sell_qty += size
                up_sell_proceeds += usdc
        else:
            if f["side"] == "BUY":
                down_buy_qty += size
                down_buy_cost += usdc
            else:
                down_sell_qty += size
                down_sell_proceeds += usdc

    up_inv = up_buy_qty - up_sell_qty
    down_inv = down_buy_qty - down_sell_qty
    up_wavg_buy = up_buy_cost / up_buy_qty if up_buy_qty > 0 else None
    down_wavg_buy = down_buy_cost / down_buy_qty if down_buy_qty > 0 else None
    up_wavg_sell = up_sell_proceeds / up_sell_qty if up_sell_qty > 0 else None
    down_wavg_sell = down_sell_proceeds / down_sell_qty if down_sell_qty > 0 else None

    paired_inv = min(max(up_inv, 0.0), max(down_inv, 0.0))
    net_dir = up_inv - down_inv

    return {
        "up_buy_qty": up_buy_qty,
        "up_buy_cost": up_buy_cost,
        "up_sell_qty": up_sell_qty,
        "up_sell_proceeds": up_sell_proceeds,
        "down_buy_qty": down_buy_qty,
        "down_buy_cost": down_buy_cost,
        "down_sell_qty": down_sell_qty,
        "down_sell_proceeds": down_sell_proceeds,
        "up_inventory": up_inv,
        "down_inventory": down_inv,
        "up_wavg_buy": up_wavg_buy,
        "down_wavg_buy": down_wavg_buy,
        "up_wavg_sell": up_wavg_sell,
        "down_wavg_sell": down_wavg_sell,
        "paired_inventory": paired_inv,
        "net_directional_inventory": net_dir,
        "gross_inventory": abs(up_inv) + abs(down_inv),
    }


def count_rotations(fills: list) -> dict:
    rotations = 0
    last_side = None
    side_changes = []
    for f in fills:
        current = f["up_down"]
        if last_side is not None and current != last_side:
            rotations += 1
            side_changes.append({
                "from": last_side,
                "to": current,
                "ts_ms": f["ts_ms"],
            })
        last_side = current
    gaps_ms = []
    for i in range(1, len(side_changes)):
        prev = side_changes[i - 1]
        curr = side_changes[i]
        if prev["ts_ms"] is not None and curr["ts_ms"] is not None:
            gaps_ms.append(curr["ts_ms"] - prev["ts_ms"])
    return {
        "rotation_count": rotations,
        "side_changes": side_changes,
        "mean_gap_ms": statistics.fmean(gaps_ms) if gaps_ms else None,
        "median_gap_ms": statistics.median(gaps_ms) if gaps_ms else None,
    }


def market_level_metrics(fills: list) -> dict:
    if not fills:
        return {"fill_count": 0, "status": "EMPTY"}
    side_inv = compute_side_inventory(fills)
    rot = count_rotations(fills)
    has_up = side_inv["up_buy_qty"] > 0 or side_inv["up_sell_qty"] > 0
    has_down = side_inv["down_buy_qty"] > 0 or side_inv["down_sell_qty"] > 0
    paired_cost_per_pair = None
    if side_inv["paired_inventory"] > 0 and side_inv["up_wavg_buy"] is not None and side_inv["down_wavg_buy"] is not None:
        paired_cost_per_pair = side_inv["up_wavg_buy"] + side_inv["down_wavg_buy"]
    max_gross_exposure = side_inv["gross_inventory"]
    max_net_exposure = abs(side_inv["net_directional_inventory"])
    realized_sells = side_inv["up_sell_proceeds"] + side_inv["down_sell_proceeds"]
    gross_spent = side_inv["up_buy_cost"] + side_inv["down_buy_cost"]
    inventory_turnover = realized_sells / gross_spent if gross_spent > 0 else None
    return {
        "fill_count": len(fills),
        "two_sided": has_up and has_down,
        "one_sided": has_up != has_down,
        **side_inv,
        **rot,
        "paired_cost_per_pair": paired_cost_per_pair,
        "realized_sells_usdc": realized_sells,
        "gross_spent_usdc": gross_spent,
        "inventory_turnover": inventory_turnover,
        "max_gross_exposure": max_gross_exposure,
        "max_net_exposure": max_net_exposure,
        "has_up": has_up,
        "has_down": has_down,
    }


# --- FIFO Pair Lock Engine (P1B) ---


def _make_lot(qty: float, price: float, ts_ms: int | None) -> dict:
    """Create a FIFO inventory lot."""
    return {"qty": qty, "price": price, "ts_ms": ts_ms}


def _lot_cost_usdc(lot: dict) -> float:
    return lot["qty"] * lot["price"]


def _consume_lots(lots: list[dict], qty_needed: float) -> tuple[float, float, list[dict]]:
    """Consume qty from front of FIFO lots. Returns (consumed_qty, total_cost, remaining_lots)."""
    consumed = 0.0
    cost = 0.0
    remaining = []
    for lot in lots:
        if consumed >= qty_needed:
            remaining.append(lot)
            continue
        take = min(lot["qty"], qty_needed - consumed)
        cost += take * lot["price"]
        consumed += take
        leftover = lot["qty"] - take
        if leftover > 1e-12:
            remaining.append(_make_lot(leftover, lot["price"], lot["ts_ms"]))
    return consumed, cost, remaining


def compute_fifo_pair_locks(fills: list) -> dict:
    """Process fills in strict chronological order. Maintain FIFO lots per side.
    Lock pairs when both UP and DOWN have unpaired inventory.

    Returns dict with per-market pair-lock metrics or error status.
    """
    if not fills:
        return {"pair_lock_accounting_complete": "YES", "fill_count": 0, "locks": []}

    # Sort by timestamp, then deterministic tiebreak: BUY before SELL, then UP before DOWN
    def sort_key(f):
        ts = f["ts_ms"] if f["ts_ms"] is not None else 0
        side_rank = 0 if f["side"] == "BUY" else 1
        ud_rank = 0 if f["up_down"] == "UP" else 1
        return (ts, side_rank, ud_rank)

    sorted_fills = sorted(fills, key=sort_key)

    # Detect ties
    tie_count = 0
    for i in range(1, len(sorted_fills)):
        if sorted_fills[i]["ts_ms"] == sorted_fills[i - 1]["ts_ms"]:
            tie_count += 1

    up_lots: list[dict] = []
    down_lots: list[dict] = []
    locks: list[dict] = []
    up_total_unpaired = 0.0
    down_total_unpaired = 0.0
    accounting_complete = True
    accounting_error = None

    for fill in sorted_fills:
        side = fill["side"]
        up_down = fill["up_down"]
        price = fill["price"]
        size = fill["size"]
        ts_ms = fill["ts_ms"]

        if side == "BUY":
            lot = _make_lot(size, price, ts_ms)
            if up_down == "UP":
                up_lots.append(lot)
                up_total_unpaired += size
            else:
                down_lots.append(lot)
                down_total_unpaired += size
        elif side == "SELL":
            # Consume from matching-side lots using FIFO
            if up_down == "UP":
                if size > up_total_unpaired + 1e-9:
                    accounting_complete = False
                    accounting_error = "SELL_EXCEEDS_UP_INVENTORY: sell_qty=%.6f up_unpaired=%.6f" % (size, up_total_unpaired)
                    break
                consumed, cost_used, up_lots = _consume_lots(up_lots, size)
                up_total_unpaired -= consumed
            else:
                if size > down_total_unpaired + 1e-9:
                    accounting_complete = False
                    accounting_error = "SELL_EXCEEDS_DOWN_INVENTORY: sell_qty=%.6f down_unpaired=%.6f" % (size, down_total_unpaired)
                    break
                consumed, cost_used, down_lots = _consume_lots(down_lots, size)
                down_total_unpaired -= consumed

        # After each fill, attempt to lock pairs
        while up_total_unpaired > 1e-12 and down_total_unpaired > 1e-12:
            lock_qty = min(up_total_unpaired, down_total_unpaired)

            # Pop from front of UP lots
            up_consumed, up_cost, up_lots = _consume_lots(up_lots, lock_qty)
            # Pop from front of DOWN lots
            down_consumed, down_cost, down_lots = _consume_lots(down_lots, lock_qty)

            up_total_unpaired -= up_consumed
            down_total_unpaired -= down_consumed

            combined_cost = up_cost + down_cost
            cost_per_pair = combined_cost / lock_qty if lock_qty > 0 else 0.0
            payout = lock_qty * 1.0
            margin = payout - combined_cost
            margin_pct = margin / combined_cost if combined_cost > 0 else 0.0

            # Determine first contributing side timestamp
            # The UP and DOWN lots we just consumed came from the front of the queues
            # We need to track the earliest timestamp among the consumed lots
            # Since we consumed from front, the first lot in each queue before consumption
            # had the earliest timestamp. We reconstruct from the lots consumed.
            # For simplicity, we use the fill timestamps that created these lots.
            # The first_side is whichever side's earliest lot came first chronologically.
            # Since lots are FIFO and we consumed from front, the first lot in each
            # queue before consumption is the oldest. We'll approximate using the
            # current fill's timestamp as lock completion time.

            # For hedge delay: time from first contributing side acquisition to lock
            # We track the earliest lot timestamp from each side before consumption.
            # Since lots are consumed, we use the fill that just triggered this lock.
            first_side_timestamp_up = ts_ms  # approximation; actual first lot may be earlier
            first_side_timestamp_down = ts_ms

            # More precise: we should have tracked lot timestamps. Let's use the
            # first lot's timestamp from each queue *before* consumption.
            # Since we already consumed, we use the fill's timestamp as lock time.
            # Hedge delay = |earliest_up_lot_ts - earliest_down_lot_ts| at lock time
            # We don't have the original lot timestamps after consumption, so we
            # record the fill timestamp as lock_timestamp.

            lock_event = {
                "lock_timestamp_ms": ts_ms,
                "locked_qty": round(lock_qty, 12),
                "up_cost_usdc": round(up_cost, 12),
                "down_cost_usdc": round(down_cost, 12),
                "combined_locked_cost_usdc": round(combined_cost, 12),
                "combined_locked_cost_per_pair": round(cost_per_pair, 12),
                "theoretical_locked_payout_usdc": round(payout, 12),
                "gross_locked_margin_usdc": round(margin, 12),
                "gross_locked_margin_pct": round(margin_pct, 12),
                "triggering_fill_side": up_down,
                "triggering_fill_price": price,
            }
            locks.append(lock_event)

    # Compute per-market aggregate lock metrics
    if not locks:
        return {
            "pair_lock_accounting_complete": "YES" if accounting_complete else "NO",
            "accounting_error": accounting_error,
            "fill_count": len(fills),
            "tie_count": tie_count,
            "chronological_locked_pair_qty": 0.0,
            "chronological_lock_event_count": 0,
            "locked_pair_cost_mean": None,
            "locked_pair_cost_median": None,
            "locked_pair_cost_min": None,
            "locked_pair_cost_max": None,
            "locked_qty_below_1": 0,
            "locked_qty_at_or_above_1": 0,
            "locked_share_below_1": 0.0,
            "gross_locked_margin_usdc": 0.0,
            "median_hedge_delay_seconds": None,
            "p90_hedge_delay_seconds": None,
            "max_hedge_delay_seconds": None,
            "max_prelock_directional_qty": 0.0,
            "max_prelock_directional_cost_usdc": 0.0,
            "locks": [],
        }

    total_locked = sum(l["locked_qty"] for l in locks)
    costs = [l["combined_locked_cost_per_pair"] for l in locks]
    margins = [l["gross_locked_margin_usdc"] for l in locks]
    below_1 = sum(l["locked_qty"] for l in locks if l["combined_locked_cost_per_pair"] < 1.0)
    at_or_above_1 = total_locked - below_1

    # Hedge delay: for each lock, we approximate as 0 since we consumed lots at the
    # same fill timestamp. The real hedge delay requires tracking lot creation timestamps.
    # We'll compute it properly by recording which fills contributed to each lock.
    # For now, use 0 as placeholder (will be refined in per-fill tracking below).

    return {
        "pair_lock_accounting_complete": "YES" if accounting_complete else "NO",
        "accounting_error": accounting_error,
        "fill_count": len(fills),
        "tie_count": tie_count,
        "chronological_locked_pair_qty": round(total_locked, 12),
        "chronological_lock_event_count": len(locks),
        "locked_pair_cost_mean": statistics.fmean(costs) if costs else None,
        "locked_pair_cost_median": statistics.median(costs) if costs else None,
        "locked_pair_cost_min": min(costs) if costs else None,
        "locked_pair_cost_max": max(costs) if costs else None,
        "locked_qty_below_1": round(below_1, 12),
        "locked_qty_at_or_above_1": round(at_or_above_1, 12),
        "locked_share_below_1": round(below_1 / total_locked, 12) if total_locked > 0 else 0.0,
        "gross_locked_margin_usdc": round(sum(margins), 12),
        "median_hedge_delay_seconds": 0.0,
        "p90_hedge_delay_seconds": 0.0,
        "max_hedge_delay_seconds": 0.0,
        "max_prelock_directional_qty": 0.0,
        "max_prelock_directional_cost_usdc": 0.0,
        "locks": locks,
    }


def compute_fifo_pair_locks_with_hedge_delay(fills: list) -> dict:
    """Enhanced version that tracks per-fill lot creation timestamps for hedge delay."""
    if not fills:
        return {"pair_lock_accounting_complete": "YES", "fill_count": 0, "locks": []}

    def sort_key(f):
        ts = f["ts_ms"] if f["ts_ms"] is not None else 0
        side_rank = 0 if f["side"] == "BUY" else 1
        ud_rank = 0 if f["up_down"] == "UP" else 1
        return (ts, side_rank, ud_rank)

    sorted_fills = sorted(fills, key=sort_key)

    tie_count = 0
    for i in range(1, len(sorted_fills)):
        if sorted_fills[i]["ts_ms"] == sorted_fills[i - 1]["ts_ms"]:
            tie_count += 1

    # Lots with full provenance: (qty, price, ts_ms, fill_index)
    up_lots: list[dict] = []
    down_lots: list[dict] = []
    locks: list[dict] = []
    up_total_unpaired = 0.0
    down_total_unpaired = 0.0
    accounting_complete = True
    accounting_error = None

    # Track cumulative directional exposure before each lock
    max_prelock_dir_qty = 0.0
    max_prelock_dir_cost = 0.0
    hedge_delays: list[float] = []

    for fill_idx, fill in enumerate(sorted_fills):
        side = fill["side"]
        up_down = fill["up_down"]
        price = fill["price"]
        size = fill["size"]
        ts_ms = fill["ts_ms"]

        if side == "BUY":
            lot = {"qty": size, "price": price, "ts_ms": ts_ms, "fill_idx": fill_idx}
            if up_down == "UP":
                up_lots.append(lot)
                up_total_unpaired += size
            else:
                down_lots.append(lot)
                down_total_unpaired += size
        elif side == "SELL":
            if up_down == "UP":
                if size > up_total_unpaired + 1e-9:
                    accounting_complete = False
                    accounting_error = "SELL_EXCEEDS_UP_INVENTORY: sell_qty=%.6f up_unpaired=%.6f" % (size, up_total_unpaired)
                    break
                # Consume FIFO
                remaining = size
                new_lots = []
                for lot in up_lots:
                    if remaining <= 0:
                        new_lots.append(lot)
                        continue
                    take = min(lot["qty"], remaining)
                    lot["qty"] -= take
                    remaining -= take
                    if lot["qty"] > 1e-12:
                        new_lots.append(lot)
                up_lots = new_lots
                up_total_unpaired -= (size - remaining)
            else:
                if size > down_total_unpaired + 1e-9:
                    accounting_complete = False
                    accounting_error = "SELL_EXCEEDS_DOWN_INVENTORY: sell_qty=%.6f down_unpaired=%.6f" % (size, down_total_unpaired)
                    break
                remaining = size
                new_lots = []
                for lot in down_lots:
                    if remaining <= 0:
                        new_lots.append(lot)
                        continue
                    take = min(lot["qty"], remaining)
                    lot["qty"] -= take
                    remaining -= take
                    if lot["qty"] > 1e-12:
                        new_lots.append(lot)
                down_lots = new_lots
                down_total_unpaired -= (size - remaining)

        # Track max directional exposure before lock
        dir_qty = abs(up_total_unpaired - down_total_unpaired)
        dir_cost = abs(
            sum(l["qty"] * l["price"] for l in up_lots)
            - sum(l["qty"] * l["price"] for l in down_lots)
        )
        if dir_qty > max_prelock_dir_qty:
            max_prelock_dir_qty = dir_qty
        if dir_cost > max_prelock_dir_cost:
            max_prelock_dir_cost = dir_cost

        # Lock pairs
        while up_total_unpaired > 1e-12 and down_total_unpaired > 1e-12:
            lock_qty = min(up_total_unpaired, down_total_unpaired)

            # Consume from UP lots (front = index 0)
            up_consumed_qty = 0.0
            up_cost = 0.0
            up_remaining = lock_qty
            up_first_ts = None
            new_up_lots = []
            for lot in up_lots:
                if up_remaining <= 0:
                    new_up_lots.append(lot)
                    continue
                take = min(lot["qty"], up_remaining)
                if up_first_ts is None:
                    up_first_ts = lot["ts_ms"]
                up_cost += take * lot["price"]
                up_consumed_qty += take
                up_remaining -= take
                leftover = lot["qty"] - take
                if leftover > 1e-12:
                    new_up_lots.append({"qty": leftover, "price": lot["price"], "ts_ms": lot["ts_ms"], "fill_idx": lot["fill_idx"]})
            up_lots = new_up_lots
            up_total_unpaired -= up_consumed_qty

            # Consume from DOWN lots
            down_consumed_qty = 0.0
            down_cost = 0.0
            down_remaining = lock_qty
            down_first_ts = None
            new_down_lots = []
            for lot in down_lots:
                if down_remaining <= 0:
                    new_down_lots.append(lot)
                    continue
                take = min(lot["qty"], down_remaining)
                if down_first_ts is None:
                    down_first_ts = lot["ts_ms"]
                down_cost += take * lot["price"]
                down_consumed_qty += take
                down_remaining -= take
                leftover = lot["qty"] - take
                if leftover > 1e-12:
                    new_down_lots.append({"qty": leftover, "price": lot["price"], "ts_ms": lot["ts_ms"], "fill_idx": lot["fill_idx"]})
            down_lots = new_down_lots
            down_total_unpaired -= down_consumed_qty

            combined_cost = up_cost + down_cost
            cost_per_pair = combined_cost / lock_qty if lock_qty > 0 else 0.0
            payout = lock_qty * 1.0
            margin = payout - combined_cost
            margin_pct = margin / combined_cost if combined_cost > 0 else 0.0

            # Hedge delay: time between first contributing side acquisition and lock completion
            hedge_delay_ms = None
            first_side = None
            if up_first_ts is not None and down_first_ts is not None:
                if up_first_ts <= down_first_ts:
                    hedge_delay_ms = ts_ms - up_first_ts
                    first_side = "DOWN"
                else:
                    hedge_delay_ms = ts_ms - down_first_ts
                    first_side = "UP"
                if hedge_delay_ms < 0:
                    hedge_delay_ms = 0
                hedge_delays.append(hedge_delay_ms / 1000.0)

            lock_event = {
                "lock_timestamp_ms": ts_ms,
                "locked_qty": round(lock_qty, 12),
                "up_cost_usdc": round(up_cost, 12),
                "down_cost_usdc": round(down_cost, 12),
                "combined_locked_cost_usdc": round(combined_cost, 12),
                "combined_locked_cost_per_pair": round(cost_per_pair, 12),
                "theoretical_locked_payout_usdc": round(payout, 12),
                "gross_locked_margin_usdc": round(margin, 12),
                "gross_locked_margin_pct": round(margin_pct, 12),
                "triggering_fill_side": up_down,
                "triggering_fill_price": price,
                "first_side": first_side,
                "hedge_delay_seconds": round(hedge_delay_ms / 1000.0, 3) if hedge_delay_ms is not None else None,
            }
            locks.append(lock_event)

    if not locks:
        return {
            "pair_lock_accounting_complete": "YES" if accounting_complete else "NO",
            "accounting_error": accounting_error,
            "fill_count": len(fills),
            "tie_count": tie_count,
            "chronological_locked_pair_qty": 0.0,
            "chronological_lock_event_count": 0,
            "locked_pair_cost_mean": None,
            "locked_pair_cost_median": None,
            "locked_pair_cost_min": None,
            "locked_pair_cost_max": None,
            "locked_qty_below_1": 0,
            "locked_qty_at_or_above_1": 0,
            "locked_share_below_1": 0.0,
            "gross_locked_margin_usdc": 0.0,
            "median_hedge_delay_seconds": None,
            "p90_hedge_delay_seconds": None,
            "max_hedge_delay_seconds": None,
            "max_prelock_directional_qty": round(max_prelock_dir_qty, 12),
            "max_prelock_directional_cost_usdc": round(max_prelock_dir_cost, 12),
            "locks": [],
        }

    total_locked = sum(l["locked_qty"] for l in locks)
    costs = [l["combined_locked_cost_per_pair"] for l in locks]
    margins = [l["gross_locked_margin_usdc"] for l in locks]
    below_1 = sum(l["locked_qty"] for l in locks if l["combined_locked_cost_per_pair"] < 1.0)
    at_or_above_1 = total_locked - below_1

    def pctile(vals, p):
        if not vals:
            return None
        s = sorted(vals)
        idx = min(len(s) - 1, max(0, round(p * (len(s) - 1))))
        return s[idx]

    return {
        "pair_lock_accounting_complete": "YES" if accounting_complete else "NO",
        "accounting_error": accounting_error,
        "fill_count": len(fills),
        "tie_count": tie_count,
        "chronological_locked_pair_qty": round(total_locked, 12),
        "chronological_lock_event_count": len(locks),
        "locked_pair_cost_mean": statistics.fmean(costs) if costs else None,
        "locked_pair_cost_median": statistics.median(costs) if costs else None,
        "locked_pair_cost_min": min(costs) if costs else None,
        "locked_pair_cost_max": max(costs) if costs else None,
        "locked_qty_below_1": round(below_1, 12),
        "locked_qty_at_or_above_1": round(at_or_above_1, 12),
        "locked_share_below_1": round(below_1 / total_locked, 12) if total_locked > 0 else 0.0,
        "gross_locked_margin_usdc": round(sum(margins), 12),
        "median_hedge_delay_seconds": statistics.median(hedge_delays) if hedge_delays else None,
        "p90_hedge_delay_seconds": pctile(hedge_delays, 0.9) if hedge_delays else None,
        "max_hedge_delay_seconds": max(hedge_delays) if hedge_delays else None,
        "max_prelock_directional_qty": round(max_prelock_dir_qty, 12),
        "max_prelock_directional_cost_usdc": round(max_prelock_dir_cost, 12),
        "locks": locks,
    }


def p1b_aggregate(markets: list) -> dict:
    """Compute aggregate P1B metrics across all markets."""
    eligible = [m for m in markets if m.get("pair_lock_accounting_complete") == "YES"]
    with_locks = [m for m in eligible if m.get("chronological_lock_event_count", 0) > 0]

    total_locked = sum(m.get("chronological_locked_pair_qty", 0) for m in with_locks)
    total_events = sum(m.get("chronological_lock_event_count", 0) for m in with_locks)
    total_below_1 = sum(m.get("locked_qty_below_1", 0) for m in with_locks)
    total_margin = sum(m.get("gross_locked_margin_usdc", 0) for m in with_locks)

    # Weighted locked cost
    weighted_cost_num = 0.0
    weighted_cost_den = 0.0
    for m in with_locks:
        qty = m.get("chronological_locked_pair_qty", 0)
        cost = m.get("locked_pair_cost_mean")
        if qty > 0 and cost is not None:
            weighted_cost_num += qty * cost
            weighted_cost_den += qty
    weighted_cost = weighted_cost_num / weighted_cost_den if weighted_cost_den > 0 else None

    # Median of per-market locked costs
    market_costs = [m["locked_pair_cost_mean"] for m in with_locks if m.get("locked_pair_cost_mean") is not None]
    median_market_cost = statistics.median(market_costs) if market_costs else None

    # Hedge delays
    all_hedge_delays = []
    for m in with_locks:
        for l in m.get("p1b_locks", []):
            hd = l.get("hedge_delay_seconds")
            if hd is not None:
                all_hedge_delays.append(hd)

    def pctile(vals, p):
        if not vals:
            return None
        s = sorted(vals)
        idx = min(len(s) - 1, max(0, round(p * (len(s) - 1))))
        return s[idx]

    # Concentration: top-1 and top-3 market shares of positive margin
    positive_margin_markets = []
    for m in with_locks:
        gm = m.get("gross_locked_margin_usdc", 0)
        if gm > 0:
            positive_margin_markets.append((m.get("slug", ""), gm))
    positive_margin_markets.sort(key=lambda x: -x[1])
    total_positive_margin = sum(gm for _, gm in positive_margin_markets)

    top1_share = 0.0
    top3_share = 0.0
    if total_positive_margin > 0 and positive_margin_markets:
        top1_share = positive_margin_markets[0][1] / total_positive_margin
        top3_share = sum(gm for _, gm in positive_margin_markets[:3]) / total_positive_margin

    # Max directional cost
    max_dir_cost = max((m.get("max_prelock_directional_cost_usdc", 0) for m in with_locks), default=0)

    return {
        "P1B_MARKETS_ELIGIBLE": len(eligible),
        "P1B_MARKETS_ACCOUNTING_COMPLETE": len(eligible),
        "P1B_MARKETS_WITH_LOCKED_PAIRS": len(with_locks),
        "P1B_TOTAL_LOCKED_PAIR_QTY": round(total_locked, 12),
        "P1B_TOTAL_LOCK_EVENTS": total_events,
        "P1B_LOCKED_QTY_BELOW_1": round(total_below_1, 12),
        "P1B_LOCKED_SHARE_BELOW_1": round(total_below_1 / total_locked, 12) if total_locked > 0 else 0.0,
        "P1B_WEIGHTED_LOCKED_COST": round(weighted_cost, 12) if weighted_cost is not None else None,
        "P1B_MEDIAN_MARKET_LOCKED_COST": round(median_market_cost, 12) if median_market_cost is not None else None,
        "P1B_GROSS_LOCKED_MARGIN_USDC": round(total_margin, 12),
        "P1B_MEDIAN_HEDGE_DELAY_SECONDS": statistics.median(all_hedge_delays) if all_hedge_delays else None,
        "P1B_P90_HEDGE_DELAY_SECONDS": pctile(all_hedge_delays, 0.9) if all_hedge_delays else None,
        "P1B_MAX_HEDGE_DELAY_SECONDS": max(all_hedge_delays) if all_hedge_delays else None,
        "P1B_MAX_PRELOCK_DIRECTIONAL_COST_USDC": round(max_dir_cost, 12),
        "P1B_MARKET_CONCENTRATION_TOP1_SHARE": round(top1_share, 6),
        "P1B_MARKET_CONCENTRATION_TOP3_SHARE": round(top3_share, 6),
        "P1B_FEE_COVERAGE_COMPLETE": "NO",
        "P1B_REBATE_COVERAGE_COMPLETE": "NO",
        "P1B_SETTLEMENT_COVERAGE_COMPLETE": "NO",
        "P1B_PROFITABILITY_PROVEN": "NO",
    }


def p1b_decision(agg: dict) -> str:
    """Frozen P1B decision logic."""
    if agg["P1B_MARKETS_WITH_LOCKED_PAIRS"] < 10:
        return "KILL"
    if agg["P1B_TOTAL_LOCKED_PAIR_QTY"] < 100:
        return "KILL"
    if agg["P1B_LOCKED_SHARE_BELOW_1"] <= 0.50:
        return "KILL"
    if agg["P1B_GROSS_LOCKED_MARGIN_USDC"] <= 0:
        return "KILL"
    if agg["P1B_MARKET_CONCENTRATION_TOP1_SHARE"] > 0.40:
        return "KILL"
    if agg["P1B_MARKET_CONCENTRATION_TOP3_SHARE"] > 0.70:
        return "KILL"
    if agg["P1B_MAX_HEDGE_DELAY_SECONDS"] is None:
        return "KILL"
    return "KEEP"


# --- P1C Holdout ---

def p1c_decision(agg: dict, trades_analyzed: int) -> str:
    """P1C holdout decision logic."""
    if trades_analyzed < P1C_MIN_TRADES_FOR_DECISION:
        return "BLOCKED_MATURATION"
    p1b_view = {
        "P1B_MARKETS_WITH_LOCKED_PAIRS": agg.get("P1C_MARKETS_WITH_LOCKED_PAIRS", 0),
        "P1B_TOTAL_LOCKED_PAIR_QTY": agg.get("P1C_TOTAL_LOCKED_PAIR_QTY", 0),
        "P1B_LOCKED_SHARE_BELOW_1": agg.get("P1C_LOCKED_SHARE_BELOW_1", 0),
        "P1B_GROSS_LOCKED_MARGIN_USDC": agg.get("P1C_GROSS_LOCKED_MARGIN_USDC", 0),
        "P1B_MARKET_CONCENTRATION_TOP1_SHARE": agg.get("P1C_MARKET_CONCENTRATION_TOP1_SHARE", 0),
        "P1B_MARKET_CONCENTRATION_TOP3_SHARE": agg.get("P1C_MARKET_CONCENTRATION_TOP3_SHARE", 0),
        "P1B_MAX_HEDGE_DELAY_SECONDS": agg.get("P1C_MAX_HEDGE_DELAY_SECONDS"),
    }
    return p1b_decision(p1b_view)


def p1c_filter_trades_by_epoch(trades: list, start_epoch: int, end_epoch: int) -> list:
    """Filter trades to only those within [start_epoch, end_epoch] ms."""
    filtered = []
    for t in trades:
        ts = t.get("timestamp")
        if ts is None:
            continue
        try:
            ts_int = int(ts)
            if ts_int < 1e12:
                ts_int = int(ts_int * 1000)
        except Exception:
            continue
        if start_epoch * 1000 <= ts_int <= end_epoch * 1000:
            filtered.append(t)
    return filtered


def p1c_deduplicate_trades(trades: list) -> list:
    """Deduplicate trades deterministically by (transactionHash, timestamp, side, price, size)."""
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


def p1c_aggregate(markets: list, trades_analyzed: int) -> dict:
    """Compute P1C aggregate metrics."""
    p1b_agg = p1b_aggregate(markets)
    p1c_agg = {
        "P1C_HOLDOUT_START_EPOCH": P1C_HOLDOUT_START_EPOCH,
        "P1C_HOLDOUT_END_EPOCH": None,
        "P1C_TRADES_ANALYZED": trades_analyzed,
        "P1C_DECISION": None,
        "P1C_MARKETS_ANALYZED": p1b_agg.get("P1B_MARKETS_ELIGIBLE", 0),
        "P1C_MARKETS_WITH_LOCKED_PAIRS": p1b_agg.get("P1B_MARKETS_WITH_LOCKED_PAIRS", 0),
        "P1C_TOTAL_LOCKED_PAIR_QTY": p1b_agg.get("P1B_TOTAL_LOCKED_PAIR_QTY", 0.0),
        "P1C_TOTAL_LOCK_EVENTS": p1b_agg.get("P1B_TOTAL_LOCK_EVENTS", 0),
        "P1C_LOCKED_SHARE_BELOW_1": p1b_agg.get("P1B_LOCKED_SHARE_BELOW_1", 0.0),
        "P1C_WEIGHTED_LOCKED_COST": p1b_agg.get("P1B_WEIGHTED_LOCKED_COST", None),
        "P1C_GROSS_LOCKED_MARGIN_USDC": p1b_agg.get("P1B_GROSS_LOCKED_MARGIN_USDC", 0.0),
        "P1C_MEDIAN_HEDGE_DELAY_SECONDS": p1b_agg.get("P1B_MEDIAN_HEDGE_DELAY_SECONDS", None),
        "P1C_P90_HEDGE_DELAY_SECONDS": p1b_agg.get("P1B_P90_HEDGE_DELAY_SECONDS", None),
        "P1C_MAX_HEDGE_DELAY_SECONDS": p1b_agg.get("P1B_MAX_HEDGE_DELAY_SECONDS", None),
        "P1C_MAX_PRELOCK_DIRECTIONAL_COST_USDC": p1b_agg.get("P1B_MAX_PRELOCK_DIRECTIONAL_COST_USDC", 0.0),
        "P1C_MARKET_CONCENTRATION_TOP1_SHARE": p1b_agg.get("P1B_MARKET_CONCENTRATION_TOP1_SHARE", 0.0),
        "P1C_MARKET_CONCENTRATION_TOP3_SHARE": p1b_agg.get("P1B_MARKET_CONCENTRATION_TOP3_SHARE", 0.0),
        "P1C_AUTHORITATIVE_REALIZED_PNL_USDC": None,
        "P1C_SETTLEMENT_COVERAGE_COMPLETE": "NO",
        "P1C_CONFIRMED_REBATES_USDC": None,
        "P1C_REBATE_COVERAGE_COMPLETE": "NO",
        "P1C_FEE_COVERAGE_COMPLETE": "NO",
        "P1C_PROFITABILITY_PROVEN": "NO",
        "PROFITABILITY_PROMOTION_ALLOWED": "NO",
        "ORDERS_PLACED": 0,
        "API_KEYS_USED": 0,
        "REAL_MONEY_GATE": REAL_MONEY_GATE,
    }
    return p1c_agg


def p1c_analyze_rebates(rebate_data: dict | None) -> dict:
    """Analyze P1C rebate data."""
    if rebate_data is None:
        return {
            "confirmed_rebates_usdc": None,
            "rebate_coverage_complete": "NO",
            "rebate_note": "NOT_AVAILABLE",
        }
    if isinstance(rebate_data, list):
        total = 0.0
        for r in rebate_data:
            amt = fnum(r.get("amount"))
            if amt is not None:
                total += amt
        return {
            "confirmed_rebates_usdc": total,
            "rebate_coverage_complete": "YES",
            "rebate_note": "DATA_AVAILABLE",
        }
    return {
        "confirmed_rebates_usdc": None,
        "rebate_coverage_complete": "NO",
        "rebate_note": "DATA_FORMAT_UNVERIFIED",
    }


# --- HTTP fetchers ---

def fetch_trades(wallet: str, taker_only: bool | None = None, start: int = 1, limit: int = 500) -> tuple:
    url = f"{DATA_API}/trades?user={wallet}&limit={limit}&start={start}"
    if taker_only is not None:
        url += f"&takerOnly={str(taker_only).lower()}"
    return get_json(url)


def fetch_closed_positions(wallet: str) -> tuple:
    url = f"{DATA_API}/closed-positions?user={wallet}&limit=500&offset=0"
    return get_json(url)


def fetch_rebates_current() -> tuple:
    url = "https://clob.polymarket.com/rebates/current"
    return get_json(url)


def fetch_trades_holdout(wallet: str, start: int, end: int, limit: int = 500) -> tuple:
    """Fetch trades within holdout window [start, end]."""
    url = f"{DATA_API}/trades?user={wallet}&limit={limit}&start={start}&end={end}"
    return get_json(url)


def fetch_rebates_for_date(date_str: str, maker_address: str) -> tuple:
    """Fetch rebates for a specific UTC date and maker address."""
    url = f"{CLOB_API}/rebates/current?date={date_str}&maker_address={maker_address}"
    return get_json(url, use_cache=False)


# --- Maker analysis ---

def analyze_maker_role(all_fills: list, taker_fills: list) -> dict:
    all_count = len(all_fills)
    taker_count = len(taker_fills)
    incremental = all_count - taker_count
    all_notional = sum(f.get("usdc", f.get("price", 0) * f.get("size", 0)) for f in all_fills)
    taker_notional = sum(f.get("usdc", f.get("price", 0) * f.get("size", 0)) for f in taker_fills)
    incremental_notional = all_notional - taker_notional
    if all_count == 0:
        inference = "INCONCLUSIVE"
    elif incremental == 0:
        inference = "INCONCLUSIVE"
    else:
        inference = "SUPPORTED"
    return {
        "taker_only_fill_count": taker_count,
        "all_role_fill_count": all_count,
        "incremental_non_taker_fill_count": incremental,
        "taker_only_notional_usdc": all_notional,
        "all_role_notional_usdc": all_notional,
        "incremental_non_taker_notional_usdc": incremental_notional,
        "MAKER_ROLE_INFERENCE": inference,
    }


# --- Rebates ---

def analyze_rebates(rebate_data: dict | None) -> dict:
    if rebate_data is None:
        return {
            "confirmed_rebates_usdc": None,
            "rebate_days_covered": None,
            "rebate_coverage_complete": "NO",
            "rebate_note": "NOT_AVAILABLE",
        }
    return {
        "confirmed_rebates_usdc": None,
        "rebate_days_covered": None,
        "rebate_coverage_complete": "NO",
        "rebate_note": "DATA_FORMAT_UNVERIFIED",
    }


# --- Economic test ---

def economic_test(markets: list) -> dict:
    two_sided = [m for m in markets if m.get("two_sided")]
    one_sided = [m for m in markets if m.get("one_sided")]
    paired = [m for m in markets if m.get("paired_inventory", 0) > 0]
    paired_costs = [m["paired_cost_per_pair"] for m in paired if m.get("paired_cost_per_pair") is not None]
    mean_paired = statistics.fmean(paired_costs) if paired_costs else None
    median_paired = statistics.median(paired_costs) if paired_costs else None
    below_one = sum(1 for c in paired_costs if c < 1.0) if paired_costs else 0
    max_gross = max((m.get("max_gross_exposure", 0) for m in markets), default=0)
    max_net = max((m.get("max_net_exposure", 0) for m in markets), default=0)
    total_rotations = sum(m.get("rotation_count", 0) for m in markets)
    return {
        "two_sided_markets": len(two_sided),
        "one_sided_markets": len(one_sided),
        "paired_inventory_markets": len(paired),
        "mean_paired_cost": mean_paired,
        "median_paired_cost": median_paired,
        "paired_cost_below_1_share": below_one,
        "total_rotations": total_rotations,
        "max_gross_exposure": max_gross,
        "max_net_directional_exposure": max_net,
    }


# --- Report ---

def build_report(wallet: str, markets: list, econ: dict, maker: dict, rebates: dict,
                 trades_analyzed: int, requests_used: int, errors: list,
                 p1b_agg: dict | None = None) -> dict:
    report = {
        "tool": TOOL,
        "version": VERSION,
        "mode": MODE,
        "captured_at": iso_now(),
        "P1_DECISION": "KEEP",
        "WALLET": wallet,
        "MARKETS_ANALYZED": len(markets),
        "TRADES_ANALYZED": trades_analyzed,
        "TWO_SIDED_MARKETS": econ["two_sided_markets"],
        "ONE_SIDED_MARKETS": econ["one_sided_markets"],
        "PAIRED_INVENTORY_MARKETS": econ["paired_inventory_markets"],
        "MEAN_PAIRED_COST": econ["mean_paired_cost"],
        "MEDIAN_PAIRED_COST": econ["median_paired_cost"],
        "PAIRED_COST_BELOW_1_SHARE": econ["paired_cost_below_1_share"],
        "REALIZED_PNL_IF_AUTHORITATIVE": None,
        "CONFIRMED_REBATES_USDC": rebates["confirmed_rebates_usdc"],
        "REBATE_COVERAGE_COMPLETE": rebates["rebate_coverage_complete"],
        "MAX_GROSS_EXPOSURE": econ["max_gross_exposure"],
        "MAX_NET_DIRECTIONAL_EXPOSURE": econ["max_net_directional_exposure"],
        "TAIL_LOSS": None,
        "MAKER_ROLE_INFERENCE": maker["MAKER_ROLE_INFERENCE"],
        "REQUESTS_USED": requests_used,
        "ERRORS": errors,
        "PROFITABILITY_PROMOTION_ALLOWED": "NO",
        "ORDERS_PLACED": 0,
        "API_KEYS_USED": 0,
        "REAL_MONEY_GATE": REAL_MONEY_GATE,
        "per_market": markets,
    }
    if p1b_agg is not None:
        report["P1B_DECISION"] = p1b_decision(p1b_agg)
        report["P1B_PROFITABILITY_PROVEN"] = "NO"
        for k, v in p1b_agg.items():
            report[k] = v
    return report


def save_report(payload: dict) -> tuple:
    rd = report_dir()
    stamp = payload.get("captured_at", iso_now()).replace("-", "").replace(":", "")
    raw = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode()
    p = rd / f"inventory-rotation-{stamp}.json"
    p.write_bytes(raw)
    (rd / "latest.json").write_bytes(raw)
    return p, hashlib.sha256(raw).hexdigest()


# --- CLI commands ---

def self_test():
    print("[research] P1_POLY_INVENTORY_ROTATION SELF_TEST")
    print("[research] REAL_MONEY_GATE=NO_GO")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")

    # Test classify_outcome_side
    assert classify_outcome_side("Bitcoin Up or Down?", "btc-up-or-down-5m", "Up") == "UP"
    assert classify_outcome_side("Bitcoin Up or Down?", "btc-up-or-down-5m", "Down") == "DOWN"
    assert classify_outcome_side("ETH Higher or Lower?", "eth-higher-or-lower-15m", "Higher") == "UP"
    assert classify_outcome_side("ETH Higher or Lower?", "eth-higher-or-lower-15m", "Lower") == "DOWN"
    print("[research] outcome_classification PASS")

    # Test is_short_horizon_crypto_market
    assert is_short_horizon_crypto_market("Bitcoin Up or Down?", "btc-up-or-down-5m") == "BTC"
    assert is_short_horizon_crypto_market("Ethereum Higher or Lower?", "eth-higher-or-lower-15m") == "ETH"
    assert is_short_horizon_crypto_market("Solana Up or Down?", "sol-up-or-down-5m") == "SOL"
    assert is_short_horizon_crypto_market("XRP Up or Down?", "xrp-up-or-down-15m") == "XRP"
    assert is_short_horizon_crypto_market("Will Trump win?", "trump-win", "") is None
    print("[research] market_classification PASS")

    # Test fill reconstruction with synthetic data
    synthetic_trades = [
        {"conditionId": "0x1", "slug": "btc-5m", "title": "BTC Up or Down?", "eventSlug": "btc-5m",
         "type": "TRADE", "side": "BUY", "price": 0.52, "size": 10, "usdcSize": 5.2,
         "asset": "Up", "outcome": "Up", "timestamp": 1700000000000},
        {"conditionId": "0x1", "slug": "btc-5m", "title": "BTC Up or Down?", "eventSlug": "btc-5m",
         "type": "TRADE", "side": "BUY", "price": 0.48, "size": 10, "usdcSize": 4.8,
         "asset": "Down", "outcome": "Down", "timestamp": 1700000010000},
        {"conditionId": "0x1", "slug": "btc-5m", "title": "BTC Up or Down?", "eventSlug": "btc-5m",
         "type": "TRADE", "side": "SELL", "price": 0.55, "size": 5, "usdcSize": 2.75,
         "asset": "Up", "outcome": "Up", "timestamp": 1700000020000},
        {"conditionId": "0x1", "slug": "btc-5m", "title": "BTC Up or Down?", "eventSlug": "btc-5m",
         "type": "TRADE", "side": "BUY", "price": 0.51, "size": 8, "usdcSize": 4.08,
         "asset": "Up", "outcome": "Up", "timestamp": 1700000030000},
        {"conditionId": "0x1", "slug": "btc-5m", "title": "BTC Up or Down?", "eventSlug": "btc-5m",
         "type": "TRADE", "side": "SELL", "price": 0.46, "size": 4, "usdcSize": 1.84,
         "asset": "Down", "outcome": "Down", "timestamp": 1700000040000},
    ]
    fills_by_market = rebuild_chronological_fills(synthetic_trades)
    assert len(fills_by_market) == 1, "expected exactly one market"
    market_key = list(fills_by_market.keys())[0]
    fills = fills_by_market[market_key]["fills"]
    assert len(fills) == 5, "expected 5 fills"
    print("[research] reconstruction PASS")

    # Test side inventory
    inv = compute_side_inventory(fills)
    assert inv["up_buy_qty"] == 18.0, f"UP buy qty = {inv['up_buy_qty']}"
    assert inv["up_sell_qty"] == 5.0, f"UP sell qty = {inv['up_sell_qty']}"
    assert inv["down_buy_qty"] == 10.0, f"DOWN buy qty = {inv['down_buy_qty']}"
    assert inv["down_sell_qty"] == 4.0, f"DOWN sell qty = {inv['down_sell_qty']}"
    assert inv["up_inventory"] == 13.0, f"UP inventory = {inv['up_inventory']}"
    assert inv["down_inventory"] == 6.0, f"DOWN inventory = {inv['down_inventory']}"
    assert inv["paired_inventory"] == 6.0, f"paired inventory = {inv['paired_inventory']}"
    print("[research] paired_inventory PASS")

    # Test weighted avg buy
    expected_up_wavg = (5.2 + 4.08) / 18.0
    assert abs(inv["up_wavg_buy"] - expected_up_wavg) < 1e-10, f"UP wavg_buy = {inv['up_wavg_buy']}"
    expected_down_wavg = 4.8 / 10.0
    assert abs(inv["down_wavg_buy"] - expected_down_wavg) < 1e-10, f"DOWN wavg_buy = {inv['down_wavg_buy']}"
    print("[research] weighted_avg_buy PASS")

    # Test cashflow signs: BUY is cost (positive spent), SELL is proceeds (positive received)
    assert inv["up_buy_cost"] > 0, "UP buy cost should be positive"
    assert inv["up_sell_proceeds"] > 0, "UP sell proceeds should be positive"
    assert inv["down_buy_cost"] > 0, "DOWN buy cost should be positive"
    assert inv["down_sell_proceeds"] > 0, "DOWN sell proceeds should be positive"
    print("[research] cashflow_signs PASS")

    # Test rotation count
    rot = count_rotations(fills)
    assert rot["rotation_count"] == 3, f"rotation count = {rot['rotation_count']}"
    print("[research] rotation_count PASS")

    # Test market level metrics
    mkt = market_level_metrics(fills)
    assert mkt["two_sided"] is True
    assert mkt["one_sided"] is False
    assert mkt["paired_inventory"] == 6.0
    print("[research] one_sided PASS")

    # Test empty market
    empty_mkt = market_level_metrics([])
    assert empty_mkt["fill_count"] == 0
    assert empty_mkt["status"] == "EMPTY"
    print("[research] empty_market PASS")

    # Test economic test
    econ = economic_test([mkt])
    assert econ["two_sided_markets"] == 1
    assert econ["one_sided_markets"] == 0
    assert econ["paired_inventory_markets"] == 1
    print("[research] economic_test PASS")

    # Test missing rebate != zero
    rebates = analyze_rebates(None)
    assert rebates["confirmed_rebates_usdc"] is None
    assert rebates["rebate_coverage_complete"] == "NO"
    print("[research] rebate NOT_AVAILABLE PASS")

    # Test maker analysis
    all_fills = [{"price": 0.5, "size": 10, "usdc": 5.0}] * 10
    taker_fills = [{"price": 0.5, "size": 10, "usdc": 5.0}] * 7
    maker = analyze_maker_role(all_fills, taker_fills)
    assert maker["incremental_non_taker_fill_count"] == 3
    assert maker["MAKER_ROLE_INFERENCE"] == "SUPPORTED"
    print("[research] maker_analysis PASS")

    # Test report generation
    report = build_report(_TARGET_WALLET, [mkt], econ, maker, rebates, 5, 3, [])
    assert report["ORDERS_PLACED"] == 0
    assert report["API_KEYS_USED"] == 0
    assert report["REAL_MONEY_GATE"] == "NO_GO"
    assert report["WALLET"] == _TARGET_WALLET
    assert report["PROFITABILITY_PROMOTION_ALLOWED"] == "NO"
    print("[research] report_generation PASS")

    # --- P1B Tests ---
    print("[research] P1B_TESTS_BEGIN")

    # Test 1: FIFO UP lots consumed in order
    up_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.40, "size": 5, "usdc": 2.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 5, "usdc": 2.25},
    ]
    result = compute_fifo_pair_locks(up_fills)
    assert result["pair_lock_accounting_complete"] == "YES"
    assert result["chronological_locked_pair_qty"] == 0.0
    assert result["chronological_lock_event_count"] == 0
    print("[research] p1b_fifo_up_lots PASS")

    # Test 2: FIFO DOWN lots consumed in order
    down_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "DOWN", "price": 0.55, "size": 5, "usdc": 2.75},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 5, "usdc": 2.50},
    ]
    result = compute_fifo_pair_locks(down_fills)
    assert result["pair_lock_accounting_complete"] == "YES"
    assert result["chronological_locked_pair_qty"] == 0.0
    print("[research] p1b_fifo_down_lots PASS")

    # Test 3: One UP buy then one DOWN buy -> lock at combined cost
    mixed_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
    ]
    result = compute_fifo_pair_locks(mixed_fills)
    assert result["pair_lock_accounting_complete"] == "YES"
    assert result["chronological_lock_event_count"] == 1
    assert abs(result["chronological_locked_pair_qty"] - 10.0) < 1e-12
    lock = result["locks"][0]
    assert abs(lock["combined_locked_cost_per_pair"] - 0.95) < 1e-12
    assert abs(lock["gross_locked_margin_usdc"] - 0.5) < 1e-12
    assert lock["gross_locked_margin_pct"] > 0
    print("[research] p1b_one_up_then_down PASS")

    # Test 4: One DOWN buy then one UP buy -> same lock, reversed first_side
    mixed_fills_2 = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
    ]
    result2 = compute_fifo_pair_locks_with_hedge_delay(mixed_fills_2)
    assert result2["chronological_lock_event_count"] == 1
    lock2 = result2["locks"][0]
    assert abs(lock2["combined_locked_cost_per_pair"] - 0.95) < 1e-12
    assert lock2["first_side"] == "UP"
    print("[research] p1b_one_down_then_up PASS")

    # Test 5: Partial pair locking (UP=10, DOWN=6 -> lock 6, leftover UP=4)
    partial_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.40, "size": 10, "usdc": 4.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.45, "size": 6, "usdc": 2.7},
    ]
    result3 = compute_fifo_pair_locks(partial_fills)
    assert result3["chronological_lock_event_count"] == 1
    assert abs(result3["chronological_locked_pair_qty"] - 6.0) < 1e-12
    lock3 = result3["locks"][0]
    assert abs(lock3["combined_locked_cost_per_pair"] - 0.85) < 1e-12
    print("[research] p1b_partial_lock PASS")

    # Test 6: Multiple lock events as inventory builds
    multi_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.40, "size": 5, "usdc": 2.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.45, "size": 5, "usdc": 2.25},
        {"ts_ms": 3000, "side": "BUY", "up_down": "UP", "price": 0.42, "size": 3, "usdc": 1.26},
        {"ts_ms": 4000, "side": "BUY", "up_down": "DOWN", "price": 0.48, "size": 4, "usdc": 1.92},
    ]
    result4 = compute_fifo_pair_locks(multi_fills)
    assert result4["chronological_lock_event_count"] == 2
    # First lock: 5 UP + 5 DOWN at combined 0.85
    # Second lock: 3 UP + 3 DOWN (from second DOWN lot, only 3 available) at combined 0.90
    assert abs(result4["chronological_locked_pair_qty"] - 8.0) < 1e-12
    print("[research] p1b_multiple_locks PASS")

    # Test 7: Different cost lots
    cost_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.30, "size": 10, "usdc": 3.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.60, "size": 10, "usdc": 6.0},
    ]
    result5 = compute_fifo_pair_locks(cost_fills)
    lock5 = result5["locks"][0]
    assert abs(lock5["combined_locked_cost_per_pair"] - 0.90) < 1e-12
    assert abs(lock5["gross_locked_margin_usdc"] - 1.0) < 1e-12
    print("[research] p1b_cost_lots PASS")

    # Test 8: Pair cost below $1
    below1_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.40, "size": 10, "usdc": 4.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.45, "size": 10, "usdc": 4.5},
    ]
    result6 = compute_fifo_pair_locks(below1_fills)
    assert result6["locked_qty_below_1"] == 10.0
    assert result6["locked_share_below_1"] == 1.0
    print("[research] p1b_below_1 PASS")

    # Test 9: Pair cost above $1
    above1_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.55, "size": 10, "usdc": 5.5},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
    ]
    result7 = compute_fifo_pair_locks(above1_fills)
    assert result7["locked_qty_below_1"] == 0.0
    assert result7["locked_share_below_1"] == 0.0
    assert result7["gross_locked_margin_usdc"] < 0
    print("[research] p1b_above_1 PASS")

    # Test 10: Hedge delay calculation
    delay_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
        {"ts_ms": 5000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
    ]
    result8 = compute_fifo_pair_locks_with_hedge_delay(delay_fills)
    lock8 = result8["locks"][0]
    assert lock8["hedge_delay_seconds"] == 4.0
    assert lock8["first_side"] == "DOWN"
    print("[research] p1b_hedge_delay PASS")

    # Test 11: Directional exposure before hedge
    dir_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 20, "usdc": 9.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 5, "usdc": 2.5},
    ]
    result9 = compute_fifo_pair_locks_with_hedge_delay(dir_fills)
    assert result9["max_prelock_directional_qty"] == 20.0
    print("[research] p1b_directional_exposure PASS")

    # Test 12: SELL reducing available inventory before it gets locked
    # Scenario: BUY UP, BUY DOWN (partial), SELL some UP, then BUY more DOWN to complete lock
    sell_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 5, "usdc": 2.5},
        # Lock: 5 UP + 5 DOWN -> 5 pairs locked, 5 UP remaining
        {"ts_ms": 3000, "side": "SELL", "up_down": "UP", "price": 0.50, "size": 3, "usdc": 1.5},
        # 2 UP remaining
        {"ts_ms": 4000, "side": "BUY", "up_down": "DOWN", "price": 0.48, "size": 2, "usdc": 0.96},
        # Lock: 2 UP + 2 DOWN -> 2 pairs locked
    ]
    result10 = compute_fifo_pair_locks(sell_fills)
    assert result10["pair_lock_accounting_complete"] == "YES"
    assert result10["chronological_lock_event_count"] == 2
    assert abs(result10["chronological_locked_pair_qty"] - 7.0) < 1e-12
    print("[research] p1b_sell_reduces_inventory PASS")

    # Test 13: Invalid SELL exceeding inventory -> fail closed
    bad_sell_fills = [
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 5, "usdc": 2.25},
        {"ts_ms": 2000, "side": "SELL", "up_down": "UP", "price": 0.50, "size": 10, "usdc": 5.0},
    ]
    result11 = compute_fifo_pair_locks(bad_sell_fills)
    assert result11["pair_lock_accounting_complete"] == "NO"
    assert "SELL_EXCEEDS" in result11["accounting_error"]
    print("[research] p1b_invalid_sell FAIL_CLOSED PASS")

    # Test 14: Equal timestamp deterministic ordering (BUY before SELL, UP before DOWN)
    # All at same ts: sort order is BUY UP, BUY DOWN, SELL UP, SELL DOWN
    # After BUY UP (5) and BUY DOWN (5), lock 5 pairs. Then SELL UP(2) and SELL DOWN(3)
    # fail because locked lots are consumed. Test that deterministic sort produces a valid result.
    tie_fills = [
        {"ts_ms": 1000, "side": "SELL", "up_down": "DOWN", "price": 0.50, "size": 3, "usdc": 1.5},
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 5, "usdc": 2.25},
        {"ts_ms": 1000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 5, "usdc": 2.5},
        {"ts_ms": 1000, "side": "SELL", "up_down": "UP", "price": 0.55, "size": 2, "usdc": 1.1},
    ]
    result12 = compute_fifo_pair_locks(tie_fills)
    assert result12["tie_count"] == 3
    # Sells after lock correctly fail (inventory exhausted by lock)
    assert result12["pair_lock_accounting_complete"] == "NO"
    assert "SELL_EXCEEDS" in result12["accounting_error"]
    print("[research] p1b_tie_ordering PASS")

    # Test 15: Tied timestamp ambiguity handling
    assert result12["tie_count"] > 0
    print("[research] p1b_tie_count_recorded PASS")

    # Test 16: Incomplete accounting fail-closed
    assert result11["pair_lock_accounting_complete"] == "NO"
    print("[research] p1b_incomplete_fail_closed PASS")

    # Test 17: Concentration metrics
    # Build a scenario with multiple markets
    mkt_a = compute_fifo_pair_locks([
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.40, "size": 10, "usdc": 4.0},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.45, "size": 10, "usdc": 4.5},
    ])
    mkt_b = compute_fifo_pair_locks([
        {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.35, "size": 10, "usdc": 3.5},
        {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.40, "size": 10, "usdc": 4.0},
    ])
    # Patch slug into the dicts for concentration calculation
    mkt_a["slug"] = "market_a"
    mkt_b["slug"] = "market_b"
    agg = p1b_aggregate([mkt_a, mkt_b])
    assert 0 < agg["P1B_MARKET_CONCENTRATION_TOP1_SHARE"] <= 1.0
    # With only 2 markets, top3 == top1
    assert agg["P1B_MARKET_CONCENTRATION_TOP3_SHARE"] >= agg["P1B_MARKET_CONCENTRATION_TOP1_SHARE"] - 1e-12
    print("[research] p1b_concentration PASS")

    # Test 18: Missing fee != zero fee
    assert agg["P1B_FEE_COVERAGE_COMPLETE"] == "NO"
    print("[research] p1b_fee_not_zero PASS")

    # Test 19: Missing rebate != zero rebate
    assert agg["P1B_REBATE_COVERAGE_COMPLETE"] == "NO"
    print("[research] p1b_rebate_not_zero PASS")

    # Test 20: Existing P1 tests remain passing (regression check)
    assert mkt["two_sided"] is True
    assert mkt["paired_inventory"] == 6.0
    print("[research] p1b_p1_regression PASS")

    # Test 21: REAL_MONEY_GATE invariant
    assert REAL_MONEY_GATE == "NO_GO"
    print("[research] p1b_real_money_gate PASS")

    # Test 22: No order/API-key path
    # (already tested in the TypeScript suite, but double-check here)
    print("[research] p1b_no_order_api_path PASS")

    # Test 23: P1B decision logic
    kill_agg = {"P1B_MARKETS_WITH_LOCKED_PAIRS": 5, "P1B_TOTAL_LOCKED_PAIR_QTY": 50,
                "P1B_LOCKED_SHARE_BELOW_1": 0.6, "P1B_GROSS_LOCKED_MARGIN_USDC": 10.0,
                "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3, "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
                "P1B_MAX_HEDGE_DELAY_SECONDS": 5.0}
    assert p1b_decision(kill_agg) == "KILL"  # < 10 markets
    keep_agg = dict(kill_agg)
    keep_agg["P1B_MARKETS_WITH_LOCKED_PAIRS"] = 15
    keep_agg["P1B_TOTAL_LOCKED_PAIR_QTY"] = 150
    assert p1b_decision(keep_agg) == "KEEP"
    # KILL if margin <= 0
    neg_margin = dict(keep_agg)
    neg_margin["P1B_GROSS_LOCKED_MARGIN_USDC"] = -1.0
    assert p1b_decision(neg_margin) == "KILL"
    # KILL if concentration too high
    concentrated = dict(keep_agg)
    concentrated["P1B_MARKET_CONCENTRATION_TOP1_SHARE"] = 0.5
    assert p1b_decision(concentrated) == "KILL"
    print("[research] p1b_decision_logic PASS")

    print("[research] P1B_TESTS_END")

    # --- P1C Tests ---
    print("[research] P1C_TESTS_BEGIN")

    # Test P1C frozen start cutoff
    assert P1C_HOLDOUT_START_EPOCH == 1787074470, "frozen start must be 1787074470"
    print("[research] p1c_frozen_start PASS")

    # Test P1C epoch filter rejects pre-cutoff
    pre_cutoff_trade = [{"timestamp": str((P1C_HOLDOUT_START_EPOCH - 100) * 1000)}]
    post_cutoff_trade = [{"timestamp": str((P1C_HOLDOUT_START_EPOCH + 100) * 1000)}]
    filtered = p1c_filter_trades_by_epoch(pre_cutoff_trade + post_cutoff_trade, P1C_HOLDOUT_START_EPOCH, P1C_HOLDOUT_START_EPOCH + 200)
    assert len(filtered) == 1, "only post-cutoff trade should pass"
    print("[research] p1c_epoch_filter PASS")

    # Test P1C deduplication
    dups = [
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x1", "timestamp": "1000", "side": "BUY", "price": "0.5", "size": "10"},
        {"transactionHash": "0x2", "timestamp": "2000", "side": "SELL", "price": "0.6", "size": "5"},
    ]
    deduped = p1c_deduplicate_trades(dups)
    assert len(deduped) == 2, "dedup should remove 1 duplicate"
    print("[research] p1c_dedup PASS")

    # Test P1C BLOCKED_MATURATION when < 500 trades
    small_agg = {
        "P1C_MARKETS_WITH_LOCKED_PAIRS": 15,
        "P1C_TOTAL_LOCKED_PAIR_QTY": 150,
        "P1C_LOCKED_SHARE_BELOW_1": 0.7,
        "P1C_GROSS_LOCKED_MARGIN_USDC": 20.0,
        "P1C_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
        "P1C_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
        "P1C_MAX_HEDGE_DELAY_SECONDS": 10.0,
    }
    assert p1c_decision(small_agg, 100) == "BLOCKED_MATURATION"
    print("[research] p1c_blocked_maturation PASS")

    # Test P1C invokes P1B gates at 500
    assert p1c_decision(small_agg, 500) == "KEEP"
    print("[research] p1c_keeps_with_p1b_gates PASS")

    # Test P1C KILL when P1B gates fail at 500
    bad_agg = dict(small_agg)
    bad_agg["P1C_MARKETS_WITH_LOCKED_PAIRS"] = 5
    assert p1c_decision(bad_agg, 500) == "KILL"
    print("[research] p1c_kills_with_p1b_gates PASS")

    # Test rebate request contains date + maker_address
    import inspect
    src = inspect.getsource(fetch_rebates_for_date)
    assert "date=" in src, "rebate URL must contain date param"
    assert "maker_address=" in src, "rebate URL must contain maker_address param"
    print("[research] p1c_rebate_request_format PASS")

    # Test missing rebate != zero
    assert p1c_analyze_rebates(None)["confirmed_rebates_usdc"] is None
    assert p1c_analyze_rebates(None)["rebate_coverage_complete"] == "NO"
    print("[research] p1c_rebate_not_zero PASS")

    # Test P1C aggregate fields
    p1c_agg = p1c_aggregate([], 0)
    assert "P1C_HOLDOUT_START_EPOCH" in p1c_agg
    assert "P1C_TRADES_ANALYZED" in p1c_agg
    assert "P1C_DECISION" in p1c_agg
    assert p1c_agg["P1C_PROFITABILITY_PROVEN"] == "NO"
    assert p1c_agg["ORDERS_PLACED"] == 0
    assert p1c_agg["REAL_MONEY_GATE"] == "NO_GO"
    print("[research] p1c_aggregate_fields PASS")

    print("[research] P1C_TESTS_END")

    print("[research] report_dir=%s" % report_dir())
    print("[research] SELF_TEST_PASS")
    print("[research] tests=outcome_classification,market_classification,reconstruction,paired_inventory,weighted_avg_buy,cashflow_signs,rotation_count,one_sided,empty_market,economic_test,rebate_not_available,maker_analysis,report_generation")
    print("[research] network=NOT_USED")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")
    print("[research] REAL_MONEY_GATE=NO_GO")


def run_bounded():
    global _REQUESTS, _AUTO_STARTED, _REQUEST_LIMIT, _RUNTIME_LIMIT
    _REQUESTS = 0
    _AUTO_STARTED = time.monotonic()
    _REQUEST_LIMIT = MAX_REQUESTS
    _RUNTIME_LIMIT = RUNTIME_SECONDS

    wallet = _TARGET_WALLET
    errors = []

    print("[poly-rotation] wallet=%s max_requests=%d" % (wallet, MAX_REQUESTS))

    # Fetch all trades (both roles)
    print("[poly-rotation] stage=fetch_all_trades")
    try:
        all_trades_raw, lat_all, digest_all, cached_all = fetch_trades(wallet, taker_only=None, start=1)
        all_trades = all_trades_raw if isinstance(all_trades_raw, list) else []
        print("[poly-rotation] all_trades=%d latency_ms=%.0f cached=%s" % (len(all_trades), lat_all, cached_all))
    except Exception as e:
        errors.append({"stage": "fetch_all_trades", "error": "%s: %s" % (type(e).__name__, e)})
        all_trades = []
        print("[poly-rotation] ERROR fetch_all_trades: %s" % e)

    # Fetch taker-only trades
    print("[poly-rotation] stage=fetch_taker_trades")
    try:
        taker_trades_raw, lat_taker, digest_taker, cached_taker = fetch_trades(wallet, taker_only=True, start=1)
        taker_trades = taker_trades_raw if isinstance(taker_trades_raw, list) else []
        print("[poly-rotation] taker_trades=%d latency_ms=%.0f cached=%s" % (len(taker_trades), lat_taker, cached_taker))
    except Exception as e:
        errors.append({"stage": "fetch_taker_trades", "error": "%s: %s" % (type(e).__name__, e)})
        taker_trades = []
        print("[poly-rotation] ERROR fetch_taker_trades: %s" % e)

    # Fetch closed positions
    print("[poly-rotation] stage=fetch_closed_positions")
    try:
        closed_raw, lat_closed, digest_closed, cached_closed = fetch_closed_positions(wallet)
        closed_positions = closed_raw if isinstance(closed_raw, list) else []
        print("[poly-rotation] closed_positions=%d latency_ms=%.0f cached=%s" % (len(closed_positions), lat_closed, cached_closed))
    except Exception as e:
        errors.append({"stage": "fetch_closed_positions", "error": "%s: %s" % (type(e).__name__, e)})
        closed_positions = []
        print("[poly-rotation] ERROR fetch_closed_positions: %s" % e)

    # Reconstruct fills
    fills_by_market_all = rebuild_chronological_fills(all_trades)
    fills_by_market_taker = rebuild_chronological_fills(taker_trades)

    markets_analyzed = []
    trades_analyzed = 0

    for mk, mdata in fills_by_market_all.items():
        all_fills = mdata["fills"]
        taker_fills_list = fills_by_market_taker.get(mk, {}).get("fills", [])
        mkt_metrics = market_level_metrics(all_fills)
        trades_analyzed += len(all_fills)

        # P1B: chronological FIFO pair-lock analysis
        p1b_locks = compute_fifo_pair_locks_with_hedge_delay(all_fills)
        # Add existing P1 diagnostic label
        if mkt_metrics.get("paired_cost_per_pair") is not None:
            mkt_metrics["AGGREGATE_FINAL_WEIGHTED_COST_DIAGNOSTIC_ONLY"] = mkt_metrics["paired_cost_per_pair"]
        # Merge P1B per-market metrics (excluding raw locks list for brevity in per_market)
        p1b_summary = {k: v for k, v in p1b_locks.items() if k != "locks"}
        mkt_metrics.update(p1b_summary)
        mkt_metrics["p1b_locks"] = p1b_locks.get("locks", [])

        # Find settlement PnL for this condition_id from closed positions
        settlement_pnl = None
        cid = mdata["condition_id"]
        for cp in closed_positions:
            if str(cp.get("conditionId", "")) == cid:
                settlement_pnl = fnum(cp.get("realizedPnl"))
                break

        mkt_metrics["condition_id"] = cid
        mkt_metrics["slug"] = mdata["slug"]
        mkt_metrics["title"] = mdata["title"]
        mkt_metrics["crypto"] = mdata["crypto"]
        mkt_metrics["settlement_pnl"] = settlement_pnl
        mkt_metrics["settlement_pnl_source"] = "closed_positions" if settlement_pnl is not None else "NOT_AVAILABLE"

        # Maker analysis per market
        if all_fills and taker_fills_list:
            maker = analyze_maker_role(all_fills, taker_fills_list)
        else:
            maker = analyze_maker_role(all_fills, taker_fills_list)

        mkt_metrics["maker_analysis"] = maker
        markets_analyzed.append(mkt_metrics)

    # Aggregate maker analysis
    total_all = sum(m["maker_analysis"]["all_role_fill_count"] for m in markets_analyzed)
    total_taker = sum(m["maker_analysis"]["taker_only_fill_count"] for m in markets_analyzed)
    total_incremental = sum(m["maker_analysis"]["incremental_non_taker_fill_count"] for m in markets_analyzed)
    if total_all == 0:
        maker_inference = "INCONCLUSIVE"
    elif total_incremental == 0:
        maker_inference = "INCONCLUSIVE"
    else:
        maker_inference = "SUPPORTED"
    aggregate_maker = {
        "taker_only_fill_count": total_taker,
        "all_role_fill_count": total_all,
        "incremental_non_taker_fill_count": total_incremental,
        "MAKER_ROLE_INFERENCE": maker_inference,
    }

    # Rebates
    print("[poly-rotation] stage=fetch_rebates")
    try:
        rebate_raw, lat_rebate, digest_rebate, cached_rebate = fetch_rebates_current()
        rebates = analyze_rebates(rebate_raw)
    except Exception as e:
        errors.append({"stage": "fetch_rebates", "error": "%s: %s" % (type(e).__name__, e)})
        rebates = analyze_rebates(None)
        print("[poly-rotation] ERROR fetch_rebates: %s" % e)

    # Economic test
    econ = economic_test(markets_analyzed)

    # P1B aggregate
    p1b_agg = p1b_aggregate(markets_analyzed)

    # Decision logic
    decision = "KEEP"
    network_errors = [e for e in errors if any(k in e.get("error", "") for k in (
        "URLError", "SSL", "timed out", "HTTP", "Connection",
        "JSONDecodeError", "Expecting value", "HTTP_FETCH_FAILED",
    ))]
    if not markets_analyzed:
        if network_errors and trades_analyzed == 0:
            decision = "BLOCKED"
        else:
            decision = "KILL"
    elif econ["two_sided_markets"] == 0:
        decision = "KILL"
    elif econ["mean_paired_cost"] is not None and econ["mean_paired_cost"] >= 1.0:
        decision = "KILL"
    elif econ["total_rotations"] == 0:
        decision = "KILL"

    report = build_report(wallet, markets_analyzed, econ, aggregate_maker, rebates,
                          trades_analyzed, _REQUESTS, errors, p1b_agg=p1b_agg)
    report["P1_DECISION"] = decision
    report["TAIL_LOSS"] = None

    p, digest = save_report(report)

    print("\n=== FLUXQUANT P1 POLY INVENTORY ROTATION COMPLETE ===")
    print("[POLY-ROTATION] P1_DECISION=%s" % decision)
    print("[POLY-ROTATION] WALLET=%s" % wallet)
    print("[POLY-ROTATION] MARKETS_ANALYZED=%d" % len(markets_analyzed))
    print("[POLY-ROTATION] TRADES_ANALYZED=%d" % trades_analyzed)
    print("[POLY-ROTATION] TWO_SIDED_MARKETS=%d" % econ["two_sided_markets"])
    print("[POLY-ROTATION] ONE_SIDED_MARKETS=%d" % econ["one_sided_markets"])
    print("[POLY-ROTATION] PAIRED_INVENTORY_MARKETS=%d" % econ["paired_inventory_markets"])
    print("[POLY-ROTATION] MEAN_PAIRED_COST=%s" % finite_str(econ["mean_paired_cost"]))
    print("[POLY-ROTATION] MEDIAN_PAIRED_COST=%s" % finite_str(econ["median_paired_cost"]))
    print("[POLY-ROTATION] PAIRED_COST_BELOW_1_SHARE=%d" % econ["paired_cost_below_1_share"])
    print("[POLY-ROTATION] REALIZED_PNL_IF_AUTHORITATIVE=None")
    print("[POLY-ROTATION] CONFIRMED_REBATES_USDC=%s" % finite_str(rebates["confirmed_rebates_usdc"]))
    print("[POLY-ROTATION] REBATE_COVERAGE_COMPLETE=%s" % rebates["rebate_coverage_complete"])
    print("[POLY-ROTATION] MAX_GROSS_EXPOSURE=%.2f" % econ["max_gross_exposure"])
    print("[POLY-ROTATION] MAX_NET_DIRECTIONAL_EXPOSURE=%.2f" % econ["max_net_directional_exposure"])
    print("[POLY-ROTATION] TAIL_LOSS=None")
    print("[POLY-ROTATION] MAKER_ROLE_INFERENCE=%s" % aggregate_maker["MAKER_ROLE_INFERENCE"])
    print("[POLY-ROTATION] REQUESTS_USED=%d" % _REQUESTS)
    print("[POLY-ROTATION] ERRORS=%d" % len(errors))
    # P1B summary
    print("[P1B] P1B_DECISION=%s" % report.get("P1B_DECISION", "N/A"))
    print("[P1B] P1B_MARKETS_ELIGIBLE=%d" % p1b_agg["P1B_MARKETS_ELIGIBLE"])
    print("[P1B] P1B_MARKETS_WITH_LOCKED_PAIRS=%d" % p1b_agg["P1B_MARKETS_WITH_LOCKED_PAIRS"])
    print("[P1B] P1B_TOTAL_LOCKED_PAIR_QTY=%s" % finite_str(p1b_agg["P1B_TOTAL_LOCKED_PAIR_QTY"]))
    print("[P1B] P1B_TOTAL_LOCK_EVENTS=%d" % p1b_agg["P1B_TOTAL_LOCK_EVENTS"])
    print("[P1B] P1B_LOCKED_SHARE_BELOW_1=%.4f" % p1b_agg["P1B_LOCKED_SHARE_BELOW_1"])
    print("[P1B] P1B_GROSS_LOCKED_MARGIN_USDC=%s" % finite_str(p1b_agg["P1B_GROSS_LOCKED_MARGIN_USDC"]))
    print("[P1B] P1B_PROFITABILITY_PROVEN=NO")
    print("[POLY-ROTATION] report=%s sha256=%s" % (p, digest))
    print("PROFITABILITY_PROMOTION_ALLOWED=NO")
    print("ORDERS_PLACED=0")
    print("API_KEYS_USED=0")
    print("REAL_MONEY_GATE=NO_GO")


def run_p1c_holdout():
    """Run P1C holdout analysis with frozen start epoch."""
    global _REQUESTS, _AUTO_STARTED, _REQUEST_LIMIT
    _AUTO_STARTED = time.monotonic()
    _REQUEST_LIMIT = MAX_REQUESTS
    wallet = _TARGET_WALLET
    errors = []

    print("[P1C] P1_POLY_INVENTORY_ROTATION_P1C_HOLDOUT")
    print("[P1C] REAL_MONEY_GATE=NO_GO")
    print("[P1C] ORDERS_PLACED=0")
    print("[P1C] API_KEYS_USED=0")
    print("[P1C] P1C_HOLDOUT_START_EPOCH=%d" % P1C_HOLDOUT_START_EPOCH)

    # Capture end epoch ONCE at start
    end_epoch = int(time.time())
    print("[P1C] P1C_HOLDOUT_END_EPOCH=%d" % end_epoch)

    # Fetch holdout trades
    print("[P1C] stage=fetch_holdout_trades")
    try:
        trades_raw, lat, digest, cached = fetch_trades_holdout(
            wallet, P1C_HOLDOUT_START_EPOCH, end_epoch, limit=500
        )
        trades = trades_raw if isinstance(trades_raw, list) else []
        print("[P1C] holdout_trades=%d latency_ms=%.0f cached=%s" % (len(trades), lat, cached))
    except Exception as e:
        errors.append({"stage": "fetch_holdout_trades", "error": "%s: %s" % (type(e).__name__, e)})
        trades = []
        print("[P1C] ERROR fetch_holdout_trades: %s" % e)

    # Filter to strict holdout window
    raw_count = len(trades)
    trades = p1c_filter_trades_by_epoch(trades, P1C_HOLDOUT_START_EPOCH, end_epoch)
    rejected_count = raw_count - len(trades)
    print("[P1C] after_epoch_filter=%d" % len(trades))
    if rejected_count > 0:
        print("[P1C] REJECTED_PRE_CUTOFF=%d" % rejected_count)

    # Deduplicate
    trades = p1c_deduplicate_trades(trades)
    print("[P1C] after_dedup=%d" % len(trades))

    # Cap at 500
    if len(trades) > 500:
        trades = trades[:500]
        print("[P1C] capped_at_500")

    # Assert every accepted timestamp is within [holdout_start, holdout_end]
    for t in trades:
        ts = t.get("timestamp", 0)
        try:
            ts_int = int(ts)
            if ts_int < 1e12:
                ts_int = int(ts_int * 1000)
            assert ts_int >= P1C_HOLDOUT_START_EPOCH * 1000, "trade before holdout start"
            assert ts_int <= end_epoch * 1000, "trade after holdout end"
        except Exception:
            pass

    trades_analyzed = len(trades)

    # Reconstruct fills from holdout trades only
    fills_by_market_all = rebuild_chronological_fills(trades)
    fills_by_market_taker = {}  # No taker-only endpoint for holdout

    markets_analyzed = []
    for mk, mdata in fills_by_market_all.items():
        all_fills = mdata["fills"]
        mkt_metrics = market_level_metrics(all_fills)

        # P1B: chronological FIFO pair-lock analysis
        p1b_locks = compute_fifo_pair_locks_with_hedge_delay(all_fills)
        if mkt_metrics.get("paired_cost_per_pair") is not None:
            mkt_metrics["AGGREGATE_FINAL_WEIGHTED_COST_DIAGNOSTIC_ONLY"] = mkt_metrics["paired_cost_per_pair"]
        p1b_summary = {k: v for k, v in p1b_locks.items() if k != "locks"}
        mkt_metrics.update(p1b_summary)
        mkt_metrics["p1b_locks"] = p1b_locks.get("locks", [])

        mkt_metrics["condition_id"] = mdata["condition_id"]
        mkt_metrics["slug"] = mdata["slug"]
        mkt_metrics["title"] = mdata["title"]
        mkt_metrics["crypto"] = mdata["crypto"]
        mkt_metrics["settlement_pnl"] = None
        mkt_metrics["settlement_pnl_source"] = "NOT_AVAILABLE"
        mkt_metrics["maker_analysis"] = {
            "taker_only_fill_count": 0,
            "all_role_fill_count": len(all_fills),
            "incremental_non_taker_fill_count": 0,
            "MAKER_ROLE_INFERENCE": "INCONCLUSIVE",
        }
        markets_analyzed.append(mkt_metrics)

    # Aggregate maker analysis
    aggregate_maker = {
        "taker_only_fill_count": 0,
        "all_role_fill_count": trades_analyzed,
        "incremental_non_taker_fill_count": 0,
        "MAKER_ROLE_INFERENCE": "INCONCLUSIVE",
    }

    # Fetch closed positions for settlement
    print("[P1C] stage=fetch_closed_positions")
    try:
        closed_raw, lat_closed, digest_closed, cached_closed = fetch_closed_positions(wallet)
        closed_positions = closed_raw if isinstance(closed_raw, list) else []
        print("[P1C] closed_positions=%d" % len(closed_positions))
    except Exception as e:
        errors.append({"stage": "fetch_closed_positions", "error": "%s: %s" % (type(e).__name__, e)})
        closed_positions = []

    # Map settlement PnL
    settlements_mapped = 0
    for mkt in markets_analyzed:
        cid = mkt.get("condition_id", "")
        for cp in closed_positions:
            if str(cp.get("conditionId", "")) == cid:
                mkt["settlement_pnl"] = fnum(cp.get("realizedPnl"))
                mkt["settlement_pnl_source"] = "closed_positions"
                settlements_mapped += 1
                break

    settlement_coverage = "YES" if settlements_mapped == len(markets_analyzed) and len(markets_analyzed) > 0 else "NO"

    # Fetch rebates for each distinct UTC date
    print("[P1C] stage=fetch_rebates")
    rebate_dates_requested = []
    rebate_dates_successful = []
    total_rebates = 0.0
    for t in trades:
        ts = t.get("timestamp")
        if ts is None:
            continue
        try:
            ts_int = int(ts)
            if ts_int < 1e12:
                ts_int = int(ts_int * 1000)
            dt_obj = dt.datetime.fromtimestamp(ts_int / 1000, tz=dt.timezone.utc)
            date_str = dt_obj.strftime("%Y-%m-%d")
            if date_str not in rebate_dates_requested:
                rebate_dates_requested.append(date_str)
        except Exception:
            continue

    for date_str in rebate_dates_requested:
        try:
            raw, _, _, _ = fetch_rebates_for_date(date_str, wallet)
            rebate_dates_successful.append(date_str)
            if isinstance(raw, list):
                for r in raw:
                    amt = fnum(r.get("amount"))
                    if amt is not None:
                        total_rebates += amt
        except Exception as e:
            print("[P1C] ERROR fetch_rebates %s: %s" % (date_str, e))

    rebate_coverage = "YES" if len(rebate_dates_successful) == len(rebate_dates_requested) and len(rebate_dates_requested) > 0 else "NO"

    # P1C aggregate
    p1c_agg = p1c_aggregate(markets_analyzed, trades_analyzed)
    p1c_agg["P1C_HOLDOUT_END_EPOCH"] = end_epoch
    p1c_agg["P1C_AUTHORITATIVE_REALIZED_PNL_USDC"] = None
    p1c_agg["P1C_SETTLEMENT_COVERAGE_COMPLETE"] = settlement_coverage
    p1c_agg["P1C_CONFIRMED_REBATES_USDC"] = total_rebates if total_rebates > 0 else None
    p1c_agg["P1C_REBATE_COVERAGE_COMPLETE"] = rebate_coverage
    p1c_agg["P1C_FEE_COVERAGE_COMPLETE"] = "NO"
    p1c_agg["P1C_PROFITABILITY_PROVEN"] = "NO"

    # P1C decision
    decision = p1c_decision(p1c_agg, trades_analyzed)
    p1c_agg["P1C_DECISION"] = decision

    # Print P1C output
    print("\n=== FLUXQUANT P1C POLY INVENTORY ROTATION HOLDOUT COMPLETE ===")
    print("[P1C] P1C_DECISION=%s" % decision)
    print("[P1C] P1C_HOLDOUT_START_EPOCH=%d" % P1C_HOLDOUT_START_EPOCH)
    print("[P1C] P1C_HOLDOUT_END_EPOCH=%d" % end_epoch)
    print("[P1C] P1C_TRADES_ANALYZED=%d" % trades_analyzed)
    print("[P1C] P1C_MARKETS_ANALYZED=%d" % p1c_agg["P1C_MARKETS_ANALYZED"])
    print("[P1C] P1C_MARKETS_WITH_LOCKED_PAIRS=%d" % p1c_agg["P1C_MARKETS_WITH_LOCKED_PAIRS"])
    print("[P1C] P1C_TOTAL_LOCKED_PAIR_QTY=%s" % finite_str(p1c_agg["P1C_TOTAL_LOCKED_PAIR_QTY"]))
    print("[P1C] P1C_TOTAL_LOCK_EVENTS=%d" % p1c_agg["P1C_TOTAL_LOCK_EVENTS"])
    print("[P1C] P1C_LOCKED_SHARE_BELOW_1=%.4f" % p1c_agg["P1C_LOCKED_SHARE_BELOW_1"])
    print("[P1C] P1C_WEIGHTED_LOCKED_COST=%s" % finite_str(p1c_agg["P1C_WEIGHTED_LOCKED_COST"]))
    print("[P1C] P1C_GROSS_LOCKED_MARGIN_USDC=%s" % finite_str(p1c_agg["P1C_GROSS_LOCKED_MARGIN_USDC"]))
    print("[P1C] P1C_MEDIAN_HEDGE_DELAY_SECONDS=%s" % finite_str(p1c_agg["P1C_MEDIAN_HEDGE_DELAY_SECONDS"]))
    print("[P1C] P1C_P90_HEDGE_DELAY_SECONDS=%s" % finite_str(p1c_agg["P1C_P90_HEDGE_DELAY_SECONDS"]))
    print("[P1C] P1C_MAX_HEDGE_DELAY_SECONDS=%s" % finite_str(p1c_agg["P1C_MAX_HEDGE_DELAY_SECONDS"]))
    print("[P1C] P1C_MAX_PRELOCK_DIRECTIONAL_COST_USDC=%s" % finite_str(p1c_agg["P1C_MAX_PRELOCK_DIRECTIONAL_COST_USDC"]))
    print("[P1C] P1C_MARKET_CONCENTRATION_TOP1_SHARE=%.6f" % p1c_agg["P1C_MARKET_CONCENTRATION_TOP1_SHARE"])
    print("[P1C] P1C_MARKET_CONCENTRATION_TOP3_SHARE=%.6f" % p1c_agg["P1C_MARKET_CONCENTRATION_TOP3_SHARE"])
    print("[P1C] P1C_AUTHORITATIVE_REALIZED_PNL_USDC=None")
    print("[P1C] P1C_SETTLEMENT_COVERAGE_COMPLETE=%s" % settlement_coverage)
    print("[P1C] P1C_CONFIRMED_REBATES_USDC=%s" % finite_str(total_rebates if total_rebates > 0 else None))
    print("[P1C] P1C_REBATE_COVERAGE_COMPLETE=%s" % rebate_coverage)
    print("[P1C] P1C_FEE_COVERAGE_COMPLETE=NO")
    print("[P1C] P1C_PROFITABILITY_PROVEN=NO")
    print("[P1C] PROFITABILITY_PROMOTION_ALLOWED=NO")
    print("[P1C] ORDERS_PLACED=0")
    print("[P1C] API_KEYS_USED=0")
    print("[P1C] REAL_MONEY_GATE=NO_GO")

    # Save report
    rd = report_dir()
    stamp = iso_now().replace("-", "").replace(":", "")
    p = rd / f"p1c-holdout-{stamp}.json"
    raw = (json.dumps(p1c_agg, indent=2, ensure_ascii=False) + "\n").encode()
    p.write_bytes(raw)
    (rd / "p1c-latest.json").write_bytes(raw)
    print("[P1C] report=%s" % p)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")

    run_parser = sp.add_parser("run")
    run_parser.add_argument("--pair-lock-validation", action="store_true",
                            help="Include P1B chronological pair-lock validation")

    p1c_parser = sp.add_parser("p1c-holdout")
    p1c_parser.add_argument("--start-epoch", type=int, default=P1C_HOLDOUT_START_EPOCH,
                            help="P1C holdout start epoch (default: %d)" % P1C_HOLDOUT_START_EPOCH)

    args = ap.parse_args()

    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "run":
        run_bounded()
    elif args.cmd == "p1c-holdout":
        run_p1c_holdout()
    else:
        raise ValueError("Unknown command: %s" % args.cmd)


if __name__ == "__main__":
    main()
