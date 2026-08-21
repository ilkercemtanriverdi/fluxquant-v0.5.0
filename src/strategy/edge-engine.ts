import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';
import { simulateTakerFill, type ShadowTakerFill } from '../shadow/taker-fill.js';

export interface PairArbitrageAssessment {
  executable: boolean;
  shares: number;
  upFill: ShadowTakerFill;
  downFill: ShadowTakerFill;
  totalCashCostUsd: number;
  lockedSettlementUsd: number;
  lockedPnlUsd: number;
  lockedReturnOnCost: number;
}

/**
 * Buy equal shares of both complementary outcomes. If both fills complete,
 * settlement is exactly `shares` dollars regardless of winner.
 */
export function assessPairArbitrage(
  upBook: PolymarketL2Book,
  downBook: PolymarketL2Book,
  shares: number,
  upFeeRate: number | undefined,
  downFeeRate: number | undefined,
): PairArbitrageAssessment {
  const upFill = simulateTakerFill(upBook, 'BUY', shares, upFeeRate);
  const downFill = simulateTakerFill(downBook, 'BUY', shares, downFeeRate);
  const executable = upFill.complete && downFill.complete;
  const totalCashCostUsd = upFill.netCashUsd + downFill.netCashUsd;
  const lockedSettlementUsd = executable ? shares : 0;
  const lockedPnlUsd = executable ? lockedSettlementUsd - totalCashCostUsd : Number.NEGATIVE_INFINITY;
  const lockedReturnOnCost = executable && totalCashCostUsd > 0 ? lockedPnlUsd / totalCashCostUsd : Number.NEGATIVE_INFINITY;

  return {
    executable,
    shares,
    upFill,
    downFill,
    totalCashCostUsd,
    lockedSettlementUsd,
    lockedPnlUsd,
    lockedReturnOnCost,
  };
}

export interface DirectionalEdgeAssessment {
  executable: boolean;
  requestedShares: number;
  probability: number;
  fill: ShadowTakerFill;
  expectedSettlementUsd: number;
  expectedPnlUsd: number;
  expectedReturnOnCost: number;
}

/**
 * Research-only EV calculator. It does not create a probability model;
 * callers must provide a calibrated probability estimate.
 */
export function assessDirectionalBuyEdge(
  book: PolymarketL2Book,
  probability: number,
  shares: number,
  feeRate: number | undefined,
): DirectionalEdgeAssessment {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('probability must be between 0 and 1');
  }
  const fill = simulateTakerFill(book, 'BUY', shares, feeRate);
  const executable = fill.complete;
  const expectedSettlementUsd = executable ? shares * probability : 0;
  const expectedPnlUsd = executable ? expectedSettlementUsd - fill.netCashUsd : Number.NEGATIVE_INFINITY;
  const expectedReturnOnCost = executable && fill.netCashUsd > 0 ? expectedPnlUsd / fill.netCashUsd : Number.NEGATIVE_INFINITY;
  return {
    executable,
    requestedShares: shares,
    probability,
    fill,
    expectedSettlementUsd,
    expectedPnlUsd,
    expectedReturnOnCost,
  };
}
