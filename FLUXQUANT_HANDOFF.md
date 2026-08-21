# FLUXQUANT — MASTER HANDOFF / CHECKPOINT

**Last updated:** 2026-08-18  
**Purpose:** This file is the persistent handoff for any future AI/coding agent. Read this file BEFORE changing anything.

---

# 0. NON-NEGOTIABLE GOVERNANCE

- `REAL_MONEY_GATE=NO_GO`
- `ORDERS_PLACED=0`
- `API_KEYS_USED=NO`
- `PROFITABILITY_PROMOTION_ALLOWED=NO`
- No private keys.
- No authenticated CLOB execution.
- No live orders.
- No real-money trading.
- Research/paper analysis only.
- Do not change production logic merely to make a research result pass.
- Do not retune thresholds after seeing holdout results.
- Preserve frozen protocols unless explicitly authorized.

**Important:** A `KILL` or `BLOCKED` research decision is a research outcome, NOT permission to change gates or bypass validation.

---

# 1. SOURCE OF TRUTH

Primary Mac project:

`~/Downloads/fluxquant-v0.5.0`

This folder is the master working copy.

Important directories:

- `tools/research/` — research implementations
- `tests/` — regression/focused tests
- `reports/research/` — experiment reports and SHA256-verifiable outputs

Colab is an execution environment only. Do NOT treat Colab as the master project copy.

Do not repeatedly create unrelated `v16/v17/v18/...` copies. Prefer one canonical project tree.

---

# 2. HOW A NEW AGENT MUST START

Before doing any work:

1. Read this file completely.
2. Inspect the current filesystem/repository state.
3. Inspect `tools/research/`.
4. Inspect `tests/`.
5. Inspect the newest reports under `reports/research/`.
6. Run existing relevant tests before modifying code.
7. Identify the exact current checkpoint.
8. Continue from the checkpoint; do NOT rebuild the project.

If something can be inspected, tested, searched, or implemented locally, do it autonomously.

Only ask the human to perform an action when the environment genuinely requires it (for example: uploading a file to an external Colab session, granting access, or running a command in an environment unavailable to the agent).

Do NOT repeatedly send the human through unnecessary upload/copy/paste loops.

---

# 3. CORE PROJECT OBJECTIVE

FluxQuant is a research-first quantitative intelligence system.

Research areas currently include:

1. Crypto market research
2. Polymarket wallet/strategy research
3. Sports edge validation
4. Future automated decision systems

Current phase: validation/research only.

---

# 4. POLYMARKET WALLETS BEING INVESTIGATED

Original wallet list:

1. `Hitmonlee`
2. `trinity42`
3. `0x13f0bcec1e2e60ec9acc3bee4d2da2fe9694a50f-1774334442364`
4. `0xce25e214d5cfe4f459cf67f08df581885aae7fdc-1777575398144`

The wallet currently analyzed in P1/P1B/P1C:

`0xce25e214d5cfe4f459cf67f08df581885aae7fdc`

The wallet currently analyzed in P2A Trinity:

`0x4228048ea2f8f571ff2777cc32baee584c5134cb`

---

# 5. P1 — POLYMARKET INVENTORY ROTATION

Implementation:

`tools/research/poly_inventory_rotation.py`

Mode is read-only paper research.

Original P1 bounded run eventually became reachable from Colab after the Mac environment had a BTK/TLS proxy problem.

Relevant P1 behavior:

- Fetch all trades
- Fetch taker trades
- Fetch closed positions
- Fetch rebates
- Reconstruct paired inventory
- Report gross/net exposure
- Do not claim profitability without authoritative realized PnL/rebate/fee/settlement evidence

Earlier successful P1 run:

- `MARKETS_ANALYZED=47`
- `TRADES_ANALYZED=500`
- `TWO_SIDED_MARKETS=38`
- `ONE_SIDED_MARKETS=9`
- `PAIRED_INVENTORY_MARKETS=38`
- `MEAN_PAIRED_COST=0.876868`
- `MEDIAN_PAIRED_COST=0.844475`
- `PAIRED_COST_BELOW_1_SHARE=29`
- `MAX_GROSS_EXPOSURE=1523.61`
- `MAX_NET_DIRECTIONAL_EXPOSURE=259.83`
- `REBATE_COVERAGE_COMPLETE=NO`
- `REALIZED_PNL_IF_AUTHORITATIVE=None`
- `MAKER_ROLE_INFERENCE=INCONCLUSIVE`

