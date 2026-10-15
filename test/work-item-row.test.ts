import { describe, expect, it } from 'vitest';

import type { CadenceError } from '../src/core/errors.js';
import type { Recurrence } from '../src/core/recurrence.js';
import { isOk, type Result } from '../src/core/result.js';
import { createEstimate } from '../src/domain/estimate.js';
import { parseId } from '../src/domain/ids.js';
import { WORK_ITEM_STATUSES, parseStatus, type WorkItem } from '../src/domain/model.js';
import { parseSchedule } from '../src/domain/schedule.js';
import { parseWorkItemRow, toWorkItemRow } from '../src/domain/work-item-row.js';

function branded<K extends string>(kind: K, raw: string) {
  const parsed = parseId(kind, raw);
  if (!parsed.ok) throw new Error(`fixture id refused by the domain rule: ${raw}`);

  return parsed.value;
}

const boardId = branded('board', 'bd_core');
const itemId = branded('work-item', 'wi_deploy');
const memberId = branded('member', 'mb_yusuf');

const weekly = {
  tz: 'Europe/Berlin',
  dtStart: Date.UTC(2026, 2, 28, 1, 30),
  freq: 'WEEKLY',
  byWeekDay: ['MO', 'FR'],
} as const satisfies Recurrence;

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: itemId,
    boardId,
    title: 'Deploy the release',
    status: 'ready',
    assigneeId: memberId,
    estimateMinutes: createEstimate(30),
    schedule: weekly,
    createdAt: 1_772_000_000_000,
    ...overrides,
  };
}

function rowOf(overrides: Partial<WorkItem> = {}): Record<string, unknown> {
  return { ...toWorkItemRow(item(overrides)) };
}

