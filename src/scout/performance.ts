import type { HorizonPerformance, ScoutObservation, ScoutPerformanceLabel } from './types.js';

export const DEFAULT_SCOUT_HORIZONS_MS = [5 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;

function pctChange(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined || start <= 0) return undefined;
  return ((end / start) - 1) * 100;
}

export function labelScoutPerformance(
  observations: readonly ScoutObservation[],
  horizonsMs: readonly number[] = DEFAULT_SCOUT_HORIZONS_MS,
  toleranceRatio = 0.20,
): ScoutPerformanceLabel | undefined {
  if (observations.length === 0) return undefined;
  const sorted = [...observations].sort((a, b) => a.observedAtMs - b.observedAtMs);
  const first = sorted[0];
  if (!first) return undefined;
  const label: ScoutPerformanceLabel = {
    chain: first.chain,
    tokenAddress: first.tokenAddress,
    firstObservedAtMs: first.observedAtMs,
    firstPriceUsd: first.priceUsd,
    firstLiquidityUsd: first.liquidityUsd,
    horizons: [],
  };

  for (const horizonMs of horizonsMs) {
    const target = first.observedAtMs + horizonMs;
    const tolerance = horizonMs * toleranceRatio;
    const candidates = sorted.filter((x) => x.observedAtMs >= target - tolerance && x.observedAtMs <= target + tolerance);
    const closest = candidates.sort((a, b) => Math.abs(a.observedAtMs - target) - Math.abs(b.observedAtMs - target))[0];
    const beforeOrAt = sorted.filter((x) => x.observedAtMs <= (closest?.observedAtMs ?? target));
    let peak = first.priceUsd;
    let maxDrawdownPct: number | undefined;
    if (first.priceUsd !== undefined) {
      maxDrawdownPct = 0;
      for (const obs of beforeOrAt) {
        if (obs.priceUsd === undefined || obs.priceUsd <= 0) continue;
        peak = Math.max(peak ?? obs.priceUsd, obs.priceUsd);
        const dd = peak > 0 ? ((obs.priceUsd / peak) - 1) * 100 : 0;
        maxDrawdownPct = Math.min(maxDrawdownPct, dd);
      }
    }
    const row: HorizonPerformance = {
      horizonMs,
      returnPct: pctChange(first.priceUsd, closest?.priceUsd),
      maxDrawdownPct,
      liquidityChangePct: pctChange(first.liquidityUsd, closest?.liquidityUsd),
      observedAtMs: closest?.observedAtMs,
    };
    label.horizons.push(row);
  }
  return label;
}
