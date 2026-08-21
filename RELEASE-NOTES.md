# FluxQuant v1.5.0 — Consolidated Baseline Release Notes

This is the one-time consolidation release following the v1.3.1 audit. It intentionally replaces the previously staged v1.4 package so development can continue from one reviewed baseline rather than a sequence of small installers.

## Important fixes found during the consolidation audit

### Sports research correctness

- **Look-ahead bias closed:** consensus now uses only reference quotes already observed by local receive-time.
- **Clock semantics fixed:** source timestamp and local receive timestamp are separate; causal research requires `receivedAtMs`.
- **Repeated-bet inflation closed:** only the first qualifying position per venue/market is admitted.
- **Paper bankroll/risk is real:** stake sizing uses the current simulated bankroll and aggregate worst-case open-risk limit.
- **Commission models corrected:** net-market-winnings and per-bet win/loss charging are modeled separately.
- **CLV semantics corrected:** CLV compares the quoted price to independent closing fair price; commission is not baked into the closing-price comparison.
- **Source rights fail closed:** licensed/explicit-research rows require traceable `sourceContractId`.
- **Pre-match boundary fixed:** unknown event start or an at/after-start candidate is rejected; cross-venue references must share the same canonical event start.
- **Closing/settlement integrity fixed:** CLOSE rows must actually be near event start; unverified/too-early/mismatched settlements cannot settle a paper position; conflicting outcomes fail closed.
- **Price evidence no longer masquerades as execution proof:** every sports candidate is labeled `PRICE_ONLY_NOT_FILL_PROOF`.
- **Audit trace expanded:** candidate reports preserve source identifiers/contract IDs and consensus-source provenance; manual reference/settlement data is non-promotable.

### Provider policy corrections

- Bet365 remains reference-only; no scraping/automation and no manually copied Bet365 odds inside the engine.
- Betfair research uses delayed/historical/licensed sources; generic live read-only API provenance is not accepted.
- Smarkets generic API access is not treated as permission to extract/benchmark; explicit research rights are required.
- Polymarket Sports remains reference-only until a dedicated binary-share fee/depth/fill model exists.

### Polymarket

The v1.3.1 failure is frozen: no positive reconstructed-L2 pair edge survived the fixed `100 ms + 1c/leg` reference stress. Pair-arbitrage is back-burnered instead of retuned.

## Safety

Live trading and live sports betting remain hard disabled. No access restriction is bypassed. The installer performs no dependency download and no network/account/private-key action.
