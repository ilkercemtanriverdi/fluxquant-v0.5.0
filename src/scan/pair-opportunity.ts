import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';
import { assessPairArbitrage } from '../strategy/edge-engine.js';

export interface PairScanOptions {
  fallbackPlatformFeeRate?: number;
  shares?: number;
  minLockedReturnOnCost?: number;
  freshnessThresholdsMs?: readonly number[];
  latencyMilestonesMs?: readonly number[];
}

export interface PairOpportunityEpisode {
  conditionId: string;
  marketId: string;
  thresholdMs: number;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  bestLockedReturnOnCost: number;
  bestLockedPnlUsd: number;
  bestAllInCostUsd: number;
  bestUpAsk: number;
  bestDownAsk: number;
  bestQuoteSkewMs: number;
  bestUpAgeMs: number;
  bestDownAgeMs: number;
}

export interface PairThresholdSummary {
  thresholdMs: number;
  qualifyingSnapshots: number;
  episodes: number;
  uniqueMarkets: number;
  totalOpportunityMs: number;
  longestEpisodeMs: number;
  bestLockedReturnOnCost: number;
  bestLockedPnlUsd: number;
  survivesLatencyMs: Record<string, number>;
}

export interface PairOpportunityScanReport {
  mode: 'RESEARCH_ONLY_EVENT_DRIVEN_PAIR_SCAN';
  shares: number;
  minLockedReturnOnCost: number;
  fallbackPlatformFeeRate?: number;
  freshnessThresholdsMs: number[];
  latencyMilestonesMs: number[];
  eventsSeen: number;
  polymarketEventsSeen: number;
  relevantPolymarketEvents: number;
  marketsEligible: number;
  feeUnknownEvents: number;
  missingBookEvaluations: number;
  nonExecutableEvaluations: number;
  topOnlyHistoricalEvents: number;
  thresholds: PairThresholdSummary[];
  episodes: PairOpportunityEpisode[];
}

interface TokenBinding {
  market: DiscoveredPolymarketMarket;
  token: PolymarketTokenMetadata;
  outcome: 'UP' | 'DOWN';
}

interface MarketState {
  market: DiscoveredPolymarketMarket;
  up: PolymarketTokenMetadata;
  down: PolymarketTokenMetadata;
  upBook: PolymarketL2Book;
  downBook: PolymarketL2Book;
}

interface CandidateSnapshot {
  conditionId: string;
  marketId: string;
  nowMs: number;
  upAgeMs: number;
  downAgeMs: number;
  skewMs: number;
  upAsk: number;
  downAsk: number;
  allInCostUsd: number;
  lockedPnlUsd: number;
  lockedReturnOnCost: number;
  validUntilMs: number;
}

interface ActiveEpisode {
  conditionId: string;
  marketId: string;
  thresholdMs: number;
  startTimeMs: number;
  validUntilMs: number;
  best: CandidateSnapshot;
}

