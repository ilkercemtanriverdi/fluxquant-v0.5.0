import type { BinaryLabel } from '../dataset/updown-dataset.js';

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanPrediction: number;
  observedRate: number;
  absoluteGap: number;
}

export interface ProbabilityMetrics {
  count: number;
  brierScore: number;
  logLoss: number;
  accuracyAt50: number;
  expectedCalibrationError: number;
  calibration: CalibrationBin[];
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - 1e-12, Math.max(1e-12, p));
}

export function evaluateProbabilities(
  probabilities: readonly number[],
  labels: readonly BinaryLabel[],
  bins = 10,
): ProbabilityMetrics {
  if (probabilities.length !== labels.length) throw new Error('probabilities/labels length mismatch');
  if (probabilities.length === 0) throw new Error('cannot evaluate an empty probability set');
  if (!Number.isInteger(bins) || bins <= 0) throw new Error('bins must be a positive integer');

  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  const bucketStats = Array.from({ length: bins }, () => ({ count: 0, predictionSum: 0, labelSum: 0 }));

  for (let i = 0; i < probabilities.length; i += 1) {
    const p = clampProbability(probabilities[i] ?? 0.5);
    const y = labels[i] ?? 0;
    const error = p - y;
    brier += error * error;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if ((p >= 0.5 ? 1 : 0) === y) correct += 1;

    const index = Math.min(bins - 1, Math.floor(p * bins));
    const bucket = bucketStats[index];
    if (bucket) {
      bucket.count += 1;
      bucket.predictionSum += p;
      bucket.labelSum += y;
    }
  }

  const calibration: CalibrationBin[] = bucketStats.map((bucket, index) => {
    const count = bucket.count;
    const meanPrediction = count > 0 ? bucket.predictionSum / count : 0;
    const observedRate = count > 0 ? bucket.labelSum / count : 0;
    return {
      lower: index / bins,
      upper: (index + 1) / bins,
      count,
      meanPrediction,
      observedRate,
      absoluteGap: count > 0 ? Math.abs(meanPrediction - observedRate) : 0,
    };
  });

  const total = probabilities.length;
  const expectedCalibrationError = calibration.reduce(
    (sum, bucket) => sum + (bucket.count / total) * bucket.absoluteGap,
    0,
  );

  return {
    count: total,
    brierScore: brier / total,
    logLoss: logLoss / total,
    accuracyAt50: correct / total,
    expectedCalibrationError,
    calibration,
  };
}
