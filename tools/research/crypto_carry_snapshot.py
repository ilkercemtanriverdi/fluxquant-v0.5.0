#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

TOOL = "FluxQuant Bybit Spot-Perp Funding Carry Paper Scanner"
MODE = "READ_ONLY_PAPER_RESEARCH"
REAL_MONEY_GATE = "NO_GO"
BASE = "https://api.bybit.com"

# Current published non-VIP base rates; actual account/region can differ.
DEFAULT_SPOT_TAKER_BPS = 10.0
DEFAULT_PERP_TAKER_BPS = 5.5
DEFAULT_NOTIONALS = [100.0, 500.0, 1000.0]
MAX_REQUESTS = 20
MAX_RUNTIME_SECONDS = 300
REQUEST_COUNT = 0
_STARTED = None

def iso_now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

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

def outroot():
    return root() / "cache" / "bybit" / "carry" / "snapshots"

def get_json(path, params=None, timeout=15):
    global REQUEST_COUNT, _STARTED
    if _STARTED is None:
        _STARTED = time.monotonic()
    REQUEST_COUNT += 1
    if REQUEST_COUNT > MAX_REQUESTS:
        raise RuntimeError("CRYPTO_CARRY_SNAPSHOT_MAX_REQUESTS_EXCEEDED")
    if time.monotonic() - _STARTED > MAX_RUNTIME_SECONDS:
        raise RuntimeError("CRYPTO_CARRY_SNAPSHOT_RUNTIME_BOUND_EXCEEDED")
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    started = time.time_ns()
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "FluxQuant-Crypto-Carry/1.5", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    ended = time.time_ns()
    obj = json.loads(raw.decode("utf-8"))
    if int(obj.get("retCode", -1)) != 0:
        raise RuntimeError("BYBIT_ERROR:%s" % obj.get("retMsg"))
    return obj, (ended-started)/1e6, hashlib.sha256(raw).hexdigest()

def f(x):
    try:
        y = float(x)
        return y if math.isfinite(y) else None
    except Exception:
        return None

def parse_ms(x):
    try:
        return int(x)
    except Exception:
        return None

def utc_from_ms(ms):
    if ms is None:
        return None
    return dt.datetime.fromtimestamp(ms/1000, dt.timezone.utc)

def normalize_levels(levels, reverse=False):
    out=[]
    for row in levels or []:
        try:
            p,q=float(row[0]),float(row[1])
        except Exception:
            continue
        if p>0 and q>0 and math.isfinite(p) and math.isfinite(q):
            out.append((p,q))
    out.sort(key=lambda z:z[0], reverse=reverse)
    return out

def fetch_tickers(category):
    obj, lat, digest = get_json("/v5/market/tickers", {"category": category})
    return obj["result"]["list"], lat, digest

def spot_map(rows):
    out={}
    for x in rows:
        sym=str(x.get("symbol",""))
        if not sym.endswith("USDT"):
            continue
        bid,ask=f(x.get("bid1Price")),f(x.get("ask1Price"))
        bq,aq=f(x.get("bid1Size")),f(x.get("ask1Size"))
        if not bid or not ask or bid<=0 or ask<=0:
            continue
        out[sym]={
            "symbol":sym, "bid":bid, "ask":ask,
            "bid_size":bq or 0.0, "ask_size":aq or 0.0,
        }
    return out

def perp_map(rows):
    out={}
    for x in rows:
        sym=str(x.get("symbol",""))
        if not sym.endswith("USDT"):
            continue
        fr=f(x.get("fundingRate"))
        nft=parse_ms(x.get("nextFundingTime"))
        if fr is None or nft is None:
            continue
        bid,ask=f(x.get("bid1Price")),f(x.get("ask1Price"))
        bq,aq=f(x.get("bid1Size")),f(x.get("ask1Size"))
        mark=f(x.get("markPrice"))
        idx=f(x.get("indexPrice"))
        interval=f(x.get("fundingIntervalHour"))
        if not bid or not ask or bid<=0 or ask<=0:
            continue
        out[sym]={
            "symbol":sym, "bid":bid, "ask":ask,
            "bid_size":bq or 0.0, "ask_size":aq or 0.0,
            "funding_rate":fr,
            "next_funding_ms":nft,
            "mark":mark, "index":idx,
            "funding_interval_hours": interval,
        }
    return out

