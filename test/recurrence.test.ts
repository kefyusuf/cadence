import { describe, expect, it } from 'vitest';

import { CadenceError } from '../src/core/errors.js';
import { wallClockAt } from '../src/core/clock.js';
import { nextOccurrence, type Recurrence, type WeekDay } from '../src/core/recurrence.js';

const W = (year: number, month: number, day: number, hour: number, minute: number, second = 0) => ({
  year,
  month,
  day,
  hour,
  minute,
  second,
});

function expectError(call: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }

  expect(thrown, `expected a throw with code ${code}`).toBeInstanceOf(CadenceError);
  expect((thrown as CadenceError).code).toBe(code);
}

describe('daily series', () => {
  const anchor = Date.UTC(2026, 0, 6, 9, 0);
  const daily = (interval = 1, extra: Partial<Recurrence> = {}): Recurrence => ({
    tz: 'UTC',
    dtStart: anchor,
    freq: 'DAILY',
    interval,
    ...extra,
  });

  it('returns the next calendar day at the same wall time', () => {
    const occ = nextOccurrence(daily(), anchor);
    expect(occ?.targetWall).toEqual(W(2026, 1, 7, 9, 0));
    expect(occ?.instant).toBe(Date.UTC(2026, 0, 7, 9, 0));
    expect(occ?.index).toBe(1);
  });

  it('honours an interval greater than one', () => {
    expect(nextOccurrence(daily(5), anchor)?.targetWall).toEqual(W(2026, 1, 11, 9, 0));
  });

  it('is strictly after the given instant', () => {
    const jan7 = Date.UTC(2026, 0, 7, 9, 0);
    expect(nextOccurrence(daily(), jan7)?.instant).toBe(Date.UTC(2026, 0, 8, 9, 0));
    expect(nextOccurrence(daily(), jan7)?.index).toBe(2);
  });

  it('floors a dtStart carrying sub-second milliseconds instead of rounding it', () => {
    const withMillis = { tz: 'UTC', dtStart: anchor + 987, freq: 'DAILY' } as const;
    const jan7 = Date.UTC(2026, 0, 7, 9, 0);

    expect(nextOccurrence(withMillis, anchor - 1)?.instant).toBe(anchor);
    expect(nextOccurrence(withMillis, anchor)?.instant).toBe(jan7);
  });

  it('walks the whole series when the cursor is decades ahead', () => {
    const far = Date.UTC(2066, 0, 6, 9, 0);
    const occ = nextOccurrence(daily(), far);
    expect(occ?.targetWall).toEqual(W(2066, 1, 7, 9, 0));
    expect(occ?.index).toBe(Math.round((Date.UTC(2066, 0, 7) - Date.UTC(2026, 0, 6)) / 86_400_000));
  });
});

describe('count bound', () => {
  const anchor = Date.UTC(2026, 0, 6, 9, 0);

  it('stops after the last occurrence of a bounded series', () => {
    const bounded: Recurrence = { tz: 'UTC', dtStart: anchor, freq: 'DAILY', count: 3 };
    expect(nextOccurrence(bounded, Date.UTC(2026, 0, 7, 9, 0))?.targetWall).toEqual(W(2026, 1, 8, 9, 0));
    expect(nextOccurrence(bounded, Date.UTC(2026, 0, 8, 9, 0))).toBeNull();
  });
});

describe('weekly series with byWeekDay', () => {
  const wednesday = Date.UTC(2026, 0, 7, 9, 0);
  const weekly = (days: WeekDay[], interval = 1): Recurrence => ({
    tz: 'UTC',
    dtStart: wednesday,
    freq: 'WEEKLY',
    interval,
    byWeekDay: days,
  });

  it('emits the selected days in chronological order, anchored to the Monday-start week', () => {
    const monFri = weekly(['MO', 'FR']);
    expect(nextOccurrence(monFri, wednesday)?.targetWall).toEqual(W(2026, 1, 9, 9, 0));
    expect(nextOccurrence(monFri, Date.UTC(2026, 0, 9, 9, 0))?.targetWall).toEqual(W(2026, 1, 12, 9, 0));
  });

  it('skips whole weeks when interval is 2', () => {
    expect(weekly(['MO'], 2).freq).toBe('WEEKLY');
    expect(nextOccurrence(weekly(['MO'], 2), wednesday)?.targetWall).toEqual(W(2026, 1, 19, 9, 0));
  });

  it('falls back to the anchor week day when byWeekDay is absent', () => {
    const occ = nextOccurrence({ tz: 'UTC', dtStart: wednesday, freq: 'WEEKLY' }, wednesday);
    expect(occ?.targetWall).toEqual(W(2026, 1, 14, 9, 0));
  });
});

