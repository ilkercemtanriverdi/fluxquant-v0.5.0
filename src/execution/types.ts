export const EXECUTION_MARKETS = ['crypto', 'football', 'polymarket'] as const;
export type ExecutionMarket = (typeof EXECUTION_MARKETS)[number];

/**
 * v1.5 safety boundary: execution adapters are research-only.
 * There is deliberately no `live` mode in this contract.
 */
export const EXECUTION_MODES = ['shadow', 'paper'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_SIDES = ['BUY', 'SELL', 'BACK', 'LAY'] as const;
export type ExecutionSide = (typeof EXECUTION_SIDES)[number];

export const EXECUTION_ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export type ExecutionOrderType = (typeof EXECUTION_ORDER_TYPES)[number];

export const EXECUTION_ORDER_STATUSES = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'CANCELLING',
  'REPLACING',
  'CLOSED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
] as const;
export type ExecutionOrderStatus = (typeof EXECUTION_ORDER_STATUSES)[number];

export interface ExecutionIntent {
  clientOrderId: string;
  market: ExecutionMarket;
  venue: string;
  instrument: string;
  side: ExecutionSide;
  orderType: ExecutionOrderType;
  quantity: number;
  limitPrice?: number;
  /** Worst-case modeled loss/liability. Required by adapters that reserve bankroll risk. */
  maxLossUsd?: number;
  createdAtMs: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ExecutionOrder extends ExecutionIntent {
  venueOrderId?: string;
  status: ExecutionOrderStatus;
  filledQuantity: number;
  averageFillPrice?: number;
  feesUsd: number;
  lastUpdateMs: number;
  /** Venue-native state retained only for audit/debug; strategy logic must use normalized status. */
  rawStatus?: string;
}

export interface ExecutionAdapterCapabilities {
  adapterId: string;
  venue: string;
  markets: readonly ExecutionMarket[];
  modes: readonly ExecutionMode[];
  supportsMarketOrders: boolean;
  supportsLimitOrders: boolean;
  supportsReplace: boolean;
  supportsPartialCancel: boolean;
}

export interface ExecutionPreflightResult {
  accepted: boolean;
  reason?: string;
}

export interface ExecutionCancelRequest {
  clientOrderId: string;
  /** Optional reduction amount. Omit for full cancel. */
  reduceByQuantity?: number;
}

export interface ExecutionReplaceRequest {
  clientOrderId: string;
  newQuantity?: number;
  newLimitPrice?: number;
}

export interface ExecutionAdapter {
  readonly mode: ExecutionMode;
  capabilities(): ExecutionAdapterCapabilities;
  preflight(intent: ExecutionIntent): Promise<ExecutionPreflightResult>;
  submit(intent: ExecutionIntent): Promise<ExecutionOrder>;
  cancel(request: ExecutionCancelRequest): Promise<ExecutionOrder>;
  replace?(request: ExecutionReplaceRequest): Promise<ExecutionOrder>;
  getOrder(clientOrderId: string): Promise<ExecutionOrder | undefined>;
  listOpenOrders(): Promise<ExecutionOrder[]>;
}
