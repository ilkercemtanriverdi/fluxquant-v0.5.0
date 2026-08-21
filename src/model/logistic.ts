import type { UpDownDatasetRow, BinaryLabel } from '../dataset/updown-dataset.js';

export const SHORT_HORIZON_FEATURE_NAMES = [
  'secondsToExpiry',
  'binanceSpreadBps',
  'binanceTopImbalance',
  'micropriceEdgeBps',
  'binanceReturn1s',
  'binanceReturn5s',
  'binanceReturn30s',
  'binanceRealizedVol30s',
  'binanceTradeImbalance5s',
  'binanceTradeImbalance30s',
  'normalizedUpMid',
  'upSpread',
  'downSpread',
  'complementMidGap',
  'complementAskCost',
] as const;

export type ShortHorizonFeatureName = typeof SHORT_HORIZON_FEATURE_NAMES[number];

export interface Standardizer {
  mean: number[];
  scale: number[];
}

export interface LogisticModel {
  featureNames: ShortHorizonFeatureName[];
  standardizer: Standardizer;
  weights: number[];
  bias: number;
}

export interface LogisticTrainingOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  equalWeightMarkets?: boolean;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

export function vectorizeRow(row: UpDownDatasetRow): number[] {
  const frame = row.frame;
  const micropriceEdgeBps = frame.binanceMid > 0
    ? ((frame.binanceMicroprice / frame.binanceMid) - 1) * 10_000
    : 0;
  return [
    Math.log1p(Math.max(0, frame.secondsToExpiry)),
    frame.binanceSpreadBps,
    frame.binanceTopImbalance,
    micropriceEdgeBps,
    frame.binanceReturn1s,
    frame.binanceReturn5s,
    frame.binanceReturn30s,
    frame.binanceRealizedVol30s,
    frame.binanceTradeImbalance5s,
    frame.binanceTradeImbalance30s,
    frame.normalizedUpMid,
    frame.upSpread,
    frame.downSpread,
    frame.complementMidGap,
    frame.complementAskCost,
  ];
}

function fitStandardizer(matrix: readonly number[][]): Standardizer {
  if (matrix.length === 0) throw new Error('cannot fit standardizer on empty matrix');
  const width = matrix[0]?.length ?? 0;
  const mean = Array.from({ length: width }, () => 0);
  for (const row of matrix) {
    if (row.length !== width) throw new Error('feature width mismatch');
    for (let j = 0; j < width; j += 1) mean[j] = (mean[j] ?? 0) + (row[j] ?? 0);
  }
  for (let j = 0; j < width; j += 1) mean[j] = (mean[j] ?? 0) / matrix.length;

  const variance = Array.from({ length: width }, () => 0);
  for (const row of matrix) {
    for (let j = 0; j < width; j += 1) {
      const d = (row[j] ?? 0) - (mean[j] ?? 0);
      variance[j] = (variance[j] ?? 0) + d * d;
    }
  }
  const scale = variance.map((sum) => {
    const std = Math.sqrt(sum / matrix.length);
    return std > 1e-12 ? std : 1;
  });
  return { mean, scale };
}

function transform(vector: readonly number[], standardizer: Standardizer): number[] {
  return vector.map((value, index) =>
    (value - (standardizer.mean[index] ?? 0)) / (standardizer.scale[index] ?? 1),
  );
}

function marketWeights(rows: readonly UpDownDatasetRow[], enabled: boolean): number[] {
  if (!enabled) return rows.map(() => 1);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.frame.conditionId, (counts.get(row.frame.conditionId) ?? 0) + 1);
  return rows.map((row) => 1 / (counts.get(row.frame.conditionId) ?? 1));
}

export function trainLogisticModel(
  rows: readonly UpDownDatasetRow[],
  options: LogisticTrainingOptions = {},
): LogisticModel {
  if (rows.length === 0) throw new Error('cannot train on an empty dataset');
  const epochs = options.epochs ?? 1_500;
  const learningRate = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 1e-3;
  const rawMatrix = rows.map(vectorizeRow);
  const standardizer = fitStandardizer(rawMatrix);
  const matrix = rawMatrix.map((row) => transform(row, standardizer));
  const labels = rows.map((row) => row.label);
  const sampleWeights = marketWeights(rows, options.equalWeightMarkets !== false);
  const sampleWeightSum = sampleWeights.reduce((sum, weight) => sum + weight, 0);
  const width = matrix[0]?.length ?? 0;
  const weights = Array.from({ length: width }, () => 0);
  let positiveWeight = 0;
  let bias = 0;
  for (let i = 0; i < labels.length; i += 1) positiveWeight += (labels[i] ?? 0) * (sampleWeights[i] ?? 1);
  const positiveRate = Math.min(1 - 1e-6, Math.max(1e-6, positiveWeight / sampleWeightSum));
  bias = Math.log(positiveRate / (1 - positiveRate));

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad = Array.from({ length: width }, () => 0);
    let biasGrad = 0;
    for (let i = 0; i < matrix.length; i += 1) {
      const x = matrix[i] ?? [];
      const y = labels[i] ?? 0;
      const sampleWeight = sampleWeights[i] ?? 1;
      const p = sigmoid(bias + dot(weights, x));
      const error = (p - y) * sampleWeight;
      biasGrad += error;
      for (let j = 0; j < width; j += 1) grad[j] = (grad[j] ?? 0) + error * (x[j] ?? 0);
    }
    bias -= learningRate * (biasGrad / sampleWeightSum);
    for (let j = 0; j < width; j += 1) {
      const regularized = (grad[j] ?? 0) / sampleWeightSum + l2 * (weights[j] ?? 0);
      weights[j] = (weights[j] ?? 0) - learningRate * regularized;
    }
  }

  return {
    featureNames: [...SHORT_HORIZON_FEATURE_NAMES],
    standardizer,
    weights,
    bias,
  };
}

export function predictLogisticProbability(model: LogisticModel, row: UpDownDatasetRow): number {
  const vector = transform(vectorizeRow(row), model.standardizer);
  return sigmoid(model.bias + dot(model.weights, vector));
}

export function predictLogisticProbabilities(
  model: LogisticModel,
  rows: readonly UpDownDatasetRow[],
): number[] {
  return rows.map((row) => predictLogisticProbability(model, row));
}

export interface PlattCalibrator {
  slope: number;
  intercept: number;
}

function logit(probability: number): number {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(p / (1 - p));
}

export function fitPlattCalibrator(
  probabilities: readonly number[],
  labels: readonly BinaryLabel[],
  epochs = 1_000,
  learningRate = 0.02,
): PlattCalibrator {
  if (probabilities.length !== labels.length || probabilities.length === 0) {
    throw new Error('Platt calibration requires equal non-empty probabilities/labels.');
  }
  let slope = 1;
  let intercept = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let slopeGrad = 0;
    let interceptGrad = 0;
    for (let i = 0; i < probabilities.length; i += 1) {
      const x = logit(probabilities[i] ?? 0.5);
      const y = labels[i] ?? 0;
      const p = sigmoid(slope * x + intercept);
      const error = p - y;
      slopeGrad += error * x;
      interceptGrad += error;
    }
    slope -= learningRate * slopeGrad / probabilities.length;
    intercept -= learningRate * interceptGrad / probabilities.length;
  }
  return { slope, intercept };
}

export function calibrateProbability(calibrator: PlattCalibrator, probability: number): number {
  return sigmoid(calibrator.slope * logit(probability) + calibrator.intercept);
}
