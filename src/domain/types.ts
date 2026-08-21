export type Venue = 'binance' | 'polymarket';
export type EventKind = 'trade' | 'best_bid_ask' | 'book' | 'price_change' | 'status';
export type CryptoUnderlying = 'BTC' | 'ETH';

export interface PolymarketTokenMetadata {
  tokenId: string;
  outcome: string;
  marketId: string;
  conditionId: string;
  slug: string;
  question: string;
  underlying: CryptoUnderlying;
  startTimeMs?: number;
  expiryTimeMs: number;
  tickSize?: number;
  minOrderSize?: number;
  gammaMakerBaseFeeBps?: number;
  gammaTakerBaseFeeBps?: number;
  clobMakerBaseFeeBps?: number;
  clobTakerBaseFeeBps?: number;
  platformFeeRate?: number;
  platformFeeExponent?: number;
  platformFeeTakerOnly?: boolean;
  minOrderAgeSeconds?: number;
}

export interface DiscoveredPolymarketMarket {
  marketId: string;
  conditionId: string;
  slug: string;
  question: string;
  underlying: CryptoUnderlying;
  startTimeMs?: number;
  expiryTimeMs: number;
  tickSize?: number;
  minOrderSize?: number;
  /** Historical datasets may provide authoritative resolved outcome. */
  resolvedOutcome?: 'UP' | 'DOWN';
  tokens: PolymarketTokenMetadata[];
}

export interface MarketEvent {
  venue: Venue;
  kind: EventKind;
  instrument: string;
  eventTimeMs: number;
  receivedTimeMs: number;
  sequence?: string | number;
  bid?: number;
  bidSize?: number;
  ask?: number;
  askSize?: number;
  price?: number;
  size?: number;
  side?: 'buy' | 'sell';
  rawType?: string;
  polymarket?: PolymarketTokenMetadata;
  raw: unknown;
}
