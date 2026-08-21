#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import random
import ssl
import statistics
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

EXPECTED_CONTRACT_SHA256 = "3c3a3bba168eac474286e4fffa78e9cd60e155f46a312a01c78bd9917d97bae8"
BASE_URL = "https://data-api.binance.vision"
KLINES_ENDPOINT = "/api/v3/klines"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
INTERVAL = "15m"
INTERVAL_MS = 15 * 60 * 1000
START = "2024-01-01T00:00:00Z"
DEV_END = "2026-01-01T00:00:00Z"
HOLDOUT_START = "2026-01-01T00:00:00Z"
END = "2026-08-01T00:00:00Z"

RET_1H_MIN = 0.005
TAKER_SHARE_MIN = 0.55
VOL_MULT_MIN = 1.5
VOL_LOOKBACK = 96
HOLD_BARS = 4
ROUND_TRIP_COST = 24.0 / 10000.0

MIN_HOLDOUT_TRADES = 50
MIN_POSITIVE_SYMBOLS = 2
MAX_POSITIVE_PNL_SHARE = 0.60
BOOT_SEED = 1337
BOOT_REPS = 5000

KLINE_LIMIT = 1000
REQUEST_TIMEOUT_SECONDS = 20
REQUEST_ATTEMPTS = 3
MAX_RUNTIME_SECONDS = 20 * 60
CACHE_CHECKPOINT_PAGES = 5

COLS = [
    "open_time", "open", "high", "low", "close", "volume", "close_time",
    "quote_volume", "num_trades", "taker_buy_base", "taker_buy_quote", "ignore",
]


def iso_ms(value: str) -> int:
    return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


START_MS = iso_ms(START)
DEV_END_MS = iso_ms(DEV_END)
HOLDOUT_START_MS = iso_ms(HOLDOUT_START)
END_MS = iso_ms(END)


def utc_iso_ms(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000.0, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError(code)


def load_and_validate_contract(path: Path) -> Dict[str, Any]:
    actual_sha = sha256_file(path)
    require(actual_sha == EXPECTED_CONTRACT_SHA256, "CRYPTO_C1_CONTRACT_SHA_MISMATCH:%s" % actual_sha)
    contract = json.loads(path.read_text(encoding="utf-8"))
    signal = contract["hypothesis"]["signal_at_completed_15m_bar"]
    execution = contract["hypothesis"]["execution"]
    window = contract["data_window"]
    cost = contract["cost_model"]
    gate = contract["holdout_gate"]
    bootstrap = contract["bootstrap"]
    source = contract["source"]

    checks = [
        (contract["capability"] == "CRYPTO_C1_BINANCE_SPOT_BASELINE", "CAPABILITY"),
        (contract["real_money_gate"] == "NO_GO", "REAL_MONEY_GATE"),
        (contract["production_v1_5"] == "UNCHANGED", "PRODUCTION_GATE"),
        (contract["football_research"] == "FROZEN_UNCHANGED", "FOOTBALL_GATE"),
        (contract["polymarket_research"] == "FROZEN_UNCHANGED", "POLYMARKET_GATE"),
        (tuple(contract["universe"]) == SYMBOLS, "UNIVERSE"),
        (contract["interval"] == INTERVAL, "INTERVAL"),
        (window["start_utc"] == START, "START"),
        (window["development_end_exclusive_utc"] == DEV_END, "DEV_END"),
        (window["holdout_start_utc"] == HOLDOUT_START, "HOLDOUT_START"),
        (window["holdout_end_exclusive_utc"] == END, "END"),
        (contract["hypothesis"]["name"] == "VOLUME_CONFIRMED_1H_MOMENTUM_LONG", "HYPOTHESIS"),
        (contract["hypothesis"]["tuning"] == "NONE", "TUNING"),
        (float(signal["one_hour_return_min"]) == RET_1H_MIN, "RET_THRESHOLD"),
        (float(signal["four_bar_taker_buy_quote_share_min"]) == TAKER_SHARE_MIN, "TAKER_THRESHOLD"),
        (float(signal["current_quote_volume_vs_prior_96_bar_mean_min"]) == VOL_MULT_MIN, "VOLUME_THRESHOLD"),
        (int(execution["holding_period_bars"]) == HOLD_BARS, "HOLD_BARS"),
        (execution["entry"] == "NEXT_15M_BAR_OPEN", "ENTRY"),
        (execution["exit"] == "OPEN_AFTER_4_COMPLETE_15M_BARS", "EXIT"),
        (execution["overlapping_positions_per_symbol"] == "FORBIDDEN", "OVERLAP"),
        (float(cost["round_trip_bps"]) == 24.0, "COST"),
        (int(gate["min_combined_trades"]) == MIN_HOLDOUT_TRADES, "MIN_TRADES"),
        (int(gate["min_positive_symbols"]) == MIN_POSITIVE_SYMBOLS, "MIN_SYMBOLS"),
        (float(gate["max_single_symbol_positive_pnl_share"]) == MAX_POSITIVE_PNL_SHARE, "CONCENTRATION"),
        (int(bootstrap["seed"]) == BOOT_SEED and int(bootstrap["replications"]) == BOOT_REPS, "BOOTSTRAP"),
        (source["base_url"] == BASE_URL and source["endpoint"] == KLINES_ENDPOINT, "SOURCE"),
        (source["authentication"] == "NONE", "AUTH"),
        (source["tls_verification"] == "REQUIRED" and source["insecure_fallback"] == "FORBIDDEN", "TLS"),
    ]
    for ok, name in checks:
        require(ok, "CRYPTO_C1_CONTRACT_DRIFT:%s" % name)
    return contract


def http_json(path: str, params: Dict[str, Any], deadline: float) -> Tuple[Any, int]:
    url = BASE_URL + path + "?" + urlencode(params)
    context = ssl.create_default_context()
    request = Request(url, headers={"User-Agent": "FluxQuant/1.5 crypto-c1-research", "Accept": "application/json"})
    last: Optional[Exception] = None
    attempts_used = 0
    for attempt in range(REQUEST_ATTEMPTS):
        require(time.monotonic() < deadline, "CRYPTO_C1_GLOBAL_TIMEOUT_RESUMABLE")
        attempts_used += 1
        try:
            with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS, context=context) as response:
                require(response.status == 200, "HTTP_%s" % response.status)
                return json.loads(response.read().decode("utf-8")), attempts_used
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            last = exc
            if attempt + 1 < REQUEST_ATTEMPTS:
                time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("BINANCE_PUBLIC_DATA_FAILED:%s" % last)


