import type { MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';
import {
  ShortHorizonFeatureState,
  type ShortHorizonFeatureFrame,
  type ShortHorizonMarketDefinition,
} from '../features/short-horizon.js';

export type BinaryLabel = 0 | 1;
export type LabelSource = 'polymarket_resolution' | 'binance_proxy';

export interface UpDownDatasetRow {
  frame: ShortHorizonFeatureFrame;
  label: BinaryLabel;
  labelSource: LabelSource;
  referenceStartPrice?: number;
  referenceEndPrice?: number;
  labelMoveBps?: number;
  sampleBucketSeconds: number;
}

export interface UpDownDatasetBuildOptions {
  sampleSecondsToExpiry?: number[];
  maxBinanceBookAgeMs?: number;
  maxPolymarketBookAgeMs?: number;
  maxCrossOutcomeQuoteSkewMs?: number;
  labelPriceToleranceMs?: number;
  minAbsoluteLabelMoveBps?: number;
  resolvedOutcomeByCondition?: ReadonlyMap<string, 'UP' | 'DOWN'>;
}

export interface UpDownDatasetBuildResult {
  rows: UpDownDatasetRow[];
  stats: {
    marketsSeen: number;
    marketsLabeled: number;
    skippedMissingReferencePrice: number;
    skippedNearTie: number;
    framesAccepted: number;
    framesRejectedStale: number;
    framesRejectedSkew: number;
  };
}

interface TimedPrice {
  timeMs: number;
  price: number;
}

class ReferencePriceSeries {
  private readonly pointsByUnderlying = new Map<'BTC' | 'ETH', TimedPrice[]>();

  add(event: MarketEvent): void {
    if (event.venue !== 'binance' || event.kind !== 'best_bid_ask') return;
    if (event.bid === undefined || event.ask === undefined) return;
    const upper = event.instrument.toUpperCase();
    const underlying = upper.startsWith('BTC') ? 'BTC' : upper.startsWith('ETH') ? 'ETH' : null;
    if (!underlying) return;
    const mid = (event.bid + event.ask) / 2;
    if (!Number.isFinite(mid) || mid <= 0) return;
    const points = this.pointsByUnderlying.get(underlying) ?? [];
    points.push({ timeMs: event.eventTimeMs, price: mid });
    this.pointsByUnderlying.set(underlying, points);
  }

  atOrAfter(underlying: 'BTC' | 'ETH', timeMs: number, toleranceMs: number): TimedPrice | undefined {
    let best: TimedPrice | undefined;
    for (const point of this.pointsByUnderlying.get(underlying) ?? []) {
      const distance = point.timeMs - timeMs;
      if (distance < 0 || distance > toleranceMs) continue;
      if (!best || point.timeMs < best.timeMs) best = point;
    }
    return best;
  }

  atOrBefore(underlying: 'BTC' | 'ETH', timeMs: number, toleranceMs: number): TimedPrice | undefined {
    let best: TimedPrice | undefined;
    for (const point of this.pointsByUnderlying.get(underlying) ?? []) {
      const distance = timeMs - point.timeMs;
      if (distance < 0 || distance > toleranceMs) continue;
      if (!best || point.timeMs > best.timeMs) best = point;
    }
    return best;
  }
}

interface CandidateFrame {
  targetTimeMs: number;
  bucketSeconds: number;
  frame?: ShortHorizonFeatureFrame;
}

function metadataForState(metadata: Iterable<PolymarketTokenMetadata>): PolymarketTokenMetadata[] {
  return Array.isArray(metadata) ? metadata : [...metadata];
}

function withinStalenessLimits(
  frame: ShortHorizonFeatureFrame,
  maxBinanceBookAgeMs: number,
  maxPolymarketBookAgeMs: number,
): boolean {
  return (
    frame.binanceBookAgeMs <= maxBinanceBookAgeMs &&
    frame.upBookAgeMs <= maxPolymarketBookAgeMs &&
    frame.downBookAgeMs <= maxPolymarketBookAgeMs
  );
}

function marketStartTime(market: ShortHorizonMarketDefinition): number | undefined {
  return market.startTimeMs;
}

export function buildUpDownDataset(
  events: readonly MarketEvent[],
  metadata: Iterable<PolymarketTokenMetadata>,
  options: UpDownDatasetBuildOptions = {},
): UpDownDatasetBuildResult {
  const sampleSecondsToExpiry = [...new Set(options.sampleSecondsToExpiry ?? [240, 120, 60, 30, 15])]
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
  const maxBinanceBookAgeMs = options.maxBinanceBookAgeMs ?? 2_000;
  const maxPolymarketBookAgeMs = options.maxPolymarketBookAgeMs ?? 5_000;
  const maxCrossOutcomeQuoteSkewMs = options.maxCrossOutcomeQuoteSkewMs ?? maxPolymarketBookAgeMs;
  const labelPriceToleranceMs = options.labelPriceToleranceMs ?? 5_000;
  const minAbsoluteLabelMoveBps = options.minAbsoluteLabelMoveBps ?? 0.5;

  const tokens = metadataForState(metadata);
  const state = new ShortHorizonFeatureState(tokens);
  const reference = new ReferencePriceSeries();
  const candidates = new Map<string, CandidateFrame[]>();
  const schedule: Array<CandidateFrame & { conditionId: string }> = [];

  for (const market of state.marketDefinitions().values()) {
    const marketCandidates = sampleSecondsToExpiry
      .map((bucketSeconds) => ({
        targetTimeMs: market.expiryTimeMs - bucketSeconds * 1000,
        bucketSeconds,
      }))
      .filter((candidate) => market.startTimeMs === undefined || candidate.targetTimeMs >= market.startTimeMs);
    candidates.set(market.conditionId, marketCandidates);
    for (const candidate of marketCandidates) schedule.push({ ...candidate, conditionId: market.conditionId });
  }
  schedule.sort((a, b) => a.targetTimeMs - b.targetTimeMs || a.conditionId.localeCompare(b.conditionId));

  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) =>
      a.event.eventTimeMs - b.event.eventTimeMs ||
      a.event.receivedTimeMs - b.event.receivedTimeMs ||
      a.index - b.index,
    );

  let framesRejectedStale = 0;
  let framesRejectedSkew = 0;
  let scheduleIndex = 0;
  const finalizeUntil = (timeMs: number, inclusive: boolean) => {
    while (scheduleIndex < schedule.length) {
      const scheduled = schedule[scheduleIndex];
      if (!scheduled) break;
      const due = inclusive ? scheduled.targetTimeMs <= timeMs : scheduled.targetTimeMs < timeMs;
      if (!due) break;
      const frame = state.frameForMarket(scheduled.conditionId, scheduled.targetTimeMs);
      const original = (candidates.get(scheduled.conditionId) ?? []).find(
        (candidate) => candidate.bucketSeconds === scheduled.bucketSeconds,
      );
      if (frame && withinStalenessLimits(frame, maxBinanceBookAgeMs, maxPolymarketBookAgeMs)) {
        if (frame.crossOutcomeQuoteSkewMs <= maxCrossOutcomeQuoteSkewMs) {
          if (original) original.frame = frame;
        } else {
          framesRejectedSkew += 1;
        }
      } else if (frame) {
        framesRejectedStale += 1;
      }
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
        state.apply(event);
        reference.add(event);
      }
      cursor += 1;
    }
    finalizeUntil(eventTimeMs, true);
  }
  finalizeUntil(Number.POSITIVE_INFINITY, true);

  const rows: UpDownDatasetRow[] = [];
  let marketsLabeled = 0;
  let skippedMissingReferencePrice = 0;
  let skippedNearTie = 0;

  for (const market of state.marketDefinitions().values()) {
    const startTimeMs = marketStartTime(market);
    if (startTimeMs === undefined) {
      skippedMissingReferencePrice += 1;
      continue;
    }
    const authoritative = options.resolvedOutcomeByCondition?.get(market.conditionId);
    // Labels must be point-in-time safe: anchor the start at/after market open and
    // the end at/before expiry. Never use a post-expiry Binance tick to decide the label.
    const start = reference.atOrAfter(market.underlying, startTimeMs, labelPriceToleranceMs);
    const end = reference.atOrBefore(market.underlying, market.expiryTimeMs, labelPriceToleranceMs);

    let label: BinaryLabel;
    let labelSource: LabelSource;
    let moveBps: number | undefined;

    if (authoritative) {
      label = authoritative === 'UP' ? 1 : 0;
      labelSource = 'polymarket_resolution';
      if (start && end) moveBps = ((end.price / start.price) - 1) * 10_000;
    } else {
      if (!start || !end) {
        skippedMissingReferencePrice += 1;
        continue;
      }
      moveBps = ((end.price / start.price) - 1) * 10_000;
      if (Math.abs(moveBps) < minAbsoluteLabelMoveBps) {
        skippedNearTie += 1;
        continue;
      }
      label = end.price > start.price ? 1 : 0;
      labelSource = 'binance_proxy';
    }
    marketsLabeled += 1;

    for (const candidate of candidates.get(market.conditionId) ?? []) {
      if (!candidate.frame) continue;
      rows.push({
        frame: candidate.frame,
        label,
        labelSource,
        referenceStartPrice: start?.price,
        referenceEndPrice: end?.price,
        labelMoveBps: moveBps,
        sampleBucketSeconds: candidate.bucketSeconds,
      });
    }
  }

  rows.sort((a, b) =>
    a.frame.expiryTimeMs - b.frame.expiryTimeMs ||
    b.sampleBucketSeconds - a.sampleBucketSeconds,
  );

  return {
    rows,
    stats: {
      marketsSeen: state.marketDefinitions().size,
      marketsLabeled,
      skippedMissingReferencePrice,
      skippedNearTie,
      framesAccepted: rows.length,
      framesRejectedStale,
      framesRejectedSkew,
    },
  };
}

