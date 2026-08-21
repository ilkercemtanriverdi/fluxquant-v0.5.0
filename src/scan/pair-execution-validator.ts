import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';
import { assessPairArbitrage } from '../strategy/edge-engine.js';
import { calculatePlatformTakerFeeUsd } from '../shadow/taker-fill.js';

export interface PairExecutionValidationOptions {
  fallbackPlatformFeeRate?: number;
  shares?: number;
  minLockedReturnOnCost?: number;
  freshnessMs?: number;
  latenciesMs?: readonly number[];
  slippagePerLeg?: readonly number[];
  oneFillPerMarket?: boolean;
  /** Historical top-only synthetic books are not executable-depth evidence. Default false. */
  allowTopOnlyHistorical?: boolean;
  /** Historical stress assumptions only; live paper/live gates must use CLOB metadata. */
  assumedMinOrderSize?: number;
  assumedTickSize?: number;
  requireMarketRules?: boolean;
}

export interface PairDetectionAttempt {
  attemptId: number;
  conditionId: string;
  marketId: string;
  detectedAtMs: number;
  sourceEventTimeMs: number;
  upAsk: number;
  downAsk: number;
  upAgeMs: number;
  downAgeMs: number;
  quoteSkewMs: number;
  lockedReturnOnCost: number;
  lockedPnlUsd: number;
}

export type PairExecutionRejectReason =
  | 'ALREADY_FILLED_MARKET'
  | 'EXPIRED'
  | 'MISSING_BOOK'
  | 'FEE_UNKNOWN'
  | 'STALE_QUOTE'
  | 'QUOTE_SKEW'
  | 'INSUFFICIENT_DEPTH'
  | 'UNTRUSTED_DEPTH'
  | 'MARKET_RULES_UNKNOWN'
  | 'BELOW_MIN_ORDER'
  | 'EDGE_DECAYED';

export interface PairExecutionCheck {
  attemptId: number;
  conditionId: string;
  marketId: string;
  latencyMs: number;
  slippagePerLeg: number;
  targetTimeMs: number;
  executed: boolean;
  rejectReason?: PairExecutionRejectReason;
  upAsk?: number;
  downAsk?: number;
  stressedUpPrice?: number;
  stressedDownPrice?: number;
  upAgeMs?: number;
  downAgeMs?: number;
  quoteSkewMs?: number;
  cashCostUsd?: number;
  lockedPnlUsd?: number;
  lockedReturnOnCost?: number;
}

export interface PairExecutionScenarioSummary {
  latencyMs: number;
  slippagePerLeg: number;
  candidateAttempts: number;
  executionChecks: number;
  executed: number;
  uniqueMarketsExecuted: number;
  rejected: Record<PairExecutionRejectReason, number>;
  cashCostUsd: number;
  lockedPnlUsd: number;
  roi: number;
  medianLockedReturnOnCost: number;
  worstLockedReturnOnCost: number;
  bestLockedReturnOnCost: number;
}

export interface PairExecutionValidationReport {
  mode: 'RESEARCH_ONLY_RECEIVED_TIME_PAIR_VALIDATION';
  shares: number;
  minLockedReturnOnCost: number;
  fallbackPlatformFeeRate?: number;
  freshnessMs: number;
  latenciesMs: number[];
  slippagePerLeg: number[];
  oneFillPerMarket: boolean;
  marketsEligible: number;
  eventsAccepted: number;
  staleArrivalDrops: number;
  topOnlyHistoricalEvents: number;
  reconstructedL2Events: number;
  liveL2Events: number;
  evidenceClass: 'LIVE_L2' | 'HISTORICAL_RECONSTRUCTED_L2' | 'TOP_ONLY_UNTRUSTED' | 'MIXED_OR_UNKNOWN';
  assumedMinOrderSize?: number;
  assumedTickSize?: number;
  requireMarketRules: boolean;
  detectionAttempts: PairDetectionAttempt[];
  scenarios: PairExecutionScenarioSummary[];
  checks: PairExecutionCheck[];
  warnings: string[];
}

interface TokenBinding {
  conditionId: string;
  outcome: 'UP' | 'DOWN';
}

