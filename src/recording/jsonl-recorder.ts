import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import type { MarketEvent } from '../domain/types.js';

/**
 * Append-only recorder using one long-lived file descriptor.
 * Writes are serialized and honor stream backpressure.
 */
export class JsonlRecorder {
  private readonly stream: WriteStream;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { flags: 'a', encoding: 'utf8' });
  }

  record(event: MarketEvent): Promise<void> {
    if (this.closing) return Promise.reject(new Error('RECORDER_CLOSED'));
    const line = JSON.stringify(event) + '\n';
    this.tail = this.tail.then(async () => {
      if (!this.stream.write(line)) await once(this.stream, 'drain');
    });
    return this.tail;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.tail;
    this.stream.end();
    await once(this.stream, 'finish');
  }
}
