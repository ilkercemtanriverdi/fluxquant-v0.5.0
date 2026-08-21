import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const MODULE = 'tools/research/crypto_altcoin_flow.py';

test('documented altcoin-flow recovery preserves frozen public-only research semantics', async () => {
  const source = await readFile(MODULE, 'utf8');
  assert.match(source, /MIN_LIQUIDITY_USD = 5_000\.0/);
  assert.match(source, /MIN_MARKET_CAP_OR_FDV_USD = 100_000\.0/);
  assert.match(source, /MIN_PAIR_AGE_MINUTES = 15\.0/);
  assert.match(source, /HORIZONS_MINUTES = \(5, 15, 30, 60\)/);
  assert.match(source, /COST_HURDLE_BPS = 100\.0/);
  assert.match(source, /solana.*base.*bsc/);
  assert.match(source, /\/token-profiles\/latest\/v1/);
  assert.match(source, /\/token-boosts\/latest\/v1/);
  assert.match(source, /\/token-pairs\/v1/);
  assert.match(source, /MAX_REQUESTS = 40/);
  assert.match(source, /MAX_HORIZON_CAPTURE_LAG_SECONDS = 90/);
  assert.match(source, /WATCH_RUNTIME_SECONDS = 65 \* 60/);
  assert.match(source, /TIMED_PRICE_SAMPLES_V2_FAIL_CLOSED/);
  assert.match(source, /INVALIDATED_V1_LATE_SHARED_SNAPSHOT/);
  assert.match(source, /TIMED_PRICE_SAMPLE_WITHIN_POST_TARGET_WINDOW/);
  assert.match(source, /same_entry_pair_required/);
  assert.match(source, /REAL_MONEY_GATE = "NO_GO"/);
  for (const forbidden of ['private_key', '/order/create', 'X-BAPI-API-KEY', 'create_order']) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `forbidden live/private primitive: ${forbidden}`);
  }
});

test('altcoin-flow offline self-test passes without network', () => {
  const r = spawnSync('python3', [MODULE, 'self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /SELF_TEST_PASS/);
  assert.match(r.stdout, /network=NOT_USED/);
  assert.match(r.stdout, /ORDERS_PLACED=0/);
  assert.match(r.stdout, /timed_horizon_resolution/);
  assert.match(r.stdout, /v1_invalidation/);
});

test('unified research CLI dispatches altcoin-flow without standalone pyz', async () => {
  const cli = await readFile('src/cli/research.ts', 'utf8');
  assert.match(cli, /capability === 'crypto-altcoin-flow'/);
  assert.match(cli, /tools\/research\/crypto_altcoin_flow\.py/);
  assert.match(cli, /venue=dexscreener real_money=NO_GO/);
  assert.match(cli, /--watch-horizons/);
  assert.match(cli, /watch-horizons/);
  assert.equal(cli.includes('fluxquant-altcoin-flow-research.pyz'), false);
});
