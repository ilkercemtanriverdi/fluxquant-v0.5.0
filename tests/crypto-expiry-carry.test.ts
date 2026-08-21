import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const MODULE = 'tools/research/crypto_expiry_carry.py';

test('recovered expiry carry keeps original fee/notional semantics and public-only safety', async () => {
  const source = await readFile(MODULE, 'utf8');
  assert.match(source, /SPOT_TAKER_BPS = 10\.0/);
  assert.match(source, /FUTURES_TAKER_BPS = 5\.5/);
  assert.match(source, /DEFAULT_NOTIONALS = \[100\.0, 500\.0, 1000\.0\]/);
  assert.match(source, /contractType\"\) == \"CarryTrade\"/);
  assert.match(source, /LinearFutures/);
  assert.match(source, /\/v5\/spread\/instrument/);
  assert.match(source, /\/v5\/market\/orderbook/);
  assert.match(source, /\/v5\/market\/delivery-price/);
  assert.match(source, /\/v5\/market\/kline/);
  assert.match(source, /MAX_REQUESTS = 40/);
  assert.match(source, /REAL_MONEY_GATE = \"NO_GO\"/);
  for (const forbidden of ['/v5/order/create', '/v5/position/', '/v5/account/', 'X-BAPI-API-KEY']) {
    assert.equal(source.includes(forbidden), false, `forbidden private/live primitive: ${forbidden}`);
  }
});

test('expiry carry offline self-test passes without network', () => {
  const r = spawnSync('python3', [MODULE, 'self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /SELF_TEST_PASS/);
  assert.match(r.stdout, /network=NOT_USED/);
  assert.match(r.stdout, /ORDERS_PLACED=0/);
});

test('unified research CLI dispatches expiry carry without standalone pyz', async () => {
  const cli = await readFile('src/cli/research.ts', 'utf8');
  assert.match(cli, /capability === 'crypto-expiry-carry'/);
  assert.match(cli, /tools\/research\/crypto_expiry_carry\.py/);
  assert.match(cli, /--matured-audit/);
  assert.match(cli, /--snapshot/);
  assert.equal(cli.includes('fluxquant-crypto-expiry-carry.pyz'), false);
});
