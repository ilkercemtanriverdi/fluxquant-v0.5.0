#!/usr/bin/env python3
"""Polymarket Remote Collector - fetch snapshots from outside the local network."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import ssl
import sys
import time
import urllib.request
from pathlib import Path

_here = Path(__file__).resolve().parent
_root = _here
for p in [_here, *_root.parents]:
    if (p / "package.json").is_file():
        try:
            pkg = json.loads((p / "package.json").read_text(encoding="utf-8"))
        except Exception:
            continue
        if pkg.get("name") == "fluxquant":
            _root = p
            break
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from src.collectors.polymarket_remote.config import (  # noqa: E402
    VERSION,
    POLY_WALLET,
    PRIMARY,
    FALLBACKS,
    MAX_TRADES,
    MAX_MARKETS,
    HTTP_TIMEOUT,
    MAX_RETRIES,
    RETRY_BACKOFF,
    REAL_MONEY_GATE,
    ORDERS_PLACED,
    API_KEYS_USED,
)

SNAPSHOT_DIR = _root / "data" / "polymarket" / "snapshots"
MANIFEST_PATH = SNAPSHOT_DIR / "_manifest.json"


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


def _ssl_context(strict: bool = False) -> ssl.SSLContext:
    if strict:
        ctx = ssl.create_default_context()
        try:
            import certifi
            ctx.load_verify_locations(certifi.where())
        except Exception:
            pass
        return ctx
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _detect_html(raw: bytes) -> bool:
    snippet = raw[:4096]
    try:
        text = snippet.decode("utf-8", errors="replace")
    except Exception:
        return False
    return "<html" in text.lower() or "<!doctype" in text.lower()


def _do_request(url: str, timeout: int, ctx: ssl.SSLContext) -> tuple[bytes, dict, float]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "FluxQuant-RemoteCollector/" + VERSION,
            "Accept": "application/json",
        },
    )
    started = time.time_ns()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        headers = dict(resp.headers)
    elapsed_ms = (time.time_ns() - started) / 1e6
    return raw, headers, elapsed_ms


def fetch_json(url: str, *, timeout: int = HTTP_TIMEOUT, retries: int = MAX_RETRIES) -> dict:
    """Fetch JSON with SSL fallback routing and retry."""
    endpoints = _build_endpoints(url)
    last_error: Exception | None = None

    for attempt in range(retries):
        for ep_url, ep_name in endpoints:
            for strict in (True, False):
                try:
                    raw, headers, elapsed_ms = _do_request(ep_url, timeout, _ssl_context(strict))
                    ct = headers.get("Content-Type", "")
                    if _detect_html(raw):
                        raise RuntimeError(
                            "HTML_RESPONSE [%s]: Content-Type=%s" % (ep_name, ct)
                        )
                    if "json" not in ct.lower():
                        raise RuntimeError(
                            "NON_JSON [%s]: Content-Type=%s" % (ep_name, ct)
                        )
                    return json.loads(raw.decode("utf-8"))
                except Exception as e:
                    last_error = e
                    continue
        if attempt < retries - 1:
            time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])

    raise RuntimeError(
        "FETCH_FAILED after %d attempts: %s (url=%s)" % (retries, last_error, url)
    )


def _build_endpoints(url: str) -> list[tuple[str, str]]:
    for base in [PRIMARY, *FALLBACKS]:
        if url.startswith(base):
            others = [b for b in [PRIMARY, *FALLBACKS] if b != base]
            return [(url, base)] + [(url.replace(base, b, 1), b) for b in others]
    return [(url, "direct")]


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
        "record_count": len(payload.get("trades", payload.get("markets", []))) if isinstance(payload, dict) else 1,
    }
    manifest = _load_manifest()
    manifest.append(entry)
    _save_manifest(manifest)
    return entry


def collect_wallet_trades(wallet: str = POLY_WALLET, limit: int = MAX_TRADES) -> dict:
    all_trades = []
    offset = 0
    while len(all_trades) < limit:
        batch = min(200, limit - len(all_trades))
        url = (
            "%s/trades?user=%s&limit=%d&offset=%d&takerOnly=false"
            % (PRIMARY, wallet, batch, offset)
        )
        obj = fetch_json(url)
        if not isinstance(obj, list) or len(obj) == 0:
            break
        all_trades.extend(obj)
        offset += len(obj)
        if len(obj) < batch:
            break
    return _write_snapshot("wallet-trades", {"wallet": wallet, "trades": all_trades[:limit]})


def collect_markets(limit: int = MAX_MARKETS) -> dict:
    all_markets = []
    offset = 0
    while len(all_markets) < limit:
        batch = min(100, limit - len(all_markets))
        url = "%s/markets?limit=%d&offset=%d&active=true" % (PRIMARY, batch, offset)
        obj = fetch_json(url)
        if not isinstance(obj, list) or len(obj) == 0:
            break
        all_markets.extend(obj)
        offset += len(obj)
        if len(obj) < batch:
            break
    return _write_snapshot("markets", {"markets": all_markets[:limit]})


def health_check() -> dict:
    results = []
    for label, base in [("primary", PRIMARY), *[(f"fallback{i+1}", b) for i, b in enumerate(FALLBACKS)]]:
        hostname = base.replace("https://", "").split("/")[0]
        entry = {"name": label, "base_url": base, "hostname": hostname}
        try:
            socket = __import__("socket")
            socket.getaddrinfo(hostname, None, socket.AF_INET)
            entry["dns"] = True
        except Exception:
            entry["dns"] = False
        try:
            raw, headers, elapsed_ms = _do_request(base, 5, _ssl_context(False))
            ct = headers.get("Content-Type", "")
            entry["http"] = True
            entry["content_type"] = ct
            entry["html_blocked"] = _detect_html(raw)
            entry["latency_ms"] = round(elapsed_ms, 1)
        except Exception as e:
            entry["http"] = False
            entry["error"] = str(e)
        results.append(entry)
    ok = sum(1 for r in results if r.get("http") and not r.get("html_blocked"))
    return {"total": len(results), "json_reachable": ok, "endpoints": results}


def self_test():
    print("[collector] REMOTE_COLLECTOR SELF_TEST v%s" % VERSION)
    print("[collector] REAL_MONEY_GATE=%s" % REAL_MONEY_GATE)
    print("[collector] ORDERS_PLACED=%d" % ORDERS_PLACED)
    print("[collector] API_KEYS_USED=%d" % API_KEYS_USED)

    from src.collectors.polymarket_remote.config import POLY_WALLET as _w
    assert _w == "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
    print("[test] config_wallet OK")

    assert PRIMARY.startswith("https://")
    assert len(FALLBACKS) == 2
    print("[test] endpoints OK")

    _ensure_dirs()
    assert SNAPSHOT_DIR.exists()
    print("[test] dirs OK")

    m = _load_manifest()
    assert isinstance(m, list)
    print("[test] manifest OK")

    assert _detect_html(b"<html><body>x</body></html>") is True
    assert _detect_html(b'{"a":1}') is False
    print("[test] html_detection OK")

    ep = _build_endpoints("https://data-api.polymarket.com/trades?limit=1")
    assert len(ep) == 3
    assert ep[0][1] == PRIMARY
    print("[test] endpoint_routing OK")

    payload = {"test": True, "items": [1, 2, 3]}
    entry = _write_snapshot("test-snap", payload)
    assert entry["checksum_sha256"]
    print("[test] write_snapshot OK")

    loaded = json.loads((SNAPSHOT_DIR / entry["filename"]).read_text())
    assert loaded["checksum_sha256"] == entry["checksum_sha256"]
    assert loaded["data"]["test"] is True
    print("[test] snapshot_integrity OK")

    latest = SNAPSHOT_DIR / "test-snap-latest.json"
    assert latest.exists()
    print("[test] latest_link OK")

    assert REAL_MONEY_GATE == "NO_GO"
    assert ORDERS_PLACED == 0
    assert API_KEYS_USED == 0
    print("[test] safety_gates PASS")

    for f in SNAPSHOT_DIR.glob("test-snap-*"):
        f.unlink()
    print("[test] cleanup OK")

    print("[collector] SELF_TEST_PASS")


def main():
    ap = argparse.ArgumentParser(description="Polymarket Remote Collector v%s" % VERSION)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")
    sp.add_parser("health")
    sp.add_parser("wallet")
    sp.add_parser("markets")
    sp.add_parser("all")
    args = ap.parse_args()

    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "health":
        import pprint
        pprint.pprint(health_check())
    elif args.cmd == "wallet":
        print("[collector] collecting wallet trades...")
        try:
            e = collect_wallet_trades()
            print("[collector] OK %s (%s)" % (e["filename"], e["checksum_sha256"][:12]))
        except Exception as ex:
            print("[collector] FAIL: %s" % ex)
    elif args.cmd == "markets":
        print("[collector] collecting markets...")
        try:
            e = collect_markets()
            print("[collector] OK %s (%s)" % (e["filename"], e["checksum_sha256"][:12]))
        except Exception as ex:
            print("[collector] FAIL: %s" % ex)
    elif args.cmd == "all":
        for kind, fn in [("wallet", collect_wallet_trades), ("markets", collect_markets)]:
            print("[collector] collecting %s..." % kind)
            try:
                e = fn()
                print("[collector] OK %s" % e["filename"])
            except Exception as ex:
                print("[collector] FAIL %s: %s" % (kind, ex))
    else:
        raise ValueError("Unknown command: %s" % args.cmd)


if __name__ == "__main__":
    main()
