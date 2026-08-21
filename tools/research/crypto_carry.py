#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from pathlib import Path

import crypto_carry_snapshot as scanner

TOOL = "FluxQuant Funding Carry Research Assistant"
MODE = "READ_ONLY_PAPER_RESEARCH"
REAL_MONEY_GATE = "NO_GO"
BASE = "https://api.bybit.com"

DEFAULT_HISTORY_LIMIT = 200
DEFAULT_TOP_PER_SNAPSHOT = 5
DEFAULT_HISTORY_SYMBOL_CAP = 10
AUTO_TOPN = 5
AUTO_NOTIONALS = [100.0, 500.0, 1000.0]
AUTO_REUSE_FRESH_MINUTES = 15
MAX_AUTO_REQUESTS = 20
AUTO_RUNTIME_SECONDS = 600
_REQUESTS = 0
_AUTO_STARTED = None
_REQUEST_LIMIT = MAX_AUTO_REQUESTS
_RUNTIME_LIMIT = AUTO_RUNTIME_SECONDS

def utcnow():
    return dt.datetime.now(dt.timezone.utc)

def iso_now():
    return utcnow().replace(microsecond=0).isoformat().replace("+00:00", "Z")

def parse_iso(s):
    if not s:
        return None
    return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))

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

def carry_roots():
    # Read new canonical cache first, while preserving automatic compatibility
    # with the historical standalone runner path.
    return [
        root() / "cache" / "bybit" / "carry" / "snapshots",
        root() / "data" / "crypto-carry-paper",
    ]

def research_root():
    p = root() / "reports" / "research" / "crypto-carry"
    p.mkdir(parents=True, exist_ok=True)
    return p

def get_json(path, params=None, timeout=15):
    global _REQUESTS
    _REQUESTS += 1
    if _REQUESTS > _REQUEST_LIMIT:
        raise RuntimeError("CRYPTO_CARRY_MAX_REQUESTS_EXCEEDED")
    if _AUTO_STARTED is not None and (time.monotonic() - _AUTO_STARTED) > _RUNTIME_LIMIT:
        raise RuntimeError("CRYPTO_CARRY_RUNTIME_BOUND_EXCEEDED")
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    started = time.time_ns()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "FluxQuant-Crypto-Carry-Research/1.5",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    ended = time.time_ns()
    obj = json.loads(raw.decode("utf-8"))
    if int(obj.get("retCode", -1)) != 0:
        raise RuntimeError("BYBIT_ERROR:%s" % obj.get("retMsg"))
    return obj, (ended-started)/1e6, hashlib.sha256(raw).hexdigest()

def fnum(x):
    try:
        y = float(x)
        return y if math.isfinite(y) else None
    except Exception:
        return None

def ms_int(x):
    try:
        return int(x)
    except Exception:
        return None

def load_snapshots():
    rows = []
    seen = set()
    for rr in carry_roots():
        for p in sorted(rr.glob("snapshot-*.json")):
            try:
                obj = json.loads(p.read_text(encoding="utf-8"))
                cap = parse_iso(obj.get("captured_at"))
                if not cap:
                    continue
                key = (obj.get("captured_at"), hashlib.sha256(p.read_bytes()).hexdigest())
                if key in seen:
                    continue
                seen.add(key)
                rows.append((cap, p, obj))
            except Exception:
                continue
    rows.sort(key=lambda x: x[0])
    return rows

def candidate_record(payload, symbol):
    for rank, c in enumerate(payload.get("candidates") or [], 1):
        if c.get("symbol") != symbol:
            continue
        sim = (c.get("depth_simulations") or [None])[0]
        basis = None
        notional = None
        fee_rate = None
        fee_cycles = None
        if sim:
            basis = fnum(sim.get("depth_entry_basis"))
            notional = fnum(sim.get("notional_usdt"))
            fee_cycles = fnum(sim.get("funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged"))
            fees = fnum(sim.get("estimated_full_roundtrip_fees_usdt"))
            if fees is not None and notional:
                fee_rate = fees / notional
        if basis is None:
            basis = fnum(c.get("executable_entry_basis"))
        fr = fnum(c.get("funding_rate"))
        if fee_rate is None:
            sf = fnum(payload.get("assumed_spot_taker_fee_bps"))
            pf = fnum(payload.get("assumed_perp_taker_fee_bps"))
            if sf is not None and pf is not None:
                fee_rate = 2.0 * (sf + pf) / 10000.0
        if fee_cycles is None and fr and fee_rate is not None:
            fee_cycles = fee_rate / fr

        # Conservative scenario: do not credit positive basis, but penalize
        # negative entry basis as though it later converges to zero.
        adverse_basis = max(0.0, -(basis or 0.0))
        stress_cycles = None
        if fr and fr > 0 and fee_rate is not None:
            stress_cycles = (fee_rate + adverse_basis) / fr

        return {
            "symbol": symbol,
            "rank": rank,
            "funding_rate": fr,
            "funding_rate_pct": (fr*100 if fr is not None else None),
            "basis": basis,
            "basis_pct": (basis*100 if basis is not None else None),
            "next_funding_time": c.get("next_funding_time"),
            "funding_interval_hours": fnum(c.get("funding_interval_hours")),
            "notional_usdt": notional,
            "roundtrip_fee_rate_est": fee_rate,
            "fee_only_cycles": fee_cycles,
            "adverse_basis_to_zero_rate": adverse_basis,
            "stress_cycles_if_negative_basis_goes_to_zero": stress_cycles,
        }
    return None

def snapshot_index(payload):
    out = {}
    for c in payload.get("candidates") or []:
        sym = c.get("symbol")
        if sym:
            out[sym] = candidate_record(payload, sym)
    return out

def compare_payloads(a, b):
    ia = snapshot_index(a)
    ib = snapshot_index(b)
    syms = sorted(set(ia) | set(ib))
    rows = []
    for sym in syms:
        x = ia.get(sym)
        y = ib.get(sym)
        row = {
            "symbol": sym,
            "old": x,
            "new": y,
            "status": (
                "PERSISTED" if x and y else
                "ENTERED_SAVED_TOP" if y else
                "DROPPED_FROM_SAVED_TOP"
            ),
        }
        if x and y:
            if x.get("funding_rate") is not None and y.get("funding_rate") is not None:
                row["funding_delta"] = y["funding_rate"] - x["funding_rate"]
                row["funding_delta_pct_points"] = 100 * row["funding_delta"]
            if x.get("basis") is not None and y.get("basis") is not None:
                row["basis_delta"] = y["basis"] - x["basis"]
                row["basis_delta_pct_points"] = 100 * row["basis_delta"]
            row["rank_delta"] = x["rank"] - y["rank"]
        rows.append(row)

    def score(r):
        y = r.get("new")
        x = r.get("old")
        fr = (y or x or {}).get("funding_rate")
        return -(fr if fr is not None else -999)
    rows.sort(key=score)
    return {
        "old_captured_at": a.get("captured_at"),
        "new_captured_at": b.get("captured_at"),
        "old_saved_candidates": len(a.get("candidates") or []),
        "new_saved_candidates": len(b.get("candidates") or []),
        "rows": rows,
        "warning": "DROPPED_FROM_SAVED_TOP means absent from the saved top-N snapshot, not proven zero funding.",
    }

