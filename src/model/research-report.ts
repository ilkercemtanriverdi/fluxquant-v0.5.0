import type { DatasetSplit, UpDownDatasetRow } from '../dataset/updown-dataset.js';
import { evaluateProbabilities, type ProbabilityMetrics } from './metrics.js';
import {
  calibrateProbability,
  fitPlattCalibrator,
  predictLogisticProbabilities,
  trainLogisticModel,
  type LogisticModel,
  type PlattCalibrator,
} from './logistic.js';

export interface ProbabilityBaselineReport {
  model: LogisticModel;
  calibrator: PlattCalibrator;
  validation: {
    rawModel: ProbabilityMetrics;
    marketBaseline: ProbabilityMetrics;
    constant50: ProbabilityMetrics;
  };
  test: {
    calibratedModel: ProbabilityMetrics;
    rawModel: ProbabilityMetrics;
    marketBaseline: ProbabilityMetrics;
    constant50: ProbabilityMetrics;
  };
}

function labels(rows: readonly UpDownDatasetRow[]): (0 | 1)[] {
  return rows.map((row) => row.label);
}

function marketBaseline(rows: readonly UpDownDatasetRow[]): number[] {
  return rows.map((row) => Math.min(1, Math.max(0, row.frame.normalizedUpMid)));
}

export function buildProbabilityBaselineReport(split: DatasetSplit): ProbabilityBaselineReport {
  if (split.train.length === 0 || split.validation.length === 0 || split.test.length === 0) {
    throw new Error('train, validation and test sets must all be non-empty');
  }

  const model = trainLogisticModel(split.train);
  const validationRaw = predictLogisticProbabilities(model, split.validation);
  const calibrator = fitPlattCalibrator(validationRaw, labels(split.validation));
  const testRaw = predictLogisticProbabilities(model, split.test);
  const testCalibrated = testRaw.map((p) => calibrateProbability(calibrator, p));

  return {
    model,
    calibrator,
    validation: {
      rawModel: evaluateProbabilities(validationRaw, labels(split.validation)),
      marketBaseline: evaluateProbabilities(marketBaseline(split.validation), labels(split.validation)),
      constant50: evaluateProbabilities(split.validation.map(() => 0.5), labels(split.validation)),
    },
    test: {
      calibratedModel: evaluateProbabilities(testCalibrated, labels(split.test)),
      rawModel: evaluateProbabilities(testRaw, labels(split.test)),
      marketBaseline: evaluateProbabilities(marketBaseline(split.test), labels(split.test)),
      constant50: evaluateProbabilities(split.test.map(() => 0.5), labels(split.test)),
    },
  };
}
