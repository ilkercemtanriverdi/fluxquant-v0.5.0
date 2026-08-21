import type { MarketEvent } from '../domain/types.js';

export interface ReplayItem {
  event: MarketEvent;
  originalIndex: number;
}

export class ReplayClock {
  private currentMs = 0;

  now(): number {
    return this.currentMs;
  }

  set(timeMs: number): void {
    if (!Number.isFinite(timeMs)) throw new Error('ReplayClock requires a finite timestamp.');
    this.currentMs = timeMs;
  }
}

export interface ReplayStats {
  events: number;
  firstEventTimeMs?: number;
  lastEventTimeMs?: number;
}

/**
 * Deterministic, zero-wait replay. Events are ordered by exchange event time,
 * then receive time, then original file/order index for stable ties.
 */
export class DeterministicReplay {
  readonly clock = new ReplayClock();

  constructor(private readonly events: readonly MarketEvent[]) {}

  run(handler: (event: MarketEvent, clock: ReplayClock) => void): ReplayStats {
    const ordered: ReplayItem[] = this.events
      .map((event, originalIndex) => ({ event, originalIndex }))
      .sort((a, b) =>
        a.event.eventTimeMs - b.event.eventTimeMs ||
        a.event.receivedTimeMs - b.event.receivedTimeMs ||
        a.originalIndex - b.originalIndex,
      );

    for (const item of ordered) {
      this.clock.set(item.event.eventTimeMs);
      handler(item.event, this.clock);
    }

    return {
      events: ordered.length,
      firstEventTimeMs: ordered[0]?.event.eventTimeMs,
      lastEventTimeMs: ordered.at(-1)?.event.eventTimeMs,
    };
  }
}
