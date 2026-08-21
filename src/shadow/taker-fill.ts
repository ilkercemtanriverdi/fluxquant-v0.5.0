import type { BookLevel } from '../orderbook/polymarket-l2.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';

export type ShadowSide = 'BUY' | 'SELL';

export interface ShadowFillLeg {
  shares: number;
  price: number;
  notionalUsd: number;
  platformFeeUsd: number;
}

export interface ShadowTakerFill {
  side: ShadowSide;
  requestedShares: number;
  filledShares: number;
  unfilledShares: number;
  complete: boolean;
  averagePrice?: number;
  topPrice?: number;
  priceImpact?: number;
  grossNotionalUsd: number;
  platformFeeUsd: number;
  /** BUY = cash paid, SELL = cash received after platform fee. */
  netCashUsd: number;
  legs: ShadowFillLeg[];
}

const FEE_PRECISION_DECIMALS = 5;
const FEE_PRECISION_SCALE = 10 ** FEE_PRECISION_DECIMALS;

/** Round protocol taker fees to the documented 5-decimal USDC precision. */
export function roundPlatformFeeUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('fee value must be >= 0');
  return Math.round((value + Number.EPSILON) * FEE_PRECISION_SCALE) / FEE_PRECISION_SCALE;
}

/** Official platform fee curve: C × feeRate × p × (1-p), rounded to 5 USDC decimals. */
export function calculatePlatformTakerFeeUsd(shares: number, price: number, feeRate: number): number {
  if (!Number.isFinite(shares) || shares < 0) throw new Error('shares must be >= 0');
  if (!Number.isFinite(price) || price < 0 || price > 1) throw new Error('price must be between 0 and 1');
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('feeRate must be >= 0');
  return roundPlatformFeeUsd(shares * feeRate * price * (1 - price));
}

function consume(
  levels: readonly BookLevel[],
  requestedShares: number,
  feeRate: number,
): { legs: ShadowFillLeg[]; filledShares: number; grossNotionalUsd: number; platformFeeUsd: number } {
  let remaining = requestedShares;
  let filledShares = 0;
  let grossNotionalUsd = 0;
  let platformFeeUsd = 0;
  const legs: ShadowFillLeg[] = [];

  for (const level of levels) {
    if (remaining <= 0) break;
    const shares = Math.min(remaining, level.size);
    if (shares <= 0) continue;
    const notionalUsd = shares * level.price;
    const feeUsd = calculatePlatformTakerFeeUsd(shares, level.price, feeRate);
    legs.push({ shares, price: level.price, notionalUsd, platformFeeUsd: feeUsd });
    remaining -= shares;
    filledShares += shares;
    grossNotionalUsd += notionalUsd;
    platformFeeUsd += feeUsd;
  }

  return { legs, filledShares, grossNotionalUsd, platformFeeUsd };
}

/**
 * Conservative shadow simulator for an immediately marketable order.
 * It walks visible L2 only and never invents hidden liquidity.
 */
export function simulateTakerFill(
  book: PolymarketL2Book,
  side: ShadowSide,
  requestedShares: number,
  platformFeeRate: number | undefined,
): ShadowTakerFill {
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) {
    throw new Error('requestedShares must be > 0');
  }
  if (platformFeeRate === undefined) {
    throw new Error('FEE_RATE_UNKNOWN: shadow taker fills require current per-market CLOB fee metadata.');
  }

  const levels = side === 'BUY' ? book.askLevels(Number.MAX_SAFE_INTEGER) : book.bidLevels(Number.MAX_SAFE_INTEGER);
  const topPrice = levels[0]?.price;
  const consumed = consume(levels, requestedShares, platformFeeRate);
  const unfilledShares = Math.max(0, requestedShares - consumed.filledShares);
  const averagePrice = consumed.filledShares > 0 ? consumed.grossNotionalUsd / consumed.filledShares : undefined;
  const priceImpact = topPrice !== undefined && averagePrice !== undefined
    ? side === 'BUY' ? averagePrice - topPrice : topPrice - averagePrice
    : undefined;
  const netCashUsd = side === 'BUY'
    ? consumed.grossNotionalUsd + consumed.platformFeeUsd
    : consumed.grossNotionalUsd - consumed.platformFeeUsd;

  return {
    side,
    requestedShares,
    filledShares: consumed.filledShares,
    unfilledShares,
    complete: unfilledShares <= 1e-12,
    averagePrice,
    topPrice,
    priceImpact,
    grossNotionalUsd: consumed.grossNotionalUsd,
    platformFeeUsd: consumed.platformFeeUsd,
    netCashUsd,
    legs: consumed.legs,
  };
}
