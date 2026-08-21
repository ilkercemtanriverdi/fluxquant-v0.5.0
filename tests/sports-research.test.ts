import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSportsConsensus } from '../src/sports/consensus.js';
import { closingLineValue } from '../src/sports/clv.js';
import { marketOverround, removeVigPower, removeVigProportional } from '../src/sports/odds.js';
import { SportsPaperLedger } from '../src/sports/paper-ledger.js';
import { researchProvenanceAllowed, sportsProviderPolicy } from '../src/sports/provider-policy.js';

test('proportional vig removal normalizes a two-way market to one', () => {
  const quotes = [
    { outcome: 'HOME', decimalOdds: 1.91 },
    { outcome: 'AWAY', decimalOdds: 1.91 },
  ];
  assert.ok(marketOverround(quotes) > 0);
  const fair = removeVigProportional(quotes);
  assert.ok(Math.abs(fair.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-12);
  assert.ok(Math.abs((fair[0]?.probability ?? 0) - 0.5) < 1e-12);
});

test('power vig removal preserves ordering and sums to one', () => {
  const fair = removeVigPower([
    { outcome: 'HOME', decimalOdds: 1.75 },
    { outcome: 'DRAW', decimalOdds: 3.8 },
    { outcome: 'AWAY', decimalOdds: 5.2 },
  ]);
  const home = fair.find((item) => item.outcome === 'HOME');
  const draw = fair.find((item) => item.outcome === 'DRAW');
  const away = fair.find((item) => item.outcome === 'AWAY');
  assert.ok(Math.abs(fair.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-10);
  assert.ok((home?.probability ?? 0) > (draw?.probability ?? 0));
  assert.ok((draw?.probability ?? 0) > (away?.probability ?? 0));
});

test('sports consensus ignores stale venues and exposes dispersion', () => {
  const now = 10_000;
  const consensus = buildSportsConsensus([
    {
      venue: 'book-a', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', asOfMs: now,
      outcomes: [{ outcome: 'A', probability: 0.55 }, { outcome: 'B', probability: 0.45 }],
    },
    {
      venue: 'exchange-b', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', asOfMs: now - 100,
      outcomes: [{ outcome: 'A', probability: 0.53 }, { outcome: 'B', probability: 0.47 }], weight: 2,
    },
    {
      venue: 'stale-book', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', asOfMs: 1,
      outcomes: [{ outcome: 'A', probability: 0.9 }, { outcome: 'B', probability: 0.1 }],
    },
  ], 1_000);
  const a = consensus.outcomes.find((outcome) => outcome.outcome === 'A');
  assert.deepEqual(consensus.sourceVenues, ['book-a', 'exchange-b']);
  assert.ok((a?.fairProbability ?? 0) > 0.53 && (a?.fairProbability ?? 0) < 0.55);
  assert.ok((a?.dispersion ?? 0) > 0);
});

test('positive CLV means taken odds beat the closing fair price', () => {
  const clv = closingLineValue(2.1, 0.52);
  assert.ok(clv.clvPct > 0);
  assert.ok(clv.expectedValueAtClose > 0);
  assert.ok(clv.logClv > 0);
});

test('paper ledger enforces edge and aggregate open-risk limits', () => {
  const ledger = new SportsPaperLedger(100, 0.1);
  const placed = ledger.place({
    id: 'b1', eventId: 'e1', marketId: 'm1', outcome: 'A', venue: 'paper',
    decimalOdds: 2.1, fairProbabilityAtEntry: 0.5, stakeUsd: 5, placedAtMs: 1,
  }, 0.04);
  assert.ok(placed.edgeAtEntry > 0.04);
  assert.throws(() => ledger.place({
    id: 'b2', eventId: 'e2', marketId: 'm2', outcome: 'B', venue: 'paper',
    decimalOdds: 2.1, fairProbabilityAtEntry: 0.5, stakeUsd: 6, placedAtMs: 2,
  }, 0.04), /SPORTS_OPEN_RISK_LIMIT/);
});

test('paper ledger tracks realized PnL and drawdown without authorizing live betting', () => {
  const ledger = new SportsPaperLedger(100, 0.2);
  ledger.place({
    id: 'b1', eventId: 'e1', marketId: 'm1', outcome: 'A', venue: 'paper',
    decimalOdds: 2, fairProbabilityAtEntry: 0.55, stakeUsd: 10, placedAtMs: 1,
  });
  ledger.settle('b1', 'LOST', 2);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.realizedPnlUsd, -10);
  assert.equal(snapshot.bankrollUsd, 90);
  assert.equal(snapshot.maxDrawdownPct, 0.1);
});

test('Bet365 policy is reference-only and explicitly forbids FluxQuant scraping/execution', () => {
  const policy = sportsProviderPolicy('bet365');
  assert.equal(policy.role, 'REFERENCE_ONLY');
  assert.equal(policy.scrapingAllowedByFluxQuant, false);
  assert.equal(policy.automatedExecutionEnabled, false);
  assert.equal(researchProvenanceAllowed('bet365', 'LICENSED_FEED'), true);
  assert.equal(researchProvenanceAllowed('bet365', 'MANUAL_RESEARCH'), false);
  assert.equal(researchProvenanceAllowed('bet365', 'OFFICIAL_API'), false);
  assert.equal(researchProvenanceAllowed('betfair-exchange', 'OFFICIAL_DELAYED_API'), true);
  assert.equal(researchProvenanceAllowed('betfair-exchange', 'OFFICIAL_API'), false);
  assert.equal(researchProvenanceAllowed('smarkets-exchange', 'OFFICIAL_API'), false);
  assert.equal(researchProvenanceAllowed('smarkets-exchange', 'EXPLICIT_RESEARCH_LICENSE'), true);
});

test('Betfair and Smarkets are paper candidates; Polymarket sports is reference-only until its binary fee/execution model is dedicated', () => {
  for (const provider of ['betfair-exchange', 'smarkets-exchange'] as const) {
    const policy = sportsProviderPolicy(provider);
    assert.equal(policy.role, 'RESEARCH_PAPER_CANDIDATE');
    assert.equal(policy.automatedExecutionEnabled, false);
  }
  assert.equal(sportsProviderPolicy('polymarket-sports').role, 'REFERENCE_ONLY');
});
