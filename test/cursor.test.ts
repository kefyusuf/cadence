import { describe, expect, it } from 'vitest';

import { createSeriesCursor } from '../src/core/cursor.js';
import type { Recurrence } from '../src/core/recurrence.js';

const anchor = Date.UTC(2026, 0, 6, 9, 0);
const daily: Recurrence = { tz: 'UTC', dtStart: anchor, freq: 'DAILY' };

describe('createSeriesCursor', () => {
  it('walks the series lazily from the anchor', () => {
    const cursor = createSeriesCursor(daily);

    const first = cursor.next();
    const second = cursor.next();

    expect(first?.targetWall).toEqual({ year: 2026, month: 1, day: 6, hour: 9, minute: 0, second: 0 });
    expect(first?.index).toBe(0);
    expect(second?.index).toBe(1);
    expect(second!.instant - first!.instant).toBe(86_400_000);
    expect(cursor.consumed()).toBe(2);
  });

  it('emits a long run without re-walking the series', () => {
    const cursor = createSeriesCursor(daily);
    let previous = -1;

    for (let step = 0; step < 500; step += 1) {
      const occurrence = cursor.next();
      expect(occurrence?.index).toBe(step);
      expect(occurrence!.instant).toBeGreaterThan(previous);
      previous = occurrence!.instant;
    }

    expect(cursor.consumed()).toBe(500);
  });

  it('does not advance on peek', () => {
    const cursor = createSeriesCursor(daily);

    const peeked = cursor.peek();
    expect(cursor.peek()).toEqual(peeked);
    expect(cursor.consumed()).toBe(0);
    expect(cursor.next()).toEqual(peeked);
  });

  it('keeps returning null once the bounded series is spent', () => {
    const cursor = createSeriesCursor({ ...daily, count: 2 });

    expect(cursor.next()?.index).toBe(0);
    expect(cursor.next()?.index).toBe(1);
    expect(cursor.peek()).toBeNull();
    expect(cursor.next()).toBeNull();
    expect(cursor.next()).toBeNull();
    expect(cursor.consumed()).toBe(2);
  });

  it('never shares position between two cursors', () => {
    const a = createSeriesCursor(daily);
    const b = createSeriesCursor(daily);

    a.next();
    a.next();

    expect(a.consumed()).toBe(2);
    expect(b.consumed()).toBe(0);
    expect(b.next()?.index).toBe(0);
  });

  it('works detached from the cursor object', () => {
    const { next, consumed } = createSeriesCursor(daily);

    expect(next()?.index).toBe(0);
    expect(next()?.index).toBe(1);
    expect(consumed()).toBe(2);
  });

  it('restarts from the anchor on reset', () => {
    const cursor = createSeriesCursor(daily);
    cursor.next();
    cursor.next();

    cursor.reset();

    expect(cursor.consumed()).toBe(0);
    expect(cursor.next()?.index).toBe(0);
  });

  it('rejects a broken rule when the cursor is created, not on the first pull', () => {
    expect(() => createSeriesCursor({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', interval: 0 })).toThrowError(
      /interval must be an integer/,
    );
  });
});
