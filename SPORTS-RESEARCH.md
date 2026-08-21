# FluxQuant Sports Research Engine — Consolidated V1.5 Contract

Status: **ACTIVE_RESEARCH_PAPER_ONLY**. Live betting is disabled.

## Purpose

The sports lane tests whether a venue quote is mispriced relative to information already visible at that moment. It does not start by asking a model to predict match winners from scratch, and it does not treat win rate as evidence of edge.

## Causal proof chain

1. Ingest authorized snapshots with canonical event/market identity.
2. Preserve provider/source timestamp separately from **local receive time**. Causal ordering and freshness use `receivedAtMs` only.
3. Require traceable research rights: `LICENSED_FEED` and `EXPLICIT_RESEARCH_LICENSE` rows must include `sourceContractId`.
4. Remove bookmaker vig with the power method (proportional fallback).
5. Build a leave-one-venue-out consensus from independent venues that were already observed and remain fresh at candidate receive-time.
6. Require known `eventStartMs`; strict paper candidates at/after start are rejected.
7. Freeze the first qualifying position per venue/market so repeated snapshots cannot multiply paper exposure.
8. Require explicit commission rate/model for candidate venues.
9. Size against current simulated bankroll and aggregate worst-case open risk.
10. Measure CLV against an independent closing consensus observed near the canonical event start (inside `maxAgeMs`); entry commission is not allowed to distort the closing market-price comparison.
11. Settle only from authorized observations after event start/entry. Conflicting settlement outcomes fail closed.
12. Evaluate event-level ROI/CLV, drawdown and concentration on an untouched forward sample.

## Timestamp contract

`asOfMs` is source/provider time for provenance and diagnostics. `receivedAtMs` is the local observation/replay time used for all causal decisions. A source row that claims an old source timestamp but arrives after a target quote cannot be used to validate that earlier quote.

This distinction exists specifically to prevent a sports version of the same timing mistake that can make market backtests look better than executable reality.

## Provider policy

### Bet365

`REFERENCE_ONLY`. FluxQuant does not scrape Bet365, does not automate Bet365 account actions and does not generate Bet365 execution candidates. Data is accepted only through a source contract/feed that explicitly permits the intended research use. Manually copied Bet365 odds are intentionally rejected. Licensed/explicit-research feeds must carry `sourceContractId`.

### Betfair Exchange

`RESEARCH_PAPER_CANDIDATE`, but data policy is strict. For analysis/simulation use official delayed App Key data, official historical data, or another explicitly licensed source. Generic `OFFICIAL_API` is intentionally not accepted because read-only collection with a Live App Key is not the supported research path.

Commission is modeled as `NET_MARKET_WINNINGS`; the rate must be supplied for the account/package/market context rather than hard-coded globally.

### Smarkets Exchange

`RESEARCH_PAPER_CANDIDATE` only when the data contract explicitly permits this research/benchmarking use. Generic Smarkets API provenance is intentionally rejected. The Standard commission model is net-market-winnings; Pro/Select-style per-bet charging is represented with `PER_BET_WIN_LOSS` so losing liability can exceed raw stake.

### Polymarket Sports

`REFERENCE_ONLY` in v1.5. Polymarket sports uses binary-share CLOB fee/depth mechanics, so the generic exchange-odds commission model is not valid for it. A dedicated paper model must query current per-market fee/rule metadata and reconstruct depth before promotion.

## Paper evidence vs execution evidence

Every v1.5 sports candidate is tagged `PRICE_ONLY_NOT_FILL_PROOF`. This means:

- a quoted price may be attractive relative to consensus;
- CLV may later be positive;
- simulated PnL may be positive;
- **none of those prove that the quoted stake could actually be accepted/matched at that price.**

Execution-grade promotion requires venue-specific depth/limits/order-acceptance/latency semantics and provider/legal eligibility.

## Paper promotion screen

The CLI may only label a run `PROMISING_UNTOUCHED_PAPER_EVIDENCE_ONLY` when all of these hold:

- no hard data/provenance/commission/timing blocker;
- at least 200 unique settled events and at least 200 settled candidates;
- CLV coverage >= 80%;
- event-level CLV lower-95% bound > 0;
- event-level ROI lower-95% bound > 0 and aggregate ROI > 0;
- max simulated drawdown <= 20%;
- max single-event turnover concentration <= 10%.

Even this label is **not live-money authorization**. It only earns independent review and the right to build a stronger execution test.

## Example JSONL fields

`SportsVenueSnapshot` supports:

- `provider`, `venue`, `eventId`, `marketId`, `marketKind`, optional `line`;
- `asOfMs` (source time), `receivedAtMs` (causal local time), `eventStartMs`;
- `stage`: `OPEN`, `CLOSE`, `SETTLED`;
- `quotes` with decimal odds;
- `provenance`, optional `sourceContractId`, `sourceEventId`, `sourceMarketId`;
- candidate venues: `commissionRate`, `commissionModel`;
- settlement rows: `settledOutcome` (`VOID` supported).

See `config/sports-research.example.jsonl` for synthetic test data only. Its PnL is not alpha evidence.
