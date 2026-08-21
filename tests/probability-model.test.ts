import test from 'node:test';
import assert from 'node:assert/strict';
import type { UpDownDatasetRow } from '../src/dataset/updown-dataset.js';
import { evaluateProbabilities } from '../src/model/metrics.js';
import {
  calibrateProbability,
  fitPlattCalibrator,
  predictLogisticProbabilities,
  trainLogisticModel,
} from '../src/model/logistic.js';

function row(index: number, signal: number, label: 0 | 1): UpDownDatasetRow {
  const condition = `c${index}`;
  return {
    label,
    labelSource: 'binance_proxy',
    referenceStartPrice: 100,
    referenceEndPrice: label ? 101 : 99,
    labelMoveBps: label ? 100 : -100,
    sampleBucketSeconds: 30,
    frame: {
      conditionId: condition,
      marketId: `m${index}`,
      underlying: 'BTC',
      observationTimeMs: index * 1_000,
      expiryTimeMs: index * 1_000 + 30_000,
      secondsToExpiry: 30,
      upTokenId: `${condition}-up`,
      downTokenId: `${condition}-down`,
      binanceMid: 100,
      binanceSpreadBps: 1,
      binanceTopImbalance: signal,
      binanceMicroprice: 100 * (1 + signal * 0.0001),
      binanceReturn1s: signal * 0.001,
      binanceReturn5s: signal * 0.002,
      binanceReturn30s: signal * 0.003,
      binanceRealizedVol30s: 0.001,
      binanceTradeImbalance5s: signal,
      binanceTradeImbalance30s: signal,
      binanceBookAgeMs: 10,
      upBid: label ? 0.52 : 0.48,
      upAsk: label ? 0.54 : 0.50,
      upMid: label ? 0.53 : 0.49,
      upSpread: 0.02,
      upBookAgeMs: 10,
      upBookEventTimeMs: index * 1_000 - 10,
      downBid: label ? 0.46 : 0.50,
      downAsk: label ? 0.48 : 0.52,
      downMid: label ? 0.47 : 0.51,
      downSpread: 0.02,
      downBookAgeMs: 10,
      downBookEventTimeMs: index * 1_000 - 10,
      crossOutcomeQuoteSkewMs: 0,
      complementMidGap: 0,
      complementAskCost: 1.02,
      normalizedUpMid: label ? 0.53 : 0.49,
    },
  };
}

test('logistic baseline learns an obvious directional signal', () => {
  const training = Array.from({ length: 80 }, (_, index) => {
    const signal = index % 2 === 0 ? 0.8 : -0.8;
    return row(index, signal, signal > 0 ? 1 : 0);
  });
  const model = trainLogisticModel(training, { epochs: 800, learningRate: 0.05 });
  const probabilities = predictLogisticProbabilities(model, training);
  const metrics = evaluateProbabilities(probabilities, training.map((item) => item.label));
  assert.ok(metrics.brierScore < 0.05);
  assert.ok(metrics.accuracyAt50 > 0.95);
});

test('Platt calibrator returns bounded probabilities and metrics include calibration error', () => {
  const raw = [0.05, 0.15, 0.8, 0.95];
  const labels: (0 | 1)[] = [0, 0, 1, 1];
  const calibrator = fitPlattCalibrator(raw, labels, 300, 0.03);
  const calibrated = raw.map((p) => calibrateProbability(calibrator, p));
  assert.ok(calibrated.every((p) => p > 0 && p < 1));
  const metrics = evaluateProbabilities(calibrated, labels, 4);
  assert.equal(metrics.count, 4);
  assert.ok(metrics.expectedCalibrationError >= 0);
});
