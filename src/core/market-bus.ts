import { EventEmitter } from 'node:events';
import type { MarketEvent } from '../domain/types.js';

export class MarketBus extends EventEmitter {
  publish(event: MarketEvent): void {
    this.emit('market_event', event);
  }

  subscribe(handler: (event: MarketEvent) => void): () => void {
    this.on('market_event', handler);
    return () => this.off('market_event', handler);
  }
}