def top_candidates(spot, perp, spot_fee_bps, perp_fee_bps):
    rows=[]
    roundtrip_fee_rate = 2*(spot_fee_bps + perp_fee_bps)/10000.0
    now=dt.datetime.now(dt.timezone.utc)
    for sym in sorted(set(spot)&set(perp)):
        s=spot[sym]; p=perp[sym]
        fr=p["funding_rate"]
        # Only positive funding, where a long-spot / short-perp holder receives funding.
        if fr <= 0:
            continue
        entry_basis = p["bid"]/s["ask"] - 1.0
        nextdt=utc_from_ms(p["next_funding_ms"])
        hours=(nextdt-now).total_seconds()/3600 if nextdt else None
        cycles_to_fee = roundtrip_fee_rate/fr if fr>0 else None
        interval=p["funding_interval_hours"]
        annualized = None
        if interval and interval>0:
            annualized = fr*(24.0/interval)*365.0
        rows.append({
            "symbol":sym,
            "spot_ask":s["ask"],
            "spot_ask_size":s["ask_size"],
            "perp_bid":p["bid"],
            "perp_bid_size":p["bid_size"],
            "executable_entry_basis":entry_basis,
            "funding_rate":fr,
            "funding_rate_pct":100*fr,
            "funding_interval_hours":interval,
            "simple_annualized_funding_if_rate_persisted":annualized,
            "next_funding_time":nextdt.isoformat().replace("+00:00","Z") if nextdt else None,
            "hours_to_next_funding":hours,
            "assumed_full_roundtrip_taker_fee_rate":roundtrip_fee_rate,
            "identical_funding_cycles_to_cover_roundtrip_fees_if_basis_unchanged":cycles_to_fee,
            "mark_price":p["mark"],
            "index_price":p["index"],
        })
    rows.sort(key=lambda x:(x["funding_rate"], x["executable_entry_basis"]), reverse=True)
    return rows

def fetch_book(category, symbol, limit=100):
    obj, lat, digest=get_json(
        "/v5/market/orderbook",
        {"category":category,"symbol":symbol,"limit":str(limit)}
    )
    x=obj["result"]
    return {
        "bids":normalize_levels(x.get("b"),True),
        "asks":normalize_levels(x.get("a"),False),
        "ts":parse_ms(x.get("ts")),
        "update_id":x.get("u"),
        "latency_ms":lat,
        "raw_sha256":digest,
    }

def buy_quote(asks, quote):
    rem=quote; qty=0.0; spent=0.0
    for p,q in asks:
        lv=p*q
        takeq=min(rem,lv)
        qty+=takeq/p
        spent+=takeq
        rem-=takeq
        if rem<=max(1e-9,quote*1e-10):
            break
    return {"full":rem<=max(1e-7,quote*1e-9),"qty":qty,"spent":spent,
            "vwap":spent/qty if qty else None}

def short_qty(bids, qty):
    rem=qty; proceeds=0.0; sold=0.0
    for p,q in bids:
        take=min(rem,q)
        sold+=take
        proceeds+=take*p
        rem-=take
        if rem<=max(1e-12,qty*1e-10):
            break
    return {"full":rem<=max(1e-10,qty*1e-9),"qty":sold,"proceeds":proceeds,
            "vwap":proceeds/sold if sold else None}

def depth_eval(candidate, notionals, spot_fee_bps, perp_fee_bps):
    sym=candidate["symbol"]
    sb=fetch_book("spot",sym,100)
    pb=fetch_book("linear",sym,100)
    out=[]
    for n in notionals:
        b=buy_quote(sb["asks"],n)
        if not b["full"] or b["qty"]<=0:
            continue
        sh=short_qty(pb["bids"],b["qty"])
        if not sh["full"]:
            continue
        entry_spot_fee=b["spent"]*spot_fee_bps/10000.0
        entry_perp_fee=sh["proceeds"]*perp_fee_bps/10000.0
        matched_notional=min(b["spent"],sh["proceeds"])
        next_funding_income=matched_notional*candidate["funding_rate"]
        entry_fee_total=entry_spot_fee+entry_perp_fee
        # Exit fees are unknown-price future costs; approximate using same matched notional.
        est_exit_fee_total=matched_notional*(spot_fee_bps+perp_fee_bps)/10000.0
        total_est_roundtrip_fees=entry_fee_total+est_exit_fee_total
        cycles=total_est_roundtrip_fees/next_funding_income if next_funding_income>0 else None
        basis=sh["vwap"]/b["vwap"]-1.0 if b["vwap"] and sh["vwap"] else None
        out.append({
            "notional_usdt":n,
            "base_qty":b["qty"],
            "spot_buy_vwap":b["vwap"],
            "perp_short_vwap":sh["vwap"],
            "depth_entry_basis":basis,
            "entry_spot_fee_usdt":entry_spot_fee,
            "entry_perp_fee_usdt":entry_perp_fee,
            "next_funding_income_if_rate_settles_unchanged_usdt":next_funding_income,
            "estimated_exit_fees_usdt_using_entry_notional":est_exit_fee_total,
            "estimated_full_roundtrip_fees_usdt":total_est_roundtrip_fees,
            "funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged":cycles,
            "spot_book_latency_ms":sb["latency_ms"],
            "perp_book_latency_ms":pb["latency_ms"],
            "book_timestamp_skew_ms":abs((sb["ts"] or 0)-(pb["ts"] or 0)) if sb["ts"] and pb["ts"] else None,
            "directional_delta_hedged_at_entry":True,
            "basis_risk_remains":True,
            "liquidation_risk_exists_on_perp_leg":True,
        })
    return out

