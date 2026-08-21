export interface ClosingLineValue {
  takenDecimalOdds: number;
  closingFairProbability: number;
  closingFairDecimalOdds: number;
  expectedValueAtClose: number;
  clvPct: number;
  logClv: number;
}

export function closingLineValue(takenDecimalOdds: number, closingFairProbability: number): ClosingLineValue {
  if (!Number.isFinite(takenDecimalOdds) || takenDecimalOdds <= 1) throw new Error('SPORTS_INVALID_TAKEN_ODDS');
  if (!Number.isFinite(closingFairProbability) || closingFairProbability <= 0 || closingFairProbability >= 1) {
    throw new Error('SPORTS_INVALID_CLOSING_PROBABILITY');
  }
  const closingFairDecimalOdds = 1 / closingFairProbability;
  const ratio = takenDecimalOdds / closingFairDecimalOdds;
  return {
    takenDecimalOdds,
    closingFairProbability,
    closingFairDecimalOdds,
    expectedValueAtClose: takenDecimalOdds * closingFairProbability - 1,
    clvPct: ratio - 1,
    logClv: Math.log(ratio),
  };
}
