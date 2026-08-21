import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const SNAPSHOT = 'tools/research/crypto_carry_snapshot.py';
const RESEARCH = 'tools/research/crypto_carry.py';

test('recovered carry modules keep public-market-only and real-money NO_GO invariants', async () => {
  const source = `${await readFile(SNAPSHOT, 'utf8')}\n${await readFile(RESEARCH, 'utf8')}`;
  assert.match(source, /REAL_MONEY_GATE = "NO_GO"/);
  for (const forbidden of ['/v5/order/create', '/v5/position/', '/v5/account/', 'X-BAPI-API-KEY']) {
    assert.equal(source.includes(forbidden), false, `forbidden private/live primitive: ${forbidden}`);
  }
  assert.match(source, /\/v5\/market\/funding\/history/);
  assert.match(source, /\/v5\/market\/orderbook/);
  assert.match(source, /MAX_AUTO_REQUESTS = 20/);
  assert.match(source, /MAX_ECON_REQUESTS = 40/);
  assert.match(source, /MAX_ECON_EPISODES = 12/);
  assert.match(source, /HISTORICAL_ECONOMIC_PNL_FROM_EX_ANTE_SNAPSHOTS/);
  assert.match(source, /\/v5\/market\/kline/);
  assert.match(source, /MAX_REQUESTS = 20/);
  assert.match(source, /AUTO_RUNTIME_SECONDS = 600/);
});

test('recovered scanner and research math self-tests pass without network', () => {
  const scan = spawnSync('python3', [SNAPSHOT, 'self-test'], { encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stderr || scan.stdout);
  assert.match(scan.stdout, /SELF_TEST_PASS/);
  assert.match(scan.stdout, /network=NOT_USED/);
  const research = spawnSync('python3', [RESEARCH, 'self-test'], { encoding: 'utf8' });
  assert.equal(research.status, 0, research.stderr || research.stdout);
  assert.match(research.stdout, /SELF_TEST_PASS/);
  assert.match(research.stdout, /network=NOT_USED/);
});

test('unified research CLI is wired to recovered carry modules rather than standalone pyz runners', async () => {
  const cli = await readFile('src/cli/research.ts', 'utf8');
  assert.match(cli, /capability === 'crypto-carry'/);
  assert.match(cli, /tools\/research\/crypto_carry_snapshot\.py/);
  assert.match(cli, /tools\/research\/crypto_carry\.py/);
  assert.equal(cli.includes('.pyz'), false);
  assert.match(cli, /venue=bybit real_money=NO_GO/);
  assert.match(cli, /--economic-pnl/);
  assert.match(cli, /'economic-pnl'/);
});
