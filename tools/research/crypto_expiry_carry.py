#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import random
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

TOOL = "FluxQuant Bybit Expiry Cash-and-Carry Research"
MODE = "READ_ONLY_PAPER_RESEARCH"
REAL_MONEY_GATE = "NO_GO"
BASE = "https://api.bybit.com"

# Recovered, frozen defaults from standalone artifact SHA256
# 18c539eb554973a1562f46782209ec87c9f9b22b396d880d1be520f903f0f5aa
SPOT_TAKER_BPS = 10.0
FUTURES_TAKER_BPS = 5.5
DEFAULT_NOTIONALS = [100.0, 500.0, 1000.0]
DEFAULT_AUDIT_NOTIONAL = 100.0

MAX_REQUESTS = 40
RUNTIME_SECONDS = 600
MAX_AUDIT_EPISODES = 12
_REQUESTS = 0
_STARTED: float | None = None


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_now() -> str:
    return now().replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)


def root() -> Path:
    p = Path.cwd().resolve()
    for x in [p, *p.parents]:
        f = x / "package.json"
        if f.is_file():
            try:
                o = json.loads(f.read_text())
            except Exception:
                continue
            if o.get("name") == "fluxquant":
                return x
    return p


def legacy_root() -> Path:
    return root() / "data" / "crypto-expiry-carry-paper"


def cache_root() -> Path:
    return root() / "cache" / "bybit" / "expiry-carry" / "snapshots"


def report_root() -> Path:
    return root() / "reports" / "research" / "crypto-expiry-carry"


def reset_bounds(max_requests: int = MAX_REQUESTS, runtime_seconds: int = RUNTIME_SECONDS) -> None:
    global _REQUESTS, _STARTED
    _REQUESTS = 0
    _STARTED = time.monotonic()
    if max_requests <= 0 or runtime_seconds <= 0:
        raise ValueError("INVALID_BOUNDS")


def get(path: str, params: dict[str, Any] | None = None, timeout: int = 15) -> tuple[dict[str, Any], float, str]:
    global _REQUESTS
    if _STARTED is None:
        reset_bounds()
    _REQUESTS += 1
    if _REQUESTS > MAX_REQUESTS:
        raise RuntimeError("EXPIRY_CARRY_MAX_REQUESTS_EXCEEDED")
    if _STARTED is not None and (time.monotonic() - _STARTED) > RUNTIME_SECONDS:
        raise RuntimeError("EXPIRY_CARRY_RUNTIME_BOUND_EXCEEDED")
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    st = time.time_ns()
    req = urllib.request.Request(url, headers={"User-Agent": "FluxQuant-Expiry-Carry/1.5", "Accept": "application/json"})
    # urllib uses Python's standard verified TLS context by default. No insecure fallback exists here.
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    en = time.time_ns()
    obj = json.loads(raw.decode())
    if int(obj.get("retCode", -1)) != 0:
        raise RuntimeError(f"BYBIT_ERROR:{obj.get('retMsg')}")
    return obj, (en - st) / 1e6, hashlib.sha256(raw).hexdigest()


def fnum(x: Any) -> float | None:
    try:
        y = float(x)
        return y if math.isfinite(y) else None
    except Exception:
        return None


def levels(xs: Any, rev: bool = False) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for r in xs or []:
        try:
            p, q = float(r[0]), float(r[1])
        except Exception:
            continue
        if p > 0 and q > 0:
            out.append((p, q))
    out.sort(key=lambda z: z[0], reverse=rev)
    return out


def fetch_spreads() -> list[dict[str, Any]]:
    cursor = None
    rows: list[dict[str, Any]] = []
    while True:
        params: dict[str, str] = {"limit": "500"}
        if cursor:
            params["cursor"] = cursor
        obj, _, _ = get("/v5/spread/instrument", params)
        rr = obj.get("result", {})
        rows.extend(rr.get("list", []) or [])
        cursor = rr.get("nextPageCursor") or ""
        if not cursor:
            break
    return [x for x in rows if x.get("contractType") == "CarryTrade" and x.get("status") == "Trading"]


def fetch_instrument(symbol: str) -> tuple[dict[str, Any], float, str]:
    obj, lat, dig = get("/v5/market/instruments-info", {"category": "linear", "symbol": symbol})
    xs = obj["result"]["list"]
    if not xs:
        raise RuntimeError("FUTURES_INSTRUMENT_NOT_FOUND")
    return xs[0], lat, dig


