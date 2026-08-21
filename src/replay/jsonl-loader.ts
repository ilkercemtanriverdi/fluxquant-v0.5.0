import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { MarketEvent } from '../domain/types.js';

function isMarketEvent(value: unknown): value is MarketEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<MarketEvent>;
  return (
    (event.venue === 'binance' || event.venue === 'polymarket') &&
    typeof event.kind === 'string' &&
    typeof event.instrument === 'string' &&
    typeof event.eventTimeMs === 'number' &&
    typeof event.receivedTimeMs === 'number'
  );
}

export interface JsonlLoadStats {
  lines: number;
  events: number;
  invalidLines: number;
}

export async function loadMarketEventsJsonl(
  path: string,
  maxEvents = Number.POSITIVE_INFINITY,
): Promise<{ events: MarketEvent[]; stats: JsonlLoadStats }> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const events: MarketEvent[] = [];
  let lineCount = 0;
  let invalidLines = 0;

  for await (const line of lines) {
    lineCount += 1;
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isMarketEvent(parsed)) {
        invalidLines += 1;
        continue;
      }
      events.push(parsed);
      if (events.length >= maxEvents) break;
    } catch {
      invalidLines += 1;
    }
  }

  input.destroy();
  return {
    events,
    stats: { lines: lineCount, events: events.length, invalidLines },
  };
}