def percentile_rank(values, x):
    vals = [v for v in values if v is not None]
    if not vals or x is None:
        return None
    return 100.0 * sum(v <= x for v in vals) / len(vals)

def quantile(values, q):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    pos = q * (len(vals)-1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return vals[lo]
    w = pos - lo
    return vals[lo]*(1-w) + vals[hi]*w

def max_streak(rates, predicate):
    best = cur = 0
    for r in rates:
        if predicate(r):
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best

def conditional_persistence(rates, threshold, future_cycles):
    # Trigger on rate >= threshold. Then ask whether ALL of the next
    # `future_cycles` settlements also remain >= threshold.
    eligible = 0
    success = 0
    for i, r in enumerate(rates):
        if r < threshold:
            continue
        if i + future_cycles >= len(rates):
            continue
        eligible += 1
        if all(rates[i+j] >= threshold for j in range(1, future_cycles+1)):
            success += 1
    return {
        "threshold": threshold,
        "future_cycles": future_cycles,
        "eligible_triggers": eligible,
        "successes": success,
        "probability": success/eligible if eligible else None,
    }

def next_positive_probability(rates, trigger_threshold):
    eligible = success = 0
    for i, r in enumerate(rates[:-1]):
        if r >= trigger_threshold:
            eligible += 1
            if rates[i+1] > 0:
                success += 1
    return {
        "trigger_threshold": trigger_threshold,
        "eligible_triggers": eligible,
        "successes": success,
        "probability": success/eligible if eligible else None,
    }

def fetch_funding_history(symbol, limit=200):
    obj, lat, digest = get_json(
        "/v5/market/funding/history",
        {"category":"linear", "symbol":symbol, "limit":str(limit)},
    )
    rows = []
    for x in obj["result"].get("list") or []:
        r = fnum(x.get("fundingRate"))
        ts = ms_int(x.get("fundingRateTimestamp"))
        if r is None or ts is None:
            continue
        rows.append({"rate":r, "timestamp_ms":ts})
    rows.sort(key=lambda x:x["timestamp_ms"])
    return rows, lat, digest

def fetch_instrument(symbol):
    obj, lat, digest = get_json(
        "/v5/market/instruments-info",
        {"category":"linear", "symbol":symbol},
    )
    xs = obj["result"].get("list") or []
    if not xs:
        raise RuntimeError("INSTRUMENT_NOT_FOUND:%s" % symbol)
    x = xs[0]
    return {
        "funding_interval_minutes": fnum(x.get("fundingInterval")),
        "upper_funding_rate": fnum(x.get("upperFundingRate")),
        "lower_funding_rate": fnum(x.get("lowerFundingRate")),
        "status": x.get("status"),
    }, lat, digest

def historical_analysis(symbol, current_quote=None, limit=200):
    history, hlat, hdig = fetch_funding_history(symbol, limit)
    inst, ilat, idig = fetch_instrument(symbol)
    rates = [x["rate"] for x in history]
    tss = [x["timestamp_ms"] for x in history]
    spacings_min = [
        (tss[i]-tss[i-1])/60000.0 for i in range(1, len(tss))
        if tss[i] > tss[i-1]
    ]

    out = {
        "symbol":symbol,
        "history_count":len(rates),
        "history_first_time": (
            dt.datetime.fromtimestamp(tss[0]/1000, dt.timezone.utc).isoformat().replace("+00:00","Z")
            if tss else None
        ),
        "history_last_time": (
            dt.datetime.fromtimestamp(tss[-1]/1000, dt.timezone.utc).isoformat().replace("+00:00","Z")
            if tss else None
        ),
        "funding_interval_minutes_current":inst["funding_interval_minutes"],
        "observed_median_spacing_minutes":statistics.median(spacings_min) if spacings_min else None,
        "positive_share":sum(r>0 for r in rates)/len(rates) if rates else None,
        "mean_rate":statistics.fmean(rates) if rates else None,
        "median_rate":statistics.median(rates) if rates else None,
        "p90_rate":quantile(rates,0.90),
        "p95_rate":quantile(rates,0.95),
        "max_rate":max(rates) if rates else None,
        "min_rate":min(rates) if rates else None,
        "max_positive_streak":max_streak(rates, lambda r:r>0),
        "current_quote":current_quote,
        "current_quote_percentile_vs_settled_history":percentile_rank(rates,current_quote),
        "history_latency_ms":hlat,
        "instrument_latency_ms":ilat,
        "history_sha256":hdig,
        "instrument_sha256":idig,
        "upper_funding_rate":inst["upper_funding_rate"],
        "lower_funding_rate":inst["lower_funding_rate"],
    }

    if current_quote is not None and current_quote > 0:
        half = 0.5 * current_quote
        same = current_quote
        out["half_current_threshold"] = half
        out["historical_count_ge_half_current"] = sum(r>=half for r in rates)
        out["historical_count_ge_current"] = sum(r>=same for r in rates)
        out["max_streak_ge_half_current"] = max_streak(rates, lambda r:r>=half)
        out["next_positive_after_ge_half_current"] = next_positive_probability(rates, half)
        out["persistence_ge_half_current_1_more"] = conditional_persistence(rates, half, 1)
        out["persistence_ge_half_current_2_more"] = conditional_persistence(rates, half, 2)
        out["persistence_ge_half_current_3_more"] = conditional_persistence(rates, half, 3)
        out["persistence_ge_current_1_more"] = conditional_persistence(rates, same, 1)
        out["persistence_ge_current_2_more"] = conditional_persistence(rates, same, 2)
    return out

def default_history_symbols(snaps, top_per_snapshot=5, cap=10):
    syms = []
    for _,_,p in snaps[-2:]:
        for c in (p.get("candidates") or [])[:top_per_snapshot]:
            s = c.get("symbol")
            if s and s not in syms:
                syms.append(s)
    return syms[:cap]

def latest_quote_for_symbol(snaps, symbol):
    for cap,pth,p in reversed(snaps):
        rec = candidate_record(p, symbol)
        if rec:
            return cap,pth,p,rec
    return None

def save_json(prefix, payload):
    rr = research_root()
    stamp = payload.get("captured_at", iso_now()).replace("-","").replace(":","")
    raw = (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode()
    p = rr / f"{prefix}-{stamp}.json"
    p.write_bytes(raw)
    (rr / f"latest-{prefix}.json").write_bytes(raw)
    return p, hashlib.sha256(raw).hexdigest()

def run_compare():
    snaps = load_snapshots()
    if len(snaps) < 2:
        raise RuntimeError("NEED_AT_LEAST_TWO_CARRY_SNAPSHOTS")
    _,_,a = snaps[-2]
    _,_,b = snaps[-1]
    cmp = compare_payloads(a,b)
    payload = {
        "tool":TOOL,
        "mode":MODE,
        "captured_at":iso_now(),
        "comparison":cmp,
        "real_money_gate":REAL_MONEY_GATE,
    }
    p,d = save_json("compare",payload)
    return payload,p,d

def print_compare(payload, top=20):
    cmp = payload["comparison"]
    print(f"[research] COMPARE old={cmp['old_captured_at']} new={cmp['new_captured_at']}")
    for r in cmp["rows"][:top]:
        x=r.get("old"); y=r.get("new")
        if x and y:
            print(
                f"CMP {r['symbol']} rank={x['rank']}->{y['rank']} "
                f"funding={x['funding_rate_pct']:+.4f}%->{y['funding_rate_pct']:+.4f}% "
                f"basis={x['basis_pct']:+.4f}%->{y['basis_pct']:+.4f}% "
                f"stress_cycles={y['stress_cycles_if_negative_basis_goes_to_zero']:.2f}"
            )
        elif y:
            print(
                f"CMP {r['symbol']} ENTERED_SAVED_TOP rank={y['rank']} "
                f"funding={y['funding_rate_pct']:+.4f}% basis={y['basis_pct']:+.4f}%"
            )
        else:
            print(
                f"CMP {r['symbol']} DROPPED_FROM_SAVED_TOP "
                f"old_rank={x['rank']} old_funding={x['funding_rate_pct']:+.4f}%"
            )
    print("[research] note=DROPPED_FROM_SAVED_TOP_DOES_NOT_MEAN_ZERO_FUNDING")

def run_history(symbols=None, limit=200):
    snaps=load_snapshots()
    if not symbols:
        symbols=default_history_symbols(snaps)
    analyses=[]
    errors=[]
    for sym in symbols:
        q=latest_quote_for_symbol(snaps,sym)
        current=q[3]["funding_rate"] if q else None
        try:
            analyses.append(historical_analysis(sym,current,limit))
        except Exception as e:
            errors.append({"symbol":sym,"error":f"{type(e).__name__}: {e}"})
    payload={
        "tool":TOOL,"mode":MODE,"captured_at":iso_now(),
        "history_limit":limit,
        "symbols":symbols,
        "analyses":analyses,
        "errors":errors,
        "real_money_gate":REAL_MONEY_GATE,
    }
    p,d=save_json("history",payload)
    return payload,p,d

def pct(x):
    return "NA" if x is None else f"{100*x:+.4f}%"

def prob(x):
    return "NA" if x is None else f"{100*x:.1f}%"

def print_history(payload):
    print(f"[research] HISTORY symbols={len(payload['symbols'])} errors={len(payload['errors'])}")
    for a in payload["analyses"]:
        p1=(a.get("persistence_ge_half_current_1_more") or {}).get("probability")
        p2=(a.get("persistence_ge_half_current_2_more") or {}).get("probability")
        p3=(a.get("persistence_ge_half_current_3_more") or {}).get("probability")
        print(
            f"HIST {a['symbol']} n={a['history_count']} current={pct(a['current_quote'])} "
            f"pctl={a['current_quote_percentile_vs_settled_history'] if a['current_quote_percentile_vs_settled_history'] is not None else 'NA'} "
            f"median={pct(a['median_rate'])} p95={pct(a['p95_rate'])} max={pct(a['max_rate'])} "
            f"persist_half[next1={prob(p1)} next2={prob(p2)} next3={prob(p3)}]"
        )

def settlement_target_for_symbol(snaps, symbol):
    # Use the latest quote for the symbol whose next_funding_time exists.
    # If multiple snapshots quote the same target, latest pre-target quote wins.
    candidates=[]
    for cap,pth,p in snaps:
        rec=candidate_record(p,symbol)
        if not rec or not rec.get("next_funding_time"):
            continue
        target=parse_iso(rec["next_funding_time"])
        if target:
            candidates.append((target,cap,pth,p,rec))
    if not candidates:
        return None
    # Prefer the latest target not later than now; otherwise nearest future.
    now=utcnow()
    past=[x for x in candidates if x[0] <= now]
    pool=past if past else candidates
    target=max(pool,key=lambda x:x[0])[0] if past else min(pool,key=lambda x:x[0])[0]
    same=[x for x in candidates if x[0]==target and x[1] < target]
    if not same:
        same=[x for x in candidates if x[0]==target]
    return max(same,key=lambda x:x[1]) if same else None

def verify_symbol(snaps, symbol):
    target_info=settlement_target_for_symbol(snaps,symbol)
    if not target_info:
        return {"symbol":symbol,"status":"NO_QUOTED_TARGET"}
    target,cap,pth,p,rec=target_info
    now=utcnow()
    if now < target:
        return {
            "symbol":symbol,
            "status":"NOT_READY_TARGET_IN_FUTURE",
            "quoted_at":cap.isoformat().replace("+00:00","Z"),
            "target_time":target.isoformat().replace("+00:00","Z"),
            "quoted_rate":rec["funding_rate"],
        }

    history,lat,dig=fetch_funding_history(symbol,200)
    target_ms=int(target.timestamp()*1000)
    matches=sorted(history,key=lambda x:abs(x["timestamp_ms"]-target_ms))
    match=matches[0] if matches else None
    if not match or abs(match["timestamp_ms"]-target_ms) > 60_000:
        return {
            "symbol":symbol,
            "status":"SETTLED_RECORD_NOT_FOUND_YET",
            "quoted_at":cap.isoformat().replace("+00:00","Z"),
            "target_time":target.isoformat().replace("+00:00","Z"),
            "quoted_rate":rec["funding_rate"],
            "history_latency_ms":lat,
            "history_sha256":dig,
        }

    settled=match["rate"]
    quoted=rec["funding_rate"]
    delta=settled-quoted if quoted is not None else None
    return {
        "symbol":symbol,
        "status":"VERIFIED",
        "quoted_at":cap.isoformat().replace("+00:00","Z"),
        "minutes_before_settlement":(target-cap).total_seconds()/60,
        "target_time":target.isoformat().replace("+00:00","Z"),
        "quoted_rate":quoted,
        "settled_rate":settled,
        "quote_minus_settled_delta":delta,
        "absolute_delta_bps":abs(delta)*10000 if delta is not None else None,
        "settled_over_quoted_ratio":settled/quoted if quoted else None,
        "history_latency_ms":lat,
        "history_sha256":dig,
    }

def run_verify(symbols=None):
    snaps=load_snapshots()
    if not snaps:
        raise RuntimeError("NO_CARRY_SNAPSHOTS")
    if not symbols:
        symbols=default_history_symbols(snaps)
    rows=[]; errors=[]
    for s in symbols:
        try:rows.append(verify_symbol(snaps,s))
        except Exception as e:errors.append({"symbol":s,"error":f"{type(e).__name__}: {e}"})
    payload={
        "tool":TOOL,"mode":MODE,"captured_at":iso_now(),
        "symbols":symbols,"verifications":rows,"errors":errors,
        "real_money_gate":REAL_MONEY_GATE,
    }
    p,d=save_json("verify",payload)
    return payload,p,d

def print_verify(payload):
    print(f"[research] VERIFY symbols={len(payload['symbols'])} errors={len(payload['errors'])}")
    for v in payload["verifications"]:
        if v["status"]=="VERIFIED":
            print(
                f"VER {v['symbol']} quoted={pct(v['quoted_rate'])} settled={pct(v['settled_rate'])} "
                f"delta={v['absolute_delta_bps']:.2f}bps pre={v['minutes_before_settlement']:.1f}m"
            )
        else:
            print(f"VER {v['symbol']} status={v['status']} target={v.get('target_time')}")

def run_research(symbols=None, limit=200):
    cmp_payload,cmp_p,cmp_d=run_compare()
    hist_payload,hist_p,hist_d=run_history(symbols,limit)
    payload={
        "tool":TOOL,"mode":MODE,"captured_at":iso_now(),
        "compare_file":str(cmp_p),"compare_sha256":cmp_d,
        "history_file":str(hist_p),"history_sha256":hist_d,
        "comparison":cmp_payload["comparison"],
        "history":hist_payload,
        "real_money_gate":REAL_MONEY_GATE,
    }
    p,d=save_json("research",payload)
    return payload,p,d

# ECON_BLOCK_MARKER
MAX_ECON_REQUESTS = 40
ECON_RUNTIME_SECONDS = 600
MAX_ECON_EPISODES = 12
MAX_HURDLE_CYCLES = 8
MIN_ECON_EPISODES = 3
MIN_PROMOTE_EPISODES = 8
MIN_POSITIVE_EPISODE_SHARE = 0.60
MAX_POSITIVE_PNL_SHARE = 0.50
BOOTSTRAP_REPS = 5000
BOOTSTRAP_SEED = 20260817


def snapshot_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def economic_anchor_candidates(snaps):
    """Build ex-ante anchors only from snapshots captured before the quoted settlement.

    Duplicate symbol/target quotes use the latest pre-target snapshot, matching the
    existing settlement verifier. To avoid overlapping same-symbol paper positions,
    the economic cohort then keeps the earliest eligible target per symbol.
    """
    by_key = {}
    for cap, pth, payload in snaps:
        for c in payload.get("candidates") or []:
            symbol = c.get("symbol")
            target = parse_iso(c.get("next_funding_time"))
            sims = c.get("depth_simulations") or []
            if not symbol or target is None or cap >= target or not sims:
                continue
            sim = sims[0]
            cycles_raw = fnum(sim.get("funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged"))
            if cycles_raw is None or cycles_raw <= 0:
                continue
            cycles = max(1, int(math.ceil(cycles_raw - 1e-12)))
            key = (symbol, target.isoformat())
            if cycles > MAX_HURDLE_CYCLES:
                continue
            row = {
                "symbol": symbol,
                "target": target,
                "captured_at": cap,
                "snapshot_path": pth,
                "snapshot": payload,
                "candidate": c,
                "simulation": sim,
                "hold_cycles": cycles,
                "fee_hurdle_cycles_raw": cycles_raw,
            }
            old = by_key.get(key)
            if old is None or cap > old["captured_at"]:
                by_key[key] = row

    rows = sorted(by_key.values(), key=lambda x: (x["captured_at"], x["symbol"]))
    selected = []
    used_symbols = set()
    for row in rows:
        if row["symbol"] in used_symbols:
            continue
        selected.append(row)
        used_symbols.add(row["symbol"])
        if len(selected) >= MAX_ECON_EPISODES:
            break
    return selected


def fetch_funding_window(symbol, start_ms, end_ms, limit=200):
    obj, lat, digest = get_json(
        "/v5/market/funding/history",
        {
            "category": "linear",
            "symbol": symbol,
            "startTime": str(start_ms),
            "endTime": str(end_ms),
            "limit": str(limit),
        },
    )
    rows = []
    for x in obj["result"].get("list") or []:
        rate = fnum(x.get("fundingRate"))
        ts = ms_int(x.get("fundingRateTimestamp"))
        if rate is None or ts is None:
            continue
        rows.append({"rate": rate, "timestamp_ms": ts})
    rows.sort(key=lambda x: x["timestamp_ms"])
    return rows, lat, digest


def fetch_exit_open(category, symbol, at_ms):
    # Exit is frozen to the first 1m candle OPEN one full minute after the final
    # funding timestamp. That guarantees the modeled exit occurs after settlement.
    obj, lat, digest = get_json(
        "/v5/market/kline",
        {
            "category": category,
            "symbol": symbol,
            "interval": "1",
            "start": str(at_ms),
            "end": str(at_ms + 180_000),
            "limit": "4",
        },
    )
    candles = []
    for row in obj["result"].get("list") or []:
        if len(row) < 2:
            continue
        ts = ms_int(row[0])
        op = fnum(row[1])
        if ts is not None and op is not None:
            candles.append((ts, op))
    candles.sort()
    for ts, op in candles:
        if ts >= at_ms:
            return {"timestamp_ms": ts, "open": op, "latency_ms": lat, "sha256": digest}
    raise RuntimeError("EXIT_KLINE_NOT_FOUND:%s:%s:%s" % (category, symbol, at_ms))


def bootstrap_mean_ci(values, reps=BOOTSTRAP_REPS, seed=BOOTSTRAP_SEED):
    vals = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    if not vals:
        return [None, None]
    if len(vals) == 1:
        return [vals[0], vals[0]]
    import random
    rng = random.Random(seed)
    n = len(vals)
    means = []
    for _ in range(reps):
        means.append(sum(vals[rng.randrange(n)] for _ in range(n)) / n)
    return [quantile(means, 0.025), quantile(means, 0.975)]


def economic_pnl_math(base_qty, spot_entry, perp_entry, spot_exit, perp_exit, funding_rates, spot_fee_bps, perp_fee_bps, entry_spot_fee=None, entry_perp_fee=None):
    spot_entry_notional = base_qty * spot_entry
    perp_entry_notional = base_qty * perp_entry
    matched_entry_notional = min(spot_entry_notional, perp_entry_notional)
    if entry_spot_fee is None:
        entry_spot_fee = spot_entry_notional * spot_fee_bps / 10000.0
    if entry_perp_fee is None:
        entry_perp_fee = perp_entry_notional * perp_fee_bps / 10000.0
    spot_exit_notional = base_qty * spot_exit
    perp_exit_notional = base_qty * perp_exit
    exit_spot_fee = spot_exit_notional * spot_fee_bps / 10000.0
    exit_perp_fee = perp_exit_notional * perp_fee_bps / 10000.0
    funding_income = matched_entry_notional * sum(funding_rates)
    spot_pnl = base_qty * (spot_exit - spot_entry)
    perp_short_pnl = base_qty * (perp_entry - perp_exit)
    basis_price_pnl = spot_pnl + perp_short_pnl
    total_fees = entry_spot_fee + entry_perp_fee + exit_spot_fee + exit_perp_fee
    net_pnl = basis_price_pnl + funding_income - total_fees
    return {
        "matched_entry_notional_usdt": matched_entry_notional,
        "funding_income_usdt": funding_income,
        "spot_pnl_usdt": spot_pnl,
        "perp_short_pnl_usdt": perp_short_pnl,
        "basis_price_pnl_usdt": basis_price_pnl,
        "entry_fees_usdt": entry_spot_fee + entry_perp_fee,
        "exit_fees_usdt": exit_spot_fee + exit_perp_fee,
        "total_fees_usdt": total_fees,
        "net_pnl_usdt": net_pnl,
        "net_return": net_pnl / matched_entry_notional if matched_entry_notional > 0 else None,
    }


def evaluate_economic_anchor(anchor):
    symbol = anchor["symbol"]
    target = anchor["target"]
    cycles = anchor["hold_cycles"]
    sim = anchor["simulation"]
    payload = anchor["snapshot"]
    candidate = anchor["candidate"]

    base_qty = fnum(sim.get("base_qty"))
    spot_entry = fnum(sim.get("spot_buy_vwap"))
    perp_entry = fnum(sim.get("perp_short_vwap"))
    if not base_qty or not spot_entry or not perp_entry:
        return {"symbol": symbol, "status": "SKIP_ENTRY_DEPTH_FIELDS_MISSING"}
    if cycles > MAX_HURDLE_CYCLES:
        return {
            "symbol": symbol,
            "status": "SKIP_FEE_HURDLE_EXCEEDS_BOUND",
            "hold_cycles": cycles,
            "max_hurdle_cycles": MAX_HURDLE_CYCLES,
        }

    # Query enough actual settlements after the ex-ante target. 7 days covers the
    # bounded <=8-cycle cohort even for common 8h funding intervals.
    target_ms = int(target.timestamp() * 1000)
    horizon_end_ms = min(
        target_ms + 7 * 24 * 60 * 60 * 1000,
        int(utcnow().timestamp() * 1000),
    )
    history, hlat, hdig = fetch_funding_window(symbol, target_ms - 60_000, horizon_end_ms, 200)
    settlements = [x for x in history if x["timestamp_ms"] >= target_ms - 60_000]
    if not settlements or abs(settlements[0]["timestamp_ms"] - target_ms) > 60_000:
        return {
            "symbol": symbol,
            "status": "SKIP_FIRST_SETTLEMENT_NOT_FOUND",
            "target_time": target.isoformat().replace("+00:00", "Z"),
            "history_sha256": hdig,
        }
    settlements = settlements[:cycles]
    if len(settlements) < cycles:
        return {
            "symbol": symbol,
            "status": "PENDING_INSUFFICIENT_SETTLEMENTS",
            "hold_cycles": cycles,
            "settlements_available": len(settlements),
            "history_sha256": hdig,
        }

    final_settlement_ms = settlements[-1]["timestamp_ms"]
    exit_request_ms = final_settlement_ms + 60_000
    now_ms = int(utcnow().timestamp() * 1000)
    if exit_request_ms + 60_000 > now_ms:
        return {
            "symbol": symbol,
            "status": "PENDING_EXIT_NOT_MATURED",
            "hold_cycles": cycles,
            "final_settlement_ms": final_settlement_ms,
            "history_sha256": hdig,
        }

    spot_exit = fetch_exit_open("spot", symbol, exit_request_ms)
    perp_exit = fetch_exit_open("linear", symbol, exit_request_ms)

    spot_fee_bps = fnum(payload.get("assumed_spot_taker_fee_bps"))
    perp_fee_bps = fnum(payload.get("assumed_perp_taker_fee_bps"))
    if spot_fee_bps is None or perp_fee_bps is None:
        return {"symbol": symbol, "status": "SKIP_FEE_ASSUMPTION_MISSING"}

    # Preserve recovered scanner semantics: each funding payment uses the frozen
    # matched entry notional rather than introducing a new mark-notional model.
    actual_rates = [x["rate"] for x in settlements]
    mathrow = economic_pnl_math(
        base_qty, spot_entry, perp_entry, spot_exit["open"], perp_exit["open"],
        actual_rates, spot_fee_bps, perp_fee_bps,
        fnum(sim.get("entry_spot_fee_usdt")), fnum(sim.get("entry_perp_fee_usdt")),
    )
    matched_entry_notional = mathrow["matched_entry_notional_usdt"]
    entry_basis = perp_entry / spot_entry - 1.0
    exit_basis = perp_exit["open"] / spot_exit["open"] - 1.0

    return {
        "symbol": symbol,
        "status": "EVALUATED",
        "snapshot": str(anchor["snapshot_path"]),
        "snapshot_sha256": snapshot_sha256(anchor["snapshot_path"]),
        "captured_at": anchor["captured_at"].isoformat().replace("+00:00", "Z"),
        "first_target_time": target.isoformat().replace("+00:00", "Z"),
        "hold_cycles": cycles,
        "fee_hurdle_cycles_raw": anchor["fee_hurdle_cycles_raw"],
        "base_qty": base_qty,
        "matched_entry_notional_usdt": matched_entry_notional,
        "quoted_first_funding_rate": fnum(candidate.get("funding_rate")),
        "actual_funding_rates": actual_rates,
        "actual_funding_sum_rate": sum(actual_rates),
        "funding_income_usdt": mathrow["funding_income_usdt"],
        "spot_entry": spot_entry,
        "perp_entry": perp_entry,
        "spot_exit": spot_exit["open"],
        "perp_exit": perp_exit["open"],
        "entry_basis": entry_basis,
        "exit_basis": exit_basis,
        "basis_price_pnl_usdt": mathrow["basis_price_pnl_usdt"],
        "spot_pnl_usdt": mathrow["spot_pnl_usdt"],
        "perp_short_pnl_usdt": mathrow["perp_short_pnl_usdt"],
        "entry_fees_usdt": mathrow["entry_fees_usdt"],
        "exit_fees_usdt": mathrow["exit_fees_usdt"],
        "total_fees_usdt": mathrow["total_fees_usdt"],
        "net_pnl_usdt": mathrow["net_pnl_usdt"],
        "net_return": mathrow["net_return"],
        "exit_time": dt.datetime.fromtimestamp(spot_exit["timestamp_ms"] / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "funding_history_latency_ms": hlat,
        "funding_history_sha256": hdig,
        "spot_exit_kline_sha256": spot_exit["sha256"],
        "perp_exit_kline_sha256": perp_exit["sha256"],
        "funding_notional_model": "FROZEN_MATCHED_ENTRY_NOTIONAL",
        "exit_rule": "FIRST_1M_OPEN_ONE_MINUTE_AFTER_FINAL_FEE_HURDLE_SETTLEMENT",
    }


def economic_decision(evaluated):
    returns = [x["net_return"] for x in evaluated if x.get("net_return") is not None]
    n = len(returns)
    mean = statistics.fmean(returns) if returns else None
    ci = bootstrap_mean_ci(returns)
    positive = [x for x in evaluated if (x.get("net_pnl_usdt") or 0.0) > 0]
    positive_share = len(positive) / n if n else None
    positive_pnl = sum(x["net_pnl_usdt"] for x in positive)
    max_positive_share = (
        max(x["net_pnl_usdt"] for x in positive) / positive_pnl
        if positive and positive_pnl > 0 else None
    )

    if n < MIN_ECON_EPISODES:
        decision = "BLOCKED_INSUFFICIENT_MATURED_EPISODES"
    elif ci[1] is not None and ci[1] < 0:
        decision = "KILL_ECONOMIC_PNL"
    elif (
        n >= MIN_PROMOTE_EPISODES
        and mean is not None and mean > 0
        and ci[0] is not None and ci[0] > 0
        and positive_share is not None and positive_share >= MIN_POSITIVE_EPISODE_SHARE
        and max_positive_share is not None and max_positive_share <= MAX_POSITIVE_PNL_SHARE
    ):
        decision = "PROMOTE_TO_SHADOW"
    else:
        decision = "KEEP_ECONOMIC_SIGNAL_UNPROVEN"

    return {
        "decision": decision,
        "episodes": n,
        "mean_net_return": mean,
        "bootstrap_mean_net_95ci": ci,
        "positive_episode_share": positive_share,
        "positive_symbols": len({x["symbol"] for x in positive}),
        "sum_net_pnl_usdt": sum(x["net_pnl_usdt"] for x in evaluated),
        "max_positive_pnl_share": max_positive_share,
        "promotion_checks": {
            "min_episodes": n >= MIN_PROMOTE_EPISODES,
            "mean_net_positive": bool(mean is not None and mean > 0),
            "bootstrap_95_lower_positive": bool(ci[0] is not None and ci[0] > 0),
            "positive_episode_share": bool(positive_share is not None and positive_share >= MIN_POSITIVE_EPISODE_SHARE),
            "positive_pnl_concentration_ok": bool(max_positive_share is not None and max_positive_share <= MAX_POSITIVE_PNL_SHARE),
        },
    }


def run_economic_pnl():
    global _REQUESTS, _AUTO_STARTED, _REQUEST_LIMIT, _RUNTIME_LIMIT
    _REQUESTS = 0
    _AUTO_STARTED = time.monotonic()
    _REQUEST_LIMIT = MAX_ECON_REQUESTS
    _RUNTIME_LIMIT = ECON_RUNTIME_SECONDS

    snaps = load_snapshots()
    if not snaps:
        raise RuntimeError("NO_CARRY_SNAPSHOTS")
    anchors = economic_anchor_candidates(snaps)
    if not anchors:
        raise RuntimeError("NO_EX_ANTE_ECONOMIC_ANCHORS")

    print("[carry-econ] anchors=%d max_episodes=%d max_requests=%d" % (len(anchors), MAX_ECON_EPISODES, MAX_ECON_REQUESTS))
    rows = []
    errors = []
    for i, anchor in enumerate(anchors, 1):
        print("[carry-econ] episode=%d/%d symbol=%s target=%s hurdle_cycles=%d" % (
            i, len(anchors), anchor["symbol"],
            anchor["target"].isoformat().replace("+00:00", "Z"), anchor["hold_cycles"]
        ))
        try:
            rows.append(evaluate_economic_anchor(anchor))
        except Exception as exc:
            errors.append({"symbol": anchor["symbol"], "error": "%s: %s" % (type(exc).__name__, exc)})

    evaluated = [x for x in rows if x.get("status") == "EVALUATED"]
    pending = [x for x in rows if str(x.get("status", "")).startswith("PENDING")]
    skipped = [x for x in rows if x.get("status") != "EVALUATED" and x not in pending]
    gate = economic_decision(evaluated)

    payload = {
        "tool": TOOL,
        "mode": MODE,
        "captured_at": iso_now(),
        "validation": "HISTORICAL_ECONOMIC_PNL_FROM_EX_ANTE_SNAPSHOTS",
        "selection_rule": "LATEST_PRE_TARGET_QUOTE_PER_SYMBOL_TARGET_THEN_EARLIEST_ELIGIBLE_TARGET_PER_SYMBOL",
        "holding_rule": "CEIL(FROZEN_FEE_ONLY_BREAK_EVEN_CYCLES)",
        "max_hurdle_cycles": MAX_HURDLE_CYCLES,
        "max_episodes": MAX_ECON_EPISODES,
        "episodes": rows,
        "errors": errors,
        "evaluated_episodes": len(evaluated),
        "pending_episodes": len(pending),
        "skipped_episodes": len(skipped),
        "gate": gate,
        "requests_used": _REQUESTS,
        "max_requests": MAX_ECON_REQUESTS,
        "runtime_bound_seconds": ECON_RUNTIME_SECONDS,
        "economic_pnl_backtest_completed": len(evaluated) >= MIN_ECON_EPISODES,
        "limitations": [
            "Cohort comes only from snapshots captured live before settlement; it is not a broad all-symbol historical cross-sectional backtest.",
            "Funding cashflow preserves recovered scanner semantics by applying settled rates to frozen matched entry notional.",
            "Entry prices are snapshot depth VWAPs; exit prices are first 1m opens one minute after the final modeled settlement.",
            "Historical exit candles do not reconstruct order-book depth, so exit slippage beyond frozen taker fees is not measured.",
            "No holdout-driven threshold retuning is performed.",
        ],
        "orders_placed": 0,
        "api_keys_used": 0,
        "real_money_gate": REAL_MONEY_GATE,
    }
    p, digest = save_json("economic-pnl", payload)
    return payload, p, digest


def print_economic_pnl(payload, path, digest):
    gate = payload["gate"]
    print("\n=== FLUXQUANT CRYPTO CARRY ECONOMIC PNL COMPLETE ===")
    for row in payload["episodes"]:
        if row.get("status") == "EVALUATED":
            print("[ECON] %s cycles=%d funding=%+.4f%% basis_pnl=%+.4f net=%+.4f return=%+.4f%%" % (
                row["symbol"], row["hold_cycles"], 100 * row["actual_funding_sum_rate"],
                row["basis_price_pnl_usdt"], row["net_pnl_usdt"], 100 * row["net_return"]
            ))
        else:
            print("[ECON] %s status=%s" % (row.get("symbol"), row.get("status")))
    lo, hi = gate["bootstrap_mean_net_95ci"]
    print("[ECON_GATE] decision=%s episodes=%d mean_net=%s ci95=%s positive_share=%s sum_net_usdt=%+.6f" % (
        gate["decision"], gate["episodes"], pct(gate["mean_net_return"]),
        ("NA" if lo is None else "[%s,%s]" % (pct(lo), pct(hi))),
        prob(gate["positive_episode_share"]), gate["sum_net_pnl_usdt"]
    ))
    print("[ECON_GATE] checks=%s" % json.dumps(gate["promotion_checks"], sort_keys=True))
    print("[ECON] evaluated=%d pending=%d skipped=%d requests=%d/%d" % (
        payload["evaluated_episodes"], payload["pending_episodes"], payload["skipped_episodes"],
        payload["requests_used"], payload["max_requests"]
    ))
    print("[ECON] report=%s sha256=%s" % (path, digest))
    print("ORDERS_PLACED=0")
    print("API_KEYS_USED=0")
    print("REAL_MONEY_GATE=NO_GO")


def _fresh_snapshot(snaps):
    if not snaps:
        return None
    cap,pth,payload = snaps[-1]
    age = (utcnow() - cap).total_seconds() / 60.0
    if age <= AUTO_REUSE_FRESH_MINUTES:
        return cap,pth,payload
    return None

def run_auto():
    global _REQUESTS, _AUTO_STARTED, _REQUEST_LIMIT, _RUNTIME_LIMIT
    _REQUESTS = 0
    _AUTO_STARTED = time.monotonic()
    _REQUEST_LIMIT = MAX_AUTO_REQUESTS
    _RUNTIME_LIMIT = AUTO_RUNTIME_SECONDS
    scanner.BASE = BASE

    before = load_snapshots()
    fresh = _fresh_snapshot(before)
    snapshot_created = False
    if fresh is None:
        print("[carry] stage=snapshot action=CAPTURE bounded_topn=%d" % AUTO_TOPN)
        payload = scanner.snapshot(
            scanner.DEFAULT_SPOT_TAKER_BPS,
            scanner.DEFAULT_PERP_TAKER_BPS,
            AUTO_NOTIONALS,
            AUTO_TOPN,
        )
        spath, cpath, sdigest = scanner.save(payload)
        snapshot_created = True
        print("[carry] snapshot=%s sha256=%s" % (spath, sdigest))
    else:
        print("[carry] stage=snapshot action=REUSE_FRESH path=%s" % fresh[1])

    snaps = load_snapshots()
    if not snaps:
        raise RuntimeError("NO_CARRY_SNAPSHOT_AFTER_CAPTURE")

    latest = snaps[-1][2]
    symbols = []
    for c in (latest.get("candidates") or [])[:DEFAULT_TOP_PER_SNAPSHOT]:
        sym = c.get("symbol")
        if sym and sym not in symbols:
            symbols.append(sym)
    if not symbols:
        report = {
            "tool": TOOL,
            "mode": MODE,
            "captured_at": iso_now(),
            "decision": "KEEP",
            "decision_reason": "No current positive-funding candidate; capability retained but no trade hypothesis is promoted.",
            "current_positive_candidates": 0,
            "snapshot_created": snapshot_created,
            "snapshot_count": len(snaps),
            "requests_used": scanner.REQUEST_COUNT + _REQUESTS,
            "max_requests": scanner.MAX_REQUESTS + MAX_AUTO_REQUESTS,
            "next_test": "RESCAN_LATER_WITHOUT_RETUNING",
            "real_money_gate": REAL_MONEY_GATE,
        }
        p,d=save_json("auto",report)
        return report,p,d

    print("[carry] stage=history symbols=%s" % ",".join(symbols))
    hist_payload,hist_p,hist_d=run_history(symbols, DEFAULT_HISTORY_LIMIT)

    comparison = None
    compare_file = None
    compare_sha = None
    if len(snaps) >= 2:
        cmp_payload,cmp_p,cmp_d=run_compare()
        comparison=cmp_payload["comparison"]
        compare_file=str(cmp_p)
        compare_sha=cmp_d

    verify_payload,verify_p,verify_d=run_verify(symbols)
    verified = [x for x in verify_payload["verifications"] if x.get("status") == "VERIFIED"]
    pending = [x for x in verify_payload["verifications"] if x.get("status") != "VERIFIED"]

    report = {
        "tool": TOOL,
        "mode": MODE,
        "captured_at": iso_now(),
        "decision": "KEEP",
        "decision_reason": "Existing carry capability produced valid public-market evidence; this is persistence/settlement research, not a PnL promotion gate.",
        "snapshot_created": snapshot_created,
        "snapshot_count": len(snaps),
        "current_symbols": symbols,
        "history_file": str(hist_p),
        "history_sha256": hist_d,
        "history": hist_payload,
        "compare_file": compare_file,
        "compare_sha256": compare_sha,
        "comparison": comparison,
        "verify_file": str(verify_p),
        "verify_sha256": verify_d,
        "verifications": verify_payload,
        "verified_settlements": len(verified),
        "pending_settlements": len(pending),
        "requests_used": scanner.REQUEST_COUNT + _REQUESTS,
        "max_requests": scanner.MAX_REQUESTS + MAX_AUTO_REQUESTS,
        "runtime_bound_seconds": AUTO_RUNTIME_SECONDS,
        "economic_pnl_backtest_completed": False,
        "next_test": (
            "BUILD_HISTORICAL_ECONOMIC_PNL_VALIDATION_WITH_FROZEN_COSTS"
            if verified else
            "VERIFY_QUOTED_FUNDING_AFTER_SETTLEMENT_THEN_BUILD_ECONOMIC_PNL_VALIDATION"
        ),
        "orders_placed": 0,
        "api_keys_used": 0,
        "real_money_gate": REAL_MONEY_GATE,
    }
    p,d=save_json("auto",report)
    return report,p,d

def print_auto(payload, path, digest):
    print("\n=== FLUXQUANT CRYPTO CARRY COMPLETE ===")
    print("[CARRY] decision=%s" % payload["decision"])
    print("[CARRY] snapshot_count=%s snapshot_created=%s" % (payload["snapshot_count"], payload["snapshot_created"]))
    print("[CARRY] symbols=%s" % ",".join(payload.get("current_symbols") or []))
    print("[CARRY] verified_settlements=%s pending_settlements=%s" % (payload.get("verified_settlements",0), payload.get("pending_settlements",0)))
    print("[CARRY] requests_used=%s/%s runtime_bound=%ss" % (payload.get("requests_used"), payload.get("max_requests"), payload.get("runtime_bound_seconds")))
    print("[CARRY] economic_pnl_backtest_completed=%s" % payload.get("economic_pnl_backtest_completed"))
    print("[CARRY] next_test=%s" % payload.get("next_test"))
    print("[CARRY] report=%s sha256=%s" % (path,digest))
    print("ORDERS_PLACED=0")
    print("API_KEYS_USED=0")
    print("REAL_MONEY_GATE=NO_GO")

def self_test():
    # Synthetic snapshots
    old={
        "captured_at":"2026-08-15T21:35:17Z",
        "assumed_spot_taker_fee_bps":10.0,
        "assumed_perp_taker_fee_bps":5.5,
        "candidates":[
            {
                "symbol":"WAVESUSDT","funding_rate":0.000987,
                "funding_rate_pct":0.0987,
                "next_funding_time":"2026-08-16T00:00:00Z",
                "depth_simulations":[{
                    "notional_usdt":100.0,
                    "depth_entry_basis":0.000735,
                    "estimated_full_roundtrip_fees_usdt":0.31,
                    "funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged":3.14,
                }],
            },
            {
                "symbol":"RPLUSUSDT","funding_rate":0.001033,
                "funding_rate_pct":0.1033,
                "next_funding_time":"2026-08-16T00:00:00Z",
                "depth_simulations":[{
                    "notional_usdt":100.0,
                    "depth_entry_basis":-0.002543,
                    "estimated_full_roundtrip_fees_usdt":0.31,
                    "funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged":3.00,
                }],
            },
        ],
    }
    new={
        "captured_at":"2026-08-15T22:50:54Z",
        "assumed_spot_taker_fee_bps":10.0,
        "assumed_perp_taker_fee_bps":5.5,
        "candidates":[
            {
                "symbol":"WAVESUSDT","funding_rate":0.001167,
                "funding_rate_pct":0.1167,
                "next_funding_time":"2026-08-16T00:00:00Z",
                "depth_simulations":[{
                    "notional_usdt":100.0,
                    "depth_entry_basis":-0.000974,
                    "estimated_full_roundtrip_fees_usdt":0.31,
                    "funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged":2.66,
                }],
            },
            {
                "symbol":"FHEUSDT","funding_rate":0.000386,
                "funding_rate_pct":0.0386,
                "next_funding_time":"2026-08-16T00:00:00Z",
                "depth_simulations":[{
                    "notional_usdt":100.0,
                    "depth_entry_basis":-0.001616,
                    "estimated_full_roundtrip_fees_usdt":0.31,
                    "funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged":8.04,
                }],
            },
        ],
    }
    cmp=compare_payloads(old,new)
    by={r["symbol"]:r for r in cmp["rows"]}
    assert by["WAVESUSDT"]["status"]=="PERSISTED"
    assert by["RPLUSUSDT"]["status"]=="DROPPED_FROM_SAVED_TOP"
    assert by["FHEUSDT"]["status"]=="ENTERED_SAVED_TOP"
    w=candidate_record(new,"WAVESUSDT")
    # 31 bps fees + 9.74 bps adverse basis / 11.67 bps funding ~= 3.49 cycles.
    assert 3.48 < w["stress_cycles_if_negative_basis_goes_to_zero"] < 3.50

    rates=[0.0001,0.0006,0.0007,0.0008,0.0002,0.0007,0.0008,0.0009]
    cp=conditional_persistence(rates,0.0005,2)
    assert cp["eligible_triggers"]==4
    assert cp["successes"]==2
    assert abs(cp["probability"]-0.5)<1e-12
    assert max_streak(rates,lambda r:r>=0.0005)==3
    assert quantile([1,2,3,4,5],0.5)==3
    assert percentile_rank([1,2,3,4],3)==75.0

    # Economic PnL math: delta-neutral price legs + positive funding - fees.
    synthetic = [{"net_return": 0.01, "net_pnl_usdt": 1.0, "symbol": "A"}, {"net_return": 0.02, "net_pnl_usdt": 2.0, "symbol": "B"}, {"net_return": 0.03, "net_pnl_usdt": 3.0, "symbol": "C"}]
    gate = economic_decision(synthetic)
    assert gate["episodes"] == 3
    assert abs(gate["mean_net_return"] - 0.02) < 1e-12
    assert gate["positive_episode_share"] == 1.0
    assert bootstrap_mean_ci([1.0, 1.0, 1.0]) == [1.0, 1.0]
    econ = economic_pnl_math(
        10.0, 10.0, 10.02, 10.10, 10.11, [0.001, 0.001, 0.001, 0.001],
        10.0, 5.5, None, None
    )
    assert abs(econ["basis_price_pnl_usdt"] - 0.1) < 1e-12
    assert abs(econ["funding_income_usdt"] - 0.4) < 1e-12
    assert abs(econ["net_pnl_usdt"] - 0.188285) < 1e-9
    assert econ["net_return"] > 0

    print("[research] SELF_TEST_PASS")
    print("[research] tests=snapshot_compare,drop_semantics,adverse_basis_stress,persistence_math,streaks,quantiles,percentiles")
    print("[research] network=NOT_USED")
    print("[research] ORDERS_PLACED=0")
    print("[research] API_KEYS_USED=0")
    print("[research] REAL_MONEY_GATE=NO_GO")

def main():
    ap=argparse.ArgumentParser()
    sp=ap.add_subparsers(dest="cmd",required=True)
    sp.add_parser("self-test")
    sp.add_parser("auto")
    sp.add_parser("economic-pnl")

    c=sp.add_parser("compare")
    c.add_argument("--top",type=int,default=20)

    h=sp.add_parser("history")
    h.add_argument("--symbols",nargs="*")
    h.add_argument("--limit",type=int,default=DEFAULT_HISTORY_LIMIT)

    v=sp.add_parser("verify")
    v.add_argument("--symbols",nargs="*")

    r=sp.add_parser("research")
    r.add_argument("--symbols",nargs="*")
    r.add_argument("--limit",type=int,default=DEFAULT_HISTORY_LIMIT)

    args=ap.parse_args()

    if args.cmd=="self-test":
        self_test()
    elif args.cmd=="auto":
        p,path,d=run_auto()
        print_auto(p,path,d)
    elif args.cmd=="economic-pnl":
        p,path,d=run_economic_pnl()
        print_economic_pnl(p,path,d)
    elif args.cmd=="compare":
        p,path,d=run_compare()
        print_compare(p,args.top)
        print(f"[research] json={path}")
        print(f"[research] sha256={d}")
        print("[research] REAL_MONEY_GATE=NO_GO")
    elif args.cmd=="history":
        p,path,d=run_history(args.symbols or None,args.limit)
        print_history(p)
        print(f"[research] json={path}")
        print(f"[research] sha256={d}")
        print("[research] REAL_MONEY_GATE=NO_GO")
    elif args.cmd=="verify":
        p,path,d=run_verify(args.symbols or None)
        print_verify(p)
        print(f"[research] json={path}")
        print(f"[research] sha256={d}")
        print("[research] REAL_MONEY_GATE=NO_GO")
    else:
        p,path,d=run_research(args.symbols or None,args.limit)
        print_compare({"comparison":p["comparison"]})
        print_history(p["history"])
        print(f"[research] combined_json={path}")
        print(f"[research] sha256={d}")
        print("[research] ORDERS_PLACED=0")
        print("[research] API_KEYS_USED=0")
        print("[research] REAL_MONEY_GATE=NO_GO")

if __name__=="__main__":
    main()