export interface DatasetSplit {
  train: UpDownDatasetRow[];
  validation: UpDownDatasetRow[];
  test: UpDownDatasetRow[];
  trainConditions: string[];
  validationConditions: string[];
  testConditions: string[];
}

export function splitDatasetChronologicallyByMarket(
  rows: readonly UpDownDatasetRow[],
  trainFraction = 0.6,
  validationFraction = 0.2,
): DatasetSplit {
  if (!(trainFraction > 0 && validationFraction > 0 && trainFraction + validationFraction < 1)) {
    throw new Error('trainFraction and validationFraction must be > 0 and sum to < 1');
  }

  const expiryByCondition = new Map<string, number>();
  for (const row of rows) {
    const previous = expiryByCondition.get(row.frame.conditionId);
    if (previous === undefined || row.frame.expiryTimeMs < previous) {
      expiryByCondition.set(row.frame.conditionId, row.frame.expiryTimeMs);
    }
  }
  const conditions = [...expiryByCondition]
    .sort((a, b) => a[1] - b[1])
    .map(([conditionId]) => conditionId);

  if (conditions.length < 3) {
    throw new Error('At least 3 distinct markets are required for train/validation/test splits.');
  }

  let trainCount = Math.max(1, Math.floor(conditions.length * trainFraction));
  let validationCount = Math.max(1, Math.floor(conditions.length * validationFraction));
  if (trainCount + validationCount >= conditions.length) {
    validationCount = 1;
    trainCount = conditions.length - 2;
  }

  const trainConditions = conditions.slice(0, trainCount);
  const validationConditions = conditions.slice(trainCount, trainCount + validationCount);
  const testConditions = conditions.slice(trainCount + validationCount);
  const trainSet = new Set(trainConditions);
  const validationSet = new Set(validationConditions);
  const testSet = new Set(testConditions);

  return {
    train: rows.filter((row) => trainSet.has(row.frame.conditionId)),
    validation: rows.filter((row) => validationSet.has(row.frame.conditionId)),
    test: rows.filter((row) => testSet.has(row.frame.conditionId)),
    trainConditions,
    validationConditions,
    testConditions,
  };
}
