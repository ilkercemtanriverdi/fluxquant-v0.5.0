import type { UpDownDatasetRow } from '../dataset/updown-dataset.js';
import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';
import { buildShortHorizonMarketDefinitions, ShortHorizonFeatureState } from '../features/short-horizon.js';
import {
  calibrateProbability,
  predictLogisticProbability,
  type LogisticModel,
  type PlattCalibrator,
} from '../model/logistic.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';
import { BinaryInventory, type BinaryOutcome } from '../portfolio/binary-inventory.js';
import { simulateTakerFill } from './taker-fill.js';
import { assessDirectionalBuyEdge, assessPairArbitrage } from '../strategy/edge-engine.js';
import { planBuyOnlyExposureAdjustment } from '../strategy/inventory-planner.js';

export interface ShadowProbabilityArtifact {
  model: LogisticModel;
  calibrator: PlattCalibrator;
}

export type ShadowStrategy = 'model' | 'market-control' | 'pair-arb';
export type ShadowTradeRole = 'DIRECTIONAL_ENTRY' | 'SEQUENTIAL_HEDGE' | 'PAIR_ARB_LEG';

export interface ShadowReplayOptions {
  decisionSecondsToExpiry?: number[];
  minExpectedReturn?: number;
  targetExposureShares?: number;
  maxAdjustmentShares?: number;
  probeShares?: number;
  maxBinanceBookAgeMs?: number;
  maxPolymarketBookAgeMs?: number;
  maxCrossOutcomeQuoteSkewMs?: number;
  strategy?: ShadowStrategy;
  conditionAllowlist?: ReadonlySet<string>;
  /** Explicit research-only fee-rate assumption when historical metadata has no fee curve. No default. */
  fallbackPlatformFeeRate?: number;
}

export interface ShadowTradeRecord {
  conditionId: string;
  observationTimeMs: number;
  secondsToExpiry: number;
  outcome: BinaryOutcome;
  shares: number;
  averagePrice: number;
  feeUsd: number;
  cashCostUsd: number;
  probabilityUp: number;
  expectedReturn: number;
  targetSignedExposure: number;
  strategy: ShadowStrategy;
  tradeRole: ShadowTradeRole;
  upBookAgeMs: number;
  downBookAgeMs: number;
  crossOutcomeQuoteSkewMs: number;
  pairAllInCostUsd?: number;
  pairLockedPnlUsd?: number;
  pairLockedReturnOnCost?: number;
}

export interface ShadowDecisionRecord {
  conditionId: string;
  observationTimeMs: number;
  secondsToExpiry: number;
  probabilityUp?: number;
  upExpectedReturn?: number;
  downExpectedReturn?: number;
  upBookAgeMs?: number;
  downBookAgeMs?: number;
  crossOutcomeQuoteSkewMs?: number;
  pairAllInCostUsd?: number;
  pairLockedReturnOnCost?: number;
  action: 'BUY_UP' | 'BUY_DOWN' | 'BUY_PAIR' | 'HOLD' | 'SKIP';
  reason: string;
}

export interface ShadowMarketResult {
  conditionId: string;
  marketId: string;
  expiryTimeMs: number;
  resolvedOutcome?: BinaryOutcome;
  decisions: number;
  trades: number;
  feesUsd: number;
  cashCostUsd: number;
  settlementUsd?: number;
  pnlUsd?: number;
  roiOnCost?: number;
  inventory: ReturnType<BinaryInventory['snapshot']>;
}

export interface ShadowDailyResult {
  date: string;
  markets: number;
  trades: number;
  feesUsd: number;
  cashCostUsd: number;
  settlementUsd: number;
  pnlUsd: number;
}

