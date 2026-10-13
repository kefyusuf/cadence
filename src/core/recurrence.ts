import { CadenceError } from './errors.js';
import { fromThrowable, type Result } from './result.js';
import { assertInstant, instantFromWallClock, wallClockAt, type Disambiguation, type WallClock } from './clock.js';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export const WEEK_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export interface Recurrence {
  readonly tz: string;
  /** Anchor instant in epoch ms. Its wall date and time of day seed the series. */
  readonly dtStart: number;
  readonly freq: Frequency;
  readonly interval?: number | undefined;
  readonly byWeekDay?: readonly WeekDay[] | undefined;
  /** Positive = day of month, negative = counted back from the last day. */
  readonly byMonthDay?: readonly number[] | undefined;
  readonly count?: number | undefined;
}

export interface Occurrence {
  readonly instant: number;
  /** Requested wall clock; read the resolved local time from `instant`. */
  readonly targetWall: WallClock;
  /** Zero-based position in the series; occurrences that fall on missing days are not counted. */
  readonly index: number;
  readonly disambiguation: Disambiguation;
}

interface Normalized {
  readonly tz: string;
  readonly dtStart: number;
  readonly freq: Frequency;
  readonly interval: number;
  readonly weekDays: readonly number[];
  readonly monthDays: readonly number[] | null;
  readonly count: number | null;
}

const DAY_MS = 86_400_000;
const MAX_CANDIDATES = 200_000;
const LAST_SUPPORTED_YEAR = 9999;

function isWeekDayToken(token: string): token is WeekDay {
  return (WEEK_DAYS as readonly string[]).includes(token);
}

function weekIndexOf(token: WeekDay): number {
  return WEEK_DAYS.indexOf(token);
}

function normalize(rec: Recurrence): Normalized {
  const interval = rec.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new CadenceError('INVALID_INTERVAL', `interval must be an integer >= 1, got ${String(rec.interval)}`);
  }

  const count = rec.count ?? null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) {
    throw new CadenceError('INVALID_COUNT', `count must be an integer >= 1, got ${String(rec.count)}`);
  }

  let weekDays: number[] = [];
  if (rec.byWeekDay !== undefined) {
    if (rec.freq !== 'WEEKLY') {
      throw new CadenceError('WEEK_DAYS_REQUIRES_WEEKLY', `byWeekDay is only valid for WEEKLY, got ${rec.freq}`);
    }
    if (rec.byWeekDay.length === 0) {
      throw new CadenceError('INVALID_WEEK_DAYS', 'byWeekDay must not be empty');
    }
    const indexes = rec.byWeekDay.map((token) => {
      if (!isWeekDayToken(token)) {
        throw new CadenceError('INVALID_WEEK_DAYS', `Unknown week day token: ${String(token)}`);
      }
      return weekIndexOf(token);
    });
    weekDays = [...new Set(indexes)].sort((a, b) => a - b);
  }

  let monthDays: readonly number[] | null = null;
  if (rec.byMonthDay !== undefined) {
    if (rec.freq !== 'MONTHLY' && rec.freq !== 'YEARLY') {
      throw new CadenceError('MONTH_DAYS_REQUIRES_MONTHLY', `byMonthDay is only valid for MONTHLY or YEARLY, got ${rec.freq}`);
    }
    if (rec.byMonthDay.length === 0) {
      throw new CadenceError('INVALID_MONTH_DAYS', 'byMonthDay must not be empty');
    }
    for (const value of rec.byMonthDay) {
      if (!Number.isInteger(value) || Math.abs(value) < 1 || Math.abs(value) > 31) {
        throw new CadenceError('INVALID_MONTH_DAYS', `byMonthDay values must be integers in [-31, -1] or [1, 31], got ${String(value)}`);
      }
    }
    monthDays = [...new Set(rec.byMonthDay)].sort((a, b) => Math.abs(a) - Math.abs(b));
  }

  return {
    tz: rec.tz,
    dtStart: assertInstant(rec.dtStart, 'dtStart'),
    freq: rec.freq,
    interval,
    weekDays,
    monthDays,
    count,
  };
}

