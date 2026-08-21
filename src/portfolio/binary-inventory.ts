export type BinaryOutcome = 'UP' | 'DOWN';

export interface InventoryLeg {
  quantity: number;
  costUsd: number;
}

export interface BinaryInventorySnapshot {
  up: InventoryLeg;
  down: InventoryLeg;
  hedgedPairs: number;
  netUp: number;
  netDown: number;
  totalCostUsd: number;
  settlementValueIfUpUsd: number;
  settlementValueIfDownUsd: number;
  pnlIfUpUsd: number;
  pnlIfDownUsd: number;
}

/** Research/shadow accounting only. No order placement. */
export class BinaryInventory {
  private readonly up: InventoryLeg = { quantity: 0, costUsd: 0 };
  private readonly down: InventoryLeg = { quantity: 0, costUsd: 0 };

  buy(outcome: BinaryOutcome, quantity: number, price: number, feeUsd = 0): void {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('quantity must be > 0');
    if (!Number.isFinite(price) || price < 0 || price > 1) throw new Error('price must be between 0 and 1');
    if (!Number.isFinite(feeUsd) || feeUsd < 0) throw new Error('feeUsd must be >= 0');
    const leg = outcome === 'UP' ? this.up : this.down;
    leg.quantity += quantity;
    leg.costUsd += quantity * price + feeUsd;
  }

  snapshot(): BinaryInventorySnapshot {
    const hedgedPairs = Math.min(this.up.quantity, this.down.quantity);
    const totalCostUsd = this.up.costUsd + this.down.costUsd;
    const settlementValueIfUpUsd = this.up.quantity;
    const settlementValueIfDownUsd = this.down.quantity;
    return {
      up: { ...this.up },
      down: { ...this.down },
      hedgedPairs,
      netUp: Math.max(0, this.up.quantity - this.down.quantity),
      netDown: Math.max(0, this.down.quantity - this.up.quantity),
      totalCostUsd,
      settlementValueIfUpUsd,
      settlementValueIfDownUsd,
      pnlIfUpUsd: settlementValueIfUpUsd - totalCostUsd,
      pnlIfDownUsd: settlementValueIfDownUsd - totalCostUsd,
    };
  }
}