interface MarketState {
  market: DiscoveredPolymarketMarket;
  up: PolymarketTokenMetadata;
  down: PolymarketTokenMetadata;
  upBook: PolymarketL2Book;
  downBook: PolymarketL2Book;
  lastUpSourceTimeMs?: number;
  lastDownSourceTimeMs?: number;
  upEvidence?: 'LIVE_L2' | 'RECONSTRUCTED_L2' | 'TOP_ONLY' | 'UNKNOWN';
  downEvidence?: 'LIVE_L2' | 'RECONSTRUCTED_L2' | 'TOP_ONLY' | 'UNKNOWN';
}

interface PendingLatencyCheck {
  attempt: PairDetectionAttempt;
  targetTimeMs: number;
  latencyMs: number;
}

interface BaseExecutionState {
  ok: boolean;
  rejectReason?: Exclude<PairExecutionRejectReason, 'ALREADY_FILLED_MARKET' | 'EDGE_DECAYED'>;
  upAsk?: number;
  downAsk?: number;
  upAgeMs?: number;
  downAgeMs?: number;
  quoteSkewMs?: number;
  upFee?: number;
  downFee?: number;
  tickSize?: number;
  minOrderSize?: number;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function normalizedList(values: readonly number[] | undefined, fallback: readonly number[], name: string): number[] {
  const source = values ?? fallback;
  const result = [...new Set(source.map((v) => finiteNonNegative(v, name)))].sort((a, b) => a - b);
  if (result.length === 0) throw new Error(`${name} requires at least one value`);
  return result;
}

function feeRate(token: PolymarketTokenMetadata, fallback?: number): number | undefined {
  return token.platformFeeRate ?? fallback;
}

function rawFlag(event: MarketEvent, name: string): boolean {
  if (!event.raw || typeof event.raw !== 'object') return false;
  return (event.raw as Record<string, unknown>)[name] === true;
}

function isTopOnlyHistorical(event: MarketEvent): boolean {
  return rawFlag(event, 'historical_top_only');
}

function isReconstructedHistoricalL2(event: MarketEvent): boolean {
  return rawFlag(event, 'historical_l2_reconstructed');
}

function evidenceOf(event: MarketEvent): 'LIVE_L2' | 'RECONSTRUCTED_L2' | 'TOP_ONLY' | 'UNKNOWN' {
  if (isTopOnlyHistorical(event)) return 'TOP_ONLY';
  if (isReconstructedHistoricalL2(event)) return 'RECONSTRUCTED_L2';
  if (event.kind === 'book' || event.kind === 'price_change') return 'LIVE_L2';
  return 'UNKNOWN';
}

function marketRule(marketValue: number | undefined, tokenValues: readonly (number | undefined)[], assumed: number | undefined): number | undefined {
  if (marketValue !== undefined) return marketValue;
  for (const value of tokenValues) if (value !== undefined) return value;
  return assumed;
}

function ceilToTick(price: number, tickSize: number | undefined): number {
  if (tickSize === undefined) return Math.min(1, price);
  const steps = Math.ceil((price - 1e-12) / tickSize);
  const rounded = Number((steps * tickSize).toFixed(12));
  return Math.min(1, Math.max(0, rounded));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function scenarioKey(latencyMs: number, slippagePerLeg: number): string {
  return `${latencyMs}|${slippagePerLeg}`;
}

function emptyRejects(): Record<PairExecutionRejectReason, number> {
  return {
    ALREADY_FILLED_MARKET: 0,
    EXPIRED: 0,
    MISSING_BOOK: 0,
    FEE_UNKNOWN: 0,
    STALE_QUOTE: 0,
    QUOTE_SKEW: 0,
    INSUFFICIENT_DEPTH: 0,
    UNTRUSTED_DEPTH: 0,
    MARKET_RULES_UNKNOWN: 0,
    BELOW_MIN_ORDER: 0,
    EDGE_DECAYED: 0,
  };
}

export class PairExecutionValidator {
  private readonly shares: number;
  private readonly minLockedReturnOnCost: number;
  private readonly fallbackPlatformFeeRate?: number;
  private readonly freshnessMs: number;
  private readonly latenciesMs: number[];
  private readonly slippagePerLeg: number[];
  private readonly oneFillPerMarket: boolean;
  private readonly allowTopOnlyHistorical: boolean;
  private readonly assumedMinOrderSize?: number;
  private readonly assumedTickSize?: number;
  private readonly requireMarketRules: boolean;
  private readonly bindings = new Map<string, TokenBinding>();
  private readonly states = new Map<string, MarketState>();
  private readonly inOpportunity = new Map<string, boolean>();
  private readonly attempts: PairDetectionAttempt[] = [];
  private readonly checks: PairExecutionCheck[] = [];
  private readonly pending: PendingLatencyCheck[] = [];
  private readonly filledByScenario = new Map<string, Set<string>>();
  private readonly scenarioReturns = new Map<string, number[]>();
  private readonly scenarioCash = new Map<string, number>();
  private readonly scenarioPnl = new Map<string, number>();
  private readonly scenarioExecuted = new Map<string, number>();
  private readonly scenarioChecks = new Map<string, number>();
  private readonly scenarioRejected = new Map<string, Record<PairExecutionRejectReason, number>>();
  private acceptedEvents = 0;
  private staleArrivalDrops = 0;
  private topOnlyHistoricalEvents = 0;
  private reconstructedL2Events = 0;
  private liveL2Events = 0;
  private nextAttemptId = 1;
  private currentClockMs = Number.NEGATIVE_INFINITY;

  constructor(markets: readonly DiscoveredPolymarketMarket[], options: PairExecutionValidationOptions = {}) {
    this.shares = finitePositive(options.shares ?? 1, 'shares');
    this.minLockedReturnOnCost = finiteNonNegative(options.minLockedReturnOnCost ?? 0.015, 'minLockedReturnOnCost');
    this.freshnessMs = Math.round(finitePositive(options.freshnessMs ?? 500, 'freshnessMs'));
    this.latenciesMs = normalizedList(options.latenciesMs, [0, 50, 100, 150, 250], 'latency');
    this.slippagePerLeg = normalizedList(options.slippagePerLeg, [0, 0.005, 0.01, 0.02], 'slippage');
    this.oneFillPerMarket = options.oneFillPerMarket ?? true;
    this.allowTopOnlyHistorical = options.allowTopOnlyHistorical ?? false;
    this.requireMarketRules = options.requireMarketRules ?? false;
    if (options.assumedMinOrderSize !== undefined) this.assumedMinOrderSize = finitePositive(options.assumedMinOrderSize, 'assumedMinOrderSize');
    if (options.assumedTickSize !== undefined) this.assumedTickSize = finitePositive(options.assumedTickSize, 'assumedTickSize');
    if (options.fallbackPlatformFeeRate !== undefined) {
      this.fallbackPlatformFeeRate = finiteNonNegative(options.fallbackPlatformFeeRate, 'fallbackPlatformFeeRate');
    }

    for (const market of markets) {
      const up = market.tokens.find((token) => token.outcome.toUpperCase() === 'UP');
      const down = market.tokens.find((token) => token.outcome.toUpperCase() === 'DOWN');
      if (!up || !down) continue;
      this.states.set(market.conditionId, {
        market,
        up,
        down,
        upBook: new PolymarketL2Book(up.tokenId),
        downBook: new PolymarketL2Book(down.tokenId),
      });
      this.bindings.set(up.tokenId, { conditionId: market.conditionId, outcome: 'UP' });
      this.bindings.set(down.tokenId, { conditionId: market.conditionId, outcome: 'DOWN' });
      this.inOpportunity.set(market.conditionId, false);
    }

    for (const latencyMs of this.latenciesMs) {
      for (const slippage of this.slippagePerLeg) {
        const key = scenarioKey(latencyMs, slippage);
        this.filledByScenario.set(key, new Set<string>());
        this.scenarioReturns.set(key, []);
        this.scenarioCash.set(key, 0);
        this.scenarioPnl.set(key, 0);
        this.scenarioExecuted.set(key, 0);
        this.scenarioChecks.set(key, 0);
        this.scenarioRejected.set(key, emptyRejects());
      }
    }
  }

  /**
   * Apply all events received at the same wall-clock timestamp as one coherent
   * batch. This avoids creating transient opportunities from line ordering
   * inside the same received-time millisecond.
   */
  applyReceivedBatch(receivedTimeMs: number, events: readonly MarketEvent[]): void {
    if (!Number.isFinite(receivedTimeMs)) throw new Error('receivedTimeMs must be finite');
    if (receivedTimeMs < this.currentClockMs) throw new Error('RECEIVED_TIME_ORDER_VIOLATION');

    this.flushPendingBefore(receivedTimeMs);
    const touched = new Set<string>();

    // Only depth-bearing L2 events can change executable pair state. Best-bid/ask,
    // trade and status messages must never refresh L2 quote age or create a phantom
    // executable opportunity without visible size.
    for (const event of events) {
      if (event.venue !== 'polymarket' || (event.kind !== 'book' && event.kind !== 'price_change')) continue;
      const binding = this.bindings.get(event.instrument);
      if (binding) touched.add(binding.conditionId);
    }
    for (const conditionId of touched) {
      if (!this.detectableAt(conditionId, receivedTimeMs)) this.inOpportunity.set(conditionId, false);
    }

    for (const event of events) {
      if (event.venue !== 'polymarket') continue;
      const binding = this.bindings.get(event.instrument);
      if (!binding) continue;
      const state = this.states.get(binding.conditionId);
      if (!state) continue;
      if (event.receivedTimeMs !== receivedTimeMs) throw new Error('BATCH_RECEIVED_TIME_MISMATCH');
      if (state.market.startTimeMs !== undefined && event.eventTimeMs < state.market.startTimeMs) continue;
      if (event.eventTimeMs > state.market.expiryTimeMs) continue;

      if (event.rawType === 'tick_size_change' && event.raw && typeof event.raw === 'object') {
        const raw = event.raw as Record<string, unknown>;
        const newTick = Number(raw.new_tick_size);
        if (Number.isFinite(newTick) && newTick > 0) {
          state.market.tickSize = newTick;
          state.up.tickSize = newTick;
          state.down.tickSize = newTick;
        }
        this.acceptedEvents += 1;
        continue;
      }

      // Non-depth messages are useful telemetry, but not executable-size evidence.
      if (event.kind !== 'book' && event.kind !== 'price_change') {
        this.acceptedEvents += 1;
        continue;
      }

      const priorSourceTime = binding.outcome === 'UP' ? state.lastUpSourceTimeMs : state.lastDownSourceTimeMs;
      if (priorSourceTime !== undefined && event.eventTimeMs < priorSourceTime) {
        this.staleArrivalDrops += 1;
        continue;
      }

      const evidence = evidenceOf(event);
      if (binding.outcome === 'UP') {
        state.upBook.apply(event);
        state.lastUpSourceTimeMs = event.eventTimeMs;
        state.upEvidence = evidence;
      } else {
        state.downBook.apply(event);
        state.lastDownSourceTimeMs = event.eventTimeMs;
        state.downEvidence = evidence;
      }
      this.acceptedEvents += 1;
      if (evidence === 'TOP_ONLY') this.topOnlyHistoricalEvents += 1;
      else if (evidence === 'RECONSTRUCTED_L2') this.reconstructedL2Events += 1;
      else if (evidence === 'LIVE_L2') this.liveL2Events += 1;
    }

    this.currentClockMs = receivedTimeMs;
    this.flushPendingAt(receivedTimeMs);

    for (const conditionId of touched) {
      const detection = this.detectionAt(conditionId, receivedTimeMs);
      if (!detection) {
        this.inOpportunity.set(conditionId, false);
        continue;
      }
      if (this.inOpportunity.get(conditionId)) continue;
      this.inOpportunity.set(conditionId, true);
      this.attempts.push(detection);
      for (const latencyMs of this.latenciesMs) {
        const targetTimeMs = receivedTimeMs + latencyMs;
        if (latencyMs === 0) this.evaluateLatency(detection, latencyMs, targetTimeMs);
        else this.pending.push({ attempt: detection, latencyMs, targetTimeMs });
      }
    }

    this.pending.sort((a, b) => a.targetTimeMs - b.targetTimeMs || a.attempt.attemptId - b.attempt.attemptId);
  }

  finish(): PairExecutionValidationReport {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!next) break;
      this.evaluateLatency(next.attempt, next.latencyMs, next.targetTimeMs);
      this.pending.shift();
    }

    const scenarios: PairExecutionScenarioSummary[] = [];
    for (const latencyMs of this.latenciesMs) {
      for (const slippage of this.slippagePerLeg) {
        const key = scenarioKey(latencyMs, slippage);
        const returns = this.scenarioReturns.get(key) ?? [];
        const pnl = this.scenarioPnl.get(key) ?? 0;
        const cash = this.scenarioCash.get(key) ?? 0;
        scenarios.push({
          latencyMs,
          slippagePerLeg: slippage,
          candidateAttempts: this.attempts.length,
          executionChecks: this.scenarioChecks.get(key) ?? 0,
          executed: this.scenarioExecuted.get(key) ?? 0,
          uniqueMarketsExecuted: this.filledByScenario.get(key)?.size ?? 0,
          rejected: { ...(this.scenarioRejected.get(key) ?? emptyRejects()) },
          cashCostUsd: cash,
          lockedPnlUsd: pnl,
          roi: cash > 0 ? pnl / cash : 0,
          medianLockedReturnOnCost: median(returns),
          worstLockedReturnOnCost: returns.length > 0 ? Math.min(...returns) : 0,
          bestLockedReturnOnCost: returns.length > 0 ? Math.max(...returns) : 0,
        });
      }
    }

    return {
      mode: 'RESEARCH_ONLY_RECEIVED_TIME_PAIR_VALIDATION',
      shares: this.shares,
      minLockedReturnOnCost: this.minLockedReturnOnCost,
      fallbackPlatformFeeRate: this.fallbackPlatformFeeRate,
      freshnessMs: this.freshnessMs,
      latenciesMs: [...this.latenciesMs],
      slippagePerLeg: [...this.slippagePerLeg],
      oneFillPerMarket: this.oneFillPerMarket,
      marketsEligible: this.states.size,
      eventsAccepted: this.acceptedEvents,
      staleArrivalDrops: this.staleArrivalDrops,
      topOnlyHistoricalEvents: this.topOnlyHistoricalEvents,
      reconstructedL2Events: this.reconstructedL2Events,
      liveL2Events: this.liveL2Events,
      evidenceClass: this.liveL2Events > 0 && this.reconstructedL2Events === 0 && this.topOnlyHistoricalEvents === 0
        ? 'LIVE_L2'
        : this.reconstructedL2Events > 0 && this.liveL2Events === 0 && this.topOnlyHistoricalEvents === 0
          ? 'HISTORICAL_RECONSTRUCTED_L2'
          : this.topOnlyHistoricalEvents > 0 && this.liveL2Events === 0 && this.reconstructedL2Events === 0
            ? 'TOP_ONLY_UNTRUSTED'
            : 'MIXED_OR_UNKNOWN',
      assumedMinOrderSize: this.assumedMinOrderSize,
      assumedTickSize: this.assumedTickSize,
      requireMarketRules: this.requireMarketRules,
      detectionAttempts: [...this.attempts],
      scenarios,
      checks: [...this.checks],
      warnings: [
        'Historical top-only synthetic depth is rejected by default and cannot establish executable fill evidence.',
        'Reconstructed OpenMarket L2 uses recorder raw_json snapshots + level deltas; it is stronger historical evidence but still not live fill/queue proof.',
        'Slippage is a stress surcharge per leg; historical matching priority and exchange processing cannot be reconstructed.',
        'Batch submission of two orders is not assumed atomic; live-money approval requires separate live paper evidence and leg-risk validation.',
        'Historical mos/mts assumptions, when supplied, are stress assumptions only; live gates must query current CLOB market info.',
      ],
    };
  }

