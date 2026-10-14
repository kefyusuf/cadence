import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createSeriesCursor } from '../src/core/cursor.js';
import { occurrences, type Recurrence } from '../src/core/recurrence.js';

const DAY = 86_400_000;
const anchor = Date.UTC(2026, 0, 5, 1, 0);
const daily = { tz: 'Europe/Berlin', dtStart: anchor, freq: 'DAILY' } as const;
const bounded = (count: number): Recurrence => ({ ...daily, count });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorCode(error: unknown): string {
  if (error instanceof Error) return 'code' in error ? String(error.code) : error.name;
  return String(error);
}

interface Walk<Out> {
  readonly iterable: Iterable<Out>;
  steps(): number;
  closedAt(): number | null;
}

/**
 * Sits in front of the engine's generator and counts every step taken into it, and whether the walk was
 * ever closed. "How far ahead did the stream pull" is only answerable by counting the engine's own work;
 * the stream's buffer is a different number and it is the one that lies.
 */
function counted<Out>(recurrence: Recurrence, project: (step: number) => Out): Walk<Out> {
  const source = occurrences(recurrence)[Symbol.iterator]();
  let steps = 0;
  let closedAt: number | null = null;

  function* walk(): Generator<Out, void> {
    try {
      for (;;) {
        const { done } = source.next();
        steps += 1;
        if (done) return;
        yield project(steps);
      }
    } finally {
      closedAt = steps;
    }
  }

  return { iterable: { [Symbol.iterator]: walk }, steps: () => steps, closedAt: () => closedAt };
}

const rows = (recurrence: Recurrence) => counted(recurrence, (step) => ({ step }));
const ndjson = (recurrence: Recurrence) =>
  counted(recurrence, (step) => `${JSON.stringify({ step, instant: anchor + step * DAY })}\n`);

/** The shape a route would build: the walk behind a buffer whose `highWaterMark` is counted in rows. */
function objectStream<Out>(walk: Walk<Out>, highWaterMark: number): Readable {
  return Readable.from(walk.iterable, { objectMode: true, highWaterMark });
}

/** Teardown errors arrive asynchronously, so every test that expects one asks for its code in order. */
function errorCodes(stream: Readable): string[] {
  const codes: string[] = [];
  stream.on('error', (error: unknown) => {
    codes.push(errorCode(error));
  });
  return codes;
}

/** A sink that takes a row only on the next turn of the loop, so `write()` genuinely has to refuse one. */
function deferringSink(): Writable {
  return new Writable({
    objectMode: true,
    write: (_chunk: unknown, _encoding: string, callback: () => void) => {
      setImmediate(callback);
    },
  });
}

/**
 * The stream semantics `GET /boards/:id/export` will be built on, pinned here so the route is written
 * against measured behaviour instead of against intuition about streams. Each number came from the probe
 * ADR 0010 describes, and CI re-takes them on both supported Node majors.
 */
describe('the series generator behind a Readable', () => {
  it('does not reach the engine until someone asks for a value', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 16);

    await wait(10);

    expect(walk.steps()).toBe(0);
    expect(walk.closedAt()).toBeNull();
    stream.destroy();
  });

  it('defaults to object mode with a one-row buffer, which is not what Readable itself does', () => {
    const walk = rows(bounded(4_000));
    const wrapped = Readable.from(walk.iterable);
    const plain = new Readable({ objectMode: true });

    expect(wrapped.readableObjectMode).toBe(true);
    expect(wrapped.readableHighWaterMark).toBe(1);
    expect(plain.readableHighWaterMark).toBe(16);
    // The byte-mode default is deliberately NOT pinned here: it is 65536 inside the supported images and
    // was 16384 on the host's v26.8.2 (ADR 0010 decision 2), so the honest claim is the one above — a
    // route states its own mode and its own highWaterMark rather than reasoning about defaults.
    wrapped.destroy();
    plain.destroy();
  });

  it('pulls exactly the highWaterMark for one read and keeps the rest buffered', () => {
    for (const highWaterMark of [1, 2, 16, 64]) {
      const walk = rows(bounded(4_000));
      const stream = objectStream(walk, highWaterMark);

      const first: unknown = stream.read();

      expect(first).toEqual({ step: 1 });
      expect(walk.steps()).toBe(highWaterMark);
      expect(stream.readableLength).toBe(highWaterMark - 1);
      stream.destroy();
    }
  });

  it('tops the buffer back up by exactly one row on the next tick', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 4);
    stream.read();

    await wait(10);

    expect(walk.steps()).toBe(5);
    expect(stream.readableLength).toBe(4);
    stream.destroy();
  });

  it('materialises a whole series that is shorter than the buffer on the first read', () => {
    const walk = rows(bounded(3));
    const stream = objectStream(walk, 16);

    stream.read();

    // Four steps for three occurrences: the fourth is the step that discovers the series is over.
    expect(walk.steps()).toBe(4);
    expect(walk.closedAt()).toBe(4);
    expect(stream.readableLength).toBe(2);
    stream.destroy();
  });

  it('starts nothing on its own once the series is exhausted', async () => {
    const walk = rows(bounded(3));
    const stream = objectStream(walk, 16);
    stream.read();
    const steps = walk.steps();

    await wait(10);

    expect(walk.steps()).toBe(steps);
    stream.destroy();
  });
});