describe('monthly and yearly series with byMonthDay', () => {
  const jan31 = Date.UTC(2026, 0, 31, 9, 0);

  it('resolves -1 to the last day of the month, leap years included', () => {
    const lastDay: Recurrence = { tz: 'UTC', dtStart: jan31, freq: 'MONTHLY', byMonthDay: [-1] };
    expect(nextOccurrence(lastDay, jan31)?.targetWall).toEqual(W(2026, 2, 28, 9, 0));

    const leap: Recurrence = { tz: 'UTC', dtStart: Date.UTC(2028, 0, 31, 9, 0), freq: 'MONTHLY', byMonthDay: [-1] };
    expect(nextOccurrence(leap, Date.UTC(2028, 0, 31, 9, 0))?.targetWall).toEqual(W(2028, 2, 29, 9, 0));
  });

  it('skips a month whose length cannot host the requested day', () => {
    const thirtyFirst: Recurrence = { tz: 'UTC', dtStart: jan31, freq: 'MONTHLY', byMonthDay: [31] };
    const occ = nextOccurrence(thirtyFirst, jan31);
    expect(occ?.targetWall).toEqual(W(2026, 3, 31, 9, 0));
    expect(occ?.index).toBe(1);
  });

  it('skips February for day 30 as well', () => {
    const thirty: Recurrence = { tz: 'UTC', dtStart: Date.UTC(2026, 0, 30, 9, 0), freq: 'MONTHLY', byMonthDay: [30] };
    expect(nextOccurrence(thirty, Date.UTC(2026, 0, 30, 9, 0))?.targetWall).toEqual(W(2026, 3, 30, 9, 0));
  });

  it('waits four years for the next 29 February', () => {
    const leapDay = Date.UTC(2024, 1, 29, 9, 0);
    const yearly: Recurrence = { tz: 'UTC', dtStart: leapDay, freq: 'YEARLY' };
    const occ = nextOccurrence(yearly, leapDay);
    expect(occ?.targetWall).toEqual(W(2028, 2, 29, 9, 0));
    expect(occ?.index).toBe(1);
  });
});

describe('daylight saving transitions', () => {
  const berlin = 'Europe/Berlin';

  it('rolls a spring-forward gap to the transition instant', () => {
    const dtStart = Date.UTC(2026, 2, 28, 1, 30);
    const occ = nextOccurrence({ tz: berlin, dtStart, freq: 'DAILY' }, dtStart);

    expect(occ?.targetWall).toEqual(W(2026, 3, 29, 2, 30));
    expect(occ?.disambiguation).toBe('gap-roll-forward');
    expect(occ?.instant).toBe(Date.UTC(2026, 2, 29, 1, 0));
    expect(wallClockAt(occ?.instant ?? 0, berlin)).toEqual(W(2026, 3, 29, 3, 0));
  });

  it('resolves a fall-back ambiguity to the earlier offset', () => {
    const dtStart = Date.UTC(2026, 9, 24, 0, 30);
    const occ = nextOccurrence({ tz: berlin, dtStart, freq: 'DAILY' }, dtStart);

    expect(occ?.targetWall).toEqual(W(2026, 10, 25, 2, 30));
    expect(occ?.disambiguation).toBe('earlier-offset');
    expect(occ?.instant).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(wallClockAt(occ?.instant ?? 0, berlin)).toEqual(W(2026, 10, 25, 2, 30));

    const following = nextOccurrence({ tz: berlin, dtStart, freq: 'DAILY' }, occ!.instant);
    expect(following?.instant).toBe(Date.UTC(2026, 9, 26, 1, 30));
    expect(following?.disambiguation).toBe('exact');
  });

  it('keeps the wall time fixed, so the gap between instants absorbs the shift', () => {
    const dtStart = Date.UTC(2026, 2, 28, 8, 0);
    const daily = nextOccurrence({ tz: berlin, dtStart, freq: 'DAILY' }, dtStart - 1);
    const next = nextOccurrence({ tz: berlin, dtStart, freq: 'DAILY' }, dtStart);

    expect(daily?.instant).toBe(dtStart);
    expect(next?.instant).toBe(Date.UTC(2026, 2, 29, 7, 0));
    expect(next!.instant - daily!.instant).toBe(23 * 3_600_000);
    expect(wallClockAt(next!.instant, berlin)).toEqual(W(2026, 3, 29, 9, 0));
  });

  it('handles a thirty minute transition in Australia/Lord_Howe', () => {
    const tz = 'Australia/Lord_Howe';
    const dtStart = Date.UTC(2026, 9, 2, 15, 45);
    const occ = nextOccurrence({ tz, dtStart, freq: 'DAILY' }, dtStart);

    expect(occ?.targetWall).toEqual(W(2026, 10, 4, 2, 15));
    expect(occ?.disambiguation).toBe('gap-roll-forward');
    expect(occ?.instant).toBe(Date.UTC(2026, 9, 3, 15, 30));
    expect(wallClockAt(occ?.instant ?? 0, tz)).toEqual(W(2026, 10, 4, 2, 30));
  });
});

