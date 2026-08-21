import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolymarketMessage } from '../src/feeds/polymarket.js';
import type { PolymarketTokenMetadata } from '../src/domain/types.js';

const metadata: PolymarketTokenMetadata = {
  tokenId: 'token-up',
  outcome: 'Up',
  marketId: '123',
  conditionId: '0xabc',
  slug: 'bitcoin-up-or-down',
  question: 'Bitcoin Up or Down?',
  underlying: 'BTC',
  expiryTimeMs: 1_800_000_000_000,
};

test('normalizes a best-bid-ask event and attaches discovered metadata', () => {
  const events = normalizePolymarketMessage({
    event_type: 'best_bid_ask',
    asset_id: 'token-up',
    best_bid: '0.48',
    best_ask: '0.52',
    timestamp: '1770000000000',
  }, 1770000000010, new Map([['token-up', metadata]]));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.bid, 0.48);
  assert.equal(events[0]?.ask, 0.52);
  assert.equal(events[0]?.polymarket?.outcome, 'Up');
});

test('splits price_change arrays into one normalized event per token', () => {
  const events = normalizePolymarketMessage({
    event_type: 'price_change',
    market: '0xmarket',
    timestamp: '1770000000000',
    price_changes: [
      { asset_id: 'token-up', price: '0.51', size: '10', side: 'BUY', best_bid: '0.51', best_ask: '0.53' },
      { asset_id: 'token-down', price: '0.49', size: '12', side: 'SELL', best_bid: '0.47', best_ask: '0.49' },
    ],
  }, 1770000000010, new Map([['token-up', metadata]]));

  assert.equal(events.length, 2);
  assert.equal(events[0]?.instrument, 'token-up');
  assert.equal(events[0]?.side, 'buy');
  assert.equal(events[1]?.instrument, 'token-down');
  assert.equal(events[1]?.side, 'sell');
});

test('tick_size_change updates token metadata and emits a status event', () => {
  const local = { ...metadata, tickSize: 0.01 };
  const events = normalizePolymarketMessage({
    event_type: 'tick_size_change',
    asset_id: 'token-up',
    old_tick_size: '0.01',
    new_tick_size: '0.001',
    timestamp: '1770000000000',
  }, 1770000000010, new Map([['token-up', local]]));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'status');
  assert.equal(local.tickSize, 0.001);
});
