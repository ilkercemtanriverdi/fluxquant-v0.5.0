# Polymarket Remote Collector v1

Fetch Polymarket wallet trades and market data from outside the local network.

## Structure

```
src/collectors/polymarket_remote/
  collector.py    # CLI + fetch logic
  config.py       # endpoints, wallet, limits
  requirements.txt
  README.md
```

## Snapshot Output

```
data/polymarket/snapshots/
  wallet-trades-latest.json
  markets-latest.json
  _manifest.json
```

Each snapshot envelope:

```json
{
  "collector_version": "1.0.0",
  "kind": "wallet-trades",
  "captured_at": "2026-08-21T01:05:43Z",
  "checksum_sha256": "a1b2c3...",
  "byte_count": 12345,
  "data": { ... }
}
```

## CLI

```bash
# self-test
python src/collectors/polymarket_remote/collector.py self-test

# health check all endpoints
python src/collectors/polymarket_remote/collector.py health

# fetch wallet trades
python src/collectors/polymarket_remote/collector.py wallet

# fetch active markets
python src/collectors/polymarket_remote/collector.py markets

# fetch both
python src/collectors/polymarket_remote/collector.py all
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLY_WALLET` | `0x04b6d7e930cf9e493c5e6ef24b496294f95594c8` | Target wallet address |

## Safety Gates

```
REAL_MONEY_GATE=NO_GO
ORDERS_PLACED=0
API_KEYS_USED=0
```

No trading execution. No API keys. Research infrastructure only.

## Deployment Options

### 1. GitHub Actions Free Runner

Create `.github/workflows/polymarket-collect.yml`:

```yaml
name: Polymarket Collect
on:
  schedule:
    - cron: '0 */4 * * *'   # every 4 hours
  workflow_dispatch:

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Run collector
        run: python src/collectors/polymarket_remote/collector.py all
      - name: Commit snapshots
        run: |
          git config user.name "polymarket-collector"
          git config user.email "collector@fluxquant.local"
          git add data/polymarket/snapshots/
          git diff --cached --quiet || git commit -m "polymarket snapshots [skip ci]"
          git push
```

Free tier: 2,000 minutes/month. This runs ~180 minutes/month.

### 2. Cloudflare Worker Alternative

Create `workers/polymarket-proxy/src/index.js`:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get("target") || "trades";

    const wallet = env.POLY_WALLET || "0x04b6d7e930cf9e493c5e6ef24b496294f95594c8";
    const baseUrl = "https://data-api.polymarket.com";

    let apiUrl;
    if (target === "trades") {
      apiUrl = `${baseUrl}/trades?user=${wallet}&limit=200&takerOnly=false`;
    } else if (target === "markets") {
      apiUrl = `${baseUrl}/markets?limit=100&active=true`;
    } else {
      return new Response(JSON.stringify({error: "unknown target"}), {status: 400});
    }

    const resp = await fetch(apiUrl, {
      headers: {"Accept": "application/json"},
    });
    const data = await resp.text();

    return new Response(data, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
```

Deploy with `wrangler deploy`. Set `POLY_WALLET` secret.

Then point collector at your worker URL:

```bash
POLY_WALLET=0x04b6d7e930cf9e493c5e6ef24b496294f95594c8 \
python src/collectors/polymarket_remote/collector.py all
```

### 3. Local Testing (Behind Geo-Block)

If the Polymarket API is geo-blocked on your network:

1. Run the collector from a non-blocked network (VPN, cloud VM, or GitHub Actions)
2. Snapshots save to `data/polymarket/snapshots/`
3. Research scripts consume snapshots via `load_latest()` or read the files directly

```bash
# On a cloud VM with API access:
python src/collectors/polymarket_remote/collector.py all

# Then pull snapshots down:
scp user@vm:data/polymarket/snapshots/wallet-trades-latest.json \
  data/polymarket/snapshots/
```

## How Research Scripts Consume Snapshots

```python
import json
from pathlib import Path

snapshot_dir = Path("data/polymarket/snapshots")
latest = snapshot_dir / "wallet-trades-latest.json"
if latest.exists():
    envelope = json.loads(latest.read_text())
    trades = envelope["data"]["trades"]
    # ... analyze trades
```

## Endpoints

| Name | URL | Role |
|------|-----|------|
| primary | `https://data-api.polymarket.com` | First attempt |
| fallback1 | `https://gamma-api.polymarket.com` | Retry target |
| fallback2 | `https://clob.polymarket.com` | Final fallback |

All three are tried with SSL strict→permissive fallback on each.
