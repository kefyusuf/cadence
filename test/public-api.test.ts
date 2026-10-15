import { describe, expect, it } from 'vitest';

import * as cadence from '../src/core/index.js';
import * as cadenceDomain from '../src/domain/index.js';
import * as cadenceScheduler from '../src/scheduler/index.js';

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
    expect(Object.keys(cadenceDomain).sort()).toEqual([
      'createEstimate',
      'parseEstimate',
      'parseId',
      'parseSchedule',
      'parseStatus',
      'parseWorkItemRow',
      'toWorkItemRow',
    ]);
  });

  it('lets a consumer put an item through a row and back', () => {
    // The row is what a store with columns holds, so the two directions have to be reachable from the same
    // entry point a consumer already uses for the values: a codec that only the server could call would leave
    // an outside store building `WorkItem`s by hand.
    const row: cadenceDomain.WorkItemRow = {
      id: 'wi_deploy',
      boardId: 'bd_core',
      title: 'Deploy the release',
      status: 'ready',
      assigneeId: null,
      estimateMinutes: 30,
      schedule: { tz: 'UTC', dtStart: Date.UTC(2026, 0, 6, 9, 0), freq: 'DAILY' },
      createdAt: 0,
    };

    const parsed = cadenceDomain.parseWorkItemRow(row);
    if (parsed.ok !== true) throw new Error(`a whole row was refused: ${parsed.error.message}`);
    if (parsed.value.estimateMinutes === null) throw new Error('the row lost its estimate');

    expect(parsed.value.estimateMinutes.equals(cadenceDomain.createEstimate(30))).toBe(true);
    expect(cadenceDomain.toWorkItemRow(parsed.value)).toEqual(row);
  });

  it('lets a consumer build the value the model is made of', () => {
    // A `WorkItem` carries an `Estimate`, so a package that could not reach a constructor could not make a
    // work item at all: the type would be public while the value behind it was not.
    const parsed = cadenceDomain.parseEstimate(30);
    if (parsed.ok !== true) throw new Error(`a whole minute count off the wire was refused: ${parsed.error.message}`);

    expect(parsed.value.equals(cadenceDomain.createEstimate(30))).toBe(true);
  });

  it('exposes exactly the scheduler runtime exports', () => {
    expect(Object.keys(cadenceScheduler).sort()).toEqual(['runSeries', 'sleep']);
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
