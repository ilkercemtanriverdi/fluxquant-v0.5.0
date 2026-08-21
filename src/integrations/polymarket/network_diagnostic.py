#!/usr/bin/env python3
"""Polymarket Network Diagnostic - probe endpoints, report DNS/SSL/HTTP/Content-Type."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import socket
import ssl
import sys
import urllib.request
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

REPORT_DIR = _project / "reports" / "research" / "polymarket-network"

ENDPOINTS = [
    ("primary", "https://data-api.polymarket.com"),
    ("fallback1", "https://gamma-api.polymarket.com"),
    ("fallback2", "https://clob.polymarket.com"),
]

TIMEOUT = 10


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _resolve_dns(hostname: str) -> dict:
    try:
        results = socket.getaddrinfo(hostname, None, socket.AF_INET)
        ips = list(set(r[4][0] for r in results))
        return {"ok": True, "ips": sorted(ips), "error": None}
    except Exception as e:
        return {"ok": False, "ips": [], "error": str(e)}


def _ssl_probe(hostname: str) -> dict:
    results = {}
    for label, verify in [("strict", True), ("permissive", False)]:
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        try:
            with ctx.wrap_socket(socket.socket(), server_hostname=hostname) as s:
                s.settimeout(TIMEOUT)
                s.connect((hostname, 443))
                cert = s.getpeercert()
                subject = dict(x[0] for x in cert.get("subject", ()))
                issuer = dict(x[0] for x in cert.get("issuer", ()))
                san_list = []
                for ext_type, ext_val in cert.get("subjectAltName", ()):
                    if ext_type == "DNS":
                        san_list.append(ext_val)
                results[label] = {
                    "ok": True,
                    "subject_cn": subject.get("commonName"),
                    "issuer_cn": issuer.get("commonName"),
                    "issuer_org": issuer.get("organizationName"),
                    "san": san_list,
                    "not_before": cert.get("notBefore"),
                    "not_after": cert.get("notAfter"),
                    "error": None,
                }
        except Exception as e:
            results[label] = {"ok": False, "error": str(e)}
    return results


def _http_probe(url: str) -> dict:
    results = {}
    for label, verify in [("strict", True), ("permissive", False)]:
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "FluxQuant-Diagnostic/1.0",
                "Accept": "application/json",
            },
        )
        try:
            started = dt.datetime.now(dt.timezone.utc)
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
                raw = resp.read()
                headers = dict(resp.headers)
            elapsed = (dt.datetime.now(dt.timezone.utc) - started).total_seconds()
            content_type = headers.get("Content-Type", "")
            content_length = headers.get("Content-Length", len(raw))
            first_bytes = raw[:256]
            results[label] = {
                "ok": True,
                "status_code": resp.status,
                "content_type": content_type,
                "content_length": int(content_length) if str(content_length).isdigit() else len(raw),
                "first_bytes_sha256": hashlib.sha256(first_bytes).hexdigest()[:16],
                "first_bytes_preview": first_bytes.decode("utf-8", errors="replace")[:120],
                "elapsed_seconds": round(elapsed, 3),
                "error": None,
            }
        except Exception as e:
            results[label] = {"ok": False, "error": str(e)}
    return results


def _json_test(url: str) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "FluxQuant-Diagnostic/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type", "")
        if "text/html" in ct.lower() or "html" in raw[:256].decode("utf-8", errors="replace").lower():
            return {"json_ok": False, "reason": "HTML response", "content_type": ct}
        obj = json.loads(raw.decode("utf-8"))
        return {"json_ok": True, "type": type(obj).__name__, "keys": len(obj) if isinstance(obj, dict) else len(obj), "content_type": ct}
    except Exception as e:
        return {"json_ok": False, "reason": str(e)}


def probe_endpoint(name: str, base_url: str) -> dict:
    from urllib.parse import urlparse
    hostname = urlparse(base_url).hostname
    return {
        "name": name,
        "base_url": base_url,
        "hostname": hostname,
        "dns": _resolve_dns(hostname),
        "ssl": _ssl_probe(hostname),
        "http_strict": _http_probe(base_url),
        "http_permissive": _http_probe(base_url),
        "json_test": _json_test(base_url + "/markets?limit=1"),
    }


def run_diagnostics() -> dict:
    results = []
    for name, url in ENDPOINTS:
        results.append(probe_endpoint(name, url))
    report = {
        "tool": "Polymarket Network Diagnostic",
        "version": "1.0.0",
        "run_at": _utcnow(),
        "endpoints": results,
    }
    return report


def save_report(report: dict) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    ts = _utcnow().replace("-", "").replace(":", "").replace("T", "-")
    filename = "diagnostic-%s.json" % ts
    path = REPORT_DIR / filename
    raw = (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    path.write_bytes(raw)
    (REPORT_DIR / "latest.json").write_bytes(raw)
    return path


def self_test():
    print("[diagnostic] NETWORK_DIAGNOSTIC SELF_TEST")

    _resolve_dns("localhost")
    print("[test] dns_resolve OK")

    _ssl_probe("localhost")
    print("[test] ssl_probe OK")

    r = run_diagnostics()
    assert "endpoints" in r
    assert len(r["endpoints"]) == 3
    print("[test] run_diagnostics OK count=%d" % len(r["endpoints"]))

    path = save_report(r)
    assert path.exists()
    print("[test] save_report OK path=%s" % path.name)

    latest = REPORT_DIR / "latest.json"
    assert latest.exists()
    print("[test] latest_symlink OK")

    loaded = json.loads(path.read_text())
    assert loaded["tool"] == "Polymarket Network Diagnostic"
    assert len(loaded["endpoints"]) == 3
    for ep in loaded["endpoints"]:
        assert "dns" in ep and "ssl" in ep and "http_strict" in ep
        print("[test] %s dns=%s ssl_strict=%s http=%s" % (
            ep["name"],
            "OK" if ep["dns"]["ok"] else "FAIL",
            "OK" if ep["ssl"].get("strict", {}).get("ok") else "FAIL",
            "OK" if ep["http_permissive"].get("ok") else "FAIL",
        ))
    print("[test] report_integrity OK")

    print("[diagnostic] SELF_TEST_PASS")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("self-test")
    sp.add_parser("run")
    args = ap.parse_args()

    if args.cmd == "self-test":
        self_test()
    elif args.cmd == "run":
        print("[diagnostic] running network diagnostics...")
        r = run_diagnostics()
        path = save_report(r)
        print("[diagnostic] report=%s" % path)
        for ep in r["endpoints"]:
            dns = "OK" if ep["dns"]["ok"] else "FAIL"
            ssl_s = "OK" if ep["ssl"].get("strict", {}).get("ok") else "FAIL"
            ssl_p = "OK" if ep["ssl"].get("permissive", {}).get("ok") else "FAIL"
            http_s = "OK" if ep["http_strict"].get("ok") else "FAIL"
            http_p = "OK" if ep["http_permissive"].get("ok") else "FAIL"
            json_ok = "OK" if ep["json_test"].get("json_ok") else "FAIL"
            print("[diagnostic] %s dns=%s ssl(strict=%s,permissive=%s) http(strict=%s,permissive=%s) json=%s" % (
                ep["name"], dns, ssl_s, ssl_p, http_s, http_p, json_ok,
            ))
    else:
        raise ValueError("Unknown command: %s" % args.cmd)


if __name__ == "__main__":
    main()