export interface ShadowReplayReport {
  summary: {
    marketsEligible: number;
    marketsSettled: number;
    decisions: number;
    trades: number;
    skippedDecisions: number;
    feesUsd: number;
    cashCostUsd: number;
    settlementUsd: number;
    netPnlUsd: number;
    roiOnCost: number;
    maxCumulativeDrawdownUsd: number;
    strategy: ShadowStrategy;
    quotePolicy: {
      maxBinanceBookAgeMs: number;
      maxPolymarketBookAgeMs: number;
      maxCrossOutcomeQuoteSkewMs: number;
    };
    skippedMissingBinanceFrame: number;
    skippedMissingPolymarketFrame: number;
    skippedStaleBinance: number;
    skippedStalePolymarket: number;
    skippedCrossOutcomeSkew: number;
    directionalEntryTrades: number;
    sequentialHedgeTrades: number;
    pairArbLegTrades: number;
  };
  markets: ShadowMarketResult[];
  daily: ShadowDailyResult[];
  decisions: ShadowDecisionRecord[];
  trades: ShadowTradeRecord[];
}

interface ScheduledDecision {
  conditionId: string;
  targetTimeMs: number;
  secondsToExpiry: number;
}

function normalizedResolvedOutcome(value: unknown): BinaryOutcome | undefined {
  const upper = String(value ?? '').trim().toUpperCase();
  if (upper === 'UP' || upper === 'HIGHER' || upper === 'YES') return 'UP';
  if (upper === 'DOWN' || upper === 'LOWER' || upper === 'NO') return 'DOWN';
  return undefined;
}

function dummyRow(frame: UpDownDatasetRow['frame']): UpDownDatasetRow {
  return {
    frame,
    label: 0,
    labelSource: 'binance_proxy',
    referenceStartPrice: 0,
    referenceEndPrice: 0,
    labelMoveBps: 0,
    sampleBucketSeconds: Math.max(1, Math.round(frame.secondsToExpiry)),
  };
}

function feeRate(token: PolymarketTokenMetadata, fallback: number | undefined): number | undefined {
  return token.platformFeeRate ?? fallback;
}

