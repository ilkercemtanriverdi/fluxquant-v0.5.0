import type { BinaryInventorySnapshot, BinaryOutcome } from '../portfolio/binary-inventory.js';

export interface InventoryAdjustment {
  action: 'BUY' | 'HOLD';
  outcome?: BinaryOutcome;
  shares: number;
  currentSignedExposure: number;
  targetSignedExposure: number;
  reason: string;
}

/**
 * Signed exposure = UP shares - DOWN shares.
 * This planner changes exposure using BUYs only, mirroring the benchmark pattern
 * we want to study: buying the opposite outcome can hedge existing exposure
 * without requiring a SELL path.
 */
export function planBuyOnlyExposureAdjustment(
  inventory: BinaryInventorySnapshot,
  targetSignedExposure: number,
  maxAdjustmentShares: number,
  epsilon = 1e-9,
): InventoryAdjustment {
  if (!Number.isFinite(targetSignedExposure)) throw new Error('targetSignedExposure must be finite');
  if (!Number.isFinite(maxAdjustmentShares) || maxAdjustmentShares <= 0) {
    throw new Error('maxAdjustmentShares must be > 0');
  }

  const currentSignedExposure = inventory.up.quantity - inventory.down.quantity;
  const delta = targetSignedExposure - currentSignedExposure;
  if (Math.abs(delta) <= epsilon) {
    return {
      action: 'HOLD',
      shares: 0,
      currentSignedExposure,
      targetSignedExposure,
      reason: 'target exposure already satisfied',
    };
  }

  const shares = Math.min(Math.abs(delta), maxAdjustmentShares);
  return {
    action: 'BUY',
    outcome: delta > 0 ? 'UP' : 'DOWN',
    shares,
    currentSignedExposure,
    targetSignedExposure,
    reason: delta > 0
      ? 'increase UP-minus-DOWN exposure with additional UP shares'
      : 'reduce UP-minus-DOWN exposure by adding DOWN hedge shares',
  };
}
