import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseResearchRegistry, filterResearchStrategies, researchStatusCounts } from '../src/research/registry.js';

async function canonical(): Promise<unknown> {
  return JSON.parse(await readFile(resolve('research/registry.json'), 'utf8')) as unknown;
}

test('canonical research registry validates and keeps all three market axes alive', async () => {
  const registry = parseResearchRegistry(await canonical());
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.governance.realMoneyGate, 'NO_GO');
  assert.deepEqual(new Set(registry.strategies.map((item) => item.market)), new Set(['crypto', 'football', 'polymarket']));
  assert.ok(registry.strategies.every((item) => item.realMoneyEligible === false));
});

test('market filtering and status counts are deterministic', async () => {
  const registry = parseResearchRegistry(await canonical());
  const football = filterResearchStrategies(registry, 'football');
  assert.equal(football.length, 1);
  assert.equal(football[0]?.status, 'BLOCKED');
  assert.deepEqual(researchStatusCounts(registry.strategies), { BLOCKED: 1, KEEP: 5, KILL: 1 });
});

test('registry rejects duplicate strategy ids', async () => {
  const raw = await canonical() as { strategies: Array<Record<string, unknown>> };
  raw.strategies.push({ ...raw.strategies[0] });
  assert.throws(() => parseResearchRegistry(raw), /REGISTRY_DUPLICATE_ID/);
});

test('registry rejects any v1.5 real-money eligibility', async () => {
  const raw = await canonical() as { strategies: Array<Record<string, unknown>> };
  raw.strategies[0] = { ...raw.strategies[0], realMoneyEligible: true };
  assert.throws(() => parseResearchRegistry(raw), /REGISTRY_REAL_MONEY_FORBIDDEN_V15/);
});

test('registry governance forbids treating user questions as pivots', async () => {
  const raw = await canonical() as { governance: Record<string, unknown> };
  raw.governance = { ...raw.governance, userQuestionIsNotPivot: false };
  assert.throws(() => parseResearchRegistry(raw), /REGISTRY_GOVERNANCE_QUESTION_PIVOT_FORBIDDEN/);
});


test('Crypto C1 is frozen KILL while recovered carry lanes remain research-only KEEP', async () => {
  const registry = parseResearchRegistry(await canonical());
  const c1 = registry.strategies.find((item) => item.id === 'crypto.c1-volume-confirmed-momentum');
  const carry = registry.strategies.find((item) => item.id === 'crypto.c2-bybit-funding-carry');
  assert.equal(c1?.status, 'KILL');
  assert.match(c1?.nextTest ?? '', /do not retune/i);
  assert.equal(carry?.status, 'KEEP');
  assert.equal(carry?.realMoneyEligible, false);
  assert.match(carry?.nextTest ?? '', /additional saved ex-ante carry anchors mature/i);
  const expiry = registry.strategies.find((item) => item.id === 'crypto.c3-bybit-expiry-carry');
  assert.equal(expiry?.status, 'KEEP');
  assert.equal(expiry?.realMoneyEligible, false);
  assert.match(expiry?.nextTest ?? '', /saved ex-ante expiry anchors mature/i);
  const altflow = registry.strategies.find((item) => item.id === 'crypto.c4-dexscreener-altcoin-flow');
  assert.equal(altflow?.status, 'KEEP');
  assert.equal(altflow?.realMoneyEligible, false);
  assert.match(altflow?.nextTest ?? '', /crypto-altcoin-flow/i);
});
