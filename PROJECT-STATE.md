# FluxQuant v1.5.0 — Consolidated Project State

## Current gate

**Research/shadow operational. Sports research active paper-only. Live trading/betting hard-disabled. REAL_MONEY_GATE = NO_GO.**

## Frozen Polymarket checkpoint

The v1.3.1 full audit is a frozen scientific checkpoint, not a tuning target:

- 2026-05-13: `TOP_ONLY_UNTRUSTED` / no executable-depth proof.
- 2026-05-14: `TOP_ONLY_UNTRUSTED` / no executable-depth proof.
- 2026-05-15: reconstructed L2 evidence was available, but no positive edge survived the frozen `100 ms + $0.01/leg` reference stress.
- read-only live CLOB V2 paper collection remained unavailable under the normal network/geographic gate; FluxQuant does not bypass the restriction.

**Decision:** complementary pair-arbitrage is back-burnered. Do not retune parameters merely to resurrect a failed historical result. Reconsider only if naturally reachable, eligible, execution-grade live V2 paper evidence changes the thesis.

## Rejected evidence

- Strict calibrated directional ML forward benchmark: negative and not an alpha candidate.
- Earlier market-control apparent profit: rejected after quote-age/synchronization audit.
- Early pair-arb profit: rejected because 500 ms downsampling and synthetic/top-only depth could create phantom fillability.
- Public flattened historical `size` is not treated as executable bid/ask depth.

## Active sports lane

v1.5 makes the sports engine causal and fail-closed rather than merely feature-complete. It now includes:

- local receive-time causality (`receivedAtMs`), separate from source timestamp;
- explicit source provenance and research-rights contract IDs;
- leave-one-venue-out no-vig consensus with canonical event-start identity checks;
- strict pre-match event-start gate;
- one position per venue/market to prevent repeated-snapshot inflation;
- explicit commission models (`NET_MARKET_WINNINGS`, `PER_BET_WIN_LOSS`);
- chronological bankroll/open-risk simulation;
- independent closing-line value with close snapshots constrained to the actual pre-start closing window;
- settlement provenance/timing/event-identity validation and conflicting-settlement rejection;
- manual reference/settlement evidence marked exploratory and non-promotable;
- event-level concentration, drawdown and approximate lower-95% evidence bounds;
- a strict paper-promotion threshold that still cannot authorize live betting;
- `PRICE_ONLY_NOT_FILL_PROOF` labeling until execution-grade sports data exists.

## Provider policy checkpoint — 2026-08-15

- Bet365: reference-only; no FluxQuant scraping or automated betting; only explicitly licensed/authorized research feeds are admitted.
- Betfair: delayed App Key / historical / explicitly licensed research data are accepted; generic live read-only data collection is not.
- Smarkets: generic API access is not accepted for benchmarking/pure paper extraction; explicit research rights are required.
- Polymarket Sports: reference-only pending a dedicated binary-share fee/depth/execution model.

## External architecture inputs

- CloddsBot: MIT; feed/freshness/risk/ledger architecture reference.
- MrFadiAi/Polymarket-bot: MIT; CTF/position-management/test ideas only; profit claims are not FluxQuant evidence.
- polymarket_lp_tool: license not established in the review; execution-safety/anti-sniping concepts only, no code copying.
- ritmex-bot: license not established in the review; adapter/recovery/Guardian concepts only, no code copying.

## Known open work after this baseline

1. Build a canonical sports event/market matcher with collision/conflict diagnostics.
2. Add a Betfair **historical/delayed-data adapter** that preserves receive/replay timing and source identity.
3. Do not add a Smarkets automated research adapter unless the data/use contract explicitly permits the research workflow.
4. Add execution-grade sports modeling (available depth, limits, matching/acceptance, latency, void/cancel semantics) before any venue can graduate beyond price-only paper evidence.
5. Freeze an untouched sports forward protocol before testing residual predictive models.
6. Add a repository lockfile only when dependency-install governance is intentionally reopened; the current safe installer is network-free and preserves the already validated local dependency tree.
7. Any real-money capability remains a separate future governance/human-approval milestone, not a normal version step.

## Release discipline

v1.5.0 is the consolidated baseline. Future version bumps should correspond to a meaningful reviewed milestone, not individual bug fixes or exploratory tests. Normal research, dataset collection and experiments should stay within this baseline until a real architectural milestone is ready.
