import { CadenceError } from './errors.js';

export interface WallClock {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  /** 1-31 */
  readonly day: number;
  /** 0-23 */
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type Disambiguation = 'exact' | 'earlier-offset' | 'gap-roll-forward';

export interface ResolvedInstant {
  readonly instant: number;
  readonly disambiguation: Disambiguation;
}

const SECOND = 1000;
const NINETY_MINUTES = 5_400_000;
const SIX_HOURS = 21_600_000;
const MAX_EPOCH_MS = 8.64e15;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // The type says `string`; a value that arrived from outside does not have to. `undefined` is what a
  // JSON body with no `tz` turns into, and Intl reads an absent option as "use the host's zone" — so a
  // rule nobody wrote would silently acquire the time zone of whichever machine ran it.
  if (typeof timeZone !== 'string') {
    throw new CadenceError('INVALID_TIME_ZONE', 'time zone must be an IANA string');
  }

  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new CadenceError('INVALID_TIME_ZONE', `Unknown IANA time zone: "${timeZone}"`);
  }

  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function assertInstant(value: number, what: string): number {
  if (!Number.isInteger(value) || Math.abs(value) > MAX_EPOCH_MS) {
    throw new CadenceError('INVALID_INSTANT', `${what} must be an integer epoch ms, got ${String(value)}`);
  }
  return value;
}

function floorSecond(value: number): number {
  return Math.floor(value / SECOND) * SECOND;
}

export function wallClockAt(instant: number, timeZone: string): WallClock {
  assertInstant(instant, 'instant');
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((part) => part.type === type)?.value;
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      throw new CadenceError('INVALID_INSTANT', `Could not read "${type}" for instant ${String(instant)}`);
    }
    return parsed;
  };

  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

export function offsetMsAt(instant: number, timeZone: string): number {
  const base = floorSecond(assertInstant(instant, 'instant'));
  const wall = wallClockAt(base, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - base;
}

function sameWall(instant: number, target: WallClock, timeZone: string): boolean {
  const wall = wallClockAt(instant, timeZone);
  return (
    wall.year === target.year &&
    wall.month === target.month &&
    wall.day === target.day &&
    wall.hour === target.hour &&
    wall.minute === target.minute &&
    wall.second === target.second
  );
}

function firstInstantAfterTransition(low: number, high: number, timeZone: string): number {
  const afterOffset = offsetMsAt(high, timeZone);
  let lo = floorSecond(low);
  let hi = floorSecond(high);

  while (lo + SECOND < hi) {
    const mid = floorSecond((lo + hi) / 2);
    if (mid === lo || mid === hi) break;
    if (offsetMsAt(mid, timeZone) === afterOffset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return hi;
}

/**
 * Wall clock -> instant. A spring-forward gap rolls to the transition instant; a
 * fall-back ambiguity resolves to the earlier of the two matching offsets.
 *
 * The fixed-point iteration alone cannot see a fold: it converges onto one of the two
 * valid offsets and reports it as exact, so offsets are sampled on both sides of the
 * candidate before deciding.
 */
export function instantFromWallClock(wall: WallClock, timeZone: string): ResolvedInstant {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

  let guess = target - offsetMsAt(target, timeZone);
  for (let step = 0; step < 3; step += 1) {
    const next = target - offsetMsAt(guess, timeZone);
    if (next === guess) break;
    guess = next;
  }

  const offsets = new Set<number>([
    offsetMsAt(guess, timeZone),
    offsetMsAt(guess - SIX_HOURS, timeZone),
    offsetMsAt(guess - NINETY_MINUTES, timeZone),
    offsetMsAt(guess + NINETY_MINUTES, timeZone),
    offsetMsAt(guess + SIX_HOURS, timeZone),
  ]);

  const matching = [...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => sameWall(candidate, wall, timeZone))
    .sort((a, b) => a - b);

  const first = matching[0];
  if (first !== undefined) {
    return { instant: first, disambiguation: matching.length > 1 ? 'earlier-offset' : 'exact' };
  }

  const fallback = target - offsetMsAt(target, timeZone);
  return {
    instant: firstInstantAfterTransition(Math.min(guess, fallback), Math.max(guess, fallback), timeZone),
    disambiguation: 'gap-roll-forward',
  };
}