P1 decision was `KEEP`, but profitability was NOT proven.

---

# 6. P1B — FIFO PAIR-LOCK ACCOUNTING

P1B was added to fix the weakness of aggregate paired-cost diagnostics.

Implementation:
`tools/research/poly_inventory_rotation.py`

P1B features:

- FIFO lot engine for UP/DOWN
- Chronological pair locking
- Hedge-delay calculation
- Locked-pair quantity
- Locked share below total cost 1
- Gross locked margin
- Concentration metrics
- Accounting completeness checks
- Missing fee/rebate/settlement are NOT silently treated as zero
- SELL exceeding remaining inventory is accounting-incomplete
- Deterministic timestamp ordering
- Tie handling is deterministic

Focused tests at the latest known checkpoint:

`39 pass, 0 fail`

All known P1/P1B regression tests passed.

A previous P1B run produced:

- `P1B_MARKETS_ELIGIBLE=47`
- `P1B_MARKETS_WITH_LOCKED_PAIRS=38`
- `P1B_TOTAL_LOCKED_PAIR_QTY=5622.175824`
- `P1B_TOTAL_LOCK_EVENTS=250`
- `P1B_LOCKED_SHARE_BELOW_1=0.5298`
- `P1B_GROSS_LOCKED_MARGIN_USDC=313.568281`
- `P1B_PROFITABILITY_PROVEN=NO`

P1B was later used as the frozen gate set for P1C maturation.

---

# 7. P1C — POLYMARKET HOLDOUT

P1C is the important holdout/maturation validation stage.

Exact implementation command:

`python3 tools/research/poly_inventory_rotation.py p1c-holdout`

Known constants:

- `P1C_HOLDOUT_START_EPOCH=1787074470`
- `P1C_MIN_TRADES_FOR_DECISION=500`
- `CLOB_API=https://clob.polymarket.com`

P1C pipeline:

1. Fetch holdout trades
2. Epoch-filter
3. Deduplicate
4. Reconstruct inventory
5. Settle
6. Analyze rebates
7. Apply frozen P1B gates
8. Decide

Important bug that was fixed:

`REJECTED_PRE_CUTOFF` was initially counted from the already-filtered list. It was corrected to:

`raw_count - filtered_count`

An assertion was also added so accepted timestamps must lie inside:

`[holdout_start*1000, holdout_end*1000]`

Another bug was fixed when the 500-trade run reached `p1b_decision` and raised:

`KeyError: 'P1B_MARKETS_WITH_LOCKED_PAIRS'`

P1C aggregation was corrected to provide the P1B-prefixed fields expected by the frozen P1B decision logic.

---

# 8. FINAL P1C HOLDOUT RESULT

The final 500-trade P1C run:

`P1C_HOLDOUT_START_EPOCH=1787074470`

`P1C_HOLDOUT_END_EPOCH=1787078380`

Results:

- `P1C_TRADES_ANALYZED=500`
- `P1C_MARKETS_ANALYZED=52`
- `P1C_MARKETS_WITH_LOCKED_PAIRS=46`
- `P1C_TOTAL_LOCKED_PAIR_QTY=5663.540070`
- `P1C_TOTAL_LOCK_EVENTS=250`
- `P1C_LOCKED_SHARE_BELOW_1=0.4809`
- `P1C_WEIGHTED_LOCKED_COST=0.985566`
- `P1C_GROSS_LOCKED_MARGIN_USDC=-0.529129`
- `P1C_MEDIAN_HEDGE_DELAY_SECONDS=57`
- `P1C_P90_HEDGE_DELAY_SECONDS=174`
- `P1C_MAX_HEDGE_DELAY_SECONDS=756`
- `P1C_MAX_PRELOCK_DIRECTIONAL_COST_USDC=132.050000`
- `P1C_MARKET_CONCENTRATION_TOP1_SHARE=0.119467`
- `P1C_MARKET_CONCENTRATION_TOP3_SHARE=0.303925`
- `P1C_AUTHORITATIVE_REALIZED_PNL_USDC=None`
- `P1C_SETTLEMENT_COVERAGE_COMPLETE=NO`
- `P1C_CONFIRMED_REBATES_USDC=None`
- `P1C_REBATE_COVERAGE_COMPLETE=YES`
- `P1C_FEE_COVERAGE_COMPLETE=NO`
- `P1C_PROFITABILITY_PROVEN=NO`
- `P1C_DECISION=KILL`

