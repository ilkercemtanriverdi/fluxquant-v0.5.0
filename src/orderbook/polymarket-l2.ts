import type { MarketEvent } from '../domain/types.js';

interface RawLevel {
  price?: unknown;
  size?: unknown;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookTop {
  bid?: BookLevel;
  ask?: BookLevel;
  spread?: number;
  midpoint?: number;
}

function finitePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  const levels: BookLevel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const level = raw as RawLevel;
    const price = finitePositive(level.price);
    const size = finitePositive(level.size);
    if (price === null || size === null) continue;
    levels.push({ price, size });
  }
  return levels;
}

export class PolymarketL2Book {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private lastEventTimeMs?: number;

  constructor(readonly tokenId: string) {}

  apply(event: MarketEvent): void {
    if (event.venue !== 'polymarket' || event.instrument !== this.tokenId) return;
    this.lastEventTimeMs = event.eventTimeMs;

    if (event.kind === 'book') {
      this.applySnapshot(event.raw);
      return;
    }

    if (event.kind === 'price_change') {
      this.applyPriceChange(event.raw);
    }
  }

  top(): BookTop {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (!bid || !ask) return { bid, ask };
    return {
      bid,
      ask,
      spread: ask.price - bid.price,
      midpoint: (ask.price + bid.price) / 2,
    };
  }

  bestBid(): BookLevel | undefined {
    let bestPrice = -Infinity;
    let bestSize = 0;
    for (const [price, size] of this.bids) {
      if (size > 0 && price > bestPrice) {
        bestPrice = price;
        bestSize = size;
      }
    }
    return Number.isFinite(bestPrice) ? { price: bestPrice, size: bestSize } : undefined;
  }

  bestAsk(): BookLevel | undefined {
    let bestPrice = Infinity;
    let bestSize = 0;
    for (const [price, size] of this.asks) {
      if (size > 0 && price < bestPrice) {
        bestPrice = price;
        bestSize = size;
      }
    }
    return Number.isFinite(bestPrice) ? { price: bestPrice, size: bestSize } : undefined;
  }

  bidLevels(limit = 20): BookLevel[] {
    return [...this.bids]
      .filter(([, size]) => size > 0)
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price)
      .slice(0, limit);
  }

  askLevels(limit = 20): BookLevel[] {
    return [...this.asks]
      .filter(([, size]) => size > 0)
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price)
      .slice(0, limit);
  }

  ageMs(nowMs: number): number | undefined {
    return this.lastEventTimeMs === undefined ? undefined : Math.max(0, nowMs - this.lastEventTimeMs);
  }

  eventTimeMs(): number | undefined {
    return this.lastEventTimeMs;
  }

  private applySnapshot(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    this.bids.clear();
    this.asks.clear();
    for (const level of parseLevels(obj.bids)) {
      if (level.size > 0) this.bids.set(level.price, level.size);
    }
    for (const level of parseLevels(obj.asks)) {
      if (level.size > 0) this.asks.set(level.price, level.size);
    }
  }

  private applyPriceChange(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const side = String(obj.side ?? '').toUpperCase();
    const price = finitePositive(obj.price);
    const size = finitePositive(obj.size);
    if (price === null || size === null) return;

    const levels = side === 'BUY' ? this.bids : side === 'SELL' ? this.asks : null;
    if (!levels) return;
    if (size === 0) levels.delete(price);
    else levels.set(price, size);
  }
}
