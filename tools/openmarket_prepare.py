#!/usr/bin/env python3
"""Download a bounded, complete OpenMarket unified-day slice for FluxQuant research.

This intentionally downloads only three public Parquet files for one UTC day:
- unified/binance_ticks_ms/date=YYYY-MM-DD/part-000001.parquet
- unified/polymarket_ticks_ms/date=YYYY-MM-DD/part-000001.parquet
- unified/market_meta/unpartitioned/part-000001.parquet

No Polymarket live endpoint, wallet, signing, or geoblock bypass is involved.
"""
from __future__ import annotations

import argparse
from pathlib import Path

try:
    from huggingface_hub import hf_hub_download
except Exception as exc:
    raise SystemExit("huggingface_hub is required: python3 -m pip install huggingface_hub") from exc

REPO = "gregyoung14/openmarket-btc-polymarket"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--date", default="2026-02-12", help="UTC date partition (YYYY-MM-DD)")
    p.add_argument("--out", type=Path, default=Path("data/openmarket-unified"))
    args = p.parse_args()

    paths = [
        f"unified/binance_ticks_ms/date={args.date}/part-000001.parquet",
        f"unified/polymarket_ticks_ms/date={args.date}/part-000001.parquet",
        "unified/market_meta/unpartitioned/part-000001.parquet",
    ]

    args.out.mkdir(parents=True, exist_ok=True)
    for filename in paths:
        local = hf_hub_download(
            repo_id=REPO,
            repo_type="dataset",
            filename=filename,
            local_dir=str(args.out),
        )
        print(f"[openmarket-prepare] downloaded={local}")

    print(f"[openmarket-prepare] root={args.out / 'unified'}")
    print(f"[openmarket-prepare] date={args.date}")


if __name__ == "__main__":
    main()