Interpretation:

The holdout did NOT validate a profitable inventory-rotation edge.

Do not retune the gates to turn this into KEEP.

This is a valid negative research result.

---

# 9. P1C REBATE BUG FIX

The Polymarket rebate endpoint originally returned HTTP 400 when called as bare:

`/rebates/current`

Root cause/fix:

`fetch_rebates_for_date()` now sends:

`?date=YYYY-MM-DD&maker_address=0x...`

and uses `use_cache=False`.

This fixed the 400 root cause for date-specific rebate retrieval.

---

# 10. P2A — TRINITY SPOT ROTATION

Wallet:

`0x4228048ea2f8f571ff2777cc32baee584c5134cb`

Purpose:

Test whether Trinity's Polymarket BUY fills are aligned with contemporaneous spot-market movement.

Initial implementation attempted per-market spot requests and exceeded the request cap.

That was fixed by batching/planning spot retrieval.

A later historical-archive path was implemented.

---

# 11. P2A HISTORICAL ARCHIVE — FINAL KNOWN RESULT

Historical window:

`2026-08-14..2026-08-18`

Source:

`POLYMARKET_ACTIVITY_START_END`

Spot source:

`BINANCE_DAILY_ARCHIVE_1S`

Final run:

- `P2A_TRADES_FETCHED=500`
- `P2A_QUALIFYING_TRADES=500`
- `P2A_QUALIFYING_BUY_FILLS=323`
- `P2A_MARKETS_ANALYZED=274`
- `P2A_MARKETS_SPOT_COMPLETE=274`
- `P2A_SPOT_MATCHED_BUY_FILLS=323`
- `P2A_SPOT_MATCH_COVERAGE=1.000000`
- `P2A_ALIGNED_BUY_FILLS=221`
- `P2A_MISALIGNED_BUY_FILLS=102`
- `P2A_NEUTRAL_BUY_FILLS=0`
- `P2A_ALIGNMENT_SHARE=0.684211`
- `P2A_MEDIAN_SIGNED_DISPLACEMENT_BPS=1.755655`
- `P2A_MEAN_SIGNED_DISPLACEMENT_BPS=1.535281`
- `P2A_TOTAL_ROTATIONS=27`
- `P2A_SPOT_SIGN_CHANGE_ROTATIONS=5`
- `P2A_SPOT_SIGN_CHANGE_ROTATION_SHARE=0.185185`
- `P2A_MEDIAN_ROTATION_GAP_SECONDS=42`
- `P2A_TOP1_MARKET_NOTIONAL_SHARE=0.087417`
- `P2A_TOP3_MARKET_NOTIONAL_SHARE=0.190942`
- `P2A_PARSE_REJECTED=0`
- `P2A_WINDOW_PARSE_REJECTED=79`
- `P2A_WINDOW_PARSE_RECOVERED=0`
- `P2A_GAMMA_METADATA_REQUESTS=2`
- `P2A_OUTSIDE_WINDOW_REJECTED=0`
- `P2A_SPOT_MATCH_INVALID=0`
- `P2A_SPOT_SOURCE=BINANCE_DAILY_ARCHIVE_1S`
- `P2A_PLANNED_SPOT_REQUESTS=8`
- `P2A_REQUEST_PLAN_EXCEEDS_CAP=NO`
- `P2A_ARCHIVE_MATURATION_REQUIRED=NO`
- `P2A_ARCHIVE_IMMATURE_UNITS=[]`
- `P2A_SPOT_FETCH_FAILURES=0`
- `P2A_HISTORICAL_SAMPLE_COMPLETE=YES`
- `REQUESTS_USED=10`
- `ERRORS=[]`
- `P2A_PROFITABILITY_PROVEN=NO`
- `PROFITABILITY_PROMOTION_ALLOWED=NO`
- `REAL_MONEY_GATE=NO_GO`

