import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../src/domain/types.js';
import { SHORT_HORIZON_FEATURE_NAMES, type LogisticModel } from '../src/model/logistic.js';
import { runShadowReplay } from '../src/shadow/replay-trader.js';

function token(id: string, outcome: 'UP' | 'DOWN', start: number, expiry: number): PolymarketTokenMetadata {
  return {
    tokenId: id,
    outcome,
    marketId: 'm1',
    conditionId: 'c1',
    slug: 'btc-up-or-down-test',
    question: 'Bitcoin Up or Down?',
    underlying: 'BTC',
    startTimeMs: start,
    expiryTimeMs: expiry,
    platformFeeRate: 0,
  };
}

function pmBook(tokenMeta: PolymarketTokenMetadata, time: number, bid: number, ask: number): MarketEvent {
  return {
    venue: 'polymarket',
    kind: 'book',
    instrument: tokenMeta.tokenId,
    eventTimeMs: time,
    receivedTimeMs: time,
    polymarket: tokenMeta,
    rawType: 'fixture',
    raw: {
      bids: [{ price: bid, size: 10 }],
      asks: [{ price: ask, size: 10 }],
    },
  };
}

test('shadow replay turns calibrated probability into bounded buy-only inventory and settled PnL', () => {
  const start = 1_800_000_000_000;
  const expiry = start + 180_000;
  const up = token('up', 'UP', start, expiry);
  const down = token('down', 'DOWN', start, expiry);
  const market: DiscoveredPolymarketMarket = {
    marketId: 'm1',
    conditionId: 'c1',
    slug: 'btc-up-or-down-test',
    question: 'Bitcoin Up or Down?',
    underlying: 'BTC',
    startTimeMs: start,
    expiryTimeMs: expiry,
    resolvedOutcome: 'UP',
    tokens: [up, down],
  };
  const observation = expiry - 120_000 - 100;
  const events: MarketEvent[] = [
    {
      venue: 'binance', kind: 'best_bid_ask', instrument: 'BTCUSDT',
      eventTimeMs: observation, receivedTimeMs: observation,
      bid: 99.9, ask: 100.1, bidSize: 1, askSize: 1, raw: {},
    },
    pmBook(up, observation, 0.54, 0.55),
    pmBook(down, observation, 0.44, 0.45),
  ];

  const width = SHORT_HORIZON_FEATURE_NAMES.length;
  const model: LogisticModel = {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer: { mean: Array(width).fill(0), scale: Array(width).fill(1) },
    weights: Array(width).fill(0),
    bias: Math.log(0.8 / 0.2),
  };
  const report = runShadowReplay(events, [market], { model, calibrator: { slope: 1, intercept: 0 } }, {
    decisionSecondsToExpiry: [120],
    minExpectedReturn: 0.01,
    targetExposureShares: 1,
    maxAdjustmentShares: 1,
    maxBinanceBookAgeMs: 1_000,
    maxPolymarketBookAgeMs: 1_000,
    conditionAllowlist: new Set(['c1']),
  });

  assert.equal(report.summary.marketsSettled, 1);
  assert.equal(report.summary.trades, 1);
  assert.equal(report.trades[0]?.outcome, 'UP');
  assert.equal(report.markets[0]?.inventory.up.quantity, 1);
  assert.ok(Math.abs(report.summary.netPnlUsd - 0.45) < 1e-9);
});


test('strict quote policy rejects cross-outcome skew before trading', () => {
  const start = 1_800_000_100_000;
  const expiry = start + 180_000;
  const up = token('up2', 'UP', start, expiry);
  const down = token('down2', 'DOWN', start, expiry);
  const market: DiscoveredPolymarketMarket = {
    marketId: 'm1',
    conditionId: 'c1',
    slug: 'btc-up-or-down-test',
    question: 'Bitcoin Up or Down?',
    underlying: 'BTC',
    startTimeMs: start,
    expiryTimeMs: expiry,
    resolvedOutcome: 'UP',
    tokens: [up, down],
  };
  const observation = expiry - 120_000;
  const events: MarketEvent[] = [
    {
      venue: 'binance', kind: 'best_bid_ask', instrument: 'BTCUSDT',
      eventTimeMs: observation, receivedTimeMs: observation,
      bid: 99.9, ask: 100.1, bidSize: 1, askSize: 1, raw: {},
    },
    pmBook(up, observation - 100, 0.54, 0.55),
    pmBook(down, observation - 900, 0.44, 0.45),
  ];
  const width = SHORT_HORIZON_FEATURE_NAMES.length;
  const model: LogisticModel = {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer: { mean: Array(width).fill(0), scale: Array(width).fill(1) },
    weights: Array(width).fill(0),
    bias: 0,
  };
  const report = runShadowReplay(events, [market], { model, calibrator: { slope: 1, intercept: 0 } }, {
    decisionSecondsToExpiry: [120],
    fallbackPlatformFeeRate: 0.07,
    maxBinanceBookAgeMs: 500,
    maxPolymarketBookAgeMs: 1_000,
    maxCrossOutcomeQuoteSkewMs: 500,
  });
  assert.equal(report.summary.trades, 0);
  assert.equal(report.summary.skippedCrossOutcomeSkew, 1);
});