describe('flowing mode', () => {
  /**
   * The probe ran this shape against an unbounded rule and the walk took the engine's whole ceiling —
   * `MAX_CANDIDATES`, with `setImmediate` and `setTimeout(0)` firing only after the last one. That is ADR
   * 0010's reason a route must bound the series. It is not repeated here because a multi-second test that
   * deliberately burns the guard is a bad gate; the bounded form of the same behaviour is what is pinned.
   */
  it('a data listener drains a bounded series before the next tick', async () => {
    const walk = rows(bounded(50));
    const stream = objectStream(walk, 2);
    let seen = 0;
    stream.on('data', () => {
      seen += 1;
    });

    await wait(10);

    expect(seen).toBe(50);
    expect(walk.steps()).toBe(51);
    expect(walk.closedAt()).toBe(51);
    // While flowing, read() leaves the data to the listener and returns nothing.
    expect(stream.read()).toBeNull();
    stream.destroy();
  });

  it('a slow sink downstream stops the walk instead of outrunning it', async () => {
    const walk = rows(bounded(20));
    const stream = objectStream(walk, 2);
    let written = 0;
    let markThird: () => void = () => {};
    const thirdWrite = new Promise<void>((resolve) => {
      markThird = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      const sink = new Writable({
        objectMode: true,
        highWaterMark: 2,
        write: (_chunk: unknown, _encoding: string, callback: () => void) => {
          written += 1;
          if (written === 3) markThird();
          setTimeout(callback, 5);
        },
      });
      sink.on('finish', () => {
        resolve();
      });
      stream.pipe(sink);
    });

    // Anchored on the third row reaching the sink rather than on a wall clock, so the bound below means the
    // same thing on a loaded machine and an idle one. Measured here: 5 steps at 3 rows written, 2 buffered.
    await thirdWrite;

    expect(written).toBe(3);
    expect(walk.steps()).toBeLessThanOrEqual(written + 3);
    expect(stream.readableLength).toBeLessThanOrEqual(3);

    await finished;

    expect(written).toBe(20);
    expect(walk.steps()).toBe(21);
  });

  it('leaves the event loop free when the consumer works between rows', async () => {
    const walk = rows(bounded(20));
    const stream = objectStream(walk, 2);
    const codes = errorCodes(stream);
    let fires = 0;
    const timer = setInterval(() => {
      fires += 1;
    }, 10);

    let seen = 0;
    for await (const _row of stream) {
      seen += 1;
      await wait(40);
      if (seen === 2) break;
    }
    clearInterval(timer);

    // Measured on host v26.8.2: 3 steps and 2 interval fires after row 1, 4 and 5 after row 2 — one row of
    // engine work per turn of the consumer, with the timer phase running the whole time.
    expect(walk.steps()).toBeLessThanOrEqual(seen + 3);
    expect(fires).toBeGreaterThanOrEqual(2);
    expect(stream.destroyed).toBe(true);

    await wait(10);

    expect(codes).toEqual(['ABORT_ERR']);
  });
});

describe('backpressure at a Writable', () => {
  it('a loop that ignores write() returning false parks every row downstream', async () => {
    const ignoring = deferringSink();
    let refused = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (!ignoring.write({ row: i })) refused += 1;
    }
    // Nothing has drained yet: the whole series is sitting in Node's buffer, not in the generator.
    const parked = ignoring.writableLength;
    ignoring.end();
    await once(ignoring, 'finish');

    const honouring = deferringSink();
    let refusedHonouring = 0;
    let peak = 0;
    for (let i = 0; i < 2_000; i += 1) {
      if (!honouring.write({ row: i })) {
        refusedHonouring += 1;
        await once(honouring, 'drain');
      }
      peak = Math.max(peak, honouring.writableLength);
    }
    honouring.end();
    await once(honouring, 'finish');

    expect(parked).toBe(2_000);
    expect(peak).toBeLessThanOrEqual(16);
    expect(refused).toBeGreaterThan(refusedHonouring);
    expect(refusedHonouring).toBeGreaterThan(0);
  });
});