  private flushPendingBefore(nowMs: number): void {
    while (this.pending.length > 0 && (this.pending[0]?.targetTimeMs ?? Infinity) < nowMs) {
      const next = this.pending.shift();
      if (!next) break;
      this.evaluateLatency(next.attempt, next.latencyMs, next.targetTimeMs);
    }
  }

  private flushPendingAt(nowMs: number): void {
    while (this.pending.length > 0 && (this.pending[0]?.targetTimeMs ?? Infinity) === nowMs) {
      const next = this.pending.shift();
      if (!next) break;
      this.evaluateLatency(next.attempt, next.latencyMs, next.targetTimeMs);
    }
  }

  private detectionAt(conditionId: string, nowMs: number): PairDetectionAttempt | null {
    const state = this.states.get(conditionId);
    if (!state) return null;
    const base = this.baseExecutionState(state, nowMs);
    if (!base.ok || base.upFee === undefined || base.downFee === undefined) return null;
    const pair = assessPairArbitrage(state.upBook, state.downBook, this.shares, base.upFee, base.downFee);
    if (!pair.executable || pair.lockedReturnOnCost < this.minLockedReturnOnCost) return null;
    return {
      attemptId: this.nextAttemptId++,
      conditionId,
      marketId: state.market.marketId,
      detectedAtMs: nowMs,
      sourceEventTimeMs: Math.max(state.lastUpSourceTimeMs ?? 0, state.lastDownSourceTimeMs ?? 0),
      upAsk: base.upAsk ?? 0,
      downAsk: base.downAsk ?? 0,
      upAgeMs: base.upAgeMs ?? 0,
      downAgeMs: base.downAgeMs ?? 0,
      quoteSkewMs: base.quoteSkewMs ?? 0,
      lockedReturnOnCost: pair.lockedReturnOnCost,
      lockedPnlUsd: pair.lockedPnlUsd,
    };
  }

