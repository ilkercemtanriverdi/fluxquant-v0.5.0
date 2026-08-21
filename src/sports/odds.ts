import type { FairOutcomeProbability, OutcomeOdds } from './types.js';

const EPS = 1e-12;

function assertOdds(quotes: OutcomeOdds[]): void {
  if (quotes.length < 2) throw new Error('SPORTS_MARKET_REQUIRES_AT_LEAST_TWO_OUTCOMES');
  const seen = new Set<string>();
  for (const quote of quotes) {
    if (!quote.outcome.trim()) throw new Error('SPORTS_OUTCOME_EMPTY');
    if (seen.has(quote.outcome)) throw new Error(`SPORTS_DUPLICATE_OUTCOME:${quote.outcome}`);
    seen.add(quote.outcome);
    if (!Number.isFinite(quote.decimalOdds) || quote.decimalOdds <= 1) {
      throw new Error(`SPORTS_INVALID_DECIMAL_ODDS:${quote.outcome}`);
    }
  }
}

export function impliedProbability(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) throw new Error('SPORTS_INVALID_DECIMAL_ODDS');
  return 1 / decimalOdds;
}

export function marketOverround(quotes: OutcomeOdds[]): number {
  assertOdds(quotes);
  return quotes.reduce((sum, quote) => sum + impliedProbability(quote.decimalOdds), 0) - 1;
}

export function removeVigProportional(quotes: OutcomeOdds[]): FairOutcomeProbability[] {
  assertOdds(quotes);
  const raw = quotes.map((quote) => ({ outcome: quote.outcome, probability: impliedProbability(quote.decimalOdds) }));
  const total = raw.reduce((sum, item) => sum + item.probability, 0);
  if (!(total > EPS)) throw new Error('SPORTS_INVALID_IMPLIED_PROBABILITY_SUM');
  return raw.map((item) => ({ outcome: item.outcome, probability: item.probability / total }));
}

/**
 * Power-method vig removal. Finds k such that sum(rawProbability^k)=1.
 * Falls back to proportional normalization if numerical bracketing is impossible.
 */
export function removeVigPower(quotes: OutcomeOdds[]): FairOutcomeProbability[] {
  assertOdds(quotes);
  const raw = quotes.map((quote) => ({ outcome: quote.outcome, probability: impliedProbability(quote.decimalOdds) }));
  const objective = (k: number): number => raw.reduce((sum, item) => sum + item.probability ** k, 0) - 1;

  let lo = 0.01;
  let hi = 20;
  let fLo = objective(lo);
  let fHi = objective(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return removeVigProportional(quotes);

  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    const fMid = objective(mid);
    if (Math.abs(fMid) < 1e-13) {
      lo = mid;
      hi = mid;
      break;
    }
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  const k = (lo + hi) / 2;
  const adjusted = raw.map((item) => ({ outcome: item.outcome, probability: item.probability ** k }));
  const total = adjusted.reduce((sum, item) => sum + item.probability, 0);
  if (!(total > EPS) || !Number.isFinite(total)) return removeVigProportional(quotes);
  return adjusted.map((item) => ({ outcome: item.outcome, probability: item.probability / total }));
}