test('pair-arb mode buys both synchronized legs only when locked return clears threshold', () => {
  const start = 1_800_000_200_000;
  const expiry = start + 180_000;
  const up = token('up3', 'UP', start, expiry);
  const down = token('down3', 'DOWN', start, expiry);
  const market: DiscoveredPolymarketMarket = {
    marketId: 'm1',
    conditionId: 'c1',
    slug: 'btc-up-or-down-test',
    question: 'Bitcoin Up or Down?',
    underlying: 'BTC',
    startTimeMs: start,
    expiryTimeMs: expiry,
    resolvedOutcome: 'UP',
    tokens: [up, down],
  };
  const observation = expiry - 120_000;
  const events: MarketEvent[] = [
    {
      venue: 'binance', kind: 'best_bid_ask', instrument: 'BTCUSDT',
      eventTimeMs: observation, receivedTimeMs: observation,
      bid: 99.9, ask: 100.1, bidSize: 1, askSize: 1, raw: {},
    },
    pmBook(up, observation, 0.43, 0.44),
    pmBook(down, observation, 0.43, 0.44),
  ];
  const width = SHORT_HORIZON_FEATURE_NAMES.length;
  const model: LogisticModel = {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer: { mean: Array(width).fill(0), scale: Array(width).fill(1) },
    weights: Array(width).fill(0),
    bias: 0,
  };
  const report = runShadowReplay(events, [market], { model, calibrator: { slope: 1, intercept: 0 } }, {
    strategy: 'pair-arb',
    decisionSecondsToExpiry: [120],
    fallbackPlatformFeeRate: 0.07,
    minExpectedReturn: 0.01,
    maxBinanceBookAgeMs: 500,
    maxPolymarketBookAgeMs: 500,
    maxCrossOutcomeQuoteSkewMs: 500,
    targetExposureShares: 1,
    maxAdjustmentShares: 1,
  });
  assert.equal(report.summary.trades, 2);
  assert.equal(report.summary.pairArbLegTrades, 2);
  assert.equal(report.markets[0]?.inventory.hedgedPairs, 1);
  assert.ok((report.markets[0]?.pnlUsd ?? 0) > 0);
});

test('pair-arb is genuinely Polymarket-only and does not require Binance state', () => {
  const start = 1_800_000_300_000;
  const expiry = start + 180_000;
  const up = token('up4', 'UP', start, expiry);
  const down = token('down4', 'DOWN', start, expiry);
  const market: DiscoveredPolymarketMarket = {
    marketId: 'm1', conditionId: 'c1', slug: 'btc-up-or-down-test', question: 'Bitcoin Up or Down?',
    underlying: 'BTC', startTimeMs: start, expiryTimeMs: expiry, resolvedOutcome: 'UP', tokens: [up, down],
  };
  const observation = expiry - 120_000;
  const events: MarketEvent[] = [
    pmBook(up, observation, 0.43, 0.44),
    pmBook(down, observation, 0.43, 0.44),
  ];
  const width = SHORT_HORIZON_FEATURE_NAMES.length;
  const model: LogisticModel = {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer: { mean: Array(width).fill(0), scale: Array(width).fill(1) },
    weights: Array(width).fill(0), bias: 0,
  };
  const report = runShadowReplay(events, [market], undefined, {
    strategy: 'pair-arb', decisionSecondsToExpiry: [120], fallbackPlatformFeeRate: 0.07,
    minExpectedReturn: 0.01, maxBinanceBookAgeMs: 1, maxPolymarketBookAgeMs: 500,
    maxCrossOutcomeQuoteSkewMs: 500, targetExposureShares: 1, maxAdjustmentShares: 1,
  });
  assert.equal(report.summary.trades, 2);
  assert.equal(report.summary.skippedMissingBinanceFrame, 0);
  assert.equal(report.summary.skippedStaleBinance, 0);
});

test('market-control ignores stale Binance while model fails closed on it', () => {
  const start = 1_800_000_400_000;
  const expiry = start + 180_000;
  const up = token('up5', 'UP', start, expiry);
  const down = token('down5', 'DOWN', start, expiry);
  const market: DiscoveredPolymarketMarket = {
    marketId: 'm1', conditionId: 'c1', slug: 'btc-up-or-down-test', question: 'Bitcoin Up or Down?',
    underlying: 'BTC', startTimeMs: start, expiryTimeMs: expiry, resolvedOutcome: 'UP', tokens: [up, down],
  };
  const observation = expiry - 120_000;
  const events: MarketEvent[] = [
    {
      venue: 'binance', kind: 'best_bid_ask', instrument: 'BTCUSDT',
      eventTimeMs: observation - 10_000, receivedTimeMs: observation - 10_000,
      bid: 99.9, ask: 100.1, bidSize: 1, askSize: 1, raw: {},
    },
    pmBook(up, observation, 0.20, 0.21),
    pmBook(down, observation, 0.78, 0.79),
  ];
  const width = SHORT_HORIZON_FEATURE_NAMES.length;
  const model: LogisticModel = {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer: { mean: Array(width).fill(0), scale: Array(width).fill(1) },
    weights: Array(width).fill(0), bias: Math.log(0.8 / 0.2),
  };

  const modelReport = runShadowReplay(events, [market], { model, calibrator: { slope: 1, intercept: 0 } }, {
    strategy: 'model', decisionSecondsToExpiry: [120], fallbackPlatformFeeRate: 0,
    minExpectedReturn: 0.01, maxBinanceBookAgeMs: 500, maxPolymarketBookAgeMs: 500,
    maxCrossOutcomeQuoteSkewMs: 500,
  });
  assert.equal(modelReport.summary.trades, 0);
  assert.equal(modelReport.summary.skippedStaleBinance, 1);

  const controlReport = runShadowReplay(events, [market], { model, calibrator: { slope: 1, intercept: 0 } }, {
    strategy: 'market-control', decisionSecondsToExpiry: [120], fallbackPlatformFeeRate: 0,
    minExpectedReturn: 0.001, maxBinanceBookAgeMs: 500, maxPolymarketBookAgeMs: 500,
    maxCrossOutcomeQuoteSkewMs: 500,
  });
  assert.equal(controlReport.summary.skippedStaleBinance, 0);
  assert.equal(controlReport.summary.skippedMissingBinanceFrame, 0);
});