interface ThresholdAccumulator {
  thresholdMs: number;
  qualifyingSnapshots: number;
  markets: Set<string>;
  activeByCondition: Map<string, ActiveEpisode>;
  episodes: PairOpportunityEpisode[];
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function normalizedThresholds(values: readonly number[] | undefined): number[] {
  const input = values ?? [100, 250, 500, 1_000, 2_000];
  const result = [...new Set(input.map((value) => Math.round(positiveFinite(value, 'freshness threshold'))))]
    .sort((a, b) => a - b);
  if (result.length === 0) throw new Error('At least one freshness threshold is required');
  return result;
}

function normalizedMilestones(values: readonly number[] | undefined): number[] {
  const input = values ?? [100, 250, 500, 1_000];
  return [...new Set(input.map((value) => Math.round(nonNegativeFinite(value, 'latency milestone'))))]
    .sort((a, b) => a - b);
}

function feeRate(token: PolymarketTokenMetadata, fallback: number | undefined): number | undefined {
  return token.platformFeeRate ?? fallback;
}

function isTopOnlyHistorical(event: MarketEvent): boolean {
  if (!event.raw || typeof event.raw !== 'object') return false;
  return (event.raw as Record<string, unknown>).historical_top_only === true;
}

function buildStates(markets: readonly DiscoveredPolymarketMarket[]): {
  bindings: Map<string, TokenBinding>;
  states: Map<string, MarketState>;
} {
  const bindings = new Map<string, TokenBinding>();
  const states = new Map<string, MarketState>();

  for (const market of markets) {
    const up = market.tokens.find((token) => token.outcome.toUpperCase() === 'UP');
    const down = market.tokens.find((token) => token.outcome.toUpperCase() === 'DOWN');
    if (!up || !down) continue;
    states.set(market.conditionId, {
      market,
      up,
      down,
      upBook: new PolymarketL2Book(up.tokenId),
      downBook: new PolymarketL2Book(down.tokenId),
    });
    bindings.set(up.tokenId, { market, token: up, outcome: 'UP' });
    bindings.set(down.tokenId, { market, token: down, outcome: 'DOWN' });
  }
  return { bindings, states };
}

function betterSnapshot(a: CandidateSnapshot, b: CandidateSnapshot): CandidateSnapshot {
  return b.lockedReturnOnCost > a.lockedReturnOnCost ? b : a;
}

function closeEpisode(acc: ThresholdAccumulator, conditionId: string, endTimeMs: number): void {
  const active = acc.activeByCondition.get(conditionId);
  if (!active) return;
  const boundedEnd = Math.max(active.startTimeMs, Math.min(endTimeMs, active.validUntilMs));
  const best = active.best;
  acc.episodes.push({
    conditionId: active.conditionId,
    marketId: active.marketId,
    thresholdMs: active.thresholdMs,
    startTimeMs: active.startTimeMs,
    endTimeMs: boundedEnd,
    durationMs: boundedEnd - active.startTimeMs,
    bestLockedReturnOnCost: best.lockedReturnOnCost,
    bestLockedPnlUsd: best.lockedPnlUsd,
    bestAllInCostUsd: best.allInCostUsd,
    bestUpAsk: best.upAsk,
    bestDownAsk: best.downAsk,
    bestQuoteSkewMs: best.skewMs,
    bestUpAgeMs: best.upAgeMs,
    bestDownAgeMs: best.downAgeMs,
  });
  acc.activeByCondition.delete(conditionId);
}

function expireBefore(acc: ThresholdAccumulator, conditionId: string, nowMs: number): void {
  const active = acc.activeByCondition.get(conditionId);
  if (active && nowMs > active.validUntilMs) closeEpisode(acc, conditionId, active.validUntilMs);
}

function updateThreshold(
  acc: ThresholdAccumulator,
  snapshot: CandidateSnapshot | null,
  conditionId: string,
  nowMs: number,
): void {
  expireBefore(acc, conditionId, nowMs);
  const active = acc.activeByCondition.get(conditionId);

  if (!snapshot || snapshot.upAgeMs > acc.thresholdMs || snapshot.downAgeMs > acc.thresholdMs || snapshot.skewMs > acc.thresholdMs) {
    if (active) closeEpisode(acc, conditionId, nowMs);
    return;
  }

  acc.qualifyingSnapshots += 1;
  acc.markets.add(conditionId);
  const thresholdValidUntil = Math.min(
    snapshot.validUntilMs,
    snapshot.nowMs + Math.max(0, acc.thresholdMs - Math.max(snapshot.upAgeMs, snapshot.downAgeMs)),
  );

  if (active) {
    active.validUntilMs = Math.max(active.validUntilMs, thresholdValidUntil);
    active.best = betterSnapshot(active.best, snapshot);
    return;
  }

  acc.activeByCondition.set(conditionId, {
    conditionId,
    marketId: snapshot.marketId,
    thresholdMs: acc.thresholdMs,
    startTimeMs: nowMs,
    validUntilMs: thresholdValidUntil,
    best: snapshot,
  });
}

function evaluateCandidate(
  state: MarketState,
  nowMs: number,
  shares: number,
  fallbackPlatformFeeRate: number | undefined,
  minLockedReturnOnCost: number,
): { snapshot: CandidateSnapshot | null; feeUnknown: boolean; missingBook: boolean; nonExecutable: boolean } {
  const upTime = state.upBook.eventTimeMs();
  const downTime = state.downBook.eventTimeMs();
  const upTop = state.upBook.top();
  const downTop = state.downBook.top();
  if (upTime === undefined || downTime === undefined || !upTop.ask || !downTop.ask) {
    return { snapshot: null, feeUnknown: false, missingBook: true, nonExecutable: false };
  }

  const upFee = feeRate(state.up, fallbackPlatformFeeRate);
  const downFee = feeRate(state.down, fallbackPlatformFeeRate);
  if (upFee === undefined || downFee === undefined) {
    return { snapshot: null, feeUnknown: true, missingBook: false, nonExecutable: false };
  }

  const pair = assessPairArbitrage(state.upBook, state.downBook, shares, upFee, downFee);
  if (!pair.executable) {
    return { snapshot: null, feeUnknown: false, missingBook: false, nonExecutable: true };
  }
  if (pair.lockedReturnOnCost < minLockedReturnOnCost) {
    return { snapshot: null, feeUnknown: false, missingBook: false, nonExecutable: false };
  }

  const upAgeMs = Math.max(0, nowMs - upTime);
  const downAgeMs = Math.max(0, nowMs - downTime);
  const skewMs = Math.abs(upTime - downTime);
  return {
    snapshot: {
      conditionId: state.market.conditionId,
      marketId: state.market.marketId,
      nowMs,
      upAgeMs,
      downAgeMs,
      skewMs,
      upAsk: upTop.ask.price,
      downAsk: downTop.ask.price,
      allInCostUsd: pair.totalCashCostUsd,
      lockedPnlUsd: pair.lockedPnlUsd,
      lockedReturnOnCost: pair.lockedReturnOnCost,
      validUntilMs: state.market.expiryTimeMs,
    },
    feeUnknown: false,
    missingBook: false,
    nonExecutable: false,
  };
}

export class PairOpportunityScanner {
  private readonly shares: number;
  private readonly minLockedReturnOnCost: number;
  private readonly freshnessThresholdsMs: number[];
  private readonly latencyMilestonesMs: number[];
  private readonly fallbackPlatformFeeRate?: number;
  private readonly bindings: Map<string, TokenBinding>;
  private readonly states: Map<string, MarketState>;
  private readonly thresholds: ThresholdAccumulator[];
  private lastEventTimeMs = Number.NEGATIVE_INFINITY;
  private eventsSeen = 0;
  private polymarketEventsSeen = 0;
  private relevantPolymarketEvents = 0;
  private feeUnknownEvents = 0;
  private missingBookEvaluations = 0;
  private nonExecutableEvaluations = 0;
  private topOnlyHistoricalEvents = 0;

