#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
EXPORTER = ROOT / "tools" / "openmarket_export.py"
DATE = "2026-05-13"


def epoch_ms(hour: int, minute: int = 0) -> int:
    return int(datetime(2026, 5, 13, hour, minute, tzinfo=timezone.utc).timestamp() * 1000)


def write_parquet(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), path)


def fixture(root: Path, *, with_raw: bool) -> None:
    markets = []
    pm = []
    for i, hour in enumerate((1, 2, 3)):
        start = epoch_ms(hour)
        slug = f"btc-updown-15m-{start // 1000}"
        up = f"up-{i}"
        down = f"down-{i}"
        markets.append({
            "slug": slug,
            "condition_id": slug,
            "question": f"Bitcoin Up or Down {i}",
            "up_token_id": up,
            "down_token_id": down,
            "resolved_outcome": None,
            "end_date_iso": datetime.fromtimestamp((start + 900_000) / 1000, tz=timezone.utc).isoformat(),
        })
        for token, side, bid, ask in ((up, "up", 0.40, 0.41), (down, "down", 0.57, 0.58)):
            for j in range(2):
                ts = start + 1_000 + j * 100
                raw_json = None
                if with_raw:
                    if j == 0:
                        raw_json = json.dumps({
                            "type": "book", "asset_id": token, "timestamp": ts,
                            "bids": [[bid, 10.0]], "asks": [[ask, 12.0]],
                        })
                    else:
                        raw_json = json.dumps({
                            "type": "price_change", "asset_id": token, "timestamp": ts,
                            "price": ask, "size": 0, "side": "SELL", "best_bid": bid, "best_ask": ask,
                        })
                row = {
                    "id": i * 10 + j,
                    "source_ts_ms": ts,
                    "ingest_ts_ms": ts + 7,
                    "market_slug": slug,
                    "asset_id": token,
                    "side_label": side,
                    "event_type": "book" if j == 0 else "price_change",
                    "price": None,
                    "best_bid": bid,
                    "best_ask": ask,
                    "size": 999.0,  # deliberately misleading flattened size
                }
                if with_raw:
                    row["raw_json"] = raw_json
                pm.append(row)

    write_parquet(root / "market_meta" / "unpartitioned" / "part-000001.parquet", markets)
    write_parquet(root / "polymarket_ticks_ms" / f"date={DATE}" / "part-000001.parquet", pm)


class ExporterPairProfileTest(unittest.TestCase):
    def run_export(self, *, with_raw: bool) -> list[dict]:
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            root = base / "unified"
            fixture(root, with_raw=with_raw)
            events = base / "events.jsonl"
            markets = base / "markets.json"
            proc = subprocess.run([
                sys.executable, str(EXPORTER), str(root),
                "--date", DATE, "--profile", "pair",
                "--events", str(events), "--markets", str(markets),
                "--max-markets", "3", "--min-samples-per-market", "1", "--sample-ms", "0",
            ], cwd=ROOT, text=True, capture_output=True)
            if proc.returncode != 0:
                raise AssertionError(proc.stdout + "\n" + proc.stderr)
            rows = [json.loads(line) for line in events.read_text().splitlines() if line.strip()]
            self.assertTrue(rows)
            received = [r["receivedTimeMs"] for r in rows]
            self.assertEqual(received, sorted(received), "pair export must be received-time ordered")
            return rows

    def test_public_parquet_without_raw_json_is_top_only_and_untrusted(self) -> None:
        rows = self.run_export(with_raw=False)
        self.assertTrue(all(r["raw"].get("historical_top_only") is True for r in rows))
        self.assertTrue(all(r["raw"]["bids"][0]["size"] == 1.0 for r in rows))
        self.assertTrue(all(r["raw"]["asks"][0]["size"] == 1.0 for r in rows))
        # Never leak the misleading flattened 999 size into executable depth.
        self.assertFalse(any(r["raw"]["bids"][0]["size"] == 999 for r in rows))

    def test_raw_recorder_json_reconstructs_snapshot_and_zero_size_deletion(self) -> None:
        rows = self.run_export(with_raw=True)
        books = [r for r in rows if r["kind"] == "book"]
        deltas = [r for r in rows if r["kind"] == "price_change"]
        self.assertTrue(books and deltas)
        self.assertTrue(all(r["raw"].get("historical_l2_reconstructed") is True for r in books + deltas))
        self.assertTrue(any(r["raw"].get("size") == 0 for r in deltas), "zero-size removals must be preserved")
        self.assertTrue(any(r["raw"]["asks"][0]["size"] == 12.0 for r in books))


if __name__ == "__main__":
    unittest.main()
