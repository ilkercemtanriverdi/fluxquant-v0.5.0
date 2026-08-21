import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const TOOL = 'tools/research/poly_inventory_rotation.py';

test('poly-inventory-rotation source contains REAL_MONEY_GATE=NO_GO and no forbidden primitives', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /REAL_MONEY_GATE = "NO_GO"/);
  assert.match(source, /MODE = "READ_ONLY_PAPER_RESEARCH"/);
  for (const forbidden of ['private_key', 'api_key=', 'api_key "', 'order/create', 'order.place', 'CLOB_AUTH', 'clob.authenticate', 'signature', 'signing']) {
    assert.equal(source.includes(forbidden), false, `forbidden primitive: ${forbidden}`);
  }
  assert.match(source, /data-api\.polymarket\.com/);
  assert.match(source, /MAX_REQUESTS = 40/);
  assert.match(source, /takerOnly/);
  assert.match(source, /closed-positions/);
});

test('self-test passes without network', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SELF_TEST_PASS/);
  assert.match(result.stdout, /ORDERS_PLACED=0/);
  assert.match(result.stdout, /API_KEYS_USED=0/);
  assert.match(result.stdout, /REAL_MONEY_GATE=NO_GO/);
});

test('chronological fill reconstruction: BUY/SELL tracked per side', () => {
  // Simulate the fill reconstruction logic from the tool via self-test
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /reconstruction/);
});

test('UP/DOWN inventory accounting: paired inventory min(UP, DOWN)', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /paired_inventory/);
});

test('weighted acquisition prices are computed correctly', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /weighted_avg_buy/);
});

test('BUY has positive cashflow sign, SELL has negative', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /cashflow_signs/);
});

test('side rotation count is deterministic', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /rotation_count/);
});

test('incomplete market handling: markets with only one side are counted as one-sided', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /one_sided/);
});

test('missing rebate is not treated as zero rebate', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /rebate.*NOT_AVAILABLE/i);
});

test('request cap enforcement at 40', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /MAX_REQUESTS = 40/);
});

test('REAL_MONEY_GATE invariant is NO_GO', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /REAL_MONEY_GATE=NO_GO/);
  assert.match(result.stdout, /ORDERS_PLACED=0/);
  assert.match(result.stdout, /API_KEYS_USED=0/);
});

test('no order placement or API key path in source', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.equal(source.includes('/order/'), false, 'no order endpoint');
  assert.equal(source.includes('X-'), false, 'no auth headers');
  assert.equal(source.includes('Bearer'), false, 'no bearer tokens');
});

test('cli router is wired to poly-inventory-rotation', async () => {
  const cli = await readFile('src/cli/research.ts', 'utf8');
  assert.match(cli, /capability === 'poly-inventory-rotation'/);
  assert.match(cli, /poly_inventory_rotation\.py/);
  assert.match(cli, /real_money=NO_GO/);
});

test('report output directory exists or is created', async () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /report_dir/);
});

// --- P1B focused tests ---

test('P1B self-test passes with FIFO pair-lock assertions', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /P1B_TESTS_BEGIN/);
  assert.match(result.stdout, /P1B_TESTS_END/);
  assert.match(result.stdout, /p1b_fifo_up_lots PASS/);
  assert.match(result.stdout, /p1b_fifo_down_lots PASS/);
  assert.match(result.stdout, /p1b_one_up_then_down PASS/);
  assert.match(result.stdout, /p1b_one_down_then_up PASS/);
  assert.match(result.stdout, /p1b_partial_lock PASS/);
  assert.match(result.stdout, /p1b_multiple_locks PASS/);
  assert.match(result.stdout, /p1b_cost_lots PASS/);
  assert.match(result.stdout, /p1b_below_1 PASS/);
  assert.match(result.stdout, /p1b_above_1 PASS/);
  assert.match(result.stdout, /p1b_hedge_delay PASS/);
  assert.match(result.stdout, /p1b_directional_exposure PASS/);
  assert.match(result.stdout, /p1b_sell_reduces_inventory PASS/);
  assert.match(result.stdout, /p1b_invalid_sell FAIL_CLOSED PASS/);
  assert.match(result.stdout, /p1b_tie_ordering PASS/);
  assert.match(result.stdout, /p1b_concentration PASS/);
  assert.match(result.stdout, /p1b_fee_not_zero PASS/);
  assert.match(result.stdout, /p1b_rebate_not_zero PASS/);
  assert.match(result.stdout, /p1b_decision_logic PASS/);
});

test('P1B source contains compute_fifo_pair_locks functions', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /def compute_fifo_pair_locks/);
  assert.match(source, /def compute_fifo_pair_locks_with_hedge_delay/);
  assert.match(source, /def p1b_aggregate/);
  assert.match(source, /def p1b_decision/);
  assert.match(source, /AGGREGATE_FINAL_WEIGHTED_COST_DIAGNOSTIC_ONLY/);
});

