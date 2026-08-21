import test from 'node:test';
import assert from 'node:assert/strict';
import { commissionSettlementMultipliers, effectiveDecimalOddsAfterCommission, runSportsResearch, type SportsVenueSnapshot } from '../src/sports/research-engine.js';

function baseRows(): SportsVenueSnapshot[] {
  return [
    { provider: 'bet365', venue: 'bet365', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 900, receivedAtMs: 900, stage: 'OPEN', quotes: [
      { outcome: 'A', decimalOdds: 1.80 }, { outcome: 'B', decimalOdds: 2.10 },
    ] },
    { provider: 'other-bookmaker', venue: 'book-b', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 950, receivedAtMs: 950, stage: 'OPEN', quotes: [
      { outcome: 'A', decimalOdds: 1.83 }, { outcome: 'B', decimalOdds: 2.05 },
    ] },
    { provider: 'betfair-exchange', venue: 'betfair', provenance: 'OFFICIAL_DELAYED_API', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 1000, receivedAtMs: 1000, stage: 'OPEN', commissionRate: 0.02, commissionModel: 'NET_MARKET_WINNINGS', quotes: [
      { outcome: 'A', decimalOdds: 2.05 }, { outcome: 'B', decimalOdds: 1.85 },
    ] },
    { provider: 'bet365', venue: 'bet365', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 4900, receivedAtMs: 4900, stage: 'CLOSE', quotes: [
      { outcome: 'A', decimalOdds: 1.70 }, { outcome: 'B', decimalOdds: 2.25 },
    ] },
    { provider: 'other-bookmaker', venue: 'book-b', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 4950, receivedAtMs: 4950, stage: 'CLOSE', quotes: [
      { outcome: 'A', decimalOdds: 1.72 }, { outcome: 'B', decimalOdds: 2.20 },
    ] },
    { provider: 'other-bookmaker', venue: 'settlement', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 6000, receivedAtMs: 6000, stage: 'SETTLED', settledOutcome: 'A', quotes: [
      { outcome: 'A', decimalOdds: 2 }, { outcome: 'B', decimalOdds: 2 },
    ] },
  ];
}

test('commission reduces exchange effective odds and edge', () => {
  assert.equal(effectiveDecimalOddsAfterCommission(2, 0.02), 1.98);
  assert.ok(effectiveDecimalOddsAfterCommission(2.5, 0.05) < 2.5);
});

test('Bet365 contributes to consensus but is never emitted as a paper execution candidate', () => {
  const report = runSportsResearch(baseRows(), { minConsensusVenues: 2, minEdge: 0.01 });
  assert.ok(report.candidates.length >= 1);
  assert.ok(report.candidates.every((candidate) => candidate.provider !== 'bet365'));
  assert.ok(report.candidates.some((candidate) => candidate.consensusVenues.includes('bet365')));
  assert.ok(report.candidates.some((candidate) => candidate.consensusSources.some((source) => source.venue === 'bet365' && source.provenance === 'LICENSED_FEED')));
});

test('leave-one-venue-out consensus prevents target venue from self-validating', () => {
  const rows = baseRows().filter((row) => row.venue !== 'book-b');
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('INSUFFICIENT_INDEPENDENT_CONSENSUS'));
});

test('sports research computes settlement PnL, bankroll drawdown and CLV without enabling live betting', () => {
  const report = runSportsResearch(baseRows(), { minConsensusVenues: 2, minEdge: 0.01, bankrollUsd: 100, stakePct: 0.02 });
  assert.equal(report.liveBettingEnabled, false);
  assert.equal(report.selectionPolicy, 'CAUSAL_FIRST_QUALIFYING_ONE_POSITION_PER_VENUE_MARKET');
  assert.ok(report.settledCandidates >= 1);
  assert.ok(report.candidates.some((candidate) => candidate.closeClvPct !== undefined));
  assert.ok(Number.isFinite(report.realizedPnlUsd));
  assert.ok(Number.isFinite(report.maxDrawdownPct));
});

test('causal consensus never uses a future reference quote', () => {
  const rows = baseRows();
  rows.push({ provider: 'other-bookmaker', venue: 'future-book', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 1200, receivedAtMs: 1200, stage: 'OPEN', quotes: [
    { outcome: 'A', decimalOdds: 10 }, { outcome: 'B', decimalOdds: 1.05 },
  ] });
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  const candidate = report.candidates.find((row) => row.venue === 'betfair');
  assert.ok(candidate);
  assert.equal(candidate?.consensusVenues.includes('future-book'), false);
});

test('repeated qualifying snapshots do not multiply paper bets for the same venue-market', () => {
  const rows = baseRows();
  rows.push({ provider: 'betfair-exchange', venue: 'betfair', provenance: 'OFFICIAL_DELAYED_API', eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000, asOfMs: 1100, receivedAtMs: 1100, stage: 'OPEN', commissionRate: 0.02, commissionModel: 'NET_MARKET_WINNINGS', quotes: [
    { outcome: 'A', decimalOdds: 2.10 }, { outcome: 'B', decimalOdds: 1.80 },
  ] });
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidates.filter((row) => row.venue === 'betfair').length, 1);
});

