#!/usr/bin/env python3
"""Polymarket Data Collector - fetch snapshots, write JSON with timestamp + checksum."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
import time
from pathlib import Path

_here = Path(__file__).resolve().parent
_project = _here
for p in [_here, *_here.parents]:
    if (p / "package.json").is_file():
        try:
            pkg = json.loads((p / "package.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        if pkg.get("name") == "fluxquant":
            _project = p
            break
if str(_project) not in sys.path:
    sys.path.insert(0, str(_project))

from src.integrations.polymarket.client import get_json, check_all_endpoints  # noqa: E402

VERSION = "1.0.0"
REAL_MONEY_GATE = "NO_GO"

SNAPSHOT_DIR = _project / "data" / "polymarket" / "snapshots"
MANIFEST_PATH = SNAPSHOT_DIR / "_manifest.json"

_TARGET_WALLET = "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
_MAX_TRADES = 500
_MAX_MARKETS = 200


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ensure_dirs():
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _load_manifest() -> list[dict]:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return []


def _save_manifest(entries: list[dict]):
    MANIFEST_PATH.write_text(
        json.dumps(entries, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _write_snapshot(kind: str, payload: dict) -> dict:
    _ensure_dirs()
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sha = _sha256(raw)
    ts = _utcnow().replace("-", "").replace(":", "").replace("T", "-")
    filename = "%s-%s.json" % (kind, ts)
    path = SNAPSHOT_DIR / filename

    envelope = {
        "collector_version": VERSION,
        "kind": kind,
        "captured_at": _utcnow(),
        "checksum_sha256": sha,
        "byte_count": len(raw),
        "data": payload,
    }
    envelope_raw = (json.dumps(envelope, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    path.write_bytes(envelope_raw)

    latest = SNAPSHOT_DIR / ("%s-latest.json" % kind)
    latest.write_bytes(envelope_raw)

    entry = {
        "kind": kind,
        "filename": filename,
        "checksum_sha256": sha,
        "captured_at": envelope["captured_at"],
        "record_count": _count_records(payload),
    }
    manifest = _load_manifest()
    manifest.append(entry)
    _save_manifest(manifest)
    return entry


def _count_records(payload) -> int:
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for v in payload.values():
            if isinstance(v, list):
                return len(v)
    return 1


def collect_wallet_trades(wallet: str = _TARGET_WALLET, limit: int = _MAX_TRADES) -> dict:
    all_trades = []
    offset = 0
    while len(all_trades) < limit:
        batch = min(200, limit - len(all_trades))
        url = (
            "https://data-api.polymarket.com/trades"
            "?user=%s&limit=%d&offset=%d&takerOnly=false" % (wallet, batch, offset)
        )
        obj, _, _, _ = get_json(url, use_cache=False, retries=3)
        if not isinstance(obj, list) or len(obj) == 0:
            break
        all_trades.extend(obj)
        offset += len(obj)
        if len(obj) < batch:
            break
    return _write_snapshot("wallet-trades", {"wallet": wallet, "trades": all_trades[:limit]})


def collect_markets(limit: int = _MAX_MARKETS) -> dict:
    all_markets = []
    offset = 0
    while len(all_markets) < limit:
        batch = min(100, limit - len(all_markets))
        url = (
            "https://data-api.polymarket.com/markets"
            "?limit=%d&offset=%d&active=true" % (batch, offset)
        )
        obj, _, _, _ = get_json(url, use_cache=False, retries=3)
        if not isinstance(obj, list) or len(obj) == 0:
            break
        all_markets.extend(obj)
        offset += len(obj)
        if len(obj) < batch:
            break
    return _write_snapshot("markets", {"markets": all_markets[:limit]})


def collect_wallet_snapshot(wallet: str = _TARGET_WALLET) -> dict:
    trades_entry = collect_wallet_trades(wallet)
    return {
        "wallet": wallet,
        "trades_snapshot": trades_entry,
        "collected_at": _utcnow(),
    }


def health_check() -> dict:
    results = check_all_endpoints()
    ok_count = sum(1 for r in results if r["ok"])
    return {
        "total": len(results),
        "reachable": ok_count,
        "endpoints": results,
    }


def list_snapshots(kind: str | None = None) -> list[dict]:
    entries = _load_manifest()
    if kind:
        entries = [e for e in entries if e.get("kind") == kind]
    return entries


def get_latest_path(kind: str) -> Path | None:
    p = SNAPSHOT_DIR / ("%s-latest.json" % kind)
    return p if p.exists() else None


def load_latest(kind: str) -> dict | None:
    p = get_latest_path(kind)
    if p is None:
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def self_test():
    print("[collector] POLY_COLLECTOR SELF_TEST")
    print("[collector] REAL_MONEY_GATE=NO_GO")
    print("[collector] VERSION=%s" % VERSION)

    _ensure_dirs()
    print("[test] dirs OK")

    manifest = _load_manifest()
    assert isinstance(manifest, list)
    print("[test] manifest_load OK")

    from src.integrations.polymarket.client import get_json as _sg
    print("[test] client_import OK")

    payload = {"test": True, "items": [1, 2, 3]}
    entry = _write_snapshot("test-snapshot", payload)
    assert entry["checksum_sha256"]
    assert entry["record_count"] == 3
    print("[test] write_snapshot OK")

    loaded = load_latest("test-snapshot")
    assert loaded is not None
    assert loaded["data"]["test"] is True
    assert loaded["checksum_sha256"] == entry["checksum_sha256"]
    print("[test] load_latest OK")

    snapshots = list_snapshots("test-snapshot")
    assert len(snapshots) >= 1
    print("[test] list_snapshots OK")

    latest_path = get_latest_path("test-snapshot")
    assert latest_path is not None and latest_path.exists()
    print("[test] get_latest_path OK")

    h = health_check()
    assert "total" in h and "reachable" in h
    print("[test] health_check OK reachable=%d/%d" % (h["reachable"], h["total"]))

    assert REAL_MONEY_GATE == "NO_GO"
    print("[test] real_money_gate PASS")

    for f in SNAPSHOT_DIR.glob("test-snapshot-*.json"):
        f.unlink()
    lp = SNAPSHOT_DIR / "test-snapshot-latest.json"
    if lp.exists():
        lp.unlink()
    print("[test] cleanup OK")

    print("[collector] SELF_TEST_PASS")
    print("[collector] REAL_MONEY_GATE=NO_GO")
    print("[collector] NO_TRADE")


def main():
    ap = argparse.ArgumentParser(description="Polymarket Data Collector")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")
    sp.add_parser("health")
    sp.add_parser("collect-all")
    sp.add_parser("list")
    args = ap.parse_args()

    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "health":
        import pprint
        pprint.pprint(health_check())
    elif args.cmd == "collect-all":
        errors = []
        print("[collector] collecting wallet trades...")
        try:
            t = collect_wallet_trades()
            print("[collector] trades=%s" % t["filename"])
        except Exception as e:
            errors.append({"kind": "wallet-trades", "error": str(e)})
            print("[collector] ERROR trades: %s" % e)
        print("[collector] collecting markets...")
        try:
            m = collect_markets()
            print("[collector] markets=%s" % m["filename"])
        except Exception as e:
            errors.append({"kind": "markets", "error": str(e)})
            print("[collector] ERROR markets: %s" % e)
        if errors:
            print("[collector] DONE with %d errors" % len(errors))
        else:
            print("[collector] DONE")
    elif args.cmd == "list":
        for e in list_snapshots():
            print("%s  %s  %s" % (e["captured_at"], e["kind"], e["checksum_sha256"][:12]))
    else:
        raise ValueError("Unknown command: %s" % args.cmd)


if __name__ == "__main__":
    main()