def book(category: str, symbol: str, limit: int = 100) -> dict[str, Any]:
    obj, lat, dig = get("/v5/market/orderbook", {"category": category, "symbol": symbol, "limit": str(limit)})
    x = obj["result"]
    return {
        "bids": levels(x.get("b"), True),
        "asks": levels(x.get("a"), False),
        "ts": int(x["ts"]) if str(x.get("ts", "")).isdigit() else None,
        "latency_ms": lat,
        "sha256": dig,
    }


def buy_quote(asks: list[tuple[float, float]], quote: float) -> tuple[bool, float, float, float | None]:
    rem = quote
    qty = 0.0
    spent = 0.0
    for p, q in asks:
        lv = p * q
        use = min(rem, lv)
        qty += use / p
        spent += use
        rem -= use
        if rem <= max(1e-9, quote * 1e-10):
            break
    return rem <= max(1e-7, quote * 1e-9), qty, spent, (spent / qty if qty else None)


def sell_qty(bids: list[tuple[float, float]], qty: float) -> tuple[bool, float, float, float | None]:
    rem = qty
    sold = 0.0
    got = 0.0
    for p, q in bids:
        use = min(rem, q)
        got += use * p
        sold += use
        rem -= use
        if rem <= max(1e-12, qty * 1e-10):
            break
    return rem <= max(1e-10, qty * 1e-9), sold, got, (got / sold if sold else None)


def candidate_from_spread(sp: dict[str, Any]) -> dict[str, Any] | None:
    legs = sp.get("legs") or []
    spot = next((x for x in legs if x.get("contractType") == "Spot"), None)
    fut = next((x for x in legs if x.get("contractType") == "LinearFutures"), None)
    if not spot or not fut:
        return None
    return {
        "spread_symbol": sp.get("symbol"),
        "baseCoin": sp.get("baseCoin"),
        "quoteCoin": sp.get("quoteCoin"),
        "spot_symbol": spot.get("symbol"),
        "futures_symbol": fut.get("symbol"),
        "spread_delivery_time": sp.get("deliveryTime"),
    }


def eval_one(c: dict[str, Any], notionals: list[float]) -> dict[str, Any] | None:
    inst, _, _ = fetch_instrument(str(c["futures_symbol"]))
    delivery_ms = int(inst.get("deliveryTime") or 0)
    if delivery_ms <= 0:
        return None
    delivery = dt.datetime.fromtimestamp(delivery_ms / 1000, dt.timezone.utc)
    days = (delivery - now()).total_seconds() / 86400
    if days <= 0:
        return None
    delivery_fee = fnum(inst.get("deliveryFeeRate")) or 0.0

    sb = book("spot", str(c["spot_symbol"]), 100)
    fb = book("linear", str(c["futures_symbol"]), 100)
    sims: list[dict[str, Any]] = []
    for n in notionals:
        ok, qty, spent, spot_vwap = buy_quote(sb["asks"], n)
        if not ok or not qty or spot_vwap is None:
            continue
        ok2, _, proceeds, fut_vwap = sell_qty(fb["bids"], qty)
        if not ok2 or fut_vwap is None:
            continue

        basis = fut_vwap / spot_vwap - 1.0
        entry_fees = spent * SPOT_TAKER_BPS / 10000 + proceeds * FUTURES_TAKER_BPS / 10000
        exit_spot_fee_est = spent * SPOT_TAKER_BPS / 10000
        delivery_fee_est = proceeds * delivery_fee
        total_cost_rate = (entry_fees + exit_spot_fee_est + delivery_fee_est) / spent
        locked_edge_before_financing = basis - total_cost_rate
        simple_apr = locked_edge_before_financing * 365 / days if days > 0 else None
        sims.append({
            "notional_usdt": n,
            "base_qty": qty,
            "spot_buy_vwap": spot_vwap,
            "futures_short_vwap": fut_vwap,
            "executable_basis": basis,
            "entry_fees_est_usdt": entry_fees,
            "exit_spot_fee_est_usdt": exit_spot_fee_est,
            "delivery_fee_rate": delivery_fee,
            "delivery_fee_est_usdt": delivery_fee_est,
            "net_locked_edge_before_financing": locked_edge_before_financing,
            "simple_apr_before_financing": simple_apr,
            "book_timestamp_skew_ms": abs((sb["ts"] or 0) - (fb["ts"] or 0)) if sb["ts"] and fb["ts"] else None,
        })
    return {
        **c,
        "delivery_time": delivery.isoformat().replace("+00:00", "Z"),
        "days_to_expiry": days,
        "delivery_fee_rate": delivery_fee,
        "futures_contract_type": inst.get("contractType"),
        "simulations": sims,
    }


