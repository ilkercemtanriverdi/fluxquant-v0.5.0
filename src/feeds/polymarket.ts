import type { MarketBus } from '../core/market-bus.js';
import type { MarketEvent, PolymarketTokenMetadata } from '../domain/types.js';

export function normalizePolymarketMessage(
  data: Record<string, unknown>,
  receivedTimeMs: number,
  metadataByToken: ReadonlyMap<string, PolymarketTokenMetadata> = new Map(),
): MarketEvent[] {
  const rawType = String(data.event_type ?? data.type ?? 'unknown');
  const eventTimeMs = Number(data.timestamp ?? receivedTimeMs);

  if (rawType === 'price_change' && Array.isArray(data.price_changes)) {
    return data.price_changes.flatMap((change) => {
      if (!change || typeof change !== 'object') return [];
      const item = change as Record<string, unknown>;
      const instrument = String(item.asset_id ?? 'unknown');
      return [{
        venue: 'polymarket' as const,
        kind: 'price_change' as const,
        instrument,
        eventTimeMs,
        receivedTimeMs,
        bid: item.best_bid == null ? undefined : Number(item.best_bid),
        ask: item.best_ask == null ? undefined : Number(item.best_ask),
        price: item.price == null ? undefined : Number(item.price),
        size: item.size == null ? undefined : Number(item.size),
        side: item.side === 'BUY' ? 'buy' as const : item.side === 'SELL' ? 'sell' as const : undefined,
        rawType,
        polymarket: metadataByToken.get(instrument),
        raw: { ...item, market: data.market, timestamp: data.timestamp },
      }];
    });
  }

  const instrument = String(data.asset_id ?? data.asset ?? data.market ?? 'unknown');
  const polymarket = metadataByToken.get(instrument);

  if (rawType === 'best_bid_ask') {
    return [{
      venue: 'polymarket',
      kind: 'best_bid_ask',
      instrument,
      eventTimeMs,
      receivedTimeMs,
      bid: Number(data.best_bid ?? data.bid),
      ask: Number(data.best_ask ?? data.ask),
      rawType,
      polymarket,
      raw: data,
    }];
  }

  if (rawType === 'tick_size_change') {
    const instrument = String(data.asset_id ?? data.asset ?? 'unknown');
    const polymarket = metadataByToken.get(instrument);
    const newTick = Number(data.new_tick_size);
    if (polymarket && Number.isFinite(newTick) && newTick > 0) polymarket.tickSize = newTick;
    return [{
      venue: 'polymarket',
      kind: 'status',
      instrument,
      eventTimeMs,
      receivedTimeMs,
      rawType,
      polymarket,
      raw: data,
    }];
  }

  if (rawType === 'last_trade_price') {
    return [{
      venue: 'polymarket',
      kind: 'trade',
      instrument,
      eventTimeMs,
      receivedTimeMs,
      price: Number(data.price),
      size: data.size == null ? undefined : Number(data.size),
      side: data.side === 'BUY' ? 'buy' : data.side === 'SELL' ? 'sell' : undefined,
      rawType,
      polymarket,
      raw: data,
    }];
  }

  if (rawType === 'book') {
    return [{
      venue: 'polymarket',
      kind: 'book',
      instrument,
      eventTimeMs,
      receivedTimeMs,
      rawType,
      polymarket,
      raw: data,
    }];
  }

  return [];
}

export class PolymarketFeed {
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly bus: MarketBus,
    private readonly assetIds: string[],
    private readonly metadataByToken: ReadonlyMap<string, PolymarketTokenMetadata> = new Map(),
  ) {}

  start(): void {
    if (this.assetIds.length === 0) {
      console.warn('[polymarket] no asset IDs available; feed disabled.');
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  private connect(): void {
    this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

    this.ws.addEventListener('open', () => {
      console.log(`[polymarket] websocket connected; subscribing ${this.assetIds.length} tokens`);
      this.ws?.send(JSON.stringify({
        assets_ids: this.assetIds,
        type: 'market',
        custom_feature_enabled: true,
      }));
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('PING');
      }, 10_000);
    });

    this.ws.addEventListener('message', (message) => {
      const receivedTimeMs = Date.now();
      const text = String(message.data);
      if (text === 'PONG') return;
      try {
        const parsed = JSON.parse(text) as unknown;
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of messages) {
          if (!msg || typeof msg !== 'object') continue;
          for (const event of normalizePolymarketMessage(
            msg as Record<string, unknown>,
            receivedTimeMs,
            this.metadataByToken,
          )) {
            this.bus.publish(event);
          }
        }
      } catch (error) {
        console.error('[polymarket] parse error', error);
      }
    });

    this.ws.addEventListener('close', () => {
      console.warn('[polymarket] websocket closed; scheduling reconnect');
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.scheduleReconnect();
    });
    this.ws.addEventListener('error', () => console.error('[polymarket] websocket error'));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.assetIds.length === 0) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 1500);
  }
}