  private detectableAt(conditionId: string, nowMs: number): boolean {
    const state = this.states.get(conditionId);
    if (!state) return false;
    const base = this.baseExecutionState(state, nowMs);
    if (!base.ok || base.upFee === undefined || base.downFee === undefined) return false;
    const pair = assessPairArbitrage(state.upBook, state.downBook, this.shares, base.upFee, base.downFee);
    return pair.executable && pair.lockedReturnOnCost >= this.minLockedReturnOnCost;
  }

  private baseExecutionState(state: MarketState, nowMs: number): BaseExecutionState {
    if (nowMs > state.market.expiryTimeMs) return { ok: false, rejectReason: 'EXPIRED' };
    const upTime = state.lastUpSourceTimeMs;
    const downTime = state.lastDownSourceTimeMs;
    const upTop = state.upBook.top();
    const downTop = state.downBook.top();
    if (upTime === undefined || downTime === undefined || !upTop.ask || !downTop.ask) {
      return { ok: false, rejectReason: 'MISSING_BOOK' };
    }
    if (!this.allowTopOnlyHistorical && (state.upEvidence === 'TOP_ONLY' || state.downEvidence === 'TOP_ONLY')) {
      return { ok: false, rejectReason: 'UNTRUSTED_DEPTH' };
    }
    const minOrderSize = marketRule(state.market.minOrderSize, [state.up.minOrderSize, state.down.minOrderSize], this.assumedMinOrderSize);
    const tickSize = marketRule(state.market.tickSize, [state.up.tickSize, state.down.tickSize], this.assumedTickSize);
    if (this.requireMarketRules && (minOrderSize === undefined || tickSize === undefined)) {
      return { ok: false, rejectReason: 'MARKET_RULES_UNKNOWN' };
    }
    if (minOrderSize !== undefined && this.shares + 1e-12 < minOrderSize) {
      return { ok: false, rejectReason: 'BELOW_MIN_ORDER', minOrderSize, tickSize };
    }
    const upFee = feeRate(state.up, this.fallbackPlatformFeeRate);
    const downFee = feeRate(state.down, this.fallbackPlatformFeeRate);
    if (upFee === undefined || downFee === undefined) return { ok: false, rejectReason: 'FEE_UNKNOWN' };
    const upAgeMs = Math.max(0, nowMs - upTime);
    const downAgeMs = Math.max(0, nowMs - downTime);
    const quoteSkewMs = Math.abs(upTime - downTime);
    if (upAgeMs > this.freshnessMs || downAgeMs > this.freshnessMs) {
      return { ok: false, rejectReason: 'STALE_QUOTE', upAgeMs, downAgeMs, quoteSkewMs, upAsk: upTop.ask.price, downAsk: downTop.ask.price, upFee, downFee, tickSize, minOrderSize };
    }
    if (quoteSkewMs > this.freshnessMs) {
      return { ok: false, rejectReason: 'QUOTE_SKEW', upAgeMs, downAgeMs, quoteSkewMs, upAsk: upTop.ask.price, downAsk: downTop.ask.price, upFee, downFee, tickSize, minOrderSize };
    }
    if (upTop.ask.size + 1e-12 < this.shares || downTop.ask.size + 1e-12 < this.shares) {
      return { ok: false, rejectReason: 'INSUFFICIENT_DEPTH', upAgeMs, downAgeMs, quoteSkewMs, upAsk: upTop.ask.price, downAsk: downTop.ask.price, upFee, downFee, tickSize, minOrderSize };
    }
    return { ok: true, upAgeMs, downAgeMs, quoteSkewMs, upAsk: upTop.ask.price, downAsk: downTop.ask.price, upFee, downFee, tickSize, minOrderSize };
  }

