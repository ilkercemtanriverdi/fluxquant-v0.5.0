import { resolve } from 'node:path';
import type { EventKind, MarketEvent } from '../domain/types.js';
import { PolymarketL2Book } from '../orderbook/polymarket-l2.js';
import { DeterministicReplay } from '../replay/deterministic-replay.js';
import { loadMarketEventsJsonl } from '../replay/jsonl-loader.js';

async function main(): Promise<void> {
  const inputArg = process.argv[2];
  if (!inputArg) {
    throw new Error('Usage: npm run replay -- <path-to-market-events.jsonl> [maxEvents]');
  }
  const path = resolve(inputArg);
  const maxEventsArg = process.argv[3] ? Number(process.argv[3]) : Number.POSITIVE_INFINITY;
  const maxEvents = Number.isFinite(maxEventsArg) && maxEventsArg > 0 ? maxEventsArg : Number.POSITIVE_INFINITY;
  const loaded = await loadMarketEventsJsonl(path, maxEvents);

  const books = new Map<string, PolymarketL2Book>();
  const byVenue = new Map<string, number>();
  const byKind = new Map<EventKind, number>();
  const instruments = new Set<string>();

  const getBook = (event: MarketEvent): PolymarketL2Book => {
    let book = books.get(event.instrument);
    if (!book) {
      book = new PolymarketL2Book(event.instrument);
      books.set(event.instrument, book);
    }
    return book;
  };

  const replayStats = new DeterministicReplay(loaded.events).run((event) => {
    instruments.add(`${event.venue}:${event.instrument}`);
    byVenue.set(event.venue, (byVenue.get(event.venue) ?? 0) + 1);
    byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    if (event.venue === 'polymarket' && (event.kind === 'book' || event.kind === 'price_change')) {
      getBook(event).apply(event);
    }
  });

  const bookTops = [...books.entries()].slice(0, 20).map(([tokenId, book]) => ({ tokenId, ...book.top() }));
  console.log(JSON.stringify({
    input: path,
    load: loaded.stats,
    replay: replayStats,
    uniqueInstruments: instruments.size,
    byVenue: Object.fromEntries(byVenue),
    byKind: Object.fromEntries(byKind),
    reconstructedBooks: books.size,
    sampleBookTops: bookTops,
  }, null, 2));
}

void main().catch((error) => {
  console.error('[replay] fatal', error);
  process.exitCode = 1;
});
