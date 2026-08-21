# FluxQuant v1.5.0 Validation

## Consolidated release-tree validation

- Node regression suite: **83 passed / 0 failed**
- TypeScript strict typecheck: **PASS**
- Doctor safety checks: **PASS**
- Full-audit summary unit test: **PASS**
- Sports audit end-to-end synthetic CLI smoke: **PASS**
- Live execution guard: **PASS / hard disabled**

The assistant build container does not include `pyarrow`, so `tools/test_openmarket_export.py` cannot run there. `doctor` now reports this explicitly. The safe installer runs `tools/test_full_audit.py`; on the user's existing FluxQuant venv, `npm run audit:full` also runs the Python exporter semantics test when `pyarrow` is available.

## Sports regression coverage added in the consolidation

Tests cover:

- causal leave-one-out consensus;
- future reference quote rejection;
- **local receive-time** causality (a late-delivered row cannot validate an earlier target merely because its source timestamp is old);
- missing receive-time fail-closed behavior;
- repeated-snapshot position deduplication;
- source provenance and licensed-contract traceability;
- mandatory commission rate/model;
- net-market-winnings and per-bet win/loss commission math;
- pre-match event-start enforcement and canonical cross-venue event-start identity;
- bankroll/open-risk limits;
- closing-window integrity plus settlement provenance/timing/identity and conflicting-settlement rejection;
- manual reference/settlement evidence is marked non-promotable;
- CLV calculation and concentration/drawdown reporting;
- provider policy (Bet365 reference-only, Betfair delayed/historical, Smarkets explicit research rights, Polymarket Sports reference-only).

## Polymarket regression coverage retained

The suite continues to verify top-only depth rejection, CLOB V2 dynamic market rules, 5-decimal fee rounding, geoblock fail-closed behavior, received-time batching, stale quote rejection and live execution disablement.

## Dependency reproducibility note

This consolidated in-place installer is **network-free** and preserves the already validated local `node_modules`. The source ZIP does not include an npm lockfile because one could not be generated/verified offline in the build environment. Therefore the release does **not** claim byte-for-byte reproducibility for a brand-new future `npm install` from an empty directory. This is an explicit known limitation, not hidden evidence. Reopening fresh-install dependency governance should be a separate milestone.

## What PASS does not mean

Passing software tests proves declared mechanics. It does not prove alpha, sportsbook/exchange limits, sports fillability, queue priority, live latency, account eligibility, legal availability, multi-day stability or profitable real execution. The release cannot authorize capital.