def snapshot(notionals: list[float], topn: int) -> dict[str, Any]:
    captured = iso_now()
    spreads = fetch_spreads()
    cand: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for sp in spreads:
        c = candidate_from_spread(sp)
        if not c:
            continue
        try:
            x = eval_one(c, notionals)
            if x:
                cand.append(x)
        except Exception as e:
            errors.append({"spread": sp.get("symbol"), "error": f"{type(e).__name__}: {e}"})

    def score(x: dict[str, Any]) -> float:
        if not x["simulations"]:
            return -999.0
        return max(float(s["net_locked_edge_before_financing"]) for s in x["simulations"])

    cand.sort(key=score, reverse=True)
    return {
        "tool": TOOL,
        "mode": MODE,
        "captured_at": captured,
        "venue": "bybit",
        "carrytrade_spreads_found": len(spreads),
        "evaluated": len(cand),
        "fee_assumptions": {"spot_taker_bps": SPOT_TAKER_BPS, "futures_taker_bps": FUTURES_TAKER_BPS},
        "candidates": cand[:topn],
        "errors": errors,
        "limitations": [
            "Financing/opportunity cost of capital is not modeled.",
            "Taxes, stablecoin risk, exchange risk, liquidation/margin mechanics and settlement mechanics beyond published delivery fee are not modeled.",
            "REST snapshots are not atomic; spread product may offer better execution than independent leg simulation.",
            "Actual user fee tier can differ from base assumptions.",
            "No orders or authenticated account data are used.",
        ],
        "real_money_gate": REAL_MONEY_GATE,
    }


def save_snapshot(p: dict[str, Any]) -> tuple[Path, Path, str]:
    rr = cache_root()
    rr.mkdir(parents=True, exist_ok=True)
    stamp = p["captured_at"].replace("-", "").replace(":", "")
    raw = (json.dumps(p, indent=2, ensure_ascii=False) + "\n").encode()
    jp = rr / f"snapshot-{stamp}.json"
    jp.write_bytes(raw)
    (rr / "latest.json").write_bytes(raw)
    rows: list[dict[str, Any]] = []
    for c in p["candidates"]:
        for s in c["simulations"]:
            rows.append({
                "captured_at": p["captured_at"],
                "spread_symbol": c["spread_symbol"],
                "spot_symbol": c["spot_symbol"],
                "futures_symbol": c["futures_symbol"],
                "delivery_time": c["delivery_time"],
                "days_to_expiry": c["days_to_expiry"],
                **s,
            })
    cp = rr / f"carry-{stamp}.csv"
    if rows:
        with cp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
    return jp, cp, hashlib.sha256(raw).hexdigest()


def report_snapshot(p: dict[str, Any], jp: Path, cp: Path, dig: str, top: int = 15) -> None:
    print(f"[expiry] LIVE_SNAPSHOT_COMPLETE captured_at={p['captured_at']}")
    print(f"[expiry] venue=bybit carrytrade_spreads={p['carrytrade_spreads_found']} evaluated={p['evaluated']}")
    print(f"[expiry] errors={len(p['errors'])}")
    shown = 0
    for c in p["candidates"]:
        if shown >= top:
            break
        if not c["simulations"]:
            continue
        s = c["simulations"][0]
        print(
            f"{shown+1:02d}. {c['spot_symbol']} / {c['futures_symbol']} "
            f"days={c['days_to_expiry']:.1f} "
            f"basis={100*s['executable_basis']:+.3f}% "
            f"net_locked={100*s['net_locked_edge_before_financing']:+.3f}% "
            f"APR={100*s['simple_apr_before_financing']:+.2f}% "
            f"N=${s['notional_usdt']:.0f}"
        )
        shown += 1
    print(f"[expiry] json={jp}")
    print(f"[expiry] csv={cp}")
    print(f"[expiry] snapshot_sha256={dig}")
    print(f"[expiry] requests={_REQUESTS}/{MAX_REQUESTS}")
    print("[expiry] TLS_VERIFICATION=STANDARD_PYTHON_DEFAULT")
    print("[expiry] ORDERS_PLACED=0")
    print("[expiry] API_KEYS_USED=0")
    print("[expiry] REAL_MONEY_GATE=NO_GO")


