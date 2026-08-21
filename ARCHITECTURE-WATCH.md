# FluxQuant Architecture Watch — External References

Review checkpoint: 2026-08-15. External projects are references, never proof of profitability.

## CloddsBot (`alsk1992/CloddsBot`)

GitHub exposes an MIT license. Useful independent-design references: feed freshness, reconnect/reconciliation, risk ledger, market adapters and structured diagnostics. FluxQuant does not put an LLM in the hot execution loop merely because Clodds is agent-oriented.

## MrFadiAi/Polymarket-bot

MIT licensed. Useful references: CTF split/merge lifecycle, dry-run ergonomics, position/risk management and test structuring. Claims such as “guaranteed arbitrage” are not accepted without FluxQuant's own depth, fee, timing and leg-risk proof.

## lihanyu81/polymarket_lp_tool

No compatible license was established during the review. Architecture ideas only: cancel/replace idempotency, cooldowns, anti-sniping filters, retry/reconciliation and observability. **No source-code copying.**

## discountry/ritmex-bot

No explicit repository license was established during the review. Architecture ideas only: exchange capability contracts, dry-run JSON CLI, restart reconciliation, depth/data-health gates and a Guardian-style protection process. **No source-code copying.** High-leverage defaults/referral/bootstrap behavior are explicitly excluded.

## FluxQuant independent implementation rules

- deterministic market/risk/execution code owns capital decisions;
- AI/LLM components may research, explain and calibrate offline but cannot hold private keys or override kill/risk gates;
- every venue adapter must advertise capabilities and rules explicitly;
- data freshness/receive-time and source provenance are first-class evidence;
- no external repo's README performance claim can promote a FluxQuant strategy.
