import { describe, expect, it } from 'vitest';

import { CadenceError } from '../src/core/errors.js';
import { instantFromWallClock, offsetMsAt, wallClockAt, type WallClock } from '../src/core/clock.js';

const W = (year: number, month: number, day: number, hour: number, minute: number, second = 0): WallClock => ({
  year,
  month,
  day,
  hour,
  minute,
  second,
});

const ZONES = [
  'UTC',
  'Europe/Istanbul',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
] as const;

describe('wallClockAt', () => {
  it('reads local fields through the zone offset', () => {
    expect(wallClockAt(Date.UTC(2026, 6, 14, 21, 0), 'Europe/Istanbul')).toEqual(W(2026, 7, 15, 0, 0));
    expect(wallClockAt(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Kathmandu')).toEqual(W(2026, 1, 15, 17, 45));
  });

  it('rejects a non-integer or out-of-range instant', () => {
    let thrown: unknown;
    try {
      wallClockAt(1.5, 'UTC');
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CadenceError).code).toBe('INVALID_INSTANT');

    expect(() => wallClockAt(9e15, 'UTC')).toThrow(CadenceError);
  });

  it('rejects an unknown zone before touching the clock', () => {
    expect(() => wallClockAt(0, 'Nowhere/Special')).toThrow(CadenceError);
  });
});

describe('offsetMsAt', () => {
  it('tracks the summer shift', () => {
    expect(offsetMsAt(Date.UTC(2026, 0, 15, 12, 0), 'Europe/Berlin')).toBe(3_600_000);
    expect(offsetMsAt(Date.UTC(2026, 6, 15, 12, 0), 'Europe/Berlin')).toBe(7_200_000);
  });

  it('supports offsets that are not whole hours', () => {
    expect(offsetMsAt(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Kathmandu')).toBe(20_700_000);
    expect(offsetMsAt(Date.UTC(2026, 6, 15, 12, 0), 'Australia/Lord_Howe')).toBe(37_800_000);
    expect(offsetMsAt(Date.UTC(2026, 0, 15, 12, 0), 'Australia/Lord_Howe')).toBe(39_600_000);
  });
});

describe('instantFromWallClock', () => {
  it('round-trips local noon across zones with odd offsets', () => {
    for (const timeZone of ZONES) {
      for (let month = 0; month < 12; month += 1) {
        const instant = Date.UTC(2026, month, 15, 12, 0);
        const resolved = instantFromWallClock(wallClockAt(instant, timeZone), timeZone);
        expect(resolved.instant, `${timeZone} month ${month + 1}`).toBe(instant);
      }
    }
  });

  it('keeps sub-second instants out of the series', () => {
    const resolved = instantFromWallClock(W(2026, 1, 15, 12, 0), 'UTC');
    expect(resolved.instant % 1000).toBe(0);
    expect(resolved).toEqual({ instant: Date.UTC(2026, 0, 15, 12, 0), disambiguation: 'exact' });
  });

  it('rolls a nonexistent spring-forward time to the transition instant', () => {
    const resolved = instantFromWallClock(W(2026, 3, 29, 2, 30), 'Europe/Berlin');
    expect(resolved).toEqual({ instant: Date.UTC(2026, 2, 29, 1, 0), disambiguation: 'gap-roll-forward' });
  });

  it('picks the first of two matching fall-back times', () => {
    const resolved = instantFromWallClock(W(2026, 10, 25, 2, 30), 'Europe/Berlin');
    expect(resolved).toEqual({ instant: Date.UTC(2026, 9, 25, 0, 30), disambiguation: 'earlier-offset' });
  });

  it('rolls a gap created by a thirty minute shift', () => {
    const resolved = instantFromWallClock(W(2026, 10, 4, 2, 15), 'Australia/Lord_Howe');
    expect(resolved).toEqual({ instant: Date.UTC(2026, 9, 3, 15, 30), disambiguation: 'gap-roll-forward' });
    expect(wallClockAt(resolved.instant, 'Australia/Lord_Howe')).toEqual(W(2026, 10, 4, 2, 30));
  });
});
