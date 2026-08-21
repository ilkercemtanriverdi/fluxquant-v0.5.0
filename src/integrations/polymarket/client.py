#!/usr/bin/env python3
"""Shared Polymarket HTTP client with endpoint routing, SSL fallback, JSON validation, caching, and retry."""
from __future__ import annotations

import hashlib
import json
import re
import ssl
import time
import urllib.request
from pathlib import Path

VERSION = "2.0.0"
USER_AGENT = "FluxQuant-PolyClient/" + VERSION
REQUEST_TIMEOUT = 15
MAX_RETRIES = 3
RETRY_BACKOFF = [0.5, 1.0, 2.0]
HEALTH_CHECK_TIMEOUT = 5

_PRIMARY = "https://data-api.polymarket.com"
_FALLBACKS = [
    "https://gamma-api.polymarket.com",
    "https://clob.polymarket.com",
]

_HTML_RE = re.compile(r"<html|<!DOCTYPE|<body|<head", re.IGNORECASE)
_CONTENT_TYPE_RE = re.compile(r"application/json|text/json|\+json", re.IGNORECASE)

_cache_root: Path | None = None
_endpoint_health: dict[str, dict] = {}


def _root() -> Path:
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


def cache_dir(subdir: str = "polymarket/client") -> Path:
    global _cache_root
    if _cache_root is None:
        _cache_root = _root() / "cache" / subdir
        _cache_root.mkdir(parents=True, exist_ok=True)
    return _cache_root


def _cache_key(url: str) -> Path:
    digest = hashlib.sha256(url.encode()).hexdigest()[:16]
    return cache_dir() / f"{digest}.json"


def _ssl_context_strict() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


def _ssl_context_permissive() -> ssl.SSLContext:
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
    return bool(_HTML_RE.search(text))


def _validate_content_type(headers: dict) -> None:
    ct = ""
    for k, v in headers.items():
        if k.lower() == "content-type":
            ct = v
            break
    if ct and not _CONTENT_TYPE_RE.search(ct):
        if _HTML_RE.search(ct) or "text/html" in ct.lower():
            raise RuntimeError(
                "NON_JSON_RESPONSE: Content-Type=%s — received HTML instead of JSON" % ct
            )
        raise RuntimeError(
            "NON_JSON_RESPONSE: Content-Type=%s — expected application/json" % ct
        )


def _do_request(url: str, timeout: int, ctx: ssl.SSLContext) -> tuple[bytes, dict, float]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    started = time.time_ns()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        headers = dict(resp.headers)
    elapsed_ms = (time.time_ns() - started) / 1e6
    return raw, headers, elapsed_ms


def _parse_json(raw: bytes, url: str, endpoint: str) -> dict:
    _validate_content_type(
        {k: v for k, v in []}
    )
    if _detect_html(raw):
        snippet = raw[:512].decode("utf-8", errors="replace")
        raise RuntimeError(
            "NON_JSON_RESPONSE [%s]: body starts with HTML (first 200 chars): %s"
            % (endpoint, snippet[:200])
        )
    return json.loads(raw.decode("utf-8"))


def _parse_json_from_parts(raw: bytes, headers: dict, url: str, endpoint: str) -> dict:
    _validate_content_type(headers)
    if _detect_html(raw):
        snippet = raw[:512].decode("utf-8", errors="replace")
        raise RuntimeError(
            "NON_JSON_RESPONSE [%s]: body starts with HTML (first 200 chars): %s"
            % (endpoint, snippet[:200])
        )
    return json.loads(raw.decode("utf-8"))


def _record_health(endpoint: str, ok: bool, elapsed_ms: float = 0.0) -> None:
    _endpoint_health[endpoint] = {
        "ok": ok,
        "latency_ms": elapsed_ms,
        "last_check": time.time(),
    }