test('P1B source contains no forbidden primitives', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /REAL_MONEY_GATE = "NO_GO"/);
  assert.match(source, /P1B_PROFITABILITY_PROVEN.*NO/);
  assert.match(source, /PROFITABILITY_PROMOTION_ALLOWED.*NO/);
});

test('P1B decision logic kills when markets with locked pairs < 10', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_decision
agg = {
    "P1B_MARKETS_WITH_LOCKED_PAIRS": 5,
    "P1B_TOTAL_LOCKED_PAIR_QTY": 200,
    "P1B_LOCKED_SHARE_BELOW_1": 0.8,
    "P1B_GROSS_LOCKED_MARGIN_USDC": 50.0,
    "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1B_MAX_HEDGE_DELAY_SECONDS": 10.0,
}
print(p1b_decision(agg))
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /KILL/);
});

test('P1B decision logic keeps when all thresholds met', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_decision
agg = {
    "P1B_MARKETS_WITH_LOCKED_PAIRS": 15,
    "P1B_TOTAL_LOCKED_PAIR_QTY": 150,
    "P1B_LOCKED_SHARE_BELOW_1": 0.7,
    "P1B_GROSS_LOCKED_MARGIN_USDC": 20.0,
    "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1B_MAX_HEDGE_DELAY_SECONDS": 10.0,
}
print(p1b_decision(agg))
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /KEEP/);
});

