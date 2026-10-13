import type { SeriesCursor } from '../core/cursor.js';
import { CadenceError } from '../core/errors.js';
import type { Occurrence } from '../core/recurrence.js';
import type { Clock } from '../domain/ports.js';

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type RunEnd = 'aborted' | 'limit' | 'series-end';

export interface RunOptions {
  readonly clock: Clock;
  readonly sleep: SleepFn;
  readonly notify: (occurrence: Occurrence) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly limit?: number;
}

export interface RunSummary {
  readonly delivered: number;
  readonly late: number;
  readonly endedBy: RunEnd;
}

/**
 * Drains a cursor in due-time order, waiting between occurrences. The clock and the wait are
 * injected, so this is testable without touching a timer, and an abort never swallows a
 * scheduled occurrence: the one being waited for is left on the cursor for the next run.
 */
export async function runSeries(cursor: SeriesCursor, options: RunOptions): Promise<RunSummary> {
  const { clock, sleep, notify, signal, limit } = options;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new CadenceError('INVALID_LIMIT', `limit must be a whole number of occurrences, got ${String(limit)}`);
  }

  let delivered = 0;
  let late = 0;

  for (;;) {
    if (signal?.aborted) return { delivered, late, endedBy: 'aborted' };
    if (limit !== undefined && delivered >= limit) return { delivered, late, endedBy: 'limit' };

    const upcoming = cursor.peek();
    if (upcoming === null) return { delivered, late, endedBy: 'series-end' };

    const now = clock.now();
    if (upcoming.instant < now) late += 1;

    try {
      await sleep(upcoming.instant > now ? upcoming.instant - now : 0, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      return { delivered, late, endedBy: 'aborted' };
    }

    if (signal?.aborted) return { delivered, late, endedBy: 'aborted' };

    cursor.next();
    delivered += 1;
    await notify(upcoming);
  }
}
