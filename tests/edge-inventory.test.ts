import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarketEvent } from '../src/domain/types.js';
import { PolymarketL2Book } from '../src/orderbook/polymarket-l2.js';
import { BinaryInventory } from '../src/portfolio/binary-inventory.js';
import { assessDirectionalBuyEdge, assessPairArbitrage } from '../src/strategy/edge-engine.js';
import { planBuyOnlyExposureAdjustment } from '../src/strategy/inventory-planner.js';

function book(token: string, bid: number, ask: number, size = 100): PolymarketL2Book {
  const b = new PolymarketL2Book(token);
  const event: MarketEvent = {
    venue: 'polymarket', kind: 'book', instrument: token, eventTimeMs: 1, receivedTimeMs: 1,
    raw: { bids: [{ price: String(bid), size: String(size) }], asks: [{ price: String(ask), size: String(size) }] },
  };
  b.apply(event);
  return b;
}

test('pair arbitrage includes both visible prices and taker fees', () => {
  const result = assessPairArbitrage(book('up', 0.45, 0.46), book('down', 0.50, 0.51), 10, 0.07, 0.07);
  assert.equal(result.executable, true);
  assert.ok(result.totalCashCostUsd > 9.7);
  assert.ok(result.lockedPnlUsd < 10 - (4.6 + 5.1)); // fees reduce naive gross edge
});

test('directional EV requires caller-provided probability', () => {
  const result = assessDirectionalBuyEdge(book('up', 0.48, 0.50), 0.60, 10, 0.07);
  assert.equal(result.executable, true);
  assert.ok(result.expectedPnlUsd > 0);
  assert.throws(() => assessDirectionalBuyEdge(book('up2', 0.48, 0.50), 1.1, 10, 0.07), /probability/);
});

test('buy-only planner hedges UP exposure by buying DOWN', () => {
  const inventory = new BinaryInventory();
  inventory.buy('UP', 10, 0.45);
  const plan = planBuyOnlyExposureAdjustment(inventory.snapshot(), 2, 20);
  assert.equal(plan.action, 'BUY');
  assert.equal(plan.outcome, 'DOWN');
  assert.equal(plan.shares, 8);
});