def check_endpoint(endpoint: str, *, timeout: int = HEALTH_CHECK_TIMEOUT) -> dict:
    """Probe an endpoint root and return health status."""
    last_err: Exception | None = None
    for ctx in (_ssl_context_strict(), _ssl_context_permissive()):
        try:
            raw, headers, elapsed_ms = _do_request(endpoint, timeout, ctx)
            _record_health(endpoint, True, elapsed_ms)
            return {
                "endpoint": endpoint,
                "ok": True,
                "latency_ms": elapsed_ms,
                "error": None,
            }
        except Exception as e:
            last_err = e
            continue
    _record_health(endpoint, False, 0.0)
    return {
        "endpoint": endpoint,
        "ok": False,
        "latency_ms": 0.0,
        "error": str(last_err),
    }


def check_all_endpoints() -> list[dict]:
    """Check primary and all fallbacks. Returns list of health results."""
    results = []
    for ep in [_PRIMARY, *_FALLBACKS]:
        results.append(check_endpoint(ep))
    return results


def get_healthy_endpoint() -> str:
    """Return the first reachable endpoint, preferring primary. Raises if none reachable."""
    for ep in [_PRIMARY, *_FALLBACKS]:
        health = check_endpoint(ep)
        if health["ok"]:
            return ep
    raise RuntimeError(
        "ALL_ENDPOINTS_UNREACHABLE: %s" % ", ".join([_PRIMARY, *_FALLBACKS])
    )


def get_json(
    url: str,
    *,
    timeout: int = REQUEST_TIMEOUT,
    use_cache: bool = True,
    retries: int = MAX_RETRIES,
    endpoint: str | None = None,
) -> tuple[dict, float, str, bool]:
    """GET a JSON endpoint with SSL fallback, retry, cache, and endpoint routing.

    Args:
        url: Full URL to fetch. If it starts with a known base, routing applies.
        timeout: Request timeout in seconds.
        use_cache: Whether to use the disk cache.
        retries: Number of retry attempts.
        endpoint: Override endpoint base. If None, uses primary with fallback routing.

    Returns (parsed_json, elapsed_ms, sha256_hex, cache_hit).
    """
    if use_cache:
        cp = _cache_key(url)
        if cp.exists():
            raw = cp.read_bytes()
            obj = json.loads(raw.decode("utf-8"))
            return obj, 0.0, hashlib.sha256(raw).hexdigest(), True

    endpoints_to_try = _build_endpoint_list(url, endpoint)
    last_error: Exception | None = None
    attempted_endpoints: list[str] = []

    for attempt in range(retries):
        for ep_url, ep_name in endpoints_to_try:
            attempted_endpoints.append(ep_name)
            for ctx in (_ssl_context_strict(), _ssl_context_permissive()):
                try:
                    raw, headers, elapsed_ms = _do_request(ep_url, timeout, ctx)
                    obj = _parse_json_from_parts(raw, headers, ep_url, ep_name)
                    sha = hashlib.sha256(raw).hexdigest()
                    cp = _cache_key(url)
                    cp.write_bytes(json.dumps(obj, ensure_ascii=False).encode("utf-8"))
                    _record_health(ep_name, True, elapsed_ms)
                    return obj, elapsed_ms, sha, False
                except Exception as e:
                    last_error = e
                    _record_health(ep_name, False, 0.0)
                    if "NON_JSON_RESPONSE" in str(e):
                        break
                    continue
        if attempt < retries - 1:
            time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])

    unique = list(dict.fromkeys(attempted_endpoints))
    raise RuntimeError(
        "HTTP_FETCH_FAILED after %d attempts on [%s]: %s (url=%s)"
        % (retries, " -> ".join(unique), last_error, url)
    )


def _build_endpoint_list(url: str, override: str | None) -> list[tuple[str, str]]:
    """Build list of (full_url, endpoint_name) to try."""
    if override is not None:
        return [(url, override)]

    for base in [_PRIMARY, *_FALLBACKS]:
        if url.startswith(base):
            others = [b for b in [_PRIMARY, *_FALLBACKS] if b != base]
            result = [(url, base)]
            for b in others:
                replacement = url.replace(base, b, 1)
                result.append((replacement, b))
            return result

    return [(url, "direct")]


def clear_cache() -> int:
    d = cache_dir()
    count = 0
    for f in d.glob("*.json"):
        f.unlink()
        count += 1
    return count
