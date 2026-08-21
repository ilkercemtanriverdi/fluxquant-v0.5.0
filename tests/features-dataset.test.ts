import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketEvent, PolymarketTokenMetadata } from '../src/domain/types.js';
import { ShortHorizonFeatureState } from '../src/features/short-horizon.js';
import { buildUpDownDataset, splitDatasetChronologicallyByMarket } from '../src/dataset/updown-dataset.js';

function token(
  conditionId: string,
  outcome: 'Up' | 'Down',
  startTimeMs: number,
  expiryTimeMs: number,
  underlying: 'BTC' | 'ETH' = 'BTC',
): PolymarketTokenMetadata {
  return {
    tokenId: `${conditionId}-${outcome.toLowerCase()}`,
    outcome,
    marketId: `market-${conditionId}`,
    conditionId,
    slug: `${underlying.toLowerCase()}-up-or-down-${conditionId}`,
    question: `${underlying} Up or Down?`,
    underlying,
    startTimeMs,
    expiryTimeMs,
  };
}

function bba(time: number, mid: number, instrument = 'BTCUSDT', bidSize = 8, askSize = 2): MarketEvent {
  return {
    venue: 'binance', kind: 'best_bid_ask', instrument, eventTimeMs: time, receivedTimeMs: time,
    bid: mid - 0.5, ask: mid + 0.5, bidSize, askSize, raw: {},
  };
}

function trade(time: number, price: number, side: 'buy' | 'sell', instrument = 'BTCUSDT'): MarketEvent {
  return {
    venue: 'binance', kind: 'trade', instrument, eventTimeMs: time, receivedTimeMs: time,
    price, size: 2, side, raw: {},
  };
}

function polyBook(time: number, tokenId: string, bid: number, ask: number): MarketEvent {
  return {
    venue: 'polymarket', kind: 'book', instrument: tokenId, eventTimeMs: time, receivedTimeMs: time,
    raw: {
      bids: [{ price: String(bid), size: '50' }],
      asks: [{ price: String(ask), size: '50' }],
    },
  };
}

test('feature state builds synchronized Binance + Polymarket frame without cross-underlying leakage', () => {
  const btcUp = token('btc-c1', 'Up', 0, 60_000, 'BTC');
  const btcDown = token('btc-c1', 'Down', 0, 60_000, 'BTC');
  const ethUp = token('eth-c1', 'Up', 0, 60_000, 'ETH');
  const ethDown = token('eth-c1', 'Down', 0, 60_000, 'ETH');
  const state = new ShortHorizonFeatureState([btcUp, btcDown, ethUp, ethDown]);

  state.apply(bba(0, 100, 'BTCUSDT'));
  state.apply(bba(0, 2_000, 'ETHUSDT', 1, 9));
  state.apply(bba(5_000, 102, 'BTCUSDT'));
  state.apply(bba(5_000, 2_020, 'ETHUSDT', 1, 9));
  state.apply(trade(4_500, 102, 'buy', 'BTCUSDT'));
  state.apply(polyBook(5_000, btcUp.tokenId, 0.54, 0.56));
  state.apply(polyBook(5_000, btcDown.tokenId, 0.44, 0.46));
  state.apply(polyBook(5_000, ethUp.tokenId, 0.60, 0.62));
  state.apply(polyBook(5_000, ethDown.tokenId, 0.38, 0.40));

  const btc = state.frameForMarket('btc-c1', 5_000);
  const eth = state.frameForMarket('eth-c1', 5_000);
  assert.ok(btc);
  assert.ok(eth);
  assert.equal(btc.binanceMid, 102);
  assert.equal(eth.binanceMid, 2_020);
  assert.ok(btc.binanceReturn5s > 0);
  assert.ok(btc.binanceTopImbalance > 0);
  assert.ok(eth.binanceTopImbalance < 0);
  assert.equal(btc.normalizedUpMid, 0.55);
  assert.equal(btc.crossOutcomeQuoteSkewMs, 0);
});

test('dataset builder creates pre-expiry rows with explicit Binance proxy labels', () => {
  const metadata: PolymarketTokenMetadata[] = [];
  const events: MarketEvent[] = [];
  const marketSpecs = [
    { id: 'c1', start: 0, expiry: 100_000, startPrice: 100, endPrice: 102 },
    { id: 'c2', start: 120_000, expiry: 220_000, startPrice: 105, endPrice: 103 },
    { id: 'c3', start: 240_000, expiry: 340_000, startPrice: 103, endPrice: 106 },
  ];

  for (const spec of marketSpecs) {
    const up = token(spec.id, 'Up', spec.start, spec.expiry);
    const down = token(spec.id, 'Down', spec.start, spec.expiry);
    metadata.push(up, down);
    events.push(bba(spec.start, spec.startPrice));
    const target = spec.expiry - 30_000;
    events.push(bba(target, (spec.startPrice + spec.endPrice) / 2));
    events.push(trade(target - 500, (spec.startPrice + spec.endPrice) / 2, spec.endPrice > spec.startPrice ? 'buy' : 'sell'));
    events.push(polyBook(target, up.tokenId, spec.endPrice > spec.startPrice ? 0.56 : 0.44, spec.endPrice > spec.startPrice ? 0.58 : 0.46));
    events.push(polyBook(target, down.tokenId, spec.endPrice > spec.startPrice ? 0.42 : 0.54, spec.endPrice > spec.startPrice ? 0.44 : 0.56));
    events.push(bba(spec.expiry, spec.endPrice));
  }

  const dataset = buildUpDownDataset(events, metadata, {
    sampleSecondsToExpiry: [30],
    labelPriceToleranceMs: 10,
    maxBinanceBookAgeMs: 10,
    maxPolymarketBookAgeMs: 10,
    minAbsoluteLabelMoveBps: 0.1,
  });

  assert.equal(dataset.rows.length, 3);
  assert.deepEqual(dataset.rows.map((row) => row.label), [1, 0, 1]);
  assert.ok(dataset.rows.every((row) => row.labelSource === 'binance_proxy'));
  assert.ok(dataset.rows.every((row) => row.frame.observationTimeMs === row.frame.expiryTimeMs - 30_000));
  assert.deepEqual(dataset.rows.map((row) => row.frame.binanceMid), [101, 104, 104.5]);

  const split = splitDatasetChronologicallyByMarket(dataset.rows, 0.34, 0.33);
  assert.equal(split.trainConditions.length, 1);
  assert.equal(split.validationConditions.length, 1);
  assert.equal(split.testConditions.length, 1);
  assert.equal(new Set([...split.trainConditions, ...split.validationConditions, ...split.testConditions]).size, 3);
});