describe('teardown', () => {
  it('destroy closes the generator and the walk stops dead', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 2);
    stream.read();
    stream.read();
    const taken = 2;
    const atDestroy = walk.steps();

    stream.destroy();
    await wait(10);

    // One row of read-ahead is the buffer's doing; more than highWaterMark would be a leak.
    expect(atDestroy).toBeGreaterThanOrEqual(taken);
    expect(atDestroy).toBeLessThanOrEqual(taken + 2);
    expect(walk.closedAt()).toBe(atDestroy);
    expect(walk.steps()).toBe(atDestroy);
  });

  it('destroying with an error reports that error first and closes the walk the same way', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 2);
    const events: string[] = [];
    stream.on('error', (error: unknown) => {
      events.push(errorCode(error));
    });
    stream.on('close', () => {
      events.push('close');
    });
    stream.read();
    stream.read();
    const atDestroy = walk.steps();

    stream.destroy(Object.assign(new Error('the store went away'), { code: 'STORE_CLOSED' }));
    await wait(10);

    expect(events).toEqual(['STORE_CLOSED', 'close']);
    expect(walk.closedAt()).toBe(atDestroy);
    expect(walk.steps()).toBe(atDestroy);
  });

  it('a stream nobody ever read has nothing to close', () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 2);

    stream.destroy();

    expect(walk.steps()).toBe(0);
    expect(walk.closedAt()).toBeNull();
  });

  it('breaking out of for-await closes the walk and reports the early exit on the next tick', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 2);
    const codes = errorCodes(stream);

    let seen = 0;
    for await (const _row of stream) {
      seen += 1;
      if (seen === 3) break;
    }

    expect(seen).toBe(3);
    expect(walk.closedAt()).toBe(walk.steps());
    expect(codes).toEqual([]);

    await wait(10);

    expect(codes).toEqual(['ABORT_ERR']);
    expect(stream.destroyed).toBe(true);
  });

  it('a consumer that throws mid-row is the same teardown, with the message kept', async () => {
    const walk = rows(bounded(4_000));
    const stream = objectStream(walk, 2);
    const codes = errorCodes(stream);
    let message = 'no throw';

    try {
      for await (const _row of stream) {
        throw new Error('row could not be encoded');
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('row could not be encoded');
    expect(walk.closedAt()).toBe(walk.steps());

    await wait(10);

    expect(codes).toEqual(['ABORT_ERR']);
  });

  it('an AbortSignal changes nothing until something wires it to destroy', async () => {
    const walk = rows(bounded(4_000));
    const controller = new AbortController();
    const stream = objectStream(walk, 2);
    stream.read();
    stream.read();
    const atAbort = walk.steps();

    controller.abort();
    await wait(10);
    const servedAfterAbort: unknown = stream.read();

    expect(stream.destroyed).toBe(false);
    expect(walk.closedAt()).toBeNull();
    // The buffered rows keep coming: an aborted request does not stop a stream that nobody told.
    expect(servedAfterAbort).not.toBeNull();
    expect(walk.steps()).toBeGreaterThanOrEqual(atAbort);
    stream.destroy();
  });

  it('abort wired to destroy closes the walk and stops serving', async () => {
    const walk = rows(bounded(4_000));
    const controller = new AbortController();
    const stream = objectStream(walk, 2);
    const order: string[] = [];
    stream.on('close', () => {
      order.push('close');
    });
    controller.signal.addEventListener('abort', () => {
      order.push('abort');
      stream.destroy();
    });
    stream.read();
    stream.read();

    controller.abort();
    await wait(10);

    expect(order).toEqual(['abort', 'close']);
    expect(walk.closedAt()).toBe(walk.steps());

    // destroy stops the walk but does not recall the row already in the buffer — ADR 0010 decision 6, and
    // the reason a streamed body is truncated rather than rewound.
    let servable = 0;
    while (stream.read() !== null) servable += 1;

    expect(servable).toBeGreaterThan(0);
    expect(servable).toBeLessThanOrEqual(2);
    expect(walk.steps()).toBe(walk.closedAt());
  });
});

describe('the cursor behind a stream', () => {
  it('consumes exactly the rows it pushes, so a buffered stream hides no lookahead', async () => {
    const cursor = createSeriesCursor(bounded(20));
    let pushed = 0;
    const stream = new Readable({
      objectMode: true,
      highWaterMark: 3,
      read: () => {
        const occurrence = cursor.next();
        if (occurrence === null) {
          stream.push(null);
          return;
        }
        pushed += 1;
        stream.push(occurrence);
      },
    });
    stream.read();
    stream.read();
    stream.read();

    await wait(10);

    expect(pushed).toBe(cursor.consumed());
    expect(stream.readableLength).toBeLessThanOrEqual(3);
    stream.destroy();
  });
});

describe('byte mode', () => {
  it('rejects an object chunk instead of buffering it', async () => {
    const walk = rows(bounded(20));
    const stream = Readable.from(walk.iterable, { objectMode: false });
    const codes = errorCodes(stream);

    stream.resume();
    await wait(10);

    expect(codes).toEqual(['ERR_INVALID_ARG_TYPE']);
    expect(walk.steps()).toBe(1);
    stream.destroy();
  });

  it('bounds the buffer in bytes, so one read holds a pile of rows', () => {
    const walk = ndjson(bounded(4_000));
    const stream = Readable.from(walk.iterable, { objectMode: false, highWaterMark: 4_096 });

    const chunk: unknown = stream.read();
    const returned = chunk instanceof Buffer ? chunk.byteLength : 0;

    // Bytes, not rows: this highWaterMark in object mode would hold four. What one read hands back versus
    // what it leaves buffered is runtime-dependent (ADR 0010 decision 9), so the claim is about the total
    // pulled, which every supported runtime agrees on.
    expect(walk.steps()).toBeGreaterThan(100);
    expect(returned + stream.readableLength).toBeGreaterThanOrEqual(4_096 - 128);
    stream.destroy();
  });
});
