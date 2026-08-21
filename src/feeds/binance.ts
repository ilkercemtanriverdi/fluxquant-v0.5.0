import type { MarketBus } from '../core/market-bus.js';
import type { MarketEvent } from '../domain/types.js';

export class BinanceFeed {
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly bus: MarketBus,
    private readonly symbol = 'btcusdt',
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const streams = `${this.symbol}@trade/${this.symbol}@bookTicker`;
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('message', (message) => {
      const receivedTimeMs = Date.now();
      try {
        const envelope = JSON.parse(String(message.data)) as { stream?: string; data?: Record<string, unknown> };
        const data = envelope.data ?? {};
        const event = this.normalize(envelope.stream ?? '', data, receivedTimeMs);
        if (event) this.bus.publish(event);
      } catch (error) {
        console.error('[binance] parse error', error);
      }
    });

    this.ws.addEventListener('close', () => this.scheduleReconnect());
    this.ws.addEventListener('error', () => console.error('[binance] websocket error'));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 1500);
  }

  private normalize(stream: string, data: Record<string, unknown>, receivedTimeMs: number): MarketEvent | null {
    if (stream.endsWith('@trade')) {
      return {
        venue: 'binance',
        kind: 'trade',
        instrument: String(data.s ?? this.symbol).toUpperCase(),
        eventTimeMs: Number(data.T ?? data.E ?? receivedTimeMs),
        receivedTimeMs,
        sequence: data.t as number | undefined,
        price: Number(data.p),
        size: Number(data.q),
        side: data.m === true ? 'sell' : 'buy',
        rawType: String(data.e ?? 'trade'),
        raw: data,
      };
    }

    if (stream.endsWith('@bookTicker')) {
      return {
        venue: 'binance',
        kind: 'best_bid_ask',
        instrument: String(data.s ?? this.symbol).toUpperCase(),
        eventTimeMs: receivedTimeMs,
        receivedTimeMs,
        sequence: data.u as number | undefined,
        bid: Number(data.b),
        bidSize: Number(data.B),
        ask: Number(data.a),
        askSize: Number(data.A),
        rawType: 'bookTicker',
        raw: data,
      };
    }

    return null;
  }
}
