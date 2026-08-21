import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketEvent } from '../src/domain/types.js';
import { PolymarketL2Book } from '../src/orderbook/polymarket-l2.js';
import { calculatePlatformTakerFeeUsd, simulateTakerFill } from '../src/shadow/taker-fill.js';

test('taker fill walks visible depth and applies platform fee per fill level', () => {
  const book = new PolymarketL2Book('up');
  const snapshot: MarketEvent = {
    venue: 'polymarket', kind: 'book', instrument: 'up', eventTimeMs: 1, receivedTimeMs: 1,
    raw: { bids: [{ price: '0.48', size: '10' }], asks: [{ price: '0.50', size: '4' }, { price: '0.51', size: '10' }] },
  };
  book.apply(snapshot);

  const fill = simulateTakerFill(book, 'BUY', 6, 0.07);
  assert.equal(fill.complete, true);
  assert.equal(fill.legs.length, 2);
  assert.ok((fill.averagePrice ?? 0) > 0.5);
  assert.ok(fill.platformFeeUsd > 0);
  assert.equal(calculatePlatformTakerFeeUsd(4, 0.5, 0.07), 0.07);
});

test('shadow taker fill fails closed when fee metadata is unknown', () => {
  const book = new PolymarketL2Book('up');
  assert.throws(() => simulateTakerFill(book, 'BUY', 5, undefined), /FEE_RATE_UNKNOWN/);
});

test('platform fee follows documented 5-decimal rounding precision', () => {
  assert.equal(calculatePlatformTakerFeeUsd(0.001, 0.01, 0.07), 0);
  assert.equal(calculatePlatformTakerFeeUsd(0.02, 0.5, 0.07), 0.00035);
});
