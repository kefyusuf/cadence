import { describe, expect, it } from 'vitest';

import { createSeriesCursor } from '../src/core/cursor.js';
import { CadenceError, isCadenceError } from '../src/core/errors.js';
import type { Occurrence, Recurrence } from '../src/core/recurrence.js';
import type { Clock } from '../src/domain/ports.js';
import { runSeries, type SleepFn } from '../src/scheduler/run-series.js';
import { sleep } from '../src/scheduler/sleep.js';

const DAY = 86_400_000;
const anchor = Date.UTC(2026, 0, 6, 9, 0);
const daily = { tz: 'UTC', dtStart: anchor, freq: 'DAILY' } as const;

function makeClock(start: number): Clock & { advance(ms: number): void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

function recordSleep(clock: Clock & { advance(ms: number): void }, delays: number[]): SleepFn {
  return (ms: number) => {
    delays.push(ms);
    clock.advance(ms);
    return Promise.resolve();
  };
}

async function failure(run: Promise<unknown>): Promise<CadenceError> {
  const caught = await run.then(
    () => null,
    (error: unknown) => error,
  );

  if (!isCadenceError(caught)) throw new Error(`expected a CadenceError, got ${String(caught)}`);
  return caught;
}

describe('runSeries', () => {
  it('walks the series and waits exactly the gap to each due time', async () => {
    const clock = makeClock(anchor);
    const delays: number[] = [];
    const indexes: number[] = [];
    const cursor = createSeriesCursor(daily);

    const result = await runSeries(cursor, {
      clock,
      sleep: recordSleep(clock, delays),
      notify: (occurrence: Occurrence) => {
        indexes.push(occurrence.index);
      },
      limit: 3,
    });

    expect(delays).toEqual([0, DAY, DAY]);
    expect(indexes).toEqual([0, 1, 2]);
    expect(result).toEqual({ delivered: 3, late: 0, endedBy: 'limit' });
  });

  it('counts an occurrence whose due time already passed as late', async () => {
    const clock = makeClock(anchor + DAY);
    const delays: number[] = [];
    const cursor = createSeriesCursor(daily);

    const result = await runSeries(cursor, {
      clock,
      sleep: recordSleep(clock, delays),
      notify: () => undefined,
      limit: 2,
    });

    expect(delays).toEqual([0, 0]);
    expect(result).toEqual({ delivered: 2, late: 1, endedBy: 'limit' });
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const clock = makeClock(anchor);
    const delays: number[] = [];
    const cursor = createSeriesCursor(daily);
    let notified = 0;

    const result = await runSeries(cursor, {
      clock,
      sleep: recordSleep(clock, delays),
      notify: () => {
        notified += 1;
      },
      signal: controller.signal,
    });

    expect(result).toEqual({ delivered: 0, late: 0, endedBy: 'aborted' });
    expect(delays).toEqual([]);
    expect(notified).toBe(0);
    expect(cursor.consumed()).toBe(0);
  });

  it('leaves the occurrence it was waiting for unconsumed when the wait is cancelled', async () => {
    const controller = new AbortController();
    const clock = makeClock(anchor);
    const indexes: number[] = [];
    const cursor = createSeriesCursor(daily);

    let waits = 0;
    const cancellingSleep: SleepFn = (ms: number) => {
      waits += 1;
      if (waits === 2) controller.abort('shutdown');
      else clock.advance(ms);
      return Promise.resolve();
    };

    const recordIndex = (occurrence: Occurrence): void => {
      indexes.push(occurrence.index);
    };

    const first = await runSeries(cursor, {
      clock,
      sleep: cancellingSleep,
      notify: recordIndex,
      signal: controller.signal,
    });

    expect(first).toEqual({ delivered: 1, late: 0, endedBy: 'aborted' });
    expect(indexes).toEqual([0]);
    expect(cursor.consumed()).toBe(1);

    const delays: number[] = [];
    const resumed = await runSeries(cursor, {
      clock,
      sleep: recordSleep(clock, delays),
      notify: recordIndex,
      limit: 1,
    });

    expect(delays).toEqual([DAY]);
    expect(resumed.endedBy).toBe('limit');
    expect(indexes).toEqual([0, 1]);
  });

  it('ends by abort instead of rethrowing when the wait rejects because the signal fired', async () => {
    const controller = new AbortController();
    const clock = makeClock(anchor);
    const cursor = createSeriesCursor(daily);
    let notified = 0;

    const rejectingSleep: SleepFn = (ms: number) => {
      controller.abort('shutdown');
      clock.advance(ms);
      return Promise.reject(new CadenceError('ABORTED', 'wait cancelled', { cause: 'shutdown' }));
    };

    const result = await runSeries(cursor, {
      clock,
      sleep: rejectingSleep,
      notify: () => {
        notified += 1;
      },
      signal: controller.signal,
    });

    expect(result).toEqual({ delivered: 0, late: 0, endedBy: 'aborted' });
    expect(notified).toBe(0);
    expect(cursor.consumed()).toBe(0);
  });

  it('ends by abort with a real timer when a mid-flight abort cuts the wait short', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort('shutdown');
    }, 5);

    const clock = makeClock(anchor);
    // a whole second, because the engine resolves occurrences to seconds and would floor a smaller offset away
    const cursor = createSeriesCursor({ ...daily, dtStart: anchor + 1000 } satisfies Recurrence);
    let notified = 0;

    const result = await runSeries(cursor, {
      clock,
      sleep,
      notify: () => {
        notified += 1;
      },
      signal: controller.signal,
    });

    expect(result).toEqual({ delivered: 0, late: 0, endedBy: 'aborted' });
    expect(notified).toBe(0);
    expect(cursor.consumed()).toBe(0);
  });

  it('waits out an occurrence months away instead of delivering it on the spot', async () => {
    // 30 days is past the 2**31-1 ms ceiling setTimeout accepts, so an unguarded wait returns
    // immediately and the run would hand out an occurrence that is a month early.
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort('shutdown');
    }, 5);

    const clock = makeClock(anchor);
    const cursor = createSeriesCursor({ ...daily, dtStart: anchor + 30 * DAY } satisfies Recurrence);
    let notified = 0;

    const result = await runSeries(cursor, {
      clock,
      sleep,
      notify: () => {
        notified += 1;
      },
      signal: controller.signal,
    });

    expect(result).toEqual({ delivered: 0, late: 0, endedBy: 'aborted' });
    expect(notified).toBe(0);
    expect(cursor.consumed()).toBe(0);
  });

  it('ends by series-end when the rule is count bounded', async () => {
    const clock = makeClock(anchor);
    const cursor = createSeriesCursor({ ...daily, count: 3 } satisfies Recurrence);
    const options = { clock, sleep: recordSleep(clock, []), notify: () => undefined };

    expect(await runSeries(cursor, options)).toEqual({ delivered: 3, late: 0, endedBy: 'series-end' });
    expect(cursor.consumed()).toBe(3);
    expect(await runSeries(cursor, options)).toEqual({ delivered: 0, late: 0, endedBy: 'series-end' });
  });

  it('consumes the occurrence it tried to deliver when the notifier throws', async () => {
    const clock = makeClock(anchor);
    const cursor = createSeriesCursor(daily);
    const boom = new Error('send failed');

    await expect(
      runSeries(cursor, { clock, sleep: recordSleep(clock, []), notify: () => { throw boom; } }),
    ).rejects.toBe(boom);

    expect(cursor.consumed()).toBe(1);
  });

  it('propagates a wait failure that is not an abort', async () => {
    const clock = makeClock(anchor);
    const cursor = createSeriesCursor(daily);
    const failing: SleepFn = () => Promise.reject(new CadenceError('UNEXPECTED', 'timer exploded'));

    const result = await failure(runSeries(cursor, { clock, sleep: failing, notify: () => undefined }));
    expect(result.code).toBe('UNEXPECTED');
  });

  it('rejects a limit it cannot honour before waiting for anything', async () => {
    for (const limit of [0, -2, 1.5]) {
      const clock = makeClock(anchor);
      const delays: number[] = [];
      const cursor = createSeriesCursor(daily);
      let notified = 0;

      const result = await failure(
        runSeries(cursor, {
          clock,
          sleep: recordSleep(clock, delays),
          notify: () => {
            notified += 1;
          },
          limit,
        }),
      );

      expect(result.code, String(limit)).toBe('INVALID_LIMIT');
      expect(delays).toEqual([]);
      expect(notified).toBe(0);
    }
  });
});