def snapshot(spot_fee_bps, perp_fee_bps, notionals, topn):
    global REQUEST_COUNT, _STARTED
    REQUEST_COUNT = 0
    _STARTED = time.monotonic()
    captured=iso_now()
    srows,slat,ssha=fetch_tickers("spot")
    prows,plat,psha=fetch_tickers("linear")
    spot=spot_map(srows); perp=perp_map(prows)
    cands=top_candidates(spot,perp,spot_fee_bps,perp_fee_bps)
    enriched=[]
    errors=[]
    for c in cands[:topn]:
        x=dict(c)
        try:
            x["depth_simulations"]=depth_eval(c,notionals,spot_fee_bps,perp_fee_bps)
        except Exception as e:
            x["depth_simulations"]=[]
            errors.append({"symbol":c["symbol"],"error":f"{type(e).__name__}: {e}"})
        enriched.append(x)
    return {
        "tool":TOOL,
        "mode":MODE,
        "captured_at":captured,
        "venue":"bybit",
        "positive_funding_spot_perp_pairs":len(cands),
        "assumed_spot_taker_fee_bps":spot_fee_bps,
        "assumed_perp_taker_fee_bps":perp_fee_bps,
        "fee_note":"Published non-VIP base assumptions; actual account/region fee may differ.",
        "ticker_latency_ms":{"spot":slat,"linear":plat},
        "ticker_sha256":{"spot":ssha,"linear":psha},
        "candidates":enriched,
        "errors":errors,
        "limitations":[
            "Funding rate is variable until settlement and may change materially.",
            "Perpetual basis has no fixed expiry convergence date.",
            "Delta hedging reduces directional risk but does not remove basis, liquidation, exchange, stablecoin or operational risk.",
            "Actual account fee tier and region-specific fees are not authenticated.",
            "Exit prices, exit slippage and future basis are unknown; exit fees are approximated only.",
            "No orders, leverage settings, balances, API keys or private account data are used."
        ],
        "real_money_gate":REAL_MONEY_GATE,
    }

def save(payload):
    rr=outroot(); rr.mkdir(parents=True,exist_ok=True)
    stamp=payload["captured_at"].replace("-","").replace(":","")
    raw=(json.dumps(payload,indent=2,ensure_ascii=False)+"\n").encode()
    jp=rr/f"snapshot-{stamp}.json"; jp.write_bytes(raw)
    (rr/"latest.json").write_bytes(raw)
    rows=[]
    for c in payload["candidates"]:
        for s in c["depth_simulations"]:
            rows.append({
                "captured_at":payload["captured_at"],
                "symbol":c["symbol"],
                "funding_rate":c["funding_rate"],
                "funding_rate_pct":c["funding_rate_pct"],
                "next_funding_time":c["next_funding_time"],
                "hours_to_next_funding":c["hours_to_next_funding"],
                "top_entry_basis":c["executable_entry_basis"],
                **s,
            })
    cp=rr/f"carry-{stamp}.csv"
    if rows:
        with cp.open("w",newline="",encoding="utf-8") as fh:
            w=csv.DictWriter(fh,fieldnames=list(rows[0].keys()))
            w.writeheader(); w.writerows(rows)
    return jp,cp,hashlib.sha256(raw).hexdigest()