  private evaluateLatency(attempt: PairDetectionAttempt, latencyMs: number, targetTimeMs: number): void {
    const state = this.states.get(attempt.conditionId);
    if (!state) return;
    const base = this.baseExecutionState(state, targetTimeMs);

    for (const slippage of this.slippagePerLeg) {
      const key = scenarioKey(latencyMs, slippage);
      this.scenarioChecks.set(key, (this.scenarioChecks.get(key) ?? 0) + 1);
      const filled = this.filledByScenario.get(key) ?? new Set<string>();
      const rejects = this.scenarioRejected.get(key) ?? emptyRejects();

      if (this.oneFillPerMarket && filled.has(attempt.conditionId)) {
        rejects.ALREADY_FILLED_MARKET += 1;
        this.scenarioRejected.set(key, rejects);
        this.checks.push({
          attemptId: attempt.attemptId, conditionId: attempt.conditionId, marketId: attempt.marketId,
          latencyMs, slippagePerLeg: slippage, targetTimeMs, executed: false, rejectReason: 'ALREADY_FILLED_MARKET',
        });
        continue;
      }

      if (!base.ok || base.upFee === undefined || base.downFee === undefined || base.upAsk === undefined || base.downAsk === undefined) {
        const reason = base.rejectReason ?? 'MISSING_BOOK';
        rejects[reason] += 1;
        this.scenarioRejected.set(key, rejects);
        this.checks.push({
          attemptId: attempt.attemptId, conditionId: attempt.conditionId, marketId: attempt.marketId,
          latencyMs, slippagePerLeg: slippage, targetTimeMs, executed: false, rejectReason: reason,
          upAsk: base.upAsk, downAsk: base.downAsk, upAgeMs: base.upAgeMs, downAgeMs: base.downAgeMs, quoteSkewMs: base.quoteSkewMs,
        });
        continue;
      }

      const upPrice = ceilToTick(base.upAsk + slippage, base.tickSize);
      const downPrice = ceilToTick(base.downAsk + slippage, base.tickSize);
      const upFeeUsd = calculatePlatformTakerFeeUsd(this.shares, upPrice, base.upFee);
      const downFeeUsd = calculatePlatformTakerFeeUsd(this.shares, downPrice, base.downFee);
      const cashCostUsd = this.shares * upPrice + upFeeUsd + this.shares * downPrice + downFeeUsd;
      const lockedPnlUsd = this.shares - cashCostUsd;
      const lockedReturnOnCost = cashCostUsd > 0 ? lockedPnlUsd / cashCostUsd : Number.NEGATIVE_INFINITY;

      if (lockedReturnOnCost < this.minLockedReturnOnCost) {
        rejects.EDGE_DECAYED += 1;
        this.scenarioRejected.set(key, rejects);
        this.checks.push({
          attemptId: attempt.attemptId, conditionId: attempt.conditionId, marketId: attempt.marketId,
          latencyMs, slippagePerLeg: slippage, targetTimeMs, executed: false, rejectReason: 'EDGE_DECAYED',
          upAsk: base.upAsk, downAsk: base.downAsk, stressedUpPrice: upPrice, stressedDownPrice: downPrice,
          upAgeMs: base.upAgeMs, downAgeMs: base.downAgeMs, quoteSkewMs: base.quoteSkewMs,
          cashCostUsd, lockedPnlUsd, lockedReturnOnCost,
        });
        continue;
      }

      filled.add(attempt.conditionId);
      this.filledByScenario.set(key, filled);
      this.scenarioExecuted.set(key, (this.scenarioExecuted.get(key) ?? 0) + 1);
      this.scenarioCash.set(key, (this.scenarioCash.get(key) ?? 0) + cashCostUsd);
      this.scenarioPnl.set(key, (this.scenarioPnl.get(key) ?? 0) + lockedPnlUsd);
      const returns = this.scenarioReturns.get(key) ?? [];
      returns.push(lockedReturnOnCost);
      this.scenarioReturns.set(key, returns);
      this.checks.push({
        attemptId: attempt.attemptId, conditionId: attempt.conditionId, marketId: attempt.marketId,
        latencyMs, slippagePerLeg: slippage, targetTimeMs, executed: true,
        upAsk: base.upAsk, downAsk: base.downAsk, stressedUpPrice: upPrice, stressedDownPrice: downPrice,
        upAgeMs: base.upAgeMs, downAgeMs: base.downAgeMs, quoteSkewMs: base.quoteSkewMs,
        cashCostUsd, lockedPnlUsd, lockedReturnOnCost,
      });
    }
  }
}
