import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const CONTRACT_PATH = 'research/experiments/crypto-c1/contract.json';
const EXPECTED_CONTRACT_SHA = '3c3a3bba168eac474286e4fffa78e9cd60e155f46a312a01c78bd9917d97bae8';

test('Crypto C1 canonical contract remains byte-frozen and real-money disabled', async () => {
  const bytes = await readFile(CONTRACT_PATH);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EXPECTED_CONTRACT_SHA);
  const contract = JSON.parse(bytes.toString('utf8')) as {
    hypothesis: { tuning: string };
    real_money_gate: string;
    production_v1_5: string;
  };
  assert.equal(contract.hypothesis.tuning, 'NONE');
  assert.equal(contract.real_money_gate, 'NO_GO');
  assert.equal(contract.production_v1_5, 'UNCHANGED');
});

test('Crypto C1 repo-internal module selftest validates leakage, data-integrity and TLS gates', () => {
  const result = spawnSync('python3', [
    'tools/research/crypto_c1.py', 'selftest',
    '--contract', CONTRACT_PATH,
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.equal(payload.status, 'PASS');
  assert.equal(payload.boundary_leakage_guard, true);
  assert.equal(payload.cache_resume_format_guard, true);
  assert.equal(payload.strict_contiguous_data_guard, true);
  assert.equal(payload.tls_verification_not_disabled, true);
  assert.equal(payload.real_money_gate, 'NO_GO');
});

test('unified research CLI dispatches Crypto C1 selftest without a standalone runner', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', 'src/cli/research.ts',
    'run', 'crypto-c1', '--selftest', '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[research\] capability=crypto-c1 mode=selftest real_money=NO_GO/);
  assert.match(result.stdout, /"status": "PASS"|"status":"PASS"/);
  assert.match(result.stdout, /"real_money_gate": "NO_GO"|"real_money_gate":"NO_GO"/);
});
