import type { CryptoUnderlying, MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';

export interface ShortHorizonMarketDefinition {
  conditionId: string;
  marketId: string;
  underlying: CryptoUnderlying;
  expiryTimeMs: number;
  startTimeMs?: number;
  up: PolymarketTokenMetadata;
  down: PolymarketTokenMetadata;
}

export interface PolymarketQuoteFrame {
  conditionId: string;
  marketId: string;
  underlying: CryptoUnderlying;
  observationTimeMs: number;
  expiryTimeMs: number;
  secondsToExpiry: number;
  upTokenId: string;
  downTokenId: string;

  upBid: number;
  upAsk: number;
  upMid: number;
  upSpread: number;
  upBookAgeMs: number;
  upBookEventTimeMs: number;
  downBid: number;
  downAsk: number;
  downMid: number;
  downSpread: number;
  downBookAgeMs: number;
  downBookEventTimeMs: number;
  crossOutcomeQuoteSkewMs: number;
  complementMidGap: number;
  complementAskCost: number;
  normalizedUpMid: number;
}

export interface ShortHorizonFeatureFrame extends PolymarketQuoteFrame {
  binanceMid: number;
  binanceSpreadBps: number;
  binanceTopImbalance: number;
  binanceMicroprice: number;
  binanceReturn1s: number;
  binanceReturn5s: number;
  binanceReturn30s: number;
  binanceRealizedVol30s: number;
  binanceTradeImbalance5s: number;
  binanceTradeImbalance30s: number;
  binanceBookAgeMs: number;
}

interface TimedValue {
  timeMs: number;
  value: number;
}

interface TimedSignedNotional {
  timeMs: number;
  signedNotional: number;
}

interface BinanceTop {
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  timeMs: number;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOutcome(value: string): 'UP' | 'DOWN' | null {
  const text = value.trim().toUpperCase();
  if (text === 'UP' || text === 'HIGHER' || text === 'YES') return 'UP';
  if (text === 'DOWN' || text === 'LOWER' || text === 'NO') return 'DOWN';
  return null;
}

export function buildShortHorizonMarketDefinitions(
  metadata: Iterable<PolymarketTokenMetadata>,
): Map<string, ShortHorizonMarketDefinition> {
  const grouped = new Map<string, { up?: PolymarketTokenMetadata; down?: PolymarketTokenMetadata }>();
  for (const token of metadata) {
    const outcome = normalizeOutcome(token.outcome);
    if (!outcome) continue;
    const entry = grouped.get(token.conditionId) ?? {};
    if (outcome === 'UP') entry.up = token;
    else entry.down = token;
    grouped.set(token.conditionId, entry);
  }

  const result = new Map<string, ShortHorizonMarketDefinition>();
  for (const [conditionId, pair] of grouped) {
    if (!pair.up || !pair.down) continue;
    result.set(conditionId, {
      conditionId,
      marketId: pair.up.marketId,
      underlying: pair.up.underlying,
      expiryTimeMs: pair.up.expiryTimeMs,
      startTimeMs: pair.up.startTimeMs,
      up: pair.up,
      down: pair.down,
    });
  }
  return result;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function logReturn(current: number, previous: number): number {
  if (current <= 0 || previous <= 0) return 0;
  return Math.log(current / previous);
}

class BinanceMicroState {
  private readonly mids: TimedValue[] = [];
  private readonly trades: TimedSignedNotional[] = [];
  private top?: BinanceTop;

  constructor(private readonly maxHistoryMs: number) {}

  apply(event: MarketEvent): void {
    if (event.kind === 'best_bid_ask') {
      const bid = finite(event.bid);
      const ask = finite(event.ask);
      const bidSize = finite(event.bidSize) ?? 0;
      const askSize = finite(event.askSize) ?? 0;
      if (bid !== null && ask !== null && bid > 0 && ask > 0) {
        // Historical OpenMarket top-of-book ticks do not include Binance top sizes.
        // Missing sizes are represented as neutral 0/0 (imbalance=0, microprice=mid), never fabricated.
        this.top = { bid, ask, bidSize, askSize, timeMs: event.eventTimeMs };
        this.mids.push({ timeMs: event.eventTimeMs, value: (bid + ask) / 2 });
      }
    } else if (event.kind === 'trade') {
      const price = finite(event.price);
      const size = finite(event.size);
      if (price !== null && size !== null && price > 0 && size >= 0 && event.side) {
        const sign = event.side === 'buy' ? 1 : -1;
        this.trades.push({ timeMs: event.eventTimeMs, signedNotional: sign * price * size });
      }
    }
    this.prune(event.eventTimeMs);
  }

  snapshot(nowMs: number): {
    top: BinanceTop;
    mid: number;
    spreadBps: number;
    imbalance: number;
    microprice: number;
    return1s: number;
    return5s: number;
    return30s: number;
    realizedVol30s: number;
    tradeImbalance5s: number;
    tradeImbalance30s: number;
    ageMs: number;
  } | null {
    const top = this.top;
    if (!top) return null;
    const mid = (top.bid + top.ask) / 2;
    const totalTopSize = top.bidSize + top.askSize;
    const imbalance = safeRatio(top.bidSize - top.askSize, totalTopSize);
    const microprice = totalTopSize > 0
      ? ((top.ask * top.bidSize) + (top.bid * top.askSize)) / totalTopSize
      : mid;
    return {
      top,
      mid,
      spreadBps: safeRatio(top.ask - top.bid, mid) * 10_000,
      imbalance,
      microprice,
      return1s: this.returnOver(nowMs, 1_000, mid),
      return5s: this.returnOver(nowMs, 5_000, mid),
      return30s: this.returnOver(nowMs, 30_000, mid),
      realizedVol30s: this.realizedVol(nowMs, 30_000),
      tradeImbalance5s: this.tradeImbalance(nowMs, 5_000),
      tradeImbalance30s: this.tradeImbalance(nowMs, 30_000),
      ageMs: Math.max(0, nowMs - top.timeMs),
    };
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxHistoryMs;
    while (this.mids.length > 0 && (this.mids[0]?.timeMs ?? Infinity) < cutoff) this.mids.shift();
    while (this.trades.length > 0 && (this.trades[0]?.timeMs ?? Infinity) < cutoff) this.trades.shift();
  }

  private valueAtOrBefore(timeMs: number): number | undefined {
    for (let i = this.mids.length - 1; i >= 0; i -= 1) {
      const point = this.mids[i];
      if (point && point.timeMs <= timeMs) return point.value;
    }
    return undefined;
  }

  private returnOver(nowMs: number, windowMs: number, currentMid: number): number {
    const previous = this.valueAtOrBefore(nowMs - windowMs);
    return previous === undefined ? 0 : logReturn(currentMid, previous);
  }

  private realizedVol(nowMs: number, windowMs: number): number {
    const cutoff = nowMs - windowMs;
    let previous: TimedValue | undefined;
    let sumSquares = 0;
    let count = 0;
    for (const point of this.mids) {
      if (point.timeMs < cutoff || point.timeMs > nowMs) continue;
      if (previous) {
        const r = logReturn(point.value, previous.value);
        sumSquares += r * r;
        count += 1;
      }
      previous = point;
    }
    return count === 0 ? 0 : Math.sqrt(sumSquares / count);
  }

  private tradeImbalance(nowMs: number, windowMs: number): number {
    const cutoff = nowMs - windowMs;
    let signed = 0;
    let absolute = 0;
    for (const trade of this.trades) {
      if (trade.timeMs < cutoff || trade.timeMs > nowMs) continue;
      signed += trade.signedNotional;
      absolute += Math.abs(trade.signedNotional);
    }
    return safeRatio(signed, absolute);
  }
}

function underlyingFromBinanceInstrument(instrument: string): CryptoUnderlying | null {
  const upper = instrument.toUpperCase();
  if (upper.startsWith('BTC')) return 'BTC';
  if (upper.startsWith('ETH')) return 'ETH';
  return null;
}

export class ShortHorizonFeatureState {
  private readonly markets: Map<string, ShortHorizonMarketDefinition>;
  private readonly tokenToMarket = new Map<string, ShortHorizonMarketDefinition>();
  private readonly books = new Map<string, PolymarketL2Book>();
  private readonly binanceByUnderlying = new Map<CryptoUnderlying, BinanceMicroState>();

  constructor(
    metadata: Iterable<PolymarketTokenMetadata>,
    private readonly maxHistoryMs = 120_000,
  ) {
    this.markets = buildShortHorizonMarketDefinitions(metadata);
    for (const market of this.markets.values()) {
      this.tokenToMarket.set(market.up.tokenId, market);
      this.tokenToMarket.set(market.down.tokenId, market);
      this.books.set(market.up.tokenId, new PolymarketL2Book(market.up.tokenId));
      this.books.set(market.down.tokenId, new PolymarketL2Book(market.down.tokenId));
      if (!this.binanceByUnderlying.has(market.underlying)) {
        this.binanceByUnderlying.set(market.underlying, new BinanceMicroState(this.maxHistoryMs));
      }
    }
  }

  marketDefinitions(): ReadonlyMap<string, ShortHorizonMarketDefinition> {
    return this.markets;
  }

  apply(event: MarketEvent): void {
    if (event.venue === 'binance') {
      const underlying = underlyingFromBinanceInstrument(event.instrument);
      if (underlying) this.binanceByUnderlying.get(underlying)?.apply(event);
      return;
    }

    if (event.venue === 'polymarket' && this.tokenToMarket.has(event.instrument)) {
      this.books.get(event.instrument)?.apply(event);
    }
  }

  quoteFrameForMarket(conditionId: string, observationTimeMs: number): PolymarketQuoteFrame | null {
    const market = this.markets.get(conditionId);
    if (!market) return null;
    if (market.startTimeMs !== undefined && observationTimeMs < market.startTimeMs) return null;
    if (market.expiryTimeMs <= observationTimeMs) return null;

    const upBook = this.books.get(market.up.tokenId);
    const downBook = this.books.get(market.down.tokenId);
    const up = upBook?.top();
    const down = downBook?.top();
    if (!up?.bid || !up.ask || !down?.bid || !down.ask) return null;

    const upEventTimeMs = upBook?.eventTimeMs();
    const downEventTimeMs = downBook?.eventTimeMs();
    if (upEventTimeMs === undefined || downEventTimeMs === undefined) return null;

    const upMid = (up.bid.price + up.ask.price) / 2;
    const downMid = (down.bid.price + down.ask.price) / 2;
    const midSum = upMid + downMid;

    return {
      conditionId,
      marketId: market.marketId,
      underlying: market.underlying,
      observationTimeMs,
      expiryTimeMs: market.expiryTimeMs,
      secondsToExpiry: Math.max(0, (market.expiryTimeMs - observationTimeMs) / 1000),
      upTokenId: market.up.tokenId,
      downTokenId: market.down.tokenId,
      upBid: up.bid.price,
      upAsk: up.ask.price,
      upMid,
      upSpread: up.ask.price - up.bid.price,
      upBookAgeMs: upBook?.ageMs(observationTimeMs) ?? Number.POSITIVE_INFINITY,
      upBookEventTimeMs: upEventTimeMs,
      downBid: down.bid.price,
      downAsk: down.ask.price,
      downMid,
      downSpread: down.ask.price - down.bid.price,
      downBookAgeMs: downBook?.ageMs(observationTimeMs) ?? Number.POSITIVE_INFINITY,
      downBookEventTimeMs: downEventTimeMs,
      crossOutcomeQuoteSkewMs: Math.abs(upEventTimeMs - downEventTimeMs),
      complementMidGap: 1 - midSum,
      complementAskCost: up.ask.price + down.ask.price,
      normalizedUpMid: midSum > 0 ? upMid / midSum : 0.5,
    };
  }

  frameForMarket(conditionId: string, observationTimeMs: number): ShortHorizonFeatureFrame | null {
    const quote = this.quoteFrameForMarket(conditionId, observationTimeMs);
    if (!quote) return null;
    const binance = this.binanceByUnderlying.get(quote.underlying)?.snapshot(observationTimeMs);
    if (!binance) return null;

    return {
      ...quote,
      binanceMid: binance.mid,
      binanceSpreadBps: binance.spreadBps,
      binanceTopImbalance: binance.imbalance,
      binanceMicroprice: binance.microprice,
      binanceReturn1s: binance.return1s,
      binanceReturn5s: binance.return5s,
      binanceReturn30s: binance.return30s,
      binanceRealizedVol30s: binance.realizedVol30s,
      binanceTradeImbalance5s: binance.tradeImbalance5s,
      binanceTradeImbalance30s: binance.tradeImbalance30s,
      binanceBookAgeMs: binance.ageMs,
    };
  }

}
