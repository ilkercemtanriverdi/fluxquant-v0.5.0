# FluxQuant Sports Data / Provider Policy

Review checkpoint: **2026-08-15**. Provider terms can change; adapters must re-check current terms before use.

## Bet365

The reviewed Bet365 terms prohibit automated systems/software used to copy or extract odds/sports data and also contain restrictions around automated/AI assistance and arbitrage activity. FluxQuant therefore has **no Bet365 scraper and no automated Bet365 execution path**. Bet365 can only be a reference source when the data itself is obtained under a source contract/feed that explicitly permits the intended research use. Manually copied Bet365 odds are intentionally rejected by the engine.

## Betfair Exchange

Betfair officially provides an Exchange API, Stream API and historical Exchange data. The developer documentation explicitly directs development/simulation to delayed data or historical data; read-only collection using a Live App Key is not the supported path. FluxQuant therefore accepts `OFFICIAL_DELAYED_API`, `OFFICIAL_HISTORICAL`, explicit research licenses and licensed feeds for paper research, but rejects generic `OFFICIAL_API` provenance.

Commission is not globally hard-coded: Betfair commission is based on **net market winnings** and the applicable rate depends on the account/package/location context.

## Smarkets Exchange

Smarkets has an official HTTP trading API, but its reviewed API terms require authorization and specifically restrict pure data extraction and use of API/data to benchmark markets/prices/liquidity/systems without appropriate permission. FluxQuant therefore does **not** treat ordinary API access as permission for this research pipeline.

Smarkets rows can become paper candidates only when provenance is `EXPLICIT_RESEARCH_LICENSE` or a `LICENSED_FEED` whose contract permits the intended analysis; such rows require `sourceContractId`.

Commission must also reflect the user's actual tier: Standard uses net-market-winnings commission, while Pro/Select-style tiers can charge per matched bet on both profits and losses.

## Polymarket

Polymarket CLOB V2 is treated as its own market microstructure, not as a sportsbook commission clone. Current fees are market-specific and queryable from CLOB market info; sports can have a different fee curve from crypto. Current orderbook data exposes depth and market rules, and WebSocket `book`/`price_change` semantics are handled separately in the Polymarket lane.

Polymarket Sports remains reference-only in the generic sports engine until a dedicated binary-share fee/depth/fill model exists. Any public endpoint use is still gated by normal connectivity/geographic eligibility; FluxQuant does not bypass restrictions.

## Provenance values

- `OFFICIAL_API`: official public API/stream only where provider policy accepts it.
- `OFFICIAL_DELAYED_API`: official delayed/development feed intended for analysis/simulation.
- `OFFICIAL_HISTORICAL`: provider historical dataset/service.
- `EXPLICIT_RESEARCH_LICENSE`: written/source contract explicitly permits this research/benchmarking use; requires `sourceContractId`.
- `LICENSED_FEED`: third-party/provider data license permits the intended research use; requires `sourceContractId`.
- `MANUAL_RESEARCH`: manually supplied non-Bet365 reference/settlement observation; exploratory only, never implies automated access rights, and hard-blocks promotion if used in consensus or settlement.
- `UNKNOWN`: rejected.

A provenance label is an audit assertion by the ingestion adapter/data owner, not a substitute for legal review. When rights are ambiguous, FluxQuant fails closed.