/** A door's refusal, taken apart so a test can name both the rule that refused and the words it used. */
function refused(run: () => Result<unknown, CadenceError>): CadenceError {
  const result = run();
  if (isOk(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);

  return result.error;
}

const refusedRow = (raw: unknown): CadenceError => refused(() => parseWorkItemRow(raw));
const refusedStatus = (raw: unknown): CadenceError => refused(() => parseStatus(raw));
const refusedSchedule = (raw: unknown): CadenceError => refused(() => parseSchedule(raw));

/** Read a whole row back, or fail the test with the message the codec wrote. */
function hydrate(raw: unknown): WorkItem {
  const parsed = parseWorkItemRow(raw);
  if (!parsed.ok) throw new Error(`row refused: ${parsed.error.message}`);

  return parsed.value;
}

/**
 * A row is what a store with columns can hold: every field is something JSON carries. The estimate is the
 * interesting one — it owns a comparison method and a phantom brand, and neither of them fits in a
 * `NUMBER` column — so the row holds the number, and this codec is the only door that turns it back into
 * a value. ADR 0012 left that door unwritten; this file is where it gets written.
 */
describe('toWorkItemRow', () => {
  it('puts the value down to the number a column can hold', () => {
    const row = toWorkItemRow(item());

    expect(row.estimateMinutes).toBe(30);
    expect(typeof row.estimateMinutes).toBe('number');
  });

  it('is JSON all the way down', () => {
    const row = toWorkItemRow(item());

    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    // A row is not a shrunken item: `Estimate.toJSON` already answers `30`, so the two spell the same 253
    // bytes (host, Node v26.8.2, off `dist`) and only their types differ. What a store writes is therefore not
    // what it stores — the wire is the same, the value behind it is not.
    expect(JSON.stringify(row)).toBe(JSON.stringify(item()));
  });

  it('survives a clone, which the item it was built from does not', () => {
    const row = toWorkItemRow(item());

    expect(structuredClone(row)).toEqual(row);
    expect(() => structuredClone(item())).toThrow();
  });

  it('leaves an absent estimate, assignee or schedule as the null a column stores', () => {
    expect(toWorkItemRow(item({ estimateMinutes: null, schedule: null, assigneeId: null }))).toEqual({
      id: itemId,
      boardId,
      title: 'Deploy the release',
      status: 'ready',
      assigneeId: null,
      estimateMinutes: null,
      schedule: null,
      createdAt: 1_772_000_000_000,
    });
  });

  it('keeps the schedule as the plain rule it already was', () => {
    expect(toWorkItemRow(item()).schedule).toEqual(weekly);
  });
});

describe('parseStatus', () => {
  it('accepts every status the domain itself lists', () => {
    for (const status of WORK_ITEM_STATUSES) {
      const parsed = parseStatus(status);
      expect(parsed.ok, status).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(status);
    }
  });

  it('refuses anything outside the vocabulary, naming what it was given', () => {
    for (const raw of ['archived', 'BACKLOG', 'Ready', '', 7, null, undefined, {}, ['done']]) {
      expect(refusedStatus(raw).code, JSON.stringify(raw)).toBe('INVALID_STATUS');
    }
  });

  it('says it in the words the HTTP door has been saying since week 4', () => {
    expect(refusedStatus(7).message).toBe('status must be one of backlog, ready, in_progress, blocked, done, got 7');
    expect(refusedStatus(null).message).toBe(
      'status must be one of backlog, ready, in_progress, blocked, done, got null',
    );
  });
});

describe('parseSchedule', () => {
  it('takes an absent schedule as no schedule', () => {
    for (const raw of [null, undefined]) {
      const parsed = parseSchedule(raw);
      expect(parsed.ok, String(raw)).toBe(true);
      if (parsed.ok) expect(parsed.value).toBeNull();
    }
  });

  it('asks the engine whether a rule can be followed, without repeating what the engine requires', () => {
    expect(parseSchedule(weekly).ok).toBe(true);
    const refusal = refusedSchedule({ ...weekly, freq: 'HOURLY' });
    expect(refusal.code).toBe('INVALID_FREQUENCY');
    expect(refusal.message).toBe('freq must be one of DAILY, WEEKLY, MONTHLY, YEARLY, got HOURLY');
    expect(refusedSchedule({ ...weekly, freq: 'DAILY' }).code).toBe('WEEK_DAYS_REQUIRES_WEEKLY');
  });

  it('refuses something that is not a rule before the engine is asked to name its fields', () => {
    // The engine answers a non-object with `freq must be one of …, got undefined`, which reports the
    // engine's own parameter for a value that never had one — the same confusion ADR 0008 removed
    // from the door.
    const refusal = refusedSchedule('PT5M');
    expect(refusal.code).toBe('INVALID_SCHEDULE');
    expect(refusal.message).toBe('schedule must be an object or null, got "PT5M"');
    expect(refusedSchedule(7).code).toBe('INVALID_SCHEDULE');
    expect(refusedSchedule([weekly]).code).toBe('INVALID_SCHEDULE');
  });

  it('hands back the rule it was given, not a normalised copy of it', () => {
    const given = { ...weekly, interval: 2 };
    const parsed = parseSchedule(given);
    if (!parsed.ok) throw new Error('a legal rule was refused');

    expect(parsed.value).toBe(given);
    expect(parsed.value).toEqual({ ...weekly, interval: 2 });
  });

  it('labels a throw the engine did not write, and keeps it as the cause', () => {
    // The engine checks that `byWeekDay` holds known tokens but never that it is an array at all, so a rule
    // spelling it `"MO"` reaches a bare TypeError inside the cursor. That is this process's problem, not the
    // caller's, and the door says so with the code `fromThrowable` owns while keeping the original failure.
    const refusal = refusedSchedule({ ...weekly, byWeekDay: 'MO' });

    expect(refusal.code).toBe('UNEXPECTED');
    expect(refusal.cause).toBeInstanceOf(TypeError);
  });
});

/**
 * `parseWorkItemRow` is a door, so it is handed `unknown`: what a driver returns is not what its declared
 * type says. It refuses rather than building a half-formed item, because `WorkItem` is where "the estimate
 * is a value and the ids have these shapes" is written.
 */
describe('parseWorkItemRow', () => {
  it('round-trips a row back to the item it came from', () => {
    const row = toWorkItemRow(item());

    expect(toWorkItemRow(hydrate(row))).toEqual(row);
  });

  it('rebuilds the value so it equals the original without being the original', () => {
    const saved = item();
    const loaded = hydrate(toWorkItemRow(saved));
    if (loaded.estimateMinutes === null) throw new Error('the row lost its estimate');

    expect(loaded.estimateMinutes.equals(saved.estimateMinutes)).toBe(true);
    expect(loaded.estimateMinutes).not.toBe(saved.estimateMinutes);
  });

  it('hands back the ids as strings and the schedule as the rule it was', () => {
    const loaded = hydrate(toWorkItemRow(item()));

    expect(loaded.id).toBe(itemId);
    expect(loaded.boardId).toBe(boardId);
    expect(loaded.assigneeId).toBe(memberId);
    expect(loaded.schedule).toEqual(weekly);
    expect(loaded.createdAt).toBe(1_772_000_000_000);
  });

  it('reads a field the row does not carry as the absence the item type names', () => {
    const { assigneeId: _assignee, estimateMinutes: _estimate, ...withoutEither } = toWorkItemRow(item());

    expect(hydrate(withoutEither)).toMatchObject({ assigneeId: null, estimateMinutes: null });
    expect(hydrate({ ...rowOf(), assigneeId: undefined }).assigneeId).toBeNull();
  });

  it('refuses a row that is not an object', () => {
    for (const raw of [null, 'wi_deploy', 7, [itemId]]) {
      expect(refusedRow(raw).code, String(raw)).toBe('INVALID_WORK_ITEM');
    }
    expect(refusedRow(null).message).toBe('a work item row must be a JSON object, got null');
  });

  it('refuses an id whose shape the domain rule refuses', () => {
    expect(refusedRow({ ...rowOf(), id: 'wi_deploy ' }).code).toBe('INVALID_ID');
    expect(refusedRow({ ...rowOf(), id: '' }).code).toBe('INVALID_ID');
    expect(refusedRow({ ...rowOf(), boardId: 42 }).code).toBe('INVALID_ID');
    expect(refusedRow({ ...rowOf(), assigneeId: 'mb you cannot' }).code).toBe('INVALID_ID');
  });

  it('refuses an estimate that is not whole minutes', () => {
    for (const raw of [30.5, '30', -1, NaN, true]) {
      expect(refusedRow({ ...rowOf(), estimateMinutes: raw }).code, String(raw)).toBe('INVALID_ESTIMATE');
    }
  });

  it('refuses a status outside the vocabulary', () => {
    expect(refusedRow({ ...rowOf(), status: 'archived' }).code).toBe('INVALID_STATUS');
  });

  it('refuses a createdAt the clock cannot name', () => {
    for (const raw of [1.5, '1772000000000', undefined, NaN]) {
      expect(refusedRow({ ...rowOf(), createdAt: raw }).code, String(raw)).toBe('INVALID_INSTANT');
    }
  });

  it('refuses a row that cannot carry a title, and only that', () => {
    const { title: _title, ...withoutTitle } = toWorkItemRow(item());
    const refusal = refusedRow(withoutTitle);

    expect(refusal.code).toBe('INVALID_WORK_ITEM');
    expect(refusal.message).toBe('title must be a string, got undefined');

    // How long and how empty are the request body's rules, written once in the HTTP door. A row that
    // reached the store by another route is not that door's business, so the gap is pinned, not hidden.
    expect(hydrate({ ...rowOf(), title: '' }).title).toBe('');
  });

  it('refuses a schedule the engine cannot follow', () => {
    expect(refusedRow({ ...rowOf(), schedule: 'PT5M' }).code).toBe('INVALID_SCHEDULE');
    expect(refusedRow({ ...rowOf(), schedule: { ...weekly, freq: 'HOURLY' } }).code).toBe('INVALID_FREQUENCY');
  });

  it('checks the shape of an id, not which kind it is, because the prefix belongs to the door', () => {
    // A `bd_core` in the work-item slot is well-formed ASCII and refuses nothing here: the brand is
    // compile-time only, and the `wi_` namespace check lives with the URL that carried it.
    expect(hydrate({ ...rowOf(), id: boardId }).id).toBe(boardId);
  });

  it('ignores the columns a row store adds around the ones the domain knows', () => {
    expect(hydrate({ ...rowOf(), updated_at: 1, board_name: 'Core platform' }).title).toBe('Deploy the release');
  });

  it('refuses the worst field it was handed before the better ones are built', () => {
    // Order matters only for the message a caller reads first: every refusal is a refusal.
    expect(refusedRow({ id: 'wi bad!', status: 'archived', estimateMinutes: 30.5 }).message).toBe(
      'work-item id must match [A-Za-z0-9][A-Za-z0-9._:-]*, got "wi bad!"',
    );
  });
});