test('unverified provenance fails closed and cannot create a paper candidate', () => {
  const rows = baseRows().map((row) => row.venue === 'betfair' ? { ...row, provenance: 'UNKNOWN' as const } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('UNVERIFIED_DATA_PROVENANCE'));
});

test('exchange commission is mandatory for a paper execution candidate', () => {
  const rows = baseRows().map((row) => row.venue === 'betfair' && row.stage === 'OPEN' ? { ...row, commissionRate: undefined } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('COMMISSION_UNKNOWN'));
});

test('pre-match engine rejects target snapshots at or after event start', () => {
  const rows = baseRows().map((row) => row.venue === 'betfair' && row.stage === 'OPEN' ? { ...row, asOfMs: 5000, receivedAtMs: 5000 } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('INPLAY_OR_POSTSTART_SNAPSHOT_REJECTED'));
});


test('per-bet win/loss commission charges both winning profit and losing liability', () => {
  const modeled = commissionSettlementMultipliers(4, 0.01, 'PER_BET_WIN_LOSS');
  assert.ok(Math.abs(modeled.winProfitMultiplier - 2.97) < 1e-12);
  assert.ok(Math.abs(modeled.lossMultiplier - 1.01) < 1e-12);
  assert.ok(Math.abs(modeled.effectiveDecimalOdds - 3.97) < 1e-12);
});

test('paper candidates require a known event start in strict pre-match mode', () => {
  const rows = baseRows().map((row) => row.venue === 'betfair' && row.stage === 'OPEN' ? { ...row, eventStartMs: undefined } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('EVENT_START_UNKNOWN'));
});

test('conflicting authorized settlement rows fail closed instead of choosing a convenient result', () => {
  const rows = baseRows();
  rows.push({
    provider: 'other-bookmaker', venue: 'settlement-2', provenance: 'MANUAL_RESEARCH',
    eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000,
    asOfMs: 6100, receivedAtMs: 6100, stage: 'SETTLED', settledOutcome: 'B',
    quotes: [{ outcome: 'A', decimalOdds: 2 }, { outcome: 'B', decimalOdds: 2 }],
  });
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0.01 });
  assert.ok(report.blockers.includes('CONFLICTING_SETTLEMENT'));
  assert.equal(report.settledCandidates, 0);
});

test('unverified settlement cannot settle an otherwise valid paper candidate', () => {
  const rows = baseRows().map((row) => row.stage === 'SETTLED' ? { ...row, provenance: 'UNKNOWN' as const } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0.01 });
  assert.ok(report.blockers.includes('UNVERIFIED_DATA_PROVENANCE'));
  assert.equal(report.settledCandidates, 0);
});


test('causal consensus uses local receive time instead of a deceptively old source timestamp', () => {
  const rows = baseRows();
  rows.push({
    provider: 'other-bookmaker', venue: 'late-delivery-book', provenance: 'LICENSED_FEED', sourceContractId: 'fixture-license-v1',
    eventId: 'e1', marketId: 'm1', marketKind: 'moneyline', eventStartMs: 5000,
    asOfMs: 800, receivedAtMs: 1200, stage: 'OPEN',
    quotes: [{ outcome: 'A', decimalOdds: 10 }, { outcome: 'B', decimalOdds: 1.05 }],
  });
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  const candidate = report.candidates.find((row) => row.venue === 'betfair');
  assert.ok(candidate);
  assert.equal(candidate?.consensusVenues.includes('late-delivery-book'), false);
});

test('missing local receive time fails closed even when source timestamp exists', () => {
  const rows = baseRows().map((row) => row.venue === 'betfair' && row.stage === 'OPEN' ? { ...row, receivedAtMs: undefined } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('RECEIVED_TIME_UNKNOWN'));
});

test('licensed research rows require a traceable source contract id', () => {
  const rows = baseRows().map((row) => row.venue === 'book-b' ? { ...row, sourceContractId: undefined } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('UNVERIFIED_DATA_PROVENANCE'));
});


test('closing-line evidence must be genuinely near event start, not an arbitrarily early CLOSE label', () => {
  const rows = baseRows().map((row) => row.stage === 'CLOSE' ? { ...row, asOfMs: 4000, receivedAtMs: 4000 } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0.01, maxAgeMs: 200 });
  assert.ok(report.candidateCount >= 1);
  assert.equal(report.clvCoveragePct, 0);
  assert.ok(report.blockers.includes('NO_CLOSING_LINE_EVIDENCE'));
});

test('cross-venue consensus requires the same canonical event-start identity', () => {
  const rows = baseRows().map((row) => row.venue === 'book-b' ? { ...row, eventStartMs: 5100 } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0 });
  assert.equal(report.candidateCount, 0);
  assert.ok(report.blockers.includes('INSUFFICIENT_INDEPENDENT_CONSENSUS'));
});

test('manual settlement may be explored but is explicitly marked non-promotable evidence', () => {
  const rows = baseRows().map((row) => row.stage === 'SETTLED' ? {
    ...row,
    provenance: 'MANUAL_RESEARCH' as const,
    sourceContractId: undefined,
  } : row);
  const report = runSportsResearch(rows, { minConsensusVenues: 2, minEdge: 0.01 });
  assert.ok(report.settledCandidates >= 1);
  assert.ok(report.blockers.includes('MANUAL_SETTLEMENT_DATA'));
});
