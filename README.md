# FluxQuant v1.5.0 — Consolidated Research Baseline

FluxQuant is a **research/shadow quantitative market engine**. Its job is not to manufacture attractive backtests; it is to reject evidence that does not survive data-quality, timing, fees, liquidity, concentration, execution and provider-policy checks.

> **Real-money trading and live sports betting are intentionally unavailable.** There is no supported capital-authorizing path in this release, and FluxQuant never bypasses geographic, network, TLS or provider-access restrictions.

## Current verdicts

- **Polymarket complementary pair-arbitrage:** back-burnered. The frozen v1.3.1 audit found no positive reconstructed-L2 edge surviving the fixed `100 ms + $0.01/leg` reference stress. Top-only historical dates remain unusable as fill proof.
- **Calibrated directional ML baseline:** rejected as an alpha candidate under the frozen strict forward benchmark.
- **Sports Research Engine:** active as **offline/paper research only**. It is designed to test market-relative residual edge and CLV without confusing price evidence with execution proof.
- **Real money:** `NO_GO` and hard-disabled.

## One release-level validation command

```bash
npm run audit:full
```

The full audit runs Node regression tests, TypeScript, Doctor, the full-audit summary test, a sports-audit smoke test, Python exporter semantics when `pyarrow` is available, historical Polymarket evidence classification, normal connectivity/eligibility checks and an optional short read-only Polymarket paper capture. It never places an order or bet.

## Sports Research Engine

```bash
npm run sports:audit -- data/sports-research.jsonl data/sports-audit/report.json
```

The sports engine uses a strict causal contract:

1. every usable row has explicit provider/provenance plus a **local receive timestamp** (`receivedAtMs`);
2. licensed/explicit-research sources carry a traceable `sourceContractId`;
3. candidate venue is excluded from its own no-vig consensus;
4. only already-observed, fresh reference snapshots with the **same canonical `eventStartMs`** are eligible;
5. strict pre-match paper candidates require known `eventStartMs` and are rejected at/after start;
6. only the first qualifying position per venue/market is admitted, preventing repeated-snapshot bet inflation;
7. commission model/rate must be explicit for paper candidate venues;
8. bankroll and aggregate open-risk limits are simulated chronologically;
9. CLV uses the quoted market price against an independent closing consensus that must be observed near event start (within the configured freshness window); commission is modeled separately;
10. settlement must come from authorized provenance, match the canonical event start, occur after event start/entry, and conflicting settlement records fail closed;
11. manual reference/settlement observations remain exploratory evidence and hard-block any promotion verdict.

All sports candidates are labeled **`PRICE_ONLY_NOT_FILL_PROOF`**. Positive paper ROI or CLV therefore cannot authorize capital without a later execution-grade layer for depth, limits, order acceptance, latency and venue eligibility.

### Provider policy

- **Bet365:** reference-only. No scraping, no automated Bet365 betting. Only a source contract/feed that explicitly authorizes the research use is accepted; manually copied Bet365 odds are not admitted to the engine.
- **Betfair Exchange:** paper research accepts official **delayed** API data, official historical data or explicitly licensed sources. Generic live read-only API provenance is intentionally rejected.
- **Smarkets Exchange:** generic API access is **not** treated as permission to extract/benchmark prices. Paper research requires a source contract that explicitly permits the research use (or a licensed feed with those rights).
- **Polymarket Sports:** reference-only until a dedicated binary-share fee/depth/fill model exists.

See `SPORTS-RESEARCH.md` and `SOURCE-POLICY.md` for the full contract.

## Polymarket evidence classes

- `LIVE_L2` — current depth-bearing WebSocket evidence; useful paper input, still not actual fill proof.
- `HISTORICAL_RECONSTRUCTED_L2` — recorder snapshots/deltas reconstructed from raw data; historical execution research only.
- `TOP_ONLY_UNTRUSTED` — flattened top-book history without trustworthy executable depth; price research only.
- `MIXED_OR_UNKNOWN` — cannot support a clean execution claim.

CLOB V2 market metadata (fees, tick size, minimum order size and other market rules) must be queried dynamically for current paper work. Historical fee assumptions are explicitly frozen research assumptions only.

## Safety invariants

- Modes: `research`, `shadow` only.
- Live-like modes are rejected and the live execution entry point throws `LIVE_EXECUTION_DISABLED`.
- No private-key/order-signing path is used by the consolidated research workflow.
- No VPN/proxy/custom-DNS/TLS/geoblock bypass.
- Two-leg FOK/postOrders behavior is never assumed cross-order atomic.
- Bet365 scraping/automation is prohibited by project policy.
- Sports live betting is disabled.
- No historical or short paper result can open the capital gate.

## Requirements

- Node.js 22+
- npm
- For historical OpenMarket tooling: Python 3, `pyarrow`, `huggingface_hub`

The safe installer is intentionally network-free and preserves the existing `.env`, `.venv`, `node_modules`, `data/`, `.git` and unrelated local files. A fresh-from-zero dependency install is not claimed to be fully reproducible because this release does not ship a generated npm lockfile; top-level versions remain declared in `package.json` and this limitation is recorded in `VALIDATION.md`.

See `PROJECT-STATE.md`, `VALIDATION.md`, `RELEASE-NOTES.md`, `SPORTS-RESEARCH.md`, `SOURCE-POLICY.md`, `ARCHITECTURE-WATCH.md`, and `MIGRATION.md`.
