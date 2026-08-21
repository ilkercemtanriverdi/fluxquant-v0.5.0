import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateShadowSuite } from '../src/experiment/shadow-suite.js';
import type { ShadowReplayReport } from '../src/shadow/replay-trader.js';

function report(strategy: 'model' | 'market-control' | 'pair-arb', pnls: number[], trades: number): ShadowReplayReport {
  const cost = pnls.length * 1;
  const net = pnls.reduce((sum, value) => sum + value, 0);
  return {
    summary: {
      marketsEligible: pnls.length,
      marketsSettled: pnls.length,
      decisions: pnls.length,
      trades,
      skippedDecisions: 0,
      feesUsd: 0.1,
      cashCostUsd: cost,
      settlementUsd: cost + net,
      netPnlUsd: net,
      roiOnCost: cost > 0 ? net / cost : 0,
      maxCumulativeDrawdownUsd: 0.5,
      strategy,
      quotePolicy: { maxBinanceBookAgeMs: 500, maxPolymarketBookAgeMs: 500, maxCrossOutcomeQuoteSkewMs: 500 },
      skippedMissingBinanceFrame: 0,
      skippedMissingPolymarketFrame: 0,
      skippedStaleBinance: 0,
      skippedStalePolymarket: 0,
      skippedCrossOutcomeSkew: 0,
      directionalEntryTrades: strategy === 'pair-arb' ? 0 : trades,
      sequentialHedgeTrades: 0,
      pairArbLegTrades: strategy === 'pair-arb' ? trades : 0,
    },
    markets: pnls.map((pnl, index) => ({
      conditionId: `c${index}`, marketId: `m${index}`, expiryTimeMs: index,
      resolvedOutcome: 'UP', decisions: 1, trades: 1, feesUsd: 0,
      cashCostUsd: 1, settlementUsd: 1 + pnl, pnlUsd: pnl, roiOnCost: pnl,
      inventory: { up: { quantity: 0, costUsd: 0 }, down: { quantity: 0, costUsd: 0 }, hedgedPairs: 0, netUp: 0, netDown: 0, totalCostUsd: 1, settlementValueIfUpUsd: 0, settlementValueIfDownUsd: 0, pnlIfUpUsd: -1, pnlIfDownUsd: -1 },
    })),
    daily: [], decisions: [], trades: [],
  };
}

test('suite aggregation exposes concentration instead of hiding it behind ROI', () => {
  const aggregate = aggregateShadowSuite([
    { id: 'd1', date: '2026-01-01', strategy: 'model', report: report('model', [5, -1, -1, -1, -1, -0.5], 6), eventPath: 'e', metadataPath: 'm' },
  ]);
  const model = aggregate.strategies[0];
  assert.ok(model);
  assert.equal(model.netPnlUsd, 0.5);
  assert.ok(model.pnlWithoutTop1Usd < 0);
  assert.equal(model.verdict, 'POSITIVE_BUT_CONCENTRATED');
});