def connectivity(deadline: float) -> int:
    data, attempts = http_json("/api/v3/exchangeInfo", {"symbol": SYMBOLS[0]}, deadline)
    symbols = data.get("symbols", []) if isinstance(data, dict) else []
    require(bool(symbols and symbols[0].get("symbol") == SYMBOLS[0] and symbols[0].get("status") == "TRADING"), "BINANCE_EXCHANGE_INFO_UNEXPECTED")
    print("[crypto-c1] connectivity=PASS endpoint=data-api.binance.vision tls_verify=ON auth=NONE")
    return attempts


def cache_path(cache_dir: Path, symbol: str) -> Path:
    return cache_dir / ("%s-%s-%s_%s.csv" % (symbol, INTERVAL, START[:10], END[:10]))


def read_existing(path: Path) -> List[List[Any]]:
    if not path.exists():
        return []
    rows: List[List[Any]] = []
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        require(reader.fieldnames == COLS, "CACHE_SCHEMA_MISMATCH:%s" % path)
        for row in reader:
            rows.append([
                int(row["open_time"]), row["open"], row["high"], row["low"], row["close"], row["volume"],
                int(row["close_time"]), row["quote_volume"], int(row["num_trades"]),
                row["taker_buy_base"], row["taker_buy_quote"], row["ignore"],
            ])
    return rows