Latest report:

`reports/research/poly-trinity-rotation/trinity-rotation-historical-2026-08-14-to-2026-08-18-20260818T200325Z.json`

SHA256:

`ff5252e3f92848ce204910f6a8de429d3f3f9389d37bfd60204220ac8d8bf02b`

Interpretation:

There is a measurable relationship in this sample:
- 68.4% of qualifying BUY fills were aligned with the measured spot direction.
- Median signed displacement was +1.755655 bps.
- Mean signed displacement was +1.535281 bps.
- 5/27 rotations showed spot sign changes.

BUT:

This is NOT yet profitability proof.

The P2A decision remains `BLOCKED`.

Do not promote this to a trading strategy based on this sample alone.

---

# 12. P2A DATA-QUALITY HISTORY

Initial P2A attempt:

- 500 trades
- 319 BUY fills
- 284 markets
- 0 spot matches
- 319 invalid spot matches
- 193 planned spot requests
- request plan exceeded cap

This was identified as an architecture/data-fetch problem, NOT evidence that Trinity had no signal.

A historical archive mode was then implemented.

One-day historical sample:

`2026-08-17`

- 222 trades found
- 140 BUY fills
- 125 markets
- no spot source initially
- blocked because spot matching was unavailable

Then the multi-day historical archive was implemented using Binance 1-second daily archives, which produced the final complete 500-trade result above.

---

# 13. CRYPTO ALTCOIN FLOW STATUS

Capability:

`crypto-altcoin-flow`

A watch-horizons run completed with:

- `WATCH_OBSERVATIONS=5`
- `VALID_HORIZONS_RESOLVED_DURING_WATCH=20`
- `LEGACY_HORIZONS_INVALIDATED_NOW=0`
- `ERRORS=0`
- `ALTFLOW_HORIZON_INSTRUMENTATION_V2=PASS`
- `LEGACY_V1_PROFITABILITY_EVIDENCE=INVALIDATED`
- `TOKEN_FILTERS_CHANGED=NO`
- `SIGNAL_FORMULAS_CHANGED=NO`
- `COST_HURDLE_CHANGED=NO`
- `LIVE_EXECUTION_ADDED=NO`
- `ORDERS_PLACED=0`
- `API_KEYS_USED=NO`
- `REAL_MONEY_GATE=NO_GO`
- `ALTFLOW_DECISION=KEEP_PROSPECTIVE_SIGNAL_UNPROVEN`

This means the signal remains prospective/unproven.

Do not treat the old V1 profitability evidence as valid.

---

# 14. CRYPTO C1 STATUS

Known bounded public-market-data research configuration:

Universe:
- BTCUSDT
- ETHUSDT
- SOLUSDT

Interval:
`15m`

Development:
`2024-01-01..2026-01-01`

Holdout:
`2026-01-01..2026-08-01`

Rows per symbol:
`90528`

Pages per symbol:
`91`

Connectivity:
`PASS`

Endpoint:
`data-api.binance.vision`

TLS verification:
`ON`

REAL_MONEY_GATE:
`NO_GO`

The BTCUSDT bounded collection reached 90528 rows through 2026-07-31 in the known checkpoint.

---

# 15. FOOTBALL RESEARCH STATUS

FluxQuant sports research has a frozen historical edge-validation protocol.

Development:
`2019/20–2024/25`

Untouched holdout:
`2025/26`

Competitions:
- Premier League
- La Liga
- Bundesliga
- Serie A
- Ligue 1
- Süper Lig

Edge threshold:
`2%`

Minimum independent bookmakers:
`3`

Production FluxQuant v1.5 must remain unchanged during this research.

---

# 16. TEST / IMPLEMENTATION DISCIPLINE

Known latest test status:

- P1/P1B/P1C focused/regression suite: `39 pass, 0 fail`
- Earlier P1/P1B suite: `29 pass, 0 fail`
- `tests/research-registry.test.ts`: `6 pass, 0 fail`

When modifying `poly_inventory_rotation.py`:

1. Run Python self-test if available.
2. Run focused TypeScript tests.
3. Run relevant regression tests.
4. Run a bounded invocation.
5. Save report.
6. Record SHA256.
7. Update this handoff.

