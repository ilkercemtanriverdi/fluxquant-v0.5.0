"""Remote Polymarket Collector configuration."""
from __future__ import annotations

import os

VERSION = "1.0.0"

POLY_WALLET = os.environ.get(
    "POLY_WALLET", "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8"
)

PRIMARY = "https://data-api.polymarket.com"
FALLBACKS = [
    "https://gamma-api.polymarket.com",
    "https://clob.polymarket.com",
]

MAX_TRADES = 500
MAX_MARKETS = 200
HTTP_TIMEOUT = 15
MAX_RETRIES = 3
RETRY_BACKOFF = [0.5, 1.0, 2.0]

REAL_MONEY_GATE = "NO_GO"
ORDERS_PLACED = 0
API_KEYS_USED = 0
