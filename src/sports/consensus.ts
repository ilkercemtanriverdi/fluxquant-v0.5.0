import type { ConsensusOutcome, SportsConsensus, VenueFairMarket } from './types.js';

function finiteWeight(value: number | undefined): number {
  return value === undefined ? 1 : Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildSportsConsensus(markets: VenueFairMarket[], maxAgeMs = 5 * 60_000): SportsConsensus {
  if (markets.length === 0) throw new Error('SPORTS_CONSENSUS_NO_MARKETS');
  const newest = Math.max(...markets.map((market) => market.asOfMs));
  const fresh = markets.filter((market) => newest - market.asOfMs <= maxAgeMs && finiteWeight(market.weight) > 0);
  if (fresh.length === 0) throw new Error('SPORTS_CONSENSUS_NO_FRESH_MARKETS');

  const template = fresh[0];
  if (!template) throw new Error('SPORTS_CONSENSUS_NO_TEMPLATE');
  const compatible = fresh.filter((market) =>
    market.eventId === template.eventId &&
    market.marketId === template.marketId &&
    market.marketKind === template.marketKind &&
    market.line === template.line,
  );
  if (compatible.length === 0) throw new Error('SPORTS_CONSENSUS_NO_COMPATIBLE_MARKETS');

  const outcomeNames = [...new Set(compatible.flatMap((market) => market.outcomes.map((outcome) => outcome.outcome)))];
  const provisional: Array<{ outcome: string; mean: number; contributors: number; dispersion: number }> = [];

  for (const outcome of outcomeNames) {
    const points = compatible.flatMap((market) => {
      const value = market.outcomes.find((item) => item.outcome === outcome)?.probability;
      const weight = finiteWeight(market.weight);
      return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 && weight > 0
        ? [{ value, weight }]
        : [];
    });
    if (points.length === 0) continue;
    const weightSum = points.reduce((sum, point) => sum + point.weight, 0);
    const mean = points.reduce((sum, point) => sum + point.value * point.weight, 0) / weightSum;
    const variance = points.reduce((sum, point) => sum + point.weight * (point.value - mean) ** 2, 0) / weightSum;
    provisional.push({ outcome, mean, contributors: points.length, dispersion: Math.sqrt(Math.max(0, variance)) });
  }

  const probabilitySum = provisional.reduce((sum, item) => sum + item.mean, 0);
  if (!(probabilitySum > 0)) throw new Error('SPORTS_CONSENSUS_INVALID_PROBABILITY_SUM');

  const outcomes: ConsensusOutcome[] = provisional.map((item) => {
    const fairProbability = item.mean / probabilitySum;
    return {
      outcome: item.outcome,
      fairProbability,
      fairDecimalOdds: fairProbability > 0 ? 1 / fairProbability : Number.POSITIVE_INFINITY,
      contributors: item.contributors,
      dispersion: item.dispersion,
    };
  });

  return {
    eventId: template.eventId,
    marketId: template.marketId,
    marketKind: template.marketKind,
    line: template.line,
    asOfMs: newest,
    outcomes,
    sourceVenues: [...new Set(compatible.map((market) => market.venue))].sort(),
  };
}