describe('time zone boundaries', () => {
  it('does the calendar arithmetic in the target zone, not in UTC', () => {
    const istanbul = 'Europe/Istanbul';
    const dtStart = Date.UTC(2026, 0, 30, 22, 0);
    const occ = nextOccurrence({ tz: istanbul, dtStart, freq: 'DAILY' }, dtStart);

    expect(occ?.targetWall).toEqual(W(2026, 2, 1, 1, 0));
    expect(occ?.instant).toBe(Date.UTC(2026, 0, 31, 22, 0));
    expect(new Date(occ?.instant ?? 0).toISOString().slice(0, 10)).toBe('2026-01-31');
  });
});

describe('validation', () => {
  const anchor = Date.UTC(2026, 0, 6, 9, 0);

  it('rejects an interval below one', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', interval: 0 }, anchor), 'INVALID_INTERVAL');
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', interval: 1.5 }, anchor), 'INVALID_INTERVAL');
  });

  it('rejects a count below one', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', count: 0 }, anchor), 'INVALID_COUNT');
  });

  it('rejects an unknown IANA time zone', () => {
    expectError(() => nextOccurrence({ tz: 'Mars/Olympus_Mons', dtStart: anchor, freq: 'DAILY' }, anchor), 'INVALID_TIME_ZONE');
  });

  it('rejects byWeekDay outside a weekly rule', () => {
    expectError(
      () => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', byWeekDay: ['MO'] }, anchor),
      'WEEK_DAYS_REQUIRES_WEEKLY',
    );
  });

  it('rejects an empty week day list', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'WEEKLY', byWeekDay: [] }, anchor), 'INVALID_WEEK_DAYS');
  });

  it('rejects a week day token outside the Monday-start set', () => {
    const bogus = 'XX';
    expectError(
      () => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'WEEKLY', byWeekDay: [bogus as WeekDay] }, anchor),
      'INVALID_WEEK_DAYS',
    );
  });

  it('rejects an empty month day list', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'MONTHLY', byMonthDay: [] }, anchor), 'INVALID_MONTH_DAYS');
  });

  it('rejects month days outside the supported range', () => {
    const base = { tz: 'UTC', dtStart: anchor, freq: 'MONTHLY' } as const;
    expectError(() => nextOccurrence({ ...base, byMonthDay: [0] }, anchor), 'INVALID_MONTH_DAYS');
    expectError(() => nextOccurrence({ ...base, byMonthDay: [-40] }, anchor), 'INVALID_MONTH_DAYS');
    expectError(() => nextOccurrence({ ...base, byMonthDay: [32] }, anchor), 'INVALID_MONTH_DAYS');
  });

  it('rejects byMonthDay on a daily rule', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY', byMonthDay: [1] }, anchor), 'MONTH_DAYS_REQUIRES_MONTHLY');
  });

  it('rejects a non-integer cursor', () => {
    expectError(() => nextOccurrence({ tz: 'UTC', dtStart: anchor, freq: 'DAILY' }, 1.5), 'INVALID_INSTANT');
  });

  it('gives up instead of walking to the end of the Gregorian calendar', () => {
    const leapDay = Date.UTC(2024, 1, 29, 9, 0);
    expectError(
      () => nextOccurrence({ tz: 'UTC', dtStart: leapDay, freq: 'YEARLY' }, Date.UTC(9999, 0, 1, 0, 0)),
      'SEARCH_EXHAUSTED',
    );
  });

  it('reports the horizon of a bounded series instead of walking forever', () => {
    const leapDay = Date.UTC(2024, 1, 29, 9, 0);
    const bounded: Recurrence = { tz: 'UTC', dtStart: leapDay, freq: 'YEARLY', count: 3 };
    expect(nextOccurrence(bounded, Date.UTC(2028, 1, 29, 9, 0))?.targetWall).toEqual(W(2032, 2, 29, 9, 0));
    expect(nextOccurrence(bounded, Date.UTC(2032, 1, 29, 9, 0))).toBeNull();
  });
});