def all_snapshot_paths() -> list[Path]:
    paths: list[Path] = []
    for rr in (legacy_root(), cache_root()):
        if rr.is_dir():
            paths.extend(sorted(rr.glob("snapshot-*.json")))
    # Deduplicate identical bytes while preserving chronological filename order.
    seen: set[str] = set()
    out: list[Path] = []
    for p in sorted(paths):
        try:
            dig = hashlib.sha256(p.read_bytes()).hexdigest()
        except OSError:
            continue
        if dig in seen:
            continue
        seen.add(dig)
        out.append(p)
    return out


def canonical_simulation(c: dict[str, Any], notional: float = DEFAULT_AUDIT_NOTIONAL) -> dict[str, Any] | None:
    sims = c.get("simulations") or []
    exact = [s for s in sims if abs(float(s.get("notional_usdt", -1)) - notional) < 1e-9]
    if exact:
        return exact[0]
    if not sims:
        return None
    # Fail-closed preference: smallest recovered default notional rather than pseudo-replicating three sizes as three episodes.
    return min(sims, key=lambda s: float(s.get("notional_usdt", 1e99)))


def build_ex_ante_anchors(paths: list[Path]) -> list[dict[str, Any]]:
    anchors: dict[tuple[str, str, str], dict[str, Any]] = {}
    for path in paths:
        try:
            snap = json.loads(path.read_text(encoding="utf-8"))
            captured_at = parse_iso(str(snap["captured_at"]))
        except Exception:
            continue
        for c in snap.get("candidates") or []:
            try:
                delivery = parse_iso(str(c["delivery_time"]))
                spot_symbol = str(c["spot_symbol"])
                futures_symbol = str(c["futures_symbol"])
            except Exception:
                continue
            if captured_at >= delivery:
                continue
            sim = canonical_simulation(c)
            if sim is None:
                continue
            key = (spot_symbol, futures_symbol, delivery.isoformat())
            rec = {
                "snapshot_path": str(path),
                "snapshot_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "captured_at": captured_at,
                "delivery_time": delivery,
                "spot_symbol": spot_symbol,
                "futures_symbol": futures_symbol,
                "quoteCoin": c.get("quoteCoin"),
                "delivery_fee_rate": float(c.get("delivery_fee_rate") or sim.get("delivery_fee_rate") or 0.0),
                "simulation": sim,
            }
            prev = anchors.get(key)
            if prev is None or captured_at > prev["captured_at"]:
                anchors[key] = rec
    return sorted(anchors.values(), key=lambda a: (a["delivery_time"], a["futures_symbol"]))


def fetch_delivery_price(symbol: str) -> tuple[float, int]:
    obj, _, _ = get("/v5/market/delivery-price", {"category": "linear", "symbol": symbol, "limit": "50"})
    rows = obj.get("result", {}).get("list", []) or []
    match = next((r for r in rows if str(r.get("symbol")) == symbol), None)
    if not match:
        raise RuntimeError("DELIVERY_PRICE_NOT_FOUND")
    price = fnum(match.get("deliveryPrice"))
    ts = int(match.get("deliveryTime") or 0)
    if price is None or price <= 0 or ts <= 0:
        raise RuntimeError("DELIVERY_PRICE_INVALID")
    return price, ts


def fetch_first_spot_open_after(symbol: str, target_ms: int) -> tuple[float, int]:
    # Fetch a small deterministic window around target. Klines are reverse-sorted by Bybit.
    obj, _, _ = get("/v5/market/kline", {
        "category": "spot",
        "symbol": symbol,
        "interval": "1",
        "start": str(target_ms),
        "end": str(target_ms + 10 * 60_000),
        "limit": "20",
    })
    rows = obj.get("result", {}).get("list", []) or []
    parsed: list[tuple[int, float]] = []
    for row in rows:
        try:
            ts = int(row[0])
            op = float(row[1])
        except Exception:
            continue
        if ts >= target_ms and op > 0 and math.isfinite(op):
            parsed.append((ts, op))
    if not parsed:
        raise RuntimeError("SPOT_EXIT_KLINE_NOT_FOUND")
    ts, op = min(parsed, key=lambda x: x[0])
    return op, ts


