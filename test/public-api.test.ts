import { describe, expect, it } from 'vitest';

import * as cadence from '../src/core/index.js';
import * as cadenceDomain from '../src/domain/index.js';

const CORE_RUNTIME_EXPORTS = [
  'CADENCE_ERROR_CODES',
  'CadenceError',
  'WEEK_DAYS',
  'andThen',
  'createSeriesCursor',
  'err',
  'fromThrowable',
  'instantFromWallClock',
  'isCadenceError',
  'isOk',
  'mapResult',
  'nextOccurrence',
  'ok',
  'occurrences',
  'tryNextOccurrence',
  'unwrapOr',
  'wallClockAt',
];

describe('public surface', () => {
  it('exposes exactly the core runtime exports', () => {
    expect(Object.keys(cadence).sort()).toEqual([...CORE_RUNTIME_EXPORTS].sort());
  });

  it('exposes exactly the domain runtime exports', () => {
    expect(Object.keys(cadenceDomain)).toEqual(['parseId']);
  });

  it('serves wall-clock correct occurrences through the barrel', () => {
    const dtStart = Date.UTC(2026, 0, 6, 9, 0);
    const recurrence = { tz: 'Europe/Berlin', dtStart, freq: 'DAILY' } as const;

    expect(cadence.nextOccurrence(recurrence, dtStart)).toEqual({
      instant: Date.UTC(2026, 0, 7, 9, 0),
      targetWall: { year: 2026, month: 1, day: 7, hour: 10, minute: 0, second: 0 },
      index: 1,
      disambiguation: 'exact',
    });
  });

  it('keeps validation reachable from the barrel', () => {
    const result = cadence.tryNextOccurrence({ tz: 'UTC', dtStart: 1.5, freq: 'DAILY' }, 0);
    if (result.ok) throw new Error('expected a rejected recurrence');
    expect(result.error.code).toBe('INVALID_INSTANT');
  });
});
