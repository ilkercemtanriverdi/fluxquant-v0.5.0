import {
  EXECUTION_MARKETS,
  EXECUTION_MODES,
  EXECUTION_ORDER_TYPES,
  EXECUTION_SIDES,
  type ExecutionAdapterCapabilities,
  type ExecutionIntent,
  type ExecutionMode,
  type ExecutionOrderStatus,
} from './types.js';

const terminalStatuses = new Set<ExecutionOrderStatus>([
  'CLOSED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
]);

const transitions: Readonly<Record<ExecutionOrderStatus, readonly ExecutionOrderStatus[]>> = {
  PENDING: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLING', 'CLOSED', 'CANCELLED', 'REJECTED', 'FAILED', 'EXPIRED'],
  OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLING', 'REPLACING', 'CLOSED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLING', 'REPLACING', 'CLOSED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  CANCELLING: ['PARTIALLY_FILLED', 'FILLED', 'CLOSED', 'CANCELLED', 'FAILED'],
  REPLACING: ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CLOSED', 'CANCELLED', 'FAILED', 'EXPIRED'],
  CLOSED: [],
  FILLED: [],
  CANCELLED: [],
  REJECTED: [],
  FAILED: [],
  EXPIRED: [],
};

export function isTerminalExecutionStatus(status: ExecutionOrderStatus): boolean {
  return terminalStatuses.has(status);
}

export function assertExecutionTransition(from: ExecutionOrderStatus, to: ExecutionOrderStatus): void {
  if (from === to) return; // idempotent venue updates are allowed
  if (!transitions[from].includes(to)) throw new Error(`EXECUTION_INVALID_TRANSITION:${from}->${to}`);
}

export function assertExecutionMode(value: string): asserts value is ExecutionMode {
  if (!EXECUTION_MODES.includes(value as ExecutionMode)) {
    throw new Error(`EXECUTION_MODE_FORBIDDEN:${value}`);
  }
}

export function validateExecutionIntent(intent: ExecutionIntent): void {
  if (!intent.clientOrderId.trim()) throw new Error('EXECUTION_CLIENT_ORDER_ID_REQUIRED');
  if (!EXECUTION_MARKETS.includes(intent.market)) throw new Error(`EXECUTION_MARKET_INVALID:${intent.market}`);
  if (!EXECUTION_SIDES.includes(intent.side)) throw new Error(`EXECUTION_SIDE_INVALID:${intent.side}`);
  if (!EXECUTION_ORDER_TYPES.includes(intent.orderType)) throw new Error(`EXECUTION_ORDER_TYPE_INVALID:${intent.orderType}`);
  if (!intent.venue.trim()) throw new Error('EXECUTION_VENUE_REQUIRED');
  if (!intent.instrument.trim()) throw new Error('EXECUTION_INSTRUMENT_REQUIRED');
  if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) throw new Error('EXECUTION_QUANTITY_INVALID');
  if (!Number.isFinite(intent.createdAtMs) || intent.createdAtMs <= 0) throw new Error('EXECUTION_CREATED_AT_INVALID');
  if (intent.orderType === 'LIMIT') {
    if (!Number.isFinite(intent.limitPrice) || (intent.limitPrice ?? 0) <= 0) throw new Error('EXECUTION_LIMIT_PRICE_REQUIRED');
  } else if (intent.limitPrice !== undefined) {
    throw new Error('EXECUTION_MARKET_ORDER_LIMIT_PRICE_FORBIDDEN');
  }
  if (intent.maxLossUsd !== undefined && (!Number.isFinite(intent.maxLossUsd) || intent.maxLossUsd <= 0)) {
    throw new Error('EXECUTION_MAX_LOSS_INVALID');
  }
}

export function validateAdapterCapabilities(capabilities: ExecutionAdapterCapabilities): void {
  if (!capabilities.adapterId.trim()) throw new Error('EXECUTION_ADAPTER_ID_REQUIRED');
  if (!capabilities.venue.trim()) throw new Error('EXECUTION_ADAPTER_VENUE_REQUIRED');
  if (capabilities.markets.length === 0) throw new Error('EXECUTION_ADAPTER_MARKET_REQUIRED');
  for (const market of capabilities.markets) {
    if (!EXECUTION_MARKETS.includes(market)) throw new Error(`EXECUTION_ADAPTER_MARKET_INVALID:${market}`);
  }
  if (capabilities.modes.length === 0) throw new Error('EXECUTION_ADAPTER_MODE_REQUIRED');
  for (const mode of capabilities.modes) assertExecutionMode(mode);
  if (!capabilities.supportsMarketOrders && !capabilities.supportsLimitOrders) {
    throw new Error('EXECUTION_ADAPTER_NO_ORDER_TYPE');
  }
}

export function assertIntentCompatible(capabilities: ExecutionAdapterCapabilities, intent: ExecutionIntent): void {
  validateAdapterCapabilities(capabilities);
  validateExecutionIntent(intent);
  if (!capabilities.markets.includes(intent.market)) throw new Error(`EXECUTION_ADAPTER_MARKET_UNSUPPORTED:${intent.market}`);
  if (intent.orderType === 'MARKET' && !capabilities.supportsMarketOrders) throw new Error('EXECUTION_MARKET_ORDER_UNSUPPORTED');
  if (intent.orderType === 'LIMIT' && !capabilities.supportsLimitOrders) throw new Error('EXECUTION_LIMIT_ORDER_UNSUPPORTED');
}