function isoDayIndex(wall: WallClock): number {
  const dow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return (dow + 6) % 7;
}

function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function addMonths(wall: WallClock, months: number): WallClock {
  const total = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, day: 1, hour: 0, minute: 0, second: 0 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** null when the requested day does not exist in this month, which skips the occurrence. */
function resolveMonthDay(year: number, month: number, spec: number): number | null {
  const length = daysInMonth(year, month);
  if (spec > 0) return spec > length ? null : spec;
  const day = length + 1 + spec;
  return day < 1 ? null : day;
}

function withTimeOfDay(date: WallClock, anchor: WallClock): WallClock {
  return { ...date, hour: anchor.hour, minute: anchor.minute, second: anchor.second };
}

function* periodWalls(rec: Normalized, anchor: WallClock, period: number): Generator<WallClock> {
  switch (rec.freq) {
    case 'DAILY':
      yield withTimeOfDay(addDays(anchor, period * rec.interval), anchor);
      return;

    case 'WEEKLY': {
      const days = rec.weekDays.length > 0 ? rec.weekDays : [isoDayIndex(anchor)];
      const weekStart = addDays(anchor, -isoDayIndex(anchor) + period * 7 * rec.interval);
      for (const offset of days) {
        yield withTimeOfDay(addDays(weekStart, offset), anchor);
      }
      return;
    }

    case 'MONTHLY': {
      const month = addMonths(anchor, period * rec.interval);
      const specs = rec.monthDays ?? [anchor.day];
      for (const spec of specs) {
        const day = resolveMonthDay(month.year, month.month, spec);
        if (day !== null) yield withTimeOfDay({ ...month, day }, anchor);
      }
      return;
    }

    case 'YEARLY': {
      const year = anchor.year + period * rec.interval;
      if (year > LAST_SUPPORTED_YEAR) return;
      const specs = rec.monthDays ?? [anchor.day];
      for (const spec of specs) {
        const day = resolveMonthDay(year, anchor.month, spec);
        if (day !== null) yield withTimeOfDay({ year, month: anchor.month, day, hour: 0, minute: 0, second: 0 }, anchor);
      }
      return;
    }
  }
}

/**
 * The series as a lazy sequence, starting at the anchor. Validation and the anchor read
 * happen eagerly so a broken rule fails when the series is created, not on first pull.
 */
export function occurrences(recurrence: Recurrence): Generator<Occurrence, void> {
  const rec = normalize(recurrence);
  const anchor = wallClockAt(rec.dtStart, rec.tz);

  function* walk(): Generator<Occurrence, void> {
    let index = 0;
    let examined = 0;

    for (let period = 0; ; period += 1) {
      let produced = 0;

      for (const wall of periodWalls(rec, anchor, period)) {
        produced += 1;
        examined += 1;
        if (examined > MAX_CANDIDATES) {
          throw new CadenceError('SEARCH_EXHAUSTED', `Gave up after ${String(MAX_CANDIDATES)} candidate occurrences`);
        }

        const resolved = instantFromWallClock(wall, rec.tz);
        yield { instant: resolved.instant, targetWall: wall, index, disambiguation: resolved.disambiguation };
        index += 1;
      }

      if (rec.count !== null && index >= rec.count) return;

      if (produced === 0 && period > 4000) {
        throw new CadenceError('SEARCH_EXHAUSTED', 'Recurrence produced no candidate occurrences in 4000 periods');
      }
    }
  }

  return walk();
}

/** The first occurrence strictly after `after`, or null when the series is bounded. */
export function nextOccurrence(recurrence: Recurrence, after: number): Occurrence | null {
  const afterInstant = assertInstant(after, 'after');

  for (const occurrence of occurrences(recurrence)) {
    if (occurrence.instant > afterInstant) return occurrence;
  }

  return null;
}

/** `nextOccurrence` for callers that want a value instead of an exception. */
export function tryNextOccurrence(recurrence: Recurrence, after: number): Result<Occurrence | null, CadenceError> {
  return fromThrowable(() => nextOccurrence(recurrence, after));
}
