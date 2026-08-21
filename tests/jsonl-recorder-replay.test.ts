import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlRecorder } from '../src/recording/jsonl-recorder.js';
import { loadMarketEventsJsonl } from '../src/replay/jsonl-loader.js';

test('stream recorder flushes and JSONL loader skips invalid lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fluxquant-'));
  const path = join(dir, 'events.jsonl');
  try {
    const recorder = new JsonlRecorder(path);
    await Promise.all([
      recorder.record({ venue: 'binance', kind: 'trade', instrument: 'BTCUSDT', eventTimeMs: 2, receivedTimeMs: 3, price: 100, raw: {} }),
      recorder.record({ venue: 'polymarket', kind: 'book', instrument: 'token', eventTimeMs: 1, receivedTimeMs: 2, raw: { bids: [], asks: [] } }),
    ]);
    await recorder.close();
    await appendFile(path, '{broken json}\n', 'utf8');

    const loaded = await loadMarketEventsJsonl(path);
    assert.equal(loaded.events.length, 2);
    assert.equal(loaded.stats.invalidLines, 1);
    assert.equal(loaded.stats.lines, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