  constructor(markets: readonly DiscoveredPolymarketMarket[], options: PairScanOptions = {}) {
    this.shares = positiveFinite(options.shares ?? 1, 'shares');
    this.minLockedReturnOnCost = nonNegativeFinite(options.minLockedReturnOnCost ?? 0.015, 'minLockedReturnOnCost');
    this.freshnessThresholdsMs = normalizedThresholds(options.freshnessThresholdsMs);
    this.latencyMilestonesMs = normalizedMilestones(options.latencyMilestonesMs);
    if (options.fallbackPlatformFeeRate !== undefined) {
      this.fallbackPlatformFeeRate = nonNegativeFinite(options.fallbackPlatformFeeRate, 'fallbackPlatformFeeRate');
    }
    const built = buildStates(markets);
    this.bindings = built.bindings;
    this.states = built.states;
    this.thresholds = this.freshnessThresholdsMs.map((thresholdMs) => ({
      thresholdMs,
      qualifyingSnapshots: 0,
      markets: new Set<string>(),
      activeByCondition: new Map<string, ActiveEpisode>(),
      episodes: [],
    }));
  }

  apply(event: MarketEvent): void {
    this.eventsSeen += 1;
    if (event.eventTimeMs < this.lastEventTimeMs) {
      throw new Error(`EVENT_ORDER_VIOLATION: ${event.eventTimeMs} < ${this.lastEventTimeMs}`);
    }
    this.lastEventTimeMs = event.eventTimeMs;
    if (event.venue !== 'polymarket') return;
    this.polymarketEventsSeen += 1;
    if (isTopOnlyHistorical(event)) this.topOnlyHistoricalEvents += 1;

    const binding = this.bindings.get(event.instrument);
    if (!binding) return;
    const state = this.states.get(binding.market.conditionId);
    if (!state) return;
    if (state.market.startTimeMs !== undefined && event.eventTimeMs < state.market.startTimeMs) return;
    if (event.eventTimeMs > state.market.expiryTimeMs) {
      for (const acc of this.thresholds) closeEpisode(acc, state.market.conditionId, state.market.expiryTimeMs);
      return;
    }

    this.relevantPolymarketEvents += 1;
    for (const acc of this.thresholds) expireBefore(acc, state.market.conditionId, event.eventTimeMs);

    if (binding.outcome === 'UP') state.upBook.apply(event);
    else state.downBook.apply(event);

    const evaluated = evaluateCandidate(
      state,
      event.eventTimeMs,
      this.shares,
      this.fallbackPlatformFeeRate,
      this.minLockedReturnOnCost,
    );
    if (evaluated.feeUnknown) this.feeUnknownEvents += 1;
    if (evaluated.missingBook) this.missingBookEvaluations += 1;
    if (evaluated.nonExecutable) this.nonExecutableEvaluations += 1;

    for (const acc of this.thresholds) {
      updateThreshold(acc, evaluated.snapshot, state.market.conditionId, event.eventTimeMs);
    }
  }