def report(payload,jp,cp,digest,top=15):
    print(f"[carry] LIVE_SNAPSHOT_COMPLETE captured_at={payload['captured_at']}")
    print("[carry] venue=bybit strategy=LONG_SPOT_SHORT_PERP_POSITIVE_FUNDING")
    print(f"[carry] positive_funding_pairs={payload['positive_funding_spot_perp_pairs']}")
    print(
        f"[carry] fee_assumption spot_taker={payload['assumed_spot_taker_fee_bps']:.2f}bps "
        f"perp_taker={payload['assumed_perp_taker_fee_bps']:.2f}bps"
    )
    print(f"[carry] depth_errors={len(payload['errors'])}")
    print()
    for i,c in enumerate(payload["candidates"][:top],1):
        sim=c["depth_simulations"][0] if c["depth_simulations"] else None
        if sim:
            print(
                f"{i:02d}. {c['symbol']} funding={c['funding_rate_pct']:+.4f}% "
                f"entry_basis={100*sim['depth_entry_basis']:+.4f}% "
                f"N=${sim['notional_usdt']:.0f} "
                f"next_income=${sim['next_funding_income_if_rate_settles_unchanged_usdt']:.4f} "
                f"fee_break_even_cycles={sim['funding_cycles_to_fee_break_even_if_rate_and_basis_unchanged']:.2f} "
                f"next={c['next_funding_time']}"
            )
        else:
            print(
                f"{i:02d}. {c['symbol']} funding={c['funding_rate_pct']:+.4f}% "
                f"entry_basis={100*c['executable_entry_basis']:+.4f}% depth=UNAVAILABLE"
            )
    print()
    print(f"[carry] json={jp}")
    print(f"[carry] csv={cp}")
    print(f"[carry] snapshot_sha256={digest}")
    print("[carry] ORDERS_PLACED=0")
    print("[carry] API_KEYS_USED=0")
    print("[carry] REAL_MONEY_GATE=NO_GO")

def self_test():
    # Positive funding long-spot/short-perp candidate
    spot={"ABCUSDT":{"symbol":"ABCUSDT","bid":9.99,"ask":10.0,"bid_size":100,"ask_size":100}}
    perp={"ABCUSDT":{"symbol":"ABCUSDT","bid":10.02,"ask":10.03,"bid_size":100,"ask_size":100,
                     "funding_rate":0.001,"next_funding_ms":1893456000000,
                     "mark":10.02,"index":10.0,"funding_interval_hours":8}}
    c=top_candidates(spot,perp,10.0,5.5)
    assert len(c)==1
    assert c[0]["funding_rate"]==0.001
    assert c[0]["executable_entry_basis"]>0
    # 31 bps full roundtrip / 10 bps funding = 3.1 cycles.
    assert abs(c[0]["identical_funding_cycles_to_cover_roundtrip_fees_if_basis_unchanged"]-3.1)<1e-12

    asks=[(10.0,20)]
    bids=[(10.02,20)]
    b=buy_quote(asks,100.0)
    sh=short_qty(bids,b["qty"])
    assert b["full"] and sh["full"]
    assert abs(b["qty"]-10.0)<1e-12
    assert abs(sh["proceeds"]-100.2)<1e-12

    print("[carry] SELF_TEST_PASS")
    print("[carry] tests=positive_funding_direction,fee_hurdle,basis_math,spot_depth,perp_depth,matched_delta")
    print("[carry] network=NOT_USED")
    print("[carry] TLS_VERIFICATION=STANDARD_PYTHON_DEFAULT")
    print("[carry] ORDERS_PLACED=0")
    print("[carry] REAL_MONEY_GATE=NO_GO")

def main():
    ap=argparse.ArgumentParser()
    sp=ap.add_subparsers(dest="cmd",required=True)
    sp.add_parser("self-test")
    p=sp.add_parser("snapshot")
    p.add_argument("--spot-fee-bps",type=float,default=DEFAULT_SPOT_TAKER_BPS)
    p.add_argument("--perp-fee-bps",type=float,default=DEFAULT_PERP_TAKER_BPS)
    p.add_argument("--notionals",nargs="+",type=float,default=list(DEFAULT_NOTIONALS))
    p.add_argument("--topn",type=int,default=20)
    args=ap.parse_args()
    if args.cmd=="self-test":
        self_test()
    else:
        payload=snapshot(args.spot_fee_bps,args.perp_fee_bps,args.notionals,args.topn)
        jp,cp,digest=save(payload)
        report(payload,jp,cp,digest,args.topn)

if __name__=="__main__":
    main()