def write_cache(path: Path, rows: Sequence[Sequence[Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(COLS)
        writer.writerows(rows)
    os.replace(temp, path)


def validate_prefix(symbol: str, rows: Sequence[Sequence[Any]]) -> None:
    if not rows:
        return
    require(int(rows[0][0]) == START_MS, "CACHE_START_MISMATCH:%s" % symbol)
    require(int(rows[-1][0]) < END_MS, "CACHE_END_OUT_OF_RANGE:%s" % symbol)
    previous = int(rows[0][0])
    for row in rows[1:]:
        current = int(row[0])
        require(current - previous == INTERVAL_MS, "CACHE_GAP_OR_DUPLICATE:%s" % symbol)
        previous = current


def integrity(symbol: str, rows: Sequence[Sequence[Any]]) -> Dict[str, Any]:
    expected = (END_MS - START_MS) // INTERVAL_MS
    if not rows:
        return {"symbol": symbol, "rows": 0, "expected_rows": expected, "exact_continuous_window": False}
    gaps = 0
    duplicates = 0
    seen = set()
    previous: Optional[int] = None
    for row in rows:
        current = int(row[0])
        if current in seen:
            duplicates += 1
        seen.add(current)
        if previous is not None and current - previous != INTERVAL_MS:
            gaps += 1
        previous = current
    exact = (
        len(rows) == expected
        and gaps == 0
        and duplicates == 0
        and int(rows[0][0]) == START_MS
        and int(rows[-1][0]) == END_MS - INTERVAL_MS
    )
    return {
        "symbol": symbol,
        "rows": len(rows),
        "expected_rows": expected,
        "coverage_ratio": len(rows) / expected,
        "gap_count": gaps,
        "duplicates": duplicates,
        "first_open": utc_iso_ms(int(rows[0][0])),
        "last_open": utc_iso_ms(int(rows[-1][0])),
        "exact_continuous_window": exact,
    }


def fetch_symbol(symbol: str, cache_dir: Path, deadline: float) -> Tuple[List[List[Any]], Path, Dict[str, Any]]:
    path = cache_path(cache_dir, symbol)
    rows = read_existing(path)
    validate_prefix(symbol, rows)
    start_rows = len(rows)
    start = START_MS if not rows else int(rows[-1][0]) + INTERVAL_MS
    expected_rows = (END_MS - START_MS) // INTERVAL_MS
    expected_pages = int(math.ceil(expected_rows / float(KLINE_LIMIT)))
    max_pages = expected_pages + 2
    pages = 0
    attempts = 0

    if rows:
        print("[crypto-c1] %s cache_resume rows=%d next=%s" % (symbol, len(rows), utc_iso_ms(start)))

    while start < END_MS:
        require(time.monotonic() < deadline, "CRYPTO_C1_GLOBAL_TIMEOUT_RESUMABLE")
        require(pages < max_pages, "CRYPTO_C1_PAGE_BOUND_EXCEEDED:%s" % symbol)
        payload, used = http_json(KLINES_ENDPOINT, {
            "symbol": symbol,
            "interval": INTERVAL,
            "startTime": start,
            "endTime": END_MS - 1,
            "limit": KLINE_LIMIT,
        }, deadline)
        attempts += used
        require(isinstance(payload, list) and payload, "KLINES_EMPTY_OR_INVALID:%s" % symbol)

        normalized: List[List[Any]] = []
        for raw in payload:
            require(isinstance(raw, list) and len(raw) >= 12, "KLINE_SHORT_ROW:%s" % symbol)
            open_time = int(raw[0])
            if START_MS <= open_time < END_MS:
                normalized.append([
                    open_time, str(raw[1]), str(raw[2]), str(raw[3]), str(raw[4]), str(raw[5]),
                    int(raw[6]), str(raw[7]), int(raw[8]), str(raw[9]), str(raw[10]), str(raw[11]),
                ])
        require(bool(normalized), "KLINES_PAGE_OUTSIDE_WINDOW:%s" % symbol)
        require(int(normalized[0][0]) == start, "KLINES_GAP_AT_PAGE_START:%s" % symbol)
        previous = int(normalized[0][0])
        for row in normalized[1:]:
            current = int(row[0])
            require(current - previous == INTERVAL_MS, "KLINES_GAP_WITHIN_PAGE:%s" % symbol)
            previous = current

        rows.extend(normalized)
        start = int(rows[-1][0]) + INTERVAL_MS
        pages += 1
        if pages % CACHE_CHECKPOINT_PAGES == 0 or start >= END_MS:
            write_cache(path, rows)
        if pages % 10 == 0 or start >= END_MS:
            print("[crypto-c1] %s pages=%d/%d rows=%d/%d through=%s" % (
                symbol, pages, expected_pages, len(rows), expected_rows, utc_iso_ms(int(rows[-1][0]))
            ))
        if len(payload) < KLINE_LIMIT and start < END_MS:
            raise RuntimeError("KLINES_INCOMPLETE_BEFORE_END:%s:%s" % (symbol, utc_iso_ms(start)))

    if not path.exists() or start_rows != len(rows):
        write_cache(path, rows)
    data_integrity = integrity(symbol, rows)
    require(data_integrity["exact_continuous_window"] is True, "CRYPTO_C1_DATA_INTEGRITY_FAIL:%s" % symbol)
    return rows, path, {
        "cache_rows_at_start": start_rows,
        "download_pages": pages,
        "request_attempts": attempts,
        "expected_pages_full_window": expected_pages,
        "integrity": data_integrity,
    }


def f(value: Any) -> float:
    return float(value)


def generate_trades(symbol: str, rows: Sequence[Sequence[Any]]) -> List[Dict[str, Any]]:
    trades: List[Dict[str, Any]] = []
    closes = [f(row[4]) for row in rows]
    quote_volume = [f(row[7]) for row in rows]
    taker_buy_quote = [f(row[10]) for row in rows]
    opens = [f(row[1]) for row in rows]
    times = [int(row[0]) for row in rows]
    prior_sum = sum(quote_volume[:VOL_LOOKBACK])
    next_entry_allowed_idx = 0

    for i in range(VOL_LOOKBACK, len(rows) - (HOLD_BARS + 1)):
        if i > VOL_LOOKBACK:
            prior_sum += quote_volume[i - 1] - quote_volume[i - 1 - VOL_LOOKBACK]
        prior_mean = prior_sum / VOL_LOOKBACK
        if prior_mean <= 0:
            continue
        ret_1h = closes[i] / closes[i - 4] - 1.0
        q4 = sum(quote_volume[i - 3:i + 1])
        tb4 = sum(taker_buy_quote[i - 3:i + 1])
        taker_share = tb4 / q4 if q4 > 0 else 0.0
        vol_mult = quote_volume[i] / prior_mean
        entry_idx = i + 1
        exit_idx = entry_idx + HOLD_BARS
        if entry_idx < next_entry_allowed_idx:
            continue
        if ret_1h >= RET_1H_MIN and taker_share >= TAKER_SHARE_MIN and vol_mult >= VOL_MULT_MIN:
            entry = opens[entry_idx]
            exit_price = opens[exit_idx]
            gross = exit_price / entry - 1.0
            trades.append({
                "symbol": symbol,
                "signal_time_ms": times[i],
                "entry_time_ms": times[entry_idx],
                "exit_time_ms": times[exit_idx],
                "entry": entry,
                "exit": exit_price,
                "ret1h_at_signal": ret_1h,
                "taker_share4": taker_share,
                "vol_mult": vol_mult,
                "gross_return": gross,
                "net_return": gross - ROUND_TRIP_COST,
            })
            next_entry_allowed_idx = exit_idx
    return trades


def split_trades(trades: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    dev: List[Dict[str, Any]] = []
    holdout: List[Dict[str, Any]] = []
    boundary_excluded: List[Dict[str, Any]] = []
    for trade in trades:
        entry = int(trade["entry_time_ms"])
        exit_time = int(trade["exit_time_ms"])
        if entry < DEV_END_MS:
            (dev if exit_time < DEV_END_MS else boundary_excluded).append(trade)
        elif HOLDOUT_START_MS <= entry < END_MS:
            (holdout if exit_time < END_MS else boundary_excluded).append(trade)
    return dev, holdout, boundary_excluded


def max_drawdown_compounded(returns: Sequence[float]) -> Tuple[float, float]:
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for value in returns:
        equity *= 1.0 + value
        peak = max(peak, equity)
        max_drawdown = min(max_drawdown, equity / peak - 1.0)
    return max_drawdown, equity - 1.0


def bootstrap_mean_ci(values: Sequence[float]) -> List[Optional[float]]:
    if not values:
        return [None, None]
    rng = random.Random(BOOT_SEED)
    n = len(values)
    means = [sum(values[rng.randrange(n)] for _ in range(n)) / n for _ in range(BOOT_REPS)]
    means.sort()
    return [means[int(0.025 * (BOOT_REPS - 1))], means[int(0.975 * (BOOT_REPS - 1))]]


def metrics(trades: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    ordered = sorted(trades, key=lambda trade: (int(trade["exit_time_ms"]), str(trade["symbol"]), int(trade["entry_time_ms"])))
    values = [float(trade["net_return"]) for trade in ordered]
    gross = [float(trade["gross_return"]) for trade in ordered]
    if not values:
        return {
            "trades": 0, "mean_net_return": None, "mean_gross_return": None, "win_rate": None,
            "bootstrap_mean_net_95ci": [None, None], "realized_sequence_max_drawdown": None,
            "sequential_trade_compounded_return": None, "sum_net_units": 0.0,
        }
    drawdown, compounded = max_drawdown_compounded(values)
    return {
        "trades": len(values),
        "mean_net_return": statistics.fmean(values),
        "mean_gross_return": statistics.fmean(gross),
        "win_rate": sum(1 for value in values if value > 0) / len(values),
        "bootstrap_mean_net_95ci": bootstrap_mean_ci(values),
        "realized_sequence_max_drawdown": drawdown,
        "sequential_trade_compounded_return": compounded,
        "sum_net_units": sum(values),
    }


def evaluate_gate(holdout_by_symbol: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    combined = [trade for trades in holdout_by_symbol.values() for trade in trades]
    positive_pnl = {symbol: max(0.0, sum(float(trade["net_return"]) for trade in trades)) for symbol, trades in holdout_by_symbol.items()}
    positive_symbols = sum(1 for value in positive_pnl.values() if value > 0)
    total_positive = sum(positive_pnl.values())
    concentration = max(positive_pnl.values()) / total_positive if total_positive > 0 else 1.0
    combined_metrics = metrics(combined)
    lower = combined_metrics["bootstrap_mean_net_95ci"][0]
    checks = {
        "min_combined_trades": combined_metrics["trades"] >= MIN_HOLDOUT_TRADES,
        "mean_net_positive": combined_metrics["mean_net_return"] is not None and combined_metrics["mean_net_return"] > 0,
        "bootstrap_95_lower_positive": lower is not None and lower > 0,
        "min_positive_symbols": positive_symbols >= MIN_POSITIVE_SYMBOLS,
        "pnl_concentration_ok": concentration <= MAX_POSITIVE_PNL_SHARE,
    }
    return {
        "status": "PASS" if all(checks.values()) else "NO_GO_BASELINE",
        "checks": checks,
        "combined_metrics": combined_metrics,
        "positive_symbols": positive_symbols,
        "positive_pnl_concentration": concentration,
    }


def fmt_pct(value: Optional[float]) -> str:
    return "N/A" if value is None else "%.4f%%" % (100.0 * value)


def fmt_ci(ci: Sequence[Optional[float]]) -> str:
    return "[N/A,N/A]" if not ci or ci[0] is None else "[%.4f%%,%.4f%%]" % (100.0 * float(ci[0]), 100.0 * float(ci[1]))


def selftest(contract_path: Path) -> Dict[str, Any]:
    load_and_validate_contract(contract_path)
    require(abs(ROUND_TRIP_COST - 0.0024) < 1e-12, "SELFTEST_COST")

    rows: List[List[Any]] = []
    for i in range(120):
        open_price = 101.0 if i == 97 else 102.0 if i == 101 else 100.0
        close_price = 100.6 if i == 96 else 100.0
        quote_volume = 200.0 if i == 96 else 100.0
        taker_buy_quote = 120.0 if i == 96 else 60.0
        open_time = START_MS + i * INTERVAL_MS
        rows.append([
            open_time, str(open_price), "103", "99", str(close_price), "1",
            open_time + INTERVAL_MS - 1, str(quote_volume), 1, "0.6", str(taker_buy_quote), "0",
        ])
    trades = generate_trades("BTCUSDT", rows)
    require(bool(trades), "SELFTEST_SIGNAL_MISSING")
    require(trades[0]["signal_time_ms"] == rows[96][0], "SELFTEST_SIGNAL_TIME")
    require(trades[0]["entry_time_ms"] == rows[97][0], "SELFTEST_NEXT_BAR_ENTRY")
    require(trades[0]["exit_time_ms"] == rows[101][0], "SELFTEST_HOLD_PERIOD")

    boundary = [
        {"symbol": "BTCUSDT", "entry_time_ms": DEV_END_MS - INTERVAL_MS, "exit_time_ms": DEV_END_MS + INTERVAL_MS},
        {"symbol": "BTCUSDT", "entry_time_ms": HOLDOUT_START_MS, "exit_time_ms": HOLDOUT_START_MS + INTERVAL_MS},
    ]
    dev, holdout, excluded = split_trades(boundary)
    require(len(dev) == 0 and len(holdout) == 1 and len(excluded) == 1, "SELFTEST_BOUNDARY_GUARD")

    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "cache.csv"
        write_cache(path, rows[:20])
        cached = read_existing(path)
        require(len(cached) == 20 and int(cached[0][0]) == START_MS, "SELFTEST_CACHE_ROUNDTRIP")
        validate_prefix("BTCUSDT", cached)
        broken = [cached[0], cached[2]]
        try:
            validate_prefix("BTCUSDT", broken)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("SELFTEST_GAP_GUARD")

    ci1 = bootstrap_mean_ci([0.01, -0.005, 0.002])
    ci2 = bootstrap_mean_ci([0.01, -0.005, 0.002])
    require(ci1 == ci2, "SELFTEST_BOOTSTRAP_DETERMINISM")
    return {
        "status": "PASS",
        "contract_sha256": EXPECTED_CONTRACT_SHA256,
        "round_trip_cost_bps": 24.0,
        "next_bar_open_execution": True,
        "boundary_leakage_guard": True,
        "strict_contiguous_data_guard": True,
        "cache_resume_format_guard": True,
        "bootstrap_seed_reproducible": True,
        "tls_verification_not_disabled": True,
        "real_money_gate": "NO_GO",
    }


def analyze(contract_path: Path, cache_dir: Path, report_path: Path) -> Dict[str, Any]:
    load_and_validate_contract(contract_path)
    expected_rows = (END_MS - START_MS) // INTERVAL_MS
    expected_pages = int(math.ceil(expected_rows / float(KLINE_LIMIT)))
    started = time.monotonic()
    deadline = started + MAX_RUNTIME_SECONDS

    print("[crypto-c1] contract_sha256=%s" % EXPECTED_CONTRACT_SHA256)
    print("[crypto-c1] universe=%s interval=%s" % (",".join(SYMBOLS), INTERVAL))
    print("[crypto-c1] dev=%s..%s holdout=%s..%s" % (START, DEV_END, HOLDOUT_START, END))
    print("[crypto-c1] bounded_scope rows_per_symbol=%d pages_per_symbol=%d max_successful_requests=%d hard_runtime_bound=%ds cache_resume=ON" % (
        expected_rows, expected_pages, 1 + expected_pages * len(SYMBOLS), MAX_RUNTIME_SECONDS,
    ))
    print("[crypto-c1] hypothesis=VOLUME_CONFIRMED_1H_MOMENTUM_LONG tuning=NONE costs=24bps_roundtrip")
    print("[crypto-c1] REAL_MONEY_GATE=NO_GO production_v1.5=UNCHANGED")

    total_attempts = connectivity(deadline)
    all_trades: Dict[str, List[Dict[str, Any]]] = {}
    integrity_report: Dict[str, Any] = {}
    cache_manifest: Dict[str, Any] = {}
    transport: Dict[str, Any] = {}

    for symbol in SYMBOLS:
        rows, path, info = fetch_symbol(symbol, cache_dir, deadline)
        total_attempts += int(info["request_attempts"])
        integrity_report[symbol] = info["integrity"]
        cache_manifest[symbol] = {"path": str(path), "sha256": sha256_file(path), "rows": len(rows)}
        transport[symbol] = {k: v for k, v in info.items() if k != "integrity"}
        print("[crypto-c1] %s integrity=PASS rows=%d gaps=0 duplicates=0 sha256=%s" % (
            symbol, len(rows), cache_manifest[symbol]["sha256"],
        ))
        all_trades[symbol] = generate_trades(symbol, rows)

    dev_by: Dict[str, List[Dict[str, Any]]] = {}
    holdout_by: Dict[str, List[Dict[str, Any]]] = {}
    per_symbol: Dict[str, Any] = {}
    boundary_excluded_total = 0
    for symbol, trades in all_trades.items():
        dev, holdout, excluded = split_trades(trades)
        dev_by[symbol] = dev
        holdout_by[symbol] = holdout
        boundary_excluded_total += len(excluded)
        per_symbol[symbol] = {
            "development": metrics(dev),
            "holdout": metrics(holdout),
            "boundary_crossing_trades_excluded": len(excluded),
        }

    combined_dev = [trade for symbol in SYMBOLS for trade in dev_by[symbol]]
    combined_holdout = [trade for symbol in SYMBOLS for trade in holdout_by[symbol]]
    gate = evaluate_gate(holdout_by)
    report = {
        "capability": "CRYPTO_C1_BINANCE_SPOT_BASELINE",
        "contract_sha256": EXPECTED_CONTRACT_SHA256,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": {"base_url": BASE_URL, "endpoint": KLINES_ENDPOINT, "tls_verify": True, "authentication": "NONE"},
        "transport": {
            "request_attempts_total": total_attempts,
            "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
            "max_attempts_per_request": REQUEST_ATTEMPTS,
            "hard_runtime_bound_seconds": MAX_RUNTIME_SECONDS,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "per_symbol": transport,
        },
        "integrity": integrity_report,
        "cache_manifest": cache_manifest,
        "methodology_guards": {
            "strict_contiguous_window_required": True,
            "cross_development_holdout_trades_excluded": True,
            "combined_metrics_ordered_by_realized_exit_time": True,
            "no_parameter_tuning": True,
        },
        "per_symbol": per_symbol,
        "combined": {
            "development": metrics(combined_dev),
            "holdout": metrics(combined_holdout),
            "boundary_crossing_trades_excluded": boundary_excluded_total,
        },
        "holdout_gate": gate,
        "real_money_gate": "NO_GO",
        "production_v1_5": "UNCHANGED",
        "football_research": "FROZEN_UNCHANGED",
        "polymarket_research": "FROZEN_UNCHANGED",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print("\n=== FLUXQUANT CRYPTO C1 COMPLETE ===")
    for symbol in SYMBOLS:
        dev = per_symbol[symbol]["development"]
        holdout = per_symbol[symbol]["holdout"]
        print("[%s] DEV trades=%d mean_net=%s ci=%s | HOLD trades=%d mean_net=%s ci=%s" % (
            symbol, dev["trades"], fmt_pct(dev["mean_net_return"]), fmt_ci(dev["bootstrap_mean_net_95ci"]),
            holdout["trades"], fmt_pct(holdout["mean_net_return"]), fmt_ci(holdout["bootstrap_mean_net_95ci"]),
        ))
    combined = report["combined"]["holdout"]
    print("[HOLDOUT_COMBINED] trades=%d mean_net=%s ci95=%s win_rate=%s sum_net_units=%.6f" % (
        combined["trades"], fmt_pct(combined["mean_net_return"]), fmt_ci(combined["bootstrap_mean_net_95ci"]),
        fmt_pct(combined["win_rate"]), combined["sum_net_units"],
    ))
    print("[GATE] %s checks=%s" % (gate["status"], json.dumps(gate["checks"], sort_keys=True)))
    print("[REPORT] %s sha256=%s" % (report_path, sha256_file(report_path)))
    print("REAL_MONEY_GATE=NO_GO")
    print("PRODUCTION_V1_5=UNCHANGED")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="FluxQuant repo-internal Crypto C1 research module")
    parser.add_argument("command", nargs="?", default="analyze", choices=("analyze", "selftest"))
    parser.add_argument("--contract", default="research/experiments/crypto-c1/contract.json")
    parser.add_argument("--cache-dir", default="cache/binance/klines/crypto-c1")
    parser.add_argument("--report", default="reports/research/crypto-c1.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "selftest":
            result = selftest(Path(args.contract))
            print(json.dumps(result, sort_keys=True) if args.json else "CRYPTO_C1_SELFTEST=PASS")
            return
        report = analyze(Path(args.contract), Path(args.cache_dir), Path(args.report))
        if args.json:
            print(json.dumps({"status": report["holdout_gate"]["status"], "report": args.report, "real_money_gate": "NO_GO"}, sort_keys=True))
    except Exception as exc:
        print("[crypto-c1] ERROR:%s" % exc, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
