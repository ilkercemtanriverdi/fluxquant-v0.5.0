import { SportsPaperLedger, type PaperBetRequest } from '../sports/paper-ledger.js';
import { assertExecutionTransition, isTerminalExecutionStatus, validateExecutionIntent } from './lifecycle.js';
import type {
  ExecutionAdapter,
  ExecutionAdapterCapabilities,
  ExecutionCancelRequest,
  ExecutionIntent,
  ExecutionOrder,
  ExecutionPreflightResult,
  ExecutionReplaceRequest,
} from './types.js';

interface SportsExecutionMetadata {
  eventId: string;
  outcome: string;
  fairProbabilityAtEntry: number;
  winProfitMultiplier?: number;
  lossMultiplier?: number;
}

function metadata(intent: ExecutionIntent): SportsExecutionMetadata {
  const raw = intent.metadata ?? {};
  const eventId = raw.eventId;
  const outcome = raw.outcome;
  const fairProbabilityAtEntry = raw.fairProbabilityAtEntry;
  if (typeof eventId !== 'string' || !eventId.trim()) throw new Error('SPORTS_EXECUTION_EVENT_ID_REQUIRED');
  if (typeof outcome !== 'string' || !outcome.trim()) throw new Error('SPORTS_EXECUTION_OUTCOME_REQUIRED');
  if (typeof fairProbabilityAtEntry !== 'number' || !Number.isFinite(fairProbabilityAtEntry)) {
    throw new Error('SPORTS_EXECUTION_FAIR_PROBABILITY_REQUIRED');
  }
  const winProfitMultiplier = raw.winProfitMultiplier;
  const lossMultiplier = raw.lossMultiplier;
  if (winProfitMultiplier !== undefined && typeof winProfitMultiplier !== 'number') throw new Error('SPORTS_EXECUTION_WIN_MULTIPLIER_INVALID');
  if (lossMultiplier !== undefined && typeof lossMultiplier !== 'number') throw new Error('SPORTS_EXECUTION_LOSS_MULTIPLIER_INVALID');
  return { eventId, outcome, fairProbabilityAtEntry, winProfitMultiplier, lossMultiplier };
}

/**
 * Adapter over the existing deterministic SportsPaperLedger.
 * No network I/O and no live execution. A paper bet is modeled as immediately
 * accepted/filled at the requested decimal odds; settlement remains in the ledger.
 */
export class SportsPaperExecutionAdapter implements ExecutionAdapter {
  readonly mode = 'paper' as const;
  private readonly orders = new Map<string, ExecutionOrder>();

  constructor(
    readonly ledger: SportsPaperLedger,
    readonly minEdge = 0,
    readonly venue = 'sports-paper',
  ) {}

  capabilities(): ExecutionAdapterCapabilities {
    return {
      adapterId: 'fluxquant.sports.paper-ledger',
      venue: this.venue,
      markets: ['football'],
      modes: ['paper'],
      supportsMarketOrders: false,
      supportsLimitOrders: true,
      supportsReplace: false,
      supportsPartialCancel: false,
    };
  }

  async preflight(intent: ExecutionIntent): Promise<ExecutionPreflightResult> {
    try {
      validateExecutionIntent(intent);
      if (intent.market !== 'football') throw new Error('SPORTS_EXECUTION_MARKET_REQUIRED');
      if (intent.side !== 'BACK') throw new Error('SPORTS_EXECUTION_BACK_ONLY_V15');
      if (intent.orderType !== 'LIMIT') throw new Error('SPORTS_EXECUTION_LIMIT_ONLY_V15');
      if ((intent.limitPrice ?? 0) <= 1) throw new Error('SPORTS_EXECUTION_DECIMAL_ODDS_INVALID');
      metadata(intent);
      if (this.orders.has(intent.clientOrderId)) throw new Error(`SPORTS_EXECUTION_DUPLICATE_ORDER:${intent.clientOrderId}`);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async submit(intent: ExecutionIntent): Promise<ExecutionOrder> {
    const gate = await this.preflight(intent);
    if (!gate.accepted) throw new Error(`SPORTS_EXECUTION_PREFLIGHT_REJECTED:${gate.reason ?? 'UNKNOWN'}`);
    const meta = metadata(intent);
    const request: PaperBetRequest = {
      id: intent.clientOrderId,
      eventId: meta.eventId,
      marketId: intent.instrument,
      outcome: meta.outcome,
      venue: intent.venue,
      decimalOdds: intent.limitPrice!,
      fairProbabilityAtEntry: meta.fairProbabilityAtEntry,
      stakeUsd: intent.quantity,
      placedAtMs: intent.createdAtMs,
      ...(meta.winProfitMultiplier !== undefined ? { winProfitMultiplier: meta.winProfitMultiplier } : {}),
      ...(meta.lossMultiplier !== undefined ? { lossMultiplier: meta.lossMultiplier } : {}),
    };

    this.ledger.place(request, this.minEdge); // existing bankroll/open-risk/edge gates fail closed
    const pending: ExecutionOrder = {
      ...intent,
      status: 'PENDING',
      filledQuantity: 0,
      feesUsd: 0,
      lastUpdateMs: intent.createdAtMs,
    };
    assertExecutionTransition(pending.status, 'FILLED');
    const filled: ExecutionOrder = {
      ...pending,
      status: 'FILLED',
      filledQuantity: intent.quantity,
      averageFillPrice: intent.limitPrice,
      lastUpdateMs: intent.createdAtMs,
      rawStatus: 'SPORTS_PAPER_LEDGER_ACCEPTED',
    };
    this.orders.set(intent.clientOrderId, filled);
    return { ...filled };
  }

  async cancel(request: ExecutionCancelRequest): Promise<ExecutionOrder> {
    const current = this.orders.get(request.clientOrderId);
    if (!current) throw new Error(`SPORTS_EXECUTION_UNKNOWN_ORDER:${request.clientOrderId}`);
    throw new Error(`SPORTS_EXECUTION_CANCEL_UNSUPPORTED_AFTER_ACCEPT:${request.clientOrderId}`);
  }

  async replace(request: ExecutionReplaceRequest): Promise<ExecutionOrder> {
    const current = this.orders.get(request.clientOrderId);
    if (!current) throw new Error(`SPORTS_EXECUTION_UNKNOWN_ORDER:${request.clientOrderId}`);
    throw new Error(`SPORTS_EXECUTION_REPLACE_UNSUPPORTED:${request.clientOrderId}`);
  }

  async getOrder(clientOrderId: string): Promise<ExecutionOrder | undefined> {
    const order = this.orders.get(clientOrderId);
    return order ? { ...order } : undefined;
  }

  async listOpenOrders(): Promise<ExecutionOrder[]> {
    return [...this.orders.values()]
      .filter((order) => !isTerminalExecutionStatus(order.status))
      .map((order) => ({ ...order }));
  }
}