  finish(): PairOpportunityScanReport {
    for (const state of this.states.values()) {
      for (const acc of this.thresholds) {
        const active = acc.activeByCondition.get(state.market.conditionId);
        if (active) closeEpisode(acc, state.market.conditionId, Math.min(active.validUntilMs, state.market.expiryTimeMs));
      }
    }

    const allEpisodes = this.thresholds.flatMap((acc) => acc.episodes);
    const thresholdSummaries = this.thresholds.map((acc): PairThresholdSummary => {
      const episodes = acc.episodes;
      const best = episodes.reduce<PairOpportunityEpisode | undefined>((current, episode) => (
        !current || episode.bestLockedReturnOnCost > current.bestLockedReturnOnCost ? episode : current
      ), undefined);
      const survivesLatencyMs: Record<string, number> = {};
      for (const milestone of this.latencyMilestonesMs) {
        survivesLatencyMs[String(milestone)] = episodes.filter((episode) => episode.durationMs >= milestone).length;
      }
      return {
        thresholdMs: acc.thresholdMs,
        qualifyingSnapshots: acc.qualifyingSnapshots,
        episodes: episodes.length,
        uniqueMarkets: acc.markets.size,
        totalOpportunityMs: episodes.reduce((sum, episode) => sum + episode.durationMs, 0),
        longestEpisodeMs: episodes.reduce((max, episode) => Math.max(max, episode.durationMs), 0),
        bestLockedReturnOnCost: best?.bestLockedReturnOnCost ?? 0,
        bestLockedPnlUsd: best?.bestLockedPnlUsd ?? 0,
        survivesLatencyMs,
      };
    });

    return {
      mode: 'RESEARCH_ONLY_EVENT_DRIVEN_PAIR_SCAN',
      shares: this.shares,
      minLockedReturnOnCost: this.minLockedReturnOnCost,
      fallbackPlatformFeeRate: this.fallbackPlatformFeeRate,
      freshnessThresholdsMs: [...this.freshnessThresholdsMs],
      latencyMilestonesMs: [...this.latencyMilestonesMs],
      eventsSeen: this.eventsSeen,
      polymarketEventsSeen: this.polymarketEventsSeen,
      relevantPolymarketEvents: this.relevantPolymarketEvents,
      marketsEligible: this.states.size,
      feeUnknownEvents: this.feeUnknownEvents,
      missingBookEvaluations: this.missingBookEvaluations,
      nonExecutableEvaluations: this.nonExecutableEvaluations,
      topOnlyHistoricalEvents: this.topOnlyHistoricalEvents,
      thresholds: thresholdSummaries,
      episodes: allEpisodes.sort((a, b) => a.thresholdMs - b.thresholdMs || a.startTimeMs - b.startTimeMs || a.conditionId.localeCompare(b.conditionId)),
    };
  }
}