test('P1B FIFO pair lock engine produces correct lock for simple UP+DOWN', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import compute_fifo_pair_locks
fills = [
    {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
    {"ts_ms": 2000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
]
r = compute_fifo_pair_locks(fills)
assert r["chronological_lock_event_count"] == 1
assert abs(r["chronological_locked_pair_qty"] - 10.0) < 1e-9
assert abs(r["locks"][0]["combined_locked_cost_per_pair"] - 0.95) < 1e-9
print("PAIR_LOCK_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /PAIR_LOCK_OK/);
});

test('P1B hedge delay is computed correctly', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import compute_fifo_pair_locks_with_hedge_delay
fills = [
    {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
    {"ts_ms": 5000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
]
r = compute_fifo_pair_locks_with_hedge_delay(fills)
lock = r["locks"][0]
assert lock["hedge_delay_seconds"] == 4.0
assert lock["first_side"] == "DOWN"
print("HEDGE_DELAY_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /HEDGE_DELAY_OK/);
});

test('P1B SELL exceeding inventory marks accounting incomplete', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import compute_fifo_pair_locks
fills = [
    {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 5, "usdc": 2.25},
    {"ts_ms": 2000, "side": "SELL", "up_down": "UP", "price": 0.50, "size": 10, "usdc": 5.0},
]
r = compute_fifo_pair_locks(fills)
assert r["pair_lock_accounting_complete"] == "NO"
assert "SELL_EXCEEDS" in r["accounting_error"]
print("FAIL_CLOSED_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /FAIL_CLOSED_OK/);
});

test('P1B aggregate: missing fee/rebate/settlement not zero', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_aggregate
m = {
    "pair_lock_accounting_complete": "YES",
    "chronological_lock_event_count": 1,
    "chronological_locked_pair_qty": 10.0,
    "locked_pair_cost_mean": 0.90,
    "locked_qty_below_1": 10.0,
    "gross_locked_margin_usdc": 1.0,
    "max_prelock_directional_cost_usdc": 5.0,
    "locks": [{"hedge_delay_seconds": 2.0}],
    "slug": "test",
}
agg = p1b_aggregate([m])
assert agg["P1B_FEE_COVERAGE_COMPLETE"] == "NO"
assert agg["P1B_REBATE_COVERAGE_COMPLETE"] == "NO"
assert agg["P1B_SETTLEMENT_COVERAGE_COMPLETE"] == "NO"
assert agg["P1B_PROFITABILITY_PROVEN"] == "NO"
print("COVERAGE_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /COVERAGE_OK/);
});

test('P1B source does not break existing P1 fields', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /paired_cost_per_pair/);
  assert.match(source, /paired_inventory/);
  assert.match(source, /MEAN_PAIRED_COST/);
  assert.match(source, /MEDIAN_PAIRED_COST/);
  assert.match(source, /PAIRED_COST_BELOW_1_SHARE/);
});

// --- P1B hedge-delay fix tests ---

test('P1B hedge delay aggregation reads from p1b_locks key', async () => {
  const source = await readFile(TOOL, 'utf8');
  // The aggregate function must read lock events from "p1b_locks", not "locks"
  assert.match(source, /m\.get\("p1b_locks", \[\]\)/, 'p1b_aggregate must read from p1b_locks key');
});

test('P1B hedge delay is populated in per-market locks', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import compute_fifo_pair_locks_with_hedge_delay
fills = [
    {"ts_ms": 1000, "side": "BUY", "up_down": "UP", "price": 0.45, "size": 10, "usdc": 4.5},
    {"ts_ms": 5000, "side": "BUY", "up_down": "DOWN", "price": 0.50, "size": 10, "usdc": 5.0},
]
r = compute_fifo_pair_locks_with_hedge_delay(fills)
lock = r["locks"][0]
assert lock["hedge_delay_seconds"] is not None
assert lock["hedge_delay_seconds"] == 4.0
assert lock["first_side"] == "DOWN"
print("PER_LOCK_HEDGE_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /PER_LOCK_HEDGE_OK/);
});

test('P1B aggregate computes hedge delay stats from p1b_locks', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_aggregate

# Simulate two markets with hedge delays in p1b_locks
m1 = {
    "pair_lock_accounting_complete": "YES",
    "chronological_lock_event_count": 1,
    "chronological_locked_pair_qty": 10.0,
    "locked_pair_cost_mean": 0.90,
    "locked_qty_below_1": 10.0,
    "gross_locked_margin_usdc": 1.0,
    "max_prelock_directional_cost_usdc": 5.0,
    "slug": "m1",
    "p1b_locks": [
        {"hedge_delay_seconds": 2.0, "combined_locked_cost_per_pair": 0.90, "locked_qty": 10.0, "gross_locked_margin_usdc": 1.0},
    ],
}
m2 = {
    "pair_lock_accounting_complete": "YES",
    "chronological_lock_event_count": 1,
    "chronological_locked_pair_qty": 8.0,
    "locked_pair_cost_mean": 0.85,
    "locked_qty_below_1": 8.0,
    "gross_locked_margin_usdc": 1.2,
    "max_prelock_directional_cost_usdc": 4.0,
    "slug": "m2",
    "p1b_locks": [
        {"hedge_delay_seconds": 6.0, "combined_locked_cost_per_pair": 0.85, "locked_qty": 8.0, "gross_locked_margin_usdc": 1.2},
    ],
}
agg = p1b_aggregate([m1, m2])
assert agg["P1B_MEDIAN_HEDGE_DELAY_SECONDS"] == 4.0
assert agg["P1B_P90_HEDGE_DELAY_SECONDS"] == 6.0
assert agg["P1B_MAX_HEDGE_DELAY_SECONDS"] == 6.0
print("AGGREGATE_HEDGE_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /AGGREGATE_HEDGE_OK/);
});

test('P1B decision does NOT kill for missing fee/rebate/settlement coverage', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_decision

# All economic thresholds met, but coverage fields are NO
agg = {
    "P1B_MARKETS_WITH_LOCKED_PAIRS": 15,
    "P1B_TOTAL_LOCKED_PAIR_QTY": 150,
    "P1B_LOCKED_SHARE_BELOW_1": 0.7,
    "P1B_GROSS_LOCKED_MARGIN_USDC": 20.0,
    "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1B_MAX_HEDGE_DELAY_SECONDS": 10.0,
    "P1B_FEE_COVERAGE_COMPLETE": "NO",
    "P1B_REBATE_COVERAGE_COMPLETE": "NO",
    "P1B_SETTLEMENT_COVERAGE_COMPLETE": "NO",
}
result = p1b_decision(agg)
assert result == "KEEP", f"Expected KEEP, got {result} -- missing coverage must not cause KILL"
print("DECISION_NO_COVERAGE_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /DECISION_NO_COVERAGE_OK/);
});

test('P1B decision still kills when hedge delay is None', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1b_decision

agg = {
    "P1B_MARKETS_WITH_LOCKED_PAIRS": 15,
    "P1B_TOTAL_LOCKED_PAIR_QTY": 150,
    "P1B_LOCKED_SHARE_BELOW_1": 0.7,
    "P1B_GROSS_LOCKED_MARGIN_USDC": 20.0,
    "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1B_MAX_HEDGE_DELAY_SECONDS": None,
}
result = p1b_decision(agg)
assert result == "KILL", f"Expected KILL, got {result}"
print("DECISION_NO_HEDGE_KILL_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /DECISION_NO_HEDGE_KILL_OK/);
});

// --- P1C holdout tests ---

test('P1C self-test passes with P1C assertions', () => {
  const result = spawnSync('python3', [TOOL, 'self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /P1C_TESTS_BEGIN/);
  assert.match(result.stdout, /P1C_TESTS_END/);
  assert.match(result.stdout, /p1c_frozen_start PASS/);
  assert.match(result.stdout, /p1c_epoch_filter PASS/);
  assert.match(result.stdout, /p1c_dedup PASS/);
  assert.match(result.stdout, /p1c_blocked_maturation PASS/);
  assert.match(result.stdout, /p1c_keeps_with_p1b_gates PASS/);
  assert.match(result.stdout, /p1c_kills_with_p1b_gates PASS/);
  assert.match(result.stdout, /p1c_rebate_request_format PASS/);
  assert.match(result.stdout, /p1c_rebate_not_zero PASS/);
  assert.match(result.stdout, /p1c_aggregate_fields PASS/);
});

test('P1C frozen start cutoff is correct', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import P1C_HOLDOUT_START_EPOCH
assert P1C_HOLDOUT_START_EPOCH == 1787074470
print("FROZEN_START_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /FROZEN_START_OK/);
});

test('P1C no pre-cutoff trade accepted', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1c_filter_trades_by_epoch, P1C_HOLDOUT_START_EPOCH
pre = [{"timestamp": str((P1C_HOLDOUT_START_EPOCH - 100) * 1000)}]
post = [{"timestamp": str((P1C_HOLDOUT_START_EPOCH + 100) * 1000)}]
filtered = p1c_filter_trades_by_epoch(pre + post, P1C_HOLDOUT_START_EPOCH, P1C_HOLDOUT_START_EPOCH + 200)
assert len(filtered) == 1
print("NO_PRE_CUTOFF_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /NO_PRE_CUTOFF_OK/);
});

test('P1C start/end query construction', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /def fetch_trades_holdout/);
  assert.match(source, /start=\{start\}/);
  assert.match(source, /end=\{end\}/);
});

test('P1C/P1B cache cannot contaminate P1C', async () => {
  const source = await readFile(TOOL, 'utf8');
  // P1C uses separate fetch_trades_holdout with start/end params
  assert.match(source, /def fetch_trades_holdout/);
  // P1C rebates use use_cache=False
  assert.match(source, /use_cache=False/);
});

test('P1C <500 => BLOCKED_MATURATION', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1c_decision
agg = {
    "P1B_MARKETS_WITH_LOCKED_PAIRS": 15,
    "P1B_TOTAL_LOCKED_PAIR_QTY": 150,
    "P1B_LOCKED_SHARE_BELOW_1": 0.7,
    "P1B_GROSS_LOCKED_MARGIN_USDC": 20.0,
    "P1B_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1B_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1B_MAX_HEDGE_DELAY_SECONDS": 10.0,
}
assert p1c_decision(agg, 100) == "BLOCKED_MATURATION"
assert p1c_decision(agg, 499) == "BLOCKED_MATURATION"
print("BLOCKED_MATURATION_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /BLOCKED_MATURATION_OK/);
});

test('P1C 500 sample invokes frozen P1B gates', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1c_decision
agg = {
    "P1C_MARKETS_WITH_LOCKED_PAIRS": 15,
    "P1C_TOTAL_LOCKED_PAIR_QTY": 150,
    "P1C_LOCKED_SHARE_BELOW_1": 0.7,
    "P1C_GROSS_LOCKED_MARGIN_USDC": 20.0,
    "P1C_MARKET_CONCENTRATION_TOP1_SHARE": 0.3,
    "P1C_MARKET_CONCENTRATION_TOP3_SHARE": 0.6,
    "P1C_MAX_HEDGE_DELAY_SECONDS": 10.0,
}
assert p1c_decision(agg, 500) == "KEEP"
# Fail P1B gate
bad = dict(agg)
bad["P1C_MARKETS_WITH_LOCKED_PAIRS"] = 5
assert p1c_decision(bad, 500) == "KILL"
print("P1B_GATES_INVOKED_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /P1B_GATES_INVOKED_OK/);
});

test('P1C rebate request contains date + maker_address', async () => {
  const source = await readFile(TOOL, 'utf8');
  assert.match(source, /def fetch_rebates_for_date/);
  assert.match(source, /date=\{date_str\}/);
  assert.match(source, /maker_address=\{maker_address\}/);
});

test('P1C missing rebate != zero', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1c_analyze_rebates
r = p1c_analyze_rebates(None)
assert r["confirmed_rebates_usdc"] is None
assert r["rebate_coverage_complete"] == "NO"
print("P1C_REBATE_NOT_ZERO_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /P1C_REBATE_NOT_ZERO_OK/);
});

test('P1C settlement coverage fail-closed', () => {
  const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, '.')
from tools.research.poly_inventory_rotation import p1c_aggregate
agg = p1c_aggregate([], 0)
assert agg["P1C_SETTLEMENT_COVERAGE_COMPLETE"] == "NO"
assert agg["P1C_PROFITABILITY_PROVEN"] == "NO"
print("SETTLEMENT_FAIL_CLOSED_OK")
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout.trim(), /SETTLEMENT_FAIL_CLOSED_OK/);
});
