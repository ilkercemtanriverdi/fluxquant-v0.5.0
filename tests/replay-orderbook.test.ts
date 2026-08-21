import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketEvent } from '../src/domain/types.js';
import { PolymarketL2Book } from '../src/orderbook/polymarket-l2.js';
import { DeterministicReplay } from '../src/replay/deterministic-replay.js';

test('deterministic replay reconstructs L2 in event-time order', () => {
  const token = 'token-up';
  const events: MarketEvent[] = [
    { venue: 'polymarket', kind: 'price_change', instrument: token, eventTimeMs: 200, receivedTimeMs: 202, raw: { side: 'BUY', price: '0.50', size: '20' } },
    { venue: 'polymarket', kind: 'book', instrument: token, eventTimeMs: 100, receivedTimeMs: 101, raw: { bids: [{ price: '0.48', size: '10' }], asks: [{ price: '0.52', size: '12' }] } },
    { venue: 'polymarket', kind: 'price_change', instrument: token, eventTimeMs: 200, receivedTimeMs: 201, raw: { side: 'SELL', price: '0.51', size: '8' } },
  ];

  const book = new PolymarketL2Book(token);
  const order: number[] = [];
  const stats = new DeterministicReplay(events).run((event, clock) => {
    order.push(clock.now());
    book.apply(event);
  });

  assert.deepEqual(order, [100, 200, 200]);
  assert.equal(stats.events, 3);
  assert.equal(book.top().bid?.price, 0.5);
  assert.equal(book.top().ask?.price, 0.51);
});