Do not claim PASS based only on source inspection.

---

# 17. KNOWN ENVIRONMENT PROBLEM

The Mac environment previously had a network transport problem for Polymarket:

`data-api.polymarket.com`

returned an SSL certificate associated with:

`*.btk.gov.tr`

This was a DNS/network proxy issue on that host.

Therefore:

- Mac live Polymarket API research may fail.
- Colab successfully reached the public Polymarket endpoints.
- This is an environment/network issue, not automatically an application bug.

When a public API cannot be reached locally, do not rewrite working code just to accommodate the local network.

---

# 18. FILE / ENVIRONMENT RULE

Do NOT make the human manually reconstruct the project from individual files unless necessary.

Preferred workflow:

Mac:
`~/Downloads/fluxquant-v0.5.0`

is the canonical source.

If Colab is required:

- transfer the minimum required project artifact,
- use an unambiguous filename,
- verify the file exists before extracting,
- verify the target directory before running,
- run from the correct project directory.

Do not assume `/content/fluxquant-v0.5.0` exists.

Do not invent `.tar.gz` names.

---

# 19. REPORTING RULE

Every bounded research run should leave:

1. exact command
2. decision
3. key metrics
4. report path
5. SHA256
6. test result
7. reason for BLOCKED/KILL/KEEP
8. whether profitability was actually proven

If a run is blocked by data availability, distinguish:

- implementation failure
- network failure
- data completeness failure
- strategy failure

These are not the same thing.

---

# 20. DO NOT CONFUSE THESE STATES

`KEEP`
=
The research gate did not reject the current evidence.

It does NOT mean profitable.

`BLOCKED`
=
There is insufficient/invalid data or maturation to make the required decision.

`KILL`
=
The frozen research criteria rejected the strategy/evidence.

`PROFITABILITY_PROVEN=NO`
=
No permission to promote.

`REAL_MONEY_GATE=NO_GO`
=
No live execution under any circumstances.

---

# 21. CURRENT MASTER CHECKPOINT

As of 2026-08-18:

### P1
Implemented and tested.

### P1B
Implemented, FIFO accounting validated.

### P1C
500-trade holdout matured.

**Decision: KILL**

Reason:
- locked-share-below-1 = 0.4809
- gross locked margin = -0.529129
- profitability not proven

### P2A Trinity
Historical archive + Binance 1s spot matching implemented.

500-trade sample complete.

**Decision: BLOCKED**

Signal observed:
- alignment share 68.4211%
- median displacement +1.755655 bps
- mean displacement +1.535281 bps
- 27 rotations
- 5 sign-change rotations

But profitability is still unproven.

### Crypto Altcoin Flow
Instrumentation V2 passed.

**Decision: KEEP_PROSPECTIVE_SIGNAL_UNPROVEN**

### Crypto C1
Bounded public-data research path operational.

### Football
Frozen historical edge-validation protocol remains active.

---

# 22. NEXT WORK — DO NOT JUMP AHEAD

Immediate priority:

Continue P2A Trinity research only if the next test materially improves statistical validity.

Possible next validation directions:

1. Larger historical sample.
2. Multiple non-overlapping historical windows.
3. Stability of alignment/displacement across windows.
4. Cost/fee-aware economics.
5. Avoid lookahead/leakage.
6. Determine whether the 1–2 bps displacement survives realistic execution costs.
7. Only after reproducibility and economic edge are established consider promotion.

Do NOT jump to live execution.

Do NOT create another versioned copy just because the next research stage is difficult.

---

# 23. HANDOFF CONTRACT FOR ANY FUTURE AGENT

You are taking over an existing research system.

Your job is NOT to start over.

Your job is:

`READ STATE → VERIFY → CONTINUE → TEST → REPORT → UPDATE HANDOFF`

Before asking the human to do anything, ask:

> "Can I do this myself from the existing Mac project, files, tools, web, or connected environment?"

If yes, do it yourself.

Only ask the human for the final unavoidable external action.

If you discover a contradiction between this file and the actual code/report state:

1. Do not silently choose one.
2. Inspect the actual code and latest report.
3. Report the discrepancy.
4. Resolve it with the smallest safe change.
5. Update this handoff.

---

# END OF MASTER HANDOFF
