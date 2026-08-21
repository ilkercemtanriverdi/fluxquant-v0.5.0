import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExecutionMode,
  assertExecutionTransition,
  assertIntentCompatible,
  isTerminalExecutionStatus,
} from '../src/execution/lifecycle.js';
import {
  normalizeFlumineOrderStatus,
  normalizeHummingbotOrderState,
} from '../src/execution/donor-normalization.js';
import type { ExecutionAdapterCapabilities, ExecutionIntent } from '../src/execution/types.js';

const caps: ExecutionAdapterCapabilities = {
  adapterId: 'fixture.crypto.paper',
  venue: 'fixture',
  markets: ['crypto'],
  modes: ['shadow', 'paper'],
  supportsMarketOrders: true,
  supportsLimitOrders: true,
  supportsReplace: true,
  supportsPartialCancel: true,
};

const intent: ExecutionIntent = {
  clientOrderId: 'c1',
  market: 'crypto',
  venue: 'fixture',
  instrument: 'BTCUSDT',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: 0.01,
  limitPrice: 50000,
  maxLossUsd: 500,
  createdAtMs: 1,
};

test('execution contract has no live mode', () => {
  assert.doesNotThrow(() => assertExecutionMode('paper'));
  assert.doesNotThrow(() => assertExecutionMode('shadow'));
  assert.throws(() => assertExecutionMode('live'), /EXECUTION_MODE_FORBIDDEN/);
});

test('normalized lifecycle accepts fill/cancel races but rejects terminal resurrection', () => {
  assert.doesNotThrow(() => assertExecutionTransition('OPEN', 'CANCELLING'));
  assert.doesNotThrow(() => assertExecutionTransition('CANCELLING', 'FILLED'));
  assert.throws(() => assertExecutionTransition('FILLED', 'OPEN'), /EXECUTION_INVALID_TRANSITION/);
  assert.equal(isTerminalExecutionStatus('CANCELLED'), true);
  assert.equal(isTerminalExecutionStatus('CLOSED'), true);
  assert.equal(isTerminalExecutionStatus('PARTIALLY_FILLED'), false);
});

test('Hummingbot states normalize to the shared lifecycle', () => {
  assert.equal(normalizeHummingbotOrderState('PENDING_CREATE'), 'PENDING');
  assert.equal(normalizeHummingbotOrderState('OPEN'), 'OPEN');
  assert.equal(normalizeHummingbotOrderState('PENDING_CANCEL'), 'CANCELLING');
  assert.equal(normalizeHummingbotOrderState('PARTIALLY_FILLED'), 'PARTIALLY_FILLED');
  assert.equal(normalizeHummingbotOrderState('CANCELED'), 'CANCELLED');
  assert.equal(normalizeHummingbotOrderState('FILLED'), 'FILLED');
  assert.throws(() => normalizeHummingbotOrderState('COMPLETED'), /EXECUTION_UNKNOWN_HUMMINGBOT_STATE/);
  assert.throws(() => normalizeHummingbotOrderState('APPROVED'), /EXECUTION_UNKNOWN_HUMMINGBOT_STATE/);
  assert.throws(() => normalizeHummingbotOrderState('MAGIC'), /EXECUTION_UNKNOWN_HUMMINGBOT_STATE/);
});

test('flumine states normalize without pretending EXECUTABLE means fully filled', () => {
  assert.equal(normalizeFlumineOrderStatus('Pending'), 'PENDING');
  assert.equal(normalizeFlumineOrderStatus('Executable', 0), 'OPEN');
  assert.equal(normalizeFlumineOrderStatus('Executable', 1), 'PARTIALLY_FILLED');
  assert.equal(normalizeFlumineOrderStatus('Cancelling'), 'CANCELLING');
  assert.equal(normalizeFlumineOrderStatus('Replacing'), 'REPLACING');
  assert.equal(normalizeFlumineOrderStatus('Execution complete', 2), 'CLOSED');
  assert.equal(normalizeFlumineOrderStatus('Violation'), 'REJECTED');
  assert.throws(() => normalizeFlumineOrderStatus('Executable', -1), /MATCHED_QUANTITY_INVALID/);
});

test('adapter compatibility rejects unsupported market and malformed limit orders', () => {
  assert.doesNotThrow(() => assertIntentCompatible(caps, intent));
  assert.throws(() => assertIntentCompatible(caps, { ...intent, market: 'football' }), /MARKET_UNSUPPORTED/);
  assert.throws(() => assertIntentCompatible(caps, { ...intent, limitPrice: undefined }), /LIMIT_PRICE_REQUIRED/);
  assert.throws(() => assertIntentCompatible(caps, { ...intent, side: 'MAGIC' as never }), /SIDE_INVALID/);
  assert.throws(() => assertIntentCompatible(caps, { ...intent, orderType: 'STOP' as never }), /ORDER_TYPE_INVALID/);
});

import { SportsPaperLedger } from '../src/sports/paper-ledger.js';
import { SportsPaperExecutionAdapter } from '../src/execution/sports-paper-adapter.js';

test('sports paper adapter reuses existing ledger risk controls and fills without live I/O', async () => {
  const ledger = new SportsPaperLedger(100, 0.1);
  const adapter = new SportsPaperExecutionAdapter(ledger, 0.01);
  const sportsIntent: ExecutionIntent = {
    clientOrderId: 'football-1',
    market: 'football',
    venue: 'paper-book',
    instrument: 'E0:match-1:1x2',
    side: 'BACK',
    orderType: 'LIMIT',
    quantity: 5,
    limitPrice: 2.2,
    maxLossUsd: 5,
    createdAtMs: 10,
    metadata: { eventId: 'match-1', outcome: 'HOME', fairProbabilityAtEntry: 0.5 },
  };
  assert.equal((await adapter.preflight(sportsIntent)).accepted, true);
  const order = await adapter.submit(sportsIntent);
  assert.equal(order.status, 'FILLED');
  assert.equal(order.filledQuantity, 5);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.snapshot().openRiskUsd, 5);
  assert.deepEqual(await adapter.listOpenOrders(), []);
});

test('sports paper adapter fails closed on risk breach and never exposes live mode', async () => {
  const ledger = new SportsPaperLedger(100, 0.05);
  const adapter = new SportsPaperExecutionAdapter(ledger, 0);
  const tooLarge: ExecutionIntent = {
    clientOrderId: 'football-risk',
    market: 'football',
    venue: 'paper-book',
    instrument: 'E0:match-2:1x2',
    side: 'BACK',
    orderType: 'LIMIT',
    quantity: 10,
    limitPrice: 2.0,
    createdAtMs: 11,
    metadata: { eventId: 'match-2', outcome: 'AWAY', fairProbabilityAtEntry: 0.55 },
  };
  await assert.rejects(() => adapter.submit(tooLarge), /SPORTS_OPEN_RISK_LIMIT/);
  assert.deepEqual(adapter.capabilities().modes, ['paper']);
});
