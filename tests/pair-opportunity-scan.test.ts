import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../src/domain/types.js';
import { PairOpportunityScanner } from '../src/scan/pair-opportunity.js';

function token(id: string, outcome: 'UP' | 'DOWN', start: number, expiry: number): PolymarketTokenMetadata {
  return {
    tokenId: id,
    outcome,
    marketId: 'm1',
    conditionId: 'c1',
    slug: 'btc-updown-test',
    question: 'BTC Up or Down?',
    underlying: 'BTC',
    startTimeMs: start,
    expiryTimeMs: expiry,
  };
}

function market(start: number, expiry: number): DiscoveredPolymarketMarket {
  const up = token('up', 'UP', start, expiry);
  const down = token('down', 'DOWN', start, expiry);
  return {
    marketId: 'm1', conditionId: 'c1', slug: 'btc-updown-test', question: 'BTC Up or Down?',
    underlying: 'BTC', startTimeMs: start, expiryTimeMs: expiry, tokens: [up, down],
  };
}

function pmBook(meta: PolymarketTokenMetadata, time: number, bid: number, ask: number): MarketEvent {
  return {
    venue: 'polymarket', kind: 'book', instrument: meta.tokenId,
    eventTimeMs: time, receivedTimeMs: time, polymarket: meta, rawType: 'fixture',
    raw: { bids: [{ price: bid, size: 1 }], asks: [{ price: ask, size: 1 }], historical_top_only: true },
  };
}

function binance(time: number): MarketEvent {
  return {
    venue: 'binance', kind: 'best_bid_ask', instrument: 'BTCUSDT', eventTimeMs: time, receivedTimeMs: time,
    bid: 100, ask: 100.1, bidSize: 1, askSize: 1, raw: {},
  };
}

test('event-driven pair scanner finds synchronized fee-adjusted pair edge without Binance', () => {
  const start = 1_800_100_000_000;
  const expiry = start + 60_000;
  const m = market(start, expiry);
  const [up, down] = m.tokens;
  assert.ok(up && down);
  const scanner = new PairOpportunityScanner([m], {
    fallbackPlatformFeeRate: 0.07,
    shares: 1,
    minLockedReturnOnCost: 0.01,
    freshnessThresholdsMs: [500],
    latencyMilestonesMs: [100, 250, 500],
  });
  scanner.apply(pmBook(up, start + 1_000, 0.42, 0.43));
  scanner.apply(pmBook(down, start + 1_050, 0.42, 0.43));
  const report = scanner.finish();
  const strict = report.thresholds[0];
  assert.equal(strict?.uniqueMarkets, 1);
  assert.equal(strict?.episodes, 1);
  assert.ok((strict?.bestLockedReturnOnCost ?? 0) > 0.01);
  assert.equal(report.topOnlyHistoricalEvents, 2);
});

test('500ms scanner rejects stale counterpart while 1000ms accepts it', () => {
  const start = 1_800_200_000_000;
  const expiry = start + 60_000;
  const m = market(start, expiry);
  const [up, down] = m.tokens;
  assert.ok(up && down);
  const scanner = new PairOpportunityScanner([m], {
    fallbackPlatformFeeRate: 0.07,
    minLockedReturnOnCost: 0.01,
    freshnessThresholdsMs: [500, 1_000],
  });
  scanner.apply(pmBook(up, start + 1_000, 0.42, 0.43));
  scanner.apply(pmBook(down, start + 1_800, 0.42, 0.43));
  const report = scanner.finish();
  assert.equal(report.thresholds.find((row) => row.thresholdMs === 500)?.episodes, 0);
  assert.equal(report.thresholds.find((row) => row.thresholdMs === 1_000)?.episodes, 1);
});

test('fee-adjusted pair scanner does not report raw ask-sum edge that fees erase', () => {
  const start = 1_800_300_000_000;
  const expiry = start + 60_000;
  const m = market(start, expiry);
  const [up, down] = m.tokens;
  assert.ok(up && down);
  const scanner = new PairOpportunityScanner([m], {
    fallbackPlatformFeeRate: 0.07,
    minLockedReturnOnCost: 0,
    freshnessThresholdsMs: [500],
  });
  scanner.apply(pmBook(up, start + 1_000, 0.48, 0.49));
  scanner.apply(pmBook(down, start + 1_000, 0.48, 0.49));
  const report = scanner.finish();
  assert.equal(report.thresholds[0]?.episodes, 0);
});

test('scanner ignores Binance for pair opportunity logic and enforces event order', () => {
  const start = 1_800_400_000_000;
  const expiry = start + 60_000;
  const m = market(start, expiry);
  const [up, down] = m.tokens;
  assert.ok(up && down);
  const scanner = new PairOpportunityScanner([m], {
    fallbackPlatformFeeRate: 0.07,
    minLockedReturnOnCost: 0.01,
    freshnessThresholdsMs: [500],
  });
  scanner.apply(binance(start + 100));
  scanner.apply(pmBook(up, start + 1_000, 0.42, 0.43));
  scanner.apply(pmBook(down, start + 1_050, 0.42, 0.43));
  assert.throws(() => scanner.apply(binance(start + 500)), /EVENT_ORDER_VIOLATION/);
  const report = scanner.finish();
  assert.equal(report.thresholds[0]?.episodes, 1);
});