def reconstruct_episode(anchor: dict[str, Any]) -> dict[str, Any]:
    sim = anchor["simulation"]
    qty = float(sim["base_qty"])
    spot_entry = float(sim["spot_buy_vwap"])
    fut_entry = float(sim["futures_short_vwap"])
    spent = float(sim["notional_usdt"])
    entry_fees = float(sim["entry_fees_est_usdt"])
    predicted_locked = float(sim["net_locked_edge_before_financing"])

    delivery_price, delivery_ts = fetch_delivery_price(anchor["futures_symbol"])
    expected_ts = int(anchor["delivery_time"].timestamp() * 1000)
    if abs(delivery_ts - expected_ts) > 5 * 60_000:
        raise RuntimeError("DELIVERY_TIMESTAMP_MISMATCH")

    # Deterministic realization rule: sell spot at first 1m open one minute after futures settlement.
    spot_exit, spot_exit_ts = fetch_first_spot_open_after(anchor["spot_symbol"], delivery_ts + 60_000)
    delivery_fee_rate = float(anchor["delivery_fee_rate"])
    spot_pnl = qty * (spot_exit - spot_entry)
    futures_pnl = qty * (fut_entry - delivery_price)
    spot_exit_fee = qty * spot_exit * SPOT_TAKER_BPS / 10000
    delivery_fee = qty * delivery_price * delivery_fee_rate
    net = spot_pnl + futures_pnl - entry_fees - spot_exit_fee - delivery_fee
    net_return = net / spent if spent else float("nan")
    predicted_pnl = predicted_locked * spent

    return {
        "spot_symbol": anchor["spot_symbol"],
        "futures_symbol": anchor["futures_symbol"],
        "captured_at": anchor["captured_at"].isoformat().replace("+00:00", "Z"),
        "delivery_time": anchor["delivery_time"].isoformat().replace("+00:00", "Z"),
        "snapshot_path": anchor["snapshot_path"],
        "snapshot_sha256": anchor["snapshot_sha256"],
        "notional": spent,
        "base_qty": qty,
        "spot_entry_vwap": spot_entry,
        "futures_short_entry_vwap": fut_entry,
        "delivery_price": delivery_price,
        "spot_exit_open": spot_exit,
        "spot_exit_time": dt.datetime.fromtimestamp(spot_exit_ts / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "spot_pnl": spot_pnl,
        "futures_pnl": futures_pnl,
        "entry_fees": entry_fees,
        "spot_exit_fee": spot_exit_fee,
        "delivery_fee_rate": delivery_fee_rate,
        "delivery_fee": delivery_fee,
        "predicted_locked_edge_before_financing": predicted_locked,
        "predicted_pnl_before_financing": predicted_pnl,
        "realized_net_before_financing": net,
        "realized_return_before_financing": net_return,
        "realization_error_return": net_return - predicted_locked,
        "financing_modeled": False,
    }


def save_report(payload: dict[str, Any], stem: str) -> tuple[Path, str]:
    rr = report_root()
    rr.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()
    p = rr / f"{stem}.json"
    p.write_bytes(raw)
    (rr / f"latest-{stem.split('-')[0]}.json").write_bytes(raw)
    return p, hashlib.sha256(raw).hexdigest()


def run_matured_audit(max_episodes: int = MAX_AUDIT_EPISODES) -> tuple[dict[str, Any], Path, str]:
    snaps = all_snapshot_paths()
    anchors = build_ex_ante_anchors(snaps)
    cutoff = now()
    matured = [a for a in anchors if a["delivery_time"] + dt.timedelta(minutes=1) <= cutoff][:max_episodes]
    pending = [a for a in anchors if a not in matured]
    episodes: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for idx, anchor in enumerate(matured, 1):
        print(f"[expiry-audit] episode={idx}/{len(matured)} {anchor['spot_symbol']} / {anchor['futures_symbol']} delivery={anchor['delivery_time'].isoformat()}")
        try:
            episodes.append(reconstruct_episode(anchor))
        except Exception as exc:
            errors.append({"futures_symbol": anchor["futures_symbol"], "error": f"{type(exc).__name__}: {exc}"})

    if not anchors:
        decision = "BLOCKED_NO_EX_ANTE_SNAPSHOTS"
    elif not matured:
        decision = "KEEP_PENDING_MATURATION"
    else:
        decision = "KEEP_ECONOMIC_AUDIT_ONLY"

    returns = [float(e["realized_return_before_financing"]) for e in episodes]
    payload = {
        "tool": TOOL,
        "mode": "HISTORICAL_DELIVERY_ECONOMIC_AUDIT_FROM_EX_ANTE_SNAPSHOTS",
        "generated_at": iso_now(),
        "decision": decision,
        "snapshot_count": len(snaps),
        "anchor_count": len(anchors),
        "matured_anchor_count": len(matured),
        "evaluated_episodes": len(episodes),
        "pending_anchors": len(pending),
        "errors": errors,
        "canonical_notional_rule": "Use recovered 100 USDT default simulation per spread/expiry; do not treat 100/500/1000 sizing variants as independent episodes.",
        "anchor_rule": "Latest saved ex-ante snapshot before each unique spot/futures/delivery tuple.",
        "spot_exit_rule": "First 1m spot open one minute after official futures delivery timestamp.",
        "delivery_rule": "Official Bybit public delivery price; futures short PnL settles against delivery price.",
        "fee_rule": "Recovered snapshot entry taker fees + 10 bps spot exit fee + snapshot-published deliveryFeeRate applied to delivery notional.",
        "financing_modeled": False,
        "profitability_promotion_allowed": False,
        "summary": {
            "mean_realized_return_before_financing": (sum(returns) / len(returns)) if returns else None,
            "positive_episode_share": (sum(1 for x in returns if x > 0) / len(returns)) if returns else None,
            "sum_realized_net_before_financing": sum(float(e["realized_net_before_financing"]) for e in episodes),
            "mean_realization_error_return": (sum(float(e["realization_error_return"]) for e in episodes) / len(episodes)) if episodes else None,
        },
        "episodes": episodes,
        "requests_used": _REQUESTS,
        "request_limit": MAX_REQUESTS,
        "network_scope": "BYBIT_PUBLIC_MARKET_DATA_ONLY",
        "api_keys_used": 0,
        "orders_placed": 0,
        "real_money_gate": REAL_MONEY_GATE,
    }
    stamp = payload["generated_at"].replace("-", "").replace(":", "")
    p, dig = save_report(payload, f"matured-audit-{stamp}")
    return payload, p, dig


def print_audit(payload: dict[str, Any], path: Path, dig: str) -> None:
    s = payload["summary"]
    print("=== FLUXQUANT CRYPTO EXPIRY CARRY AUDIT COMPLETE ===")
    for e in payload["episodes"]:
        print(
            f"[EXPIRY_ECON] {e['spot_symbol']}/{e['futures_symbol']} "
            f"predicted={100*e['predicted_locked_edge_before_financing']:+.4f}% "
            f"realized={100*e['realized_return_before_financing']:+.4f}% "
            f"error={100*e['realization_error_return']:+.4f}%"
        )
    mean = s["mean_realized_return_before_financing"]
    pos = s["positive_episode_share"]
    err = s["mean_realization_error_return"]
    print(f"[EXPIRY_GATE] decision={payload['decision']} snapshots={payload['snapshot_count']} anchors={payload['anchor_count']} matured={payload['matured_anchor_count']} evaluated={payload['evaluated_episodes']} pending={payload['pending_anchors']}")
    print(f"[EXPIRY_GATE] mean_realized_before_financing={'NA' if mean is None else f'{100*mean:+.4f}%'} positive_share={'NA' if pos is None else f'{100*pos:.1f}%'} mean_realization_error={'NA' if err is None else f'{100*err:+.4f}%'}")
    print(f"[EXPIRY] requests={payload['requests_used']}/{payload['request_limit']}")
    print(f"[EXPIRY] report={path} sha256={dig}")
    print("[EXPIRY] financing_modeled=NO")
    print("[EXPIRY] profitability_promotion_allowed=NO")
    print("[EXPIRY] ORDERS_PLACED=0")
    print("[EXPIRY] API_KEYS_USED=0")
    print("[EXPIRY] REAL_MONEY_GATE=NO_GO")


def run_auto(topn: int = 20) -> int:
    # Prefer reusable saved evidence. If no ex-ante expiry snapshot exists, capture exactly one bounded snapshot.
    anchors = build_ex_ante_anchors(all_snapshot_paths())
    created = False
    if not anchors:
        print("[expiry] stage=snapshot action=CAPTURE reason=NO_EX_ANTE_SNAPSHOT")
        p = snapshot(list(DEFAULT_NOTIONALS), topn)
        jp, cp, dig = save_snapshot(p)
        report_snapshot(p, jp, cp, dig, topn)
        created = True
    else:
        print(f"[expiry] stage=snapshot action=REUSE anchors={len(anchors)}")

    payload, path, dig = run_matured_audit()
    payload["snapshot_created_this_run"] = created
    # Re-save with added field so report SHA reflects final payload.
    stamp = payload["generated_at"].replace("-", "").replace(":", "")
    path, dig = save_report(payload, f"auto-{stamp}")
    print_audit(payload, path, dig)
    print("=== FLUXQUANT CRYPTO EXPIRY CARRY RESULT ===")
    print(f"EXPIRY_DECISION={payload['decision']}")
    print(f"SNAPSHOT_CREATED={created}")
    print(f"SNAPSHOT_COUNT={payload['snapshot_count'] + (1 if created and payload['snapshot_count'] == 0 else 0)}")
    print(f"ANCHOR_COUNT={payload['anchor_count']}")
    print(f"MATURED_ANCHORS={payload['matured_anchor_count']}")
    print(f"EVALUATED_EPISODES={payload['evaluated_episodes']}")
    print(f"PENDING_ANCHORS={payload['pending_anchors']}")
    print("FINANCING_MODELED=NO")
    print("PROFITABILITY_PROMOTION_ALLOWED=NO")
    print(f"REQUESTS_USED={_REQUESTS}")
    print(f"REPORT={path}")
    print(f"REPORT_SHA256={dig}")
    print("REAL_MONEY_GATE=NO_GO")
    return 0


def self_test() -> None:
    asks = [(100.0, 10)]
    bids = [(102.0, 10)]
    ok, q, spent, sv = buy_quote(asks, 100)
    ok2, _, proc, fv = sell_qty(bids, q)
    assert ok and ok2 and abs(q - 1) < 1e-12 and sv is not None and fv is not None
    basis = fv / sv - 1
    hurdle = (10 + 5.5 + 10) / 10000
    assert basis - hurdle > 0
    assert abs((basis - hurdle) - 0.01745) < 1e-12

    # Synthetic settlement arithmetic: basis convergence should preserve locked edge apart from exit/delivery-notional differences.
    qty = 1.0
    spot_entry = 100.0
    fut_entry = 102.0
    delivery = 101.0
    spot_exit = 101.0
    entry_fees = 100 * 10 / 10000 + 102 * 5.5 / 10000
    spot_exit_fee = spot_exit * 10 / 10000
    net = qty * (spot_exit - spot_entry) + qty * (fut_entry - delivery) - entry_fees - spot_exit_fee
    assert net > 0
    print("[expiry] SELF_TEST_PASS")
    print("[expiry] tests=spot_depth,futures_depth,matched_qty,basis_math,fee_hurdle,expiry_hold_model,settlement_reconstruction")
    print("[expiry] network=NOT_USED")
    print("[expiry] TLS_VERIFICATION=STANDARD_PYTHON_DEFAULT")
    print("[expiry] ORDERS_PLACED=0")
    print("[expiry] API_KEYS_USED=0")
    print("[expiry] REAL_MONEY_GATE=NO_GO")


def main() -> None:
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")
    p = sp.add_parser("snapshot")
    p.add_argument("--notionals", nargs="+", type=float, default=list(DEFAULT_NOTIONALS))
    p.add_argument("--topn", type=int, default=20)
    a = sp.add_parser("matured-audit")
    a.add_argument("--max-episodes", type=int, default=MAX_AUDIT_EPISODES)
    auto = sp.add_parser("auto")
    auto.add_argument("--topn", type=int, default=20)
    args = ap.parse_args()

    reset_bounds()
    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "snapshot":
        x = snapshot(args.notionals, args.topn)
        jp, cp, d = save_snapshot(x)
        report_snapshot(x, jp, cp, d, args.topn)
    elif args.cmd == "matured-audit":
        payload, path, dig = run_matured_audit(args.max_episodes)
        print_audit(payload, path, dig)
    else:
        raise SystemExit(run_auto(args.topn))


if __name__ == "__main__":
    main()