function utcDate(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

export function runShadowReplay(
  events: readonly MarketEvent[],
  markets: readonly DiscoveredPolymarketMarket[],
  artifact: ShadowProbabilityArtifact | undefined,
  options: ShadowReplayOptions = {},
): ShadowReplayReport {
  const decisionBuckets = [...new Set(options.decisionSecondsToExpiry ?? [120, 60, 30, 15])]
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => b - a);
  const minExpectedReturn = options.minExpectedReturn ?? 0.015;
  const targetExposureShares = options.targetExposureShares ?? 1;
  const maxAdjustmentShares = options.maxAdjustmentShares ?? 1;
  const probeShares = options.probeShares ?? Math.min(1, maxAdjustmentShares);
  const maxBinanceBookAgeMs = options.maxBinanceBookAgeMs ?? 2_000;
  const maxPolymarketBookAgeMs = options.maxPolymarketBookAgeMs ?? 5_000;
  const maxCrossOutcomeQuoteSkewMs = options.maxCrossOutcomeQuoteSkewMs ?? maxPolymarketBookAgeMs;
  const strategy = options.strategy ?? 'model';
  if (strategy === 'model' && !artifact) throw new Error('MODEL_ARTIFACT_REQUIRED: model strategy requires a trained probability artifact.');

  const tokens = markets.flatMap((market) => market.tokens ?? []);
  const featureState = new ShortHorizonFeatureState(tokens);
  const definitions = buildShortHorizonMarketDefinitions(tokens);
  const marketByCondition = new Map(markets.map((market) => [market.conditionId, market]));
  const books = new Map<string, PolymarketL2Book>();
  for (const token of tokens) books.set(token.tokenId, new PolymarketL2Book(token.tokenId));
  const inventories = new Map<string, BinaryInventory>();
  const decisions: ShadowDecisionRecord[] = [];
  const trades: ShadowTradeRecord[] = [];

  const schedule: ScheduledDecision[] = [];
  for (const def of definitions.values()) {
    if (options.conditionAllowlist && !options.conditionAllowlist.has(def.conditionId)) continue;
    for (const secondsToExpiry of decisionBuckets) {
      const targetTimeMs = def.expiryTimeMs - secondsToExpiry * 1000;
      if (def.startTimeMs !== undefined && targetTimeMs < def.startTimeMs) continue;
      schedule.push({ conditionId: def.conditionId, targetTimeMs, secondsToExpiry });
    }
  }
  schedule.sort((a, b) => a.targetTimeMs - b.targetTimeMs || a.conditionId.localeCompare(b.conditionId));

  const executeDecision = (scheduled: ScheduledDecision) => {
    const def = definitions.get(scheduled.conditionId);
    if (!def) return;
    const quoteFrame = featureState.quoteFrameForMarket(scheduled.conditionId, scheduled.targetTimeMs);
    if (!quoteFrame) {
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        action: 'SKIP',
        reason: 'POLYMARKET_QUOTE_FRAME_UNAVAILABLE',
      });
      return;
    }

    const quoteDiagnostics = {
      upBookAgeMs: quoteFrame.upBookAgeMs,
      downBookAgeMs: quoteFrame.downBookAgeMs,
      crossOutcomeQuoteSkewMs: quoteFrame.crossOutcomeQuoteSkewMs,
    };
    if (quoteFrame.upBookAgeMs > maxPolymarketBookAgeMs || quoteFrame.downBookAgeMs > maxPolymarketBookAgeMs) {
      decisions.push({ ...scheduled, observationTimeMs: scheduled.targetTimeMs, ...quoteDiagnostics, action: 'SKIP', reason: 'STALE_POLYMARKET_QUOTE' });
      return;
    }
    if (quoteFrame.crossOutcomeQuoteSkewMs > maxCrossOutcomeQuoteSkewMs) {
      decisions.push({ ...scheduled, observationTimeMs: scheduled.targetTimeMs, ...quoteDiagnostics, action: 'SKIP', reason: 'CROSS_OUTCOME_QUOTE_SKEW' });
      return;
    }

    let probabilityUp: number;
    if (strategy === 'model') {
      const frame = featureState.frameForMarket(scheduled.conditionId, scheduled.targetTimeMs);
      if (!frame) {
        decisions.push({
          ...scheduled,
          observationTimeMs: scheduled.targetTimeMs,
          ...quoteDiagnostics,
          action: 'SKIP',
          reason: 'BINANCE_FEATURE_FRAME_UNAVAILABLE',
        });
        return;
      }
      if (frame.binanceBookAgeMs > maxBinanceBookAgeMs) {
        decisions.push({
          ...scheduled,
          observationTimeMs: scheduled.targetTimeMs,
          ...quoteDiagnostics,
          action: 'SKIP',
          reason: 'STALE_BINANCE_QUOTE',
        });
        return;
      }
      const rawP = predictLogisticProbability(artifact!.model, dummyRow(frame));
      probabilityUp = calibrateProbability(artifact!.calibrator, rawP);
    } else {
      probabilityUp = quoteFrame.normalizedUpMid;
    }

    const upBook = books.get(def.up.tokenId);
    const downBook = books.get(def.down.tokenId);
    if (!upBook || !downBook) return;
    const upFee = feeRate(def.up, options.fallbackPlatformFeeRate);
    const downFee = feeRate(def.down, options.fallbackPlatformFeeRate);
    if (upFee === undefined || downFee === undefined) {
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        probabilityUp,
        ...quoteDiagnostics,
        action: 'SKIP',
        reason: 'FEE_RATE_UNKNOWN: supply explicit historical fee assumption or fee metadata',
      });
      return;
    }

    const pair = assessPairArbitrage(upBook, downBook, probeShares, upFee, downFee);
    const pairDiagnostics = pair.executable ? {
      pairAllInCostUsd: pair.totalCashCostUsd,
      pairLockedReturnOnCost: pair.lockedReturnOnCost,
    } : {};

    const inventory = inventories.get(def.conditionId) ?? new BinaryInventory();
    inventories.set(def.conditionId, inventory);

    if (strategy === 'pair-arb') {
      const currentPairs = inventory.snapshot().hedgedPairs;
      const remainingPairShares = Math.max(0, targetExposureShares - currentPairs);
      const pairShares = Math.min(remainingPairShares, maxAdjustmentShares, probeShares);
      if (pairShares <= 1e-12) {
        decisions.push({
          ...scheduled,
          observationTimeMs: scheduled.targetTimeMs,
          probabilityUp,
          ...quoteDiagnostics,
          ...pairDiagnostics,
          action: 'HOLD',
          reason: 'pair target already satisfied',
        });
        return;
      }
      const executablePair = assessPairArbitrage(upBook, downBook, pairShares, upFee, downFee);
      if (!executablePair.executable || executablePair.lockedReturnOnCost < minExpectedReturn) {
        decisions.push({
          ...scheduled,
          observationTimeMs: scheduled.targetTimeMs,
          probabilityUp,
          ...quoteDiagnostics,
          ...pairDiagnostics,
          action: 'HOLD',
          reason: 'no synchronous fee/depth-adjusted pair edge above threshold',
        });
        return;
      }
      const pairMeta = {
        pairAllInCostUsd: executablePair.totalCashCostUsd,
        pairLockedPnlUsd: executablePair.lockedPnlUsd,
        pairLockedReturnOnCost: executablePair.lockedReturnOnCost,
      };
      const pairLegs: Array<[BinaryOutcome, typeof executablePair.upFill]> = [
        ['UP', executablePair.upFill],
        ['DOWN', executablePair.downFill],
      ];
      for (const [outcome, fill] of pairLegs) {
        if (!fill.complete || fill.averagePrice === undefined) throw new Error('pair assessment/fill invariant violated');
        inventory.buy(outcome, fill.filledShares, fill.averagePrice, fill.platformFeeUsd);
        trades.push({
          conditionId: def.conditionId,
          observationTimeMs: scheduled.targetTimeMs,
          secondsToExpiry: scheduled.secondsToExpiry,
          outcome,
          shares: fill.filledShares,
          averagePrice: fill.averagePrice,
          feeUsd: fill.platformFeeUsd,
          cashCostUsd: fill.netCashUsd,
          probabilityUp,
          expectedReturn: executablePair.lockedReturnOnCost,
          targetSignedExposure: 0,
          strategy,
          tradeRole: 'PAIR_ARB_LEG',
          ...quoteDiagnostics,
          ...pairMeta,
        });
      }
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        probabilityUp,
        ...quoteDiagnostics,
        ...pairMeta,
        action: 'BUY_PAIR',
        reason: 'synchronous complementary pair locks positive fee/depth-adjusted return',
      });
      return;
    }

    let upEdge;
    let downEdge;
    try {
      upEdge = assessDirectionalBuyEdge(upBook, probabilityUp, probeShares, upFee);
      downEdge = assessDirectionalBuyEdge(downBook, 1 - probabilityUp, probeShares, downFee);
    } catch (error) {
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        probabilityUp,
        ...quoteDiagnostics,
        ...pairDiagnostics,
        action: 'SKIP',
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const upReturn = upEdge.expectedReturnOnCost;
    const downReturn = downEdge.expectedReturnOnCost;
    let targetSignedExposure = 0;
    if (upEdge.executable && upReturn >= minExpectedReturn && upReturn > downReturn) {
      targetSignedExposure = targetExposureShares;
    } else if (downEdge.executable && downReturn >= minExpectedReturn && downReturn > upReturn) {
      targetSignedExposure = -targetExposureShares;
    }

    const adjustment = planBuyOnlyExposureAdjustment(inventory.snapshot(), targetSignedExposure, maxAdjustmentShares);
    if (adjustment.action === 'HOLD' || !adjustment.outcome) {
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        probabilityUp,
        upExpectedReturn: upReturn,
        downExpectedReturn: downReturn,
        ...quoteDiagnostics,
        ...pairDiagnostics,
        action: 'HOLD',
        reason: targetSignedExposure === 0 ? 'no fee/depth-adjusted directional edge above threshold' : adjustment.reason,
      });
      return;
    }

    const outcome = adjustment.outcome;
    const selectedBook = outcome === 'UP' ? upBook : downBook;
    const selectedFee = outcome === 'UP' ? upFee : downFee;
    const selectedReturn = outcome === 'UP' ? upReturn : downReturn;
    const fill = simulateTakerFill(selectedBook, 'BUY', adjustment.shares, selectedFee);
    if (!fill.complete || fill.averagePrice === undefined) {
      decisions.push({
        ...scheduled,
        observationTimeMs: scheduled.targetTimeMs,
        probabilityUp,
        upExpectedReturn: upReturn,
        downExpectedReturn: downReturn,
        ...quoteDiagnostics,
        ...pairDiagnostics,
        action: 'SKIP',
        reason: 'visible depth insufficient for bounded shadow adjustment',
      });
      return;
    }

    const before = inventory.snapshot();
    const preTradeSignedExposure = before.up.quantity - before.down.quantity;
    const tradeRole: ShadowTradeRole = (outcome === 'UP' && preTradeSignedExposure < 0) || (outcome === 'DOWN' && preTradeSignedExposure > 0)
      ? 'SEQUENTIAL_HEDGE'
      : 'DIRECTIONAL_ENTRY';
    inventory.buy(outcome, fill.filledShares, fill.averagePrice, fill.platformFeeUsd);
    trades.push({
      conditionId: def.conditionId,
      observationTimeMs: scheduled.targetTimeMs,
      secondsToExpiry: scheduled.secondsToExpiry,
      outcome,
      shares: fill.filledShares,
      averagePrice: fill.averagePrice,
      feeUsd: fill.platformFeeUsd,
      cashCostUsd: fill.netCashUsd,
      probabilityUp,
      expectedReturn: selectedReturn,
      targetSignedExposure,
      strategy,
      tradeRole,
      ...quoteDiagnostics,
      ...(pair.executable ? {
        pairAllInCostUsd: pair.totalCashCostUsd,
        pairLockedPnlUsd: pair.lockedPnlUsd,
        pairLockedReturnOnCost: pair.lockedReturnOnCost,
      } : {}),
    });
    decisions.push({
      ...scheduled,
      observationTimeMs: scheduled.targetTimeMs,
      probabilityUp,
      upExpectedReturn: upReturn,
      downExpectedReturn: downReturn,
      ...quoteDiagnostics,
      ...pairDiagnostics,
      action: outcome === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      reason: adjustment.reason,
    });
  };

  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.eventTimeMs - b.event.eventTimeMs || a.event.receivedTimeMs - b.event.receivedTimeMs || a.index - b.index);
  let scheduleIndex = 0;
  const finalizeUntil = (timeMs: number, inclusive: boolean) => {
    while (scheduleIndex < schedule.length) {
      const scheduled = schedule[scheduleIndex];
      if (!scheduled) break;
      const due = inclusive ? scheduled.targetTimeMs <= timeMs : scheduled.targetTimeMs < timeMs;
      if (!due) break;
      executeDecision(scheduled);
      scheduleIndex += 1;
    }
  };

  let cursor = 0;
  while (cursor < ordered.length) {
    const eventTimeMs = ordered[cursor]?.event.eventTimeMs;
    if (eventTimeMs === undefined) break;
    finalizeUntil(eventTimeMs, false);
    while (cursor < ordered.length && ordered[cursor]?.event.eventTimeMs === eventTimeMs) {
      const event = ordered[cursor]?.event;
      if (event) {
        featureState.apply(event);
        books.get(event.instrument)?.apply(event);
      }
      cursor += 1;
    }
    finalizeUntil(eventTimeMs, true);
  }
  finalizeUntil(Number.POSITIVE_INFINITY, true);

  const marketResults: ShadowMarketResult[] = [];
  for (const def of definitions.values()) {
    if (options.conditionAllowlist && !options.conditionAllowlist.has(def.conditionId)) continue;
    const market = marketByCondition.get(def.conditionId);
    const resolvedOutcome = normalizedResolvedOutcome(market?.resolvedOutcome);
    const inventory = inventories.get(def.conditionId) ?? new BinaryInventory();
    const snapshot = inventory.snapshot();
    const marketTrades = trades.filter((trade) => trade.conditionId === def.conditionId);
    const marketDecisions = decisions.filter((decision) => decision.conditionId === def.conditionId);
    const feesUsd = marketTrades.reduce((sum, trade) => sum + trade.feeUsd, 0);
    const cashCostUsd = snapshot.totalCostUsd;
    const settlementUsd = resolvedOutcome === 'UP'
      ? snapshot.settlementValueIfUpUsd
      : resolvedOutcome === 'DOWN'
        ? snapshot.settlementValueIfDownUsd
        : undefined;
    const pnlUsd = settlementUsd === undefined ? undefined : settlementUsd - cashCostUsd;
    marketResults.push({
      conditionId: def.conditionId,
      marketId: def.marketId,
      expiryTimeMs: def.expiryTimeMs,
      resolvedOutcome,
      decisions: marketDecisions.length,
      trades: marketTrades.length,
      feesUsd,
      cashCostUsd,
      settlementUsd,
      pnlUsd,
      roiOnCost: pnlUsd !== undefined && cashCostUsd > 0 ? pnlUsd / cashCostUsd : undefined,
      inventory: snapshot,
    });
  }
  marketResults.sort((a, b) => a.expiryTimeMs - b.expiryTimeMs || a.conditionId.localeCompare(b.conditionId));

  const settled = marketResults.filter((market) => market.pnlUsd !== undefined);
  const dailyMap = new Map<string, ShadowDailyResult>();
  for (const market of settled) {
    const date = utcDate(market.expiryTimeMs);
    const row = dailyMap.get(date) ?? { date, markets: 0, trades: 0, feesUsd: 0, cashCostUsd: 0, settlementUsd: 0, pnlUsd: 0 };
    row.markets += 1;
    row.trades += market.trades;
    row.feesUsd += market.feesUsd;
    row.cashCostUsd += market.cashCostUsd;
    row.settlementUsd += market.settlementUsd ?? 0;
    row.pnlUsd += market.pnlUsd ?? 0;
    dailyMap.set(date, row);
  }

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const market of settled) {
    cumulative += market.pnlUsd ?? 0;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  const cashCostUsd = settled.reduce((sum, market) => sum + market.cashCostUsd, 0);
  const settlementUsd = settled.reduce((sum, market) => sum + (market.settlementUsd ?? 0), 0);
  const feesUsd = settled.reduce((sum, market) => sum + market.feesUsd, 0);
  const netPnlUsd = settlementUsd - cashCostUsd;
  return {
    summary: {
      marketsEligible: marketResults.length,
      marketsSettled: settled.length,
      decisions: decisions.length,
      trades: trades.length,
      skippedDecisions: decisions.filter((decision) => decision.action === 'SKIP').length,
      feesUsd,
      cashCostUsd,
      settlementUsd,
      netPnlUsd,
      roiOnCost: cashCostUsd > 0 ? netPnlUsd / cashCostUsd : 0,
      maxCumulativeDrawdownUsd: maxDrawdown,
      strategy,
      quotePolicy: {
        maxBinanceBookAgeMs,
        maxPolymarketBookAgeMs,
        maxCrossOutcomeQuoteSkewMs,
      },
      skippedMissingBinanceFrame: decisions.filter((decision) => decision.reason === 'BINANCE_FEATURE_FRAME_UNAVAILABLE').length,
      skippedMissingPolymarketFrame: decisions.filter((decision) => decision.reason === 'POLYMARKET_QUOTE_FRAME_UNAVAILABLE').length,
      skippedStaleBinance: decisions.filter((decision) => decision.reason === 'STALE_BINANCE_QUOTE').length,
      skippedStalePolymarket: decisions.filter((decision) => decision.reason === 'STALE_POLYMARKET_QUOTE').length,
      skippedCrossOutcomeSkew: decisions.filter((decision) => decision.reason === 'CROSS_OUTCOME_QUOTE_SKEW').length,
      directionalEntryTrades: trades.filter((trade) => trade.tradeRole === 'DIRECTIONAL_ENTRY').length,
      sequentialHedgeTrades: trades.filter((trade) => trade.tradeRole === 'SEQUENTIAL_HEDGE').length,
      pairArbLegTrades: trades.filter((trade) => trade.tradeRole === 'PAIR_ARB_LEG').length,
    },
    markets: marketResults,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    decisions,
    trades,
  };
}
