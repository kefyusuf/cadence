import { describe, expect, it } from 'vitest';

import { createSeriesCursor } from '../src/core/cursor.js';
import { CadenceError } from '../src/core/errors.js';
import { nextOccurrence, type Occurrence, type Recurrence } from '../src/core/recurrence.js';
import { parseId } from '../src/domain/ids.js';
import type { WorkItem } from '../src/domain/model.js';
import type { Clock, ScheduleNotifier } from '../src/domain/ports.js';
import { runSeries, type SleepFn } from '../src/scheduler/run-series.js';
import { createLogNotifier, type NotifierRecord, type NotifierSink } from '../src/adapters/log-notifier.js';

function branded<K extends string>(kind: K, raw: string) {
  const parsed = parseId(kind, raw);
  if (!parsed.ok) throw new Error(`fixture id refused by the domain rule: ${raw}`);
  return parsed.value;
}

const boardId = branded('board', 'bd_core');
const itemId = branded('work-item', 'wi_deploy');
const memberId = branded('member', 'mb_yusuf');

/** The Berlin spring-forward rule: 02:30 does not exist on 2026-03-29. */
const berlin = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' } as const satisfies Recurrence;

const gapInstant = Date.UTC(2026, 2, 29, 1, 0);

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: itemId,
    boardId,
    title: 'Deploy the release',
    status: 'ready',
    assigneeId: memberId,
    estimateMinutes: 30,
    schedule: berlin,
    createdAt: 0,
    ...overrides,
  };
}

function notifierAt(clockMs: number) {
  const records: NotifierRecord[] = [];
  const sink: NotifierSink = (record) => {
    records.push(record);
  };
  return { records, notifier: createLogNotifier({ sink, clock: { now: () => clockMs } }) };
}

const plain: Occurrence = {
  instant: gapInstant,
  index: 4,
  disambiguation: 'exact',
  targetWall: { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 15 },
};

describe('createLogNotifier', () => {
  it('writes exactly one record for the occurrence it is given', async () => {
    const { notifier, records } = notifierAt(gapInstant);

    await notifier.notify(item(), plain);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      msg: 'cadence.due',
      itemId: 'wi_deploy',
      boardId: 'bd_core',
      assigneeId: 'mb_yusuf',
      title: 'Deploy the release',
      index: 4,
      disambiguation: 'exact',
    });
  });

  it('keeps both the wall clock that was asked for and the instant it resolved to', async () => {
    const { notifier, records } = notifierAt(gapInstant);
    const gap = nextOccurrence(berlin, berlin.dtStart);
    expect(gap).not.toBeNull();

    await notifier.notify(item(), gap!);

    expect(records[0]).toMatchObject({
      due: '2026-03-29T01:00:00.000Z',
      wall: '2026-03-29 02:30:00',
      disambiguation: 'gap-roll-forward',
      tz: 'Europe/Berlin',
    });
  });

  it('stamps emittedAt from the injected clock, twice identically', async () => {
    const { notifier, records } = notifierAt(gapInstant + 500);

    await notifier.notify(item(), plain);
    await notifier.notify(item(), plain);

    expect(records.map((record) => record.emittedAt)).toEqual([
      '2026-03-29T01:00:00.500Z',
      '2026-03-29T01:00:00.500Z',
    ]);
  });

  it('calls an occurrence late only when the clock is past its instant', async () => {
    const cases = [
      { clockMs: gapInstant - 1, late: false },
      { clockMs: gapInstant, late: false },
      { clockMs: gapInstant + 1, late: true },
    ];

    for (const testCase of cases) {
      const { notifier, records } = notifierAt(testCase.clockMs);
      await notifier.notify(item(), plain);
      expect(records[0]?.late, `clock at ${String(testCase.clockMs)}`).toBe(testCase.late);
    }
  });

  it('reports the rule time zone, or null when the item has no schedule', async () => {
    const scheduled = notifierAt(gapInstant);
    await scheduled.notifier.notify(item(), plain);
    expect(scheduled.records[0]?.tz).toBe('Europe/Berlin');

    const unscheduled = notifierAt(gapInstant);
    await unscheduled.notifier.notify(item({ schedule: null }), plain);
    expect(unscheduled.records[0]?.tz).toBeNull();
  });

  it('passes a sink failure through untouched', async () => {
    const failure = new CadenceError('UNEXPECTED', 'the transport is down');
    const thrown = createLogNotifier({
      sink: () => {
        throw failure;
      },
      clock: { now: () => gapInstant },
    });

    await expect(thrown.notify(item(), plain)).rejects.toBe(failure);
  });

  it('holds no state between the items it notifies', async () => {
    const { notifier, records } = notifierAt(gapInstant);
    const other = item({ id: branded('work-item', 'wi_other'), title: 'Rotate the keys' });

    await notifier.notify(item(), plain);
    await notifier.notify(other, { ...plain, index: 9 });

    expect(records.map((record) => [record.itemId, record.title, record.index])).toEqual([
      ['wi_deploy', 'Deploy the release', 4],
      ['wi_other', 'Rotate the keys', 9],
    ]);
  });

  it('renders a record that survives a JSON pipeline with ids as plain strings', async () => {
    const { notifier, records } = notifierAt(gapInstant);
    await notifier.notify(item({ assigneeId: null }), plain);

    const record = records[0];
    if (!record) throw new Error('the notifier wrote no record');
    expect(typeof record.itemId).toBe('string');
    expect(record).toHaveProperty('assigneeId', null);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    expect(JSON.stringify(record)).not.toContain('undefined');
  });

  it('resolves to undefined, which is the whole port', async () => {
    const { notifier } = notifierAt(gapInstant);
    await expect(notifier.notify(item(), plain)).resolves.toBeUndefined();
  });

  it('satisfies ScheduleNotifier without a cast', () => {
    const clock: Clock = { now: () => gapInstant };
    const typed: ScheduleNotifier = createLogNotifier({ sink: () => undefined, clock });

    expect(typeof typed.notify).toBe('function');
  });
});

/**
 * The port is only real once something drives it. These run the adapter through `runSeries` the
 * way week 4 will: `notify: (occurrence) => notifier.notify(item, occurrence)`, with no helper in
 * between.
 */
describe('the notifier driven by runSeries', () => {
  function runWith(sink: NotifierSink, clockStart: number) {
    let current = clockStart;
    const clock: Clock = { now: () => current };
    const records: NotifierRecord[] = [];
    const notifier = createLogNotifier({
      sink: async (record) => {
        await sink(record);
        records.push(record);
      },
      clock,
    });
    const cursor = createSeriesCursor(berlin);
    const sleep: SleepFn = (ms) => {
      current += ms;
      return Promise.resolve();
    };
    const run = runSeries(cursor, {
      clock,
      sleep,
      notify: (occurrence) => notifier.notify(item(), occurrence),
      limit: 3,
    });
    return { records, cursor, run };
  }

  it('records every occurrence of a run in due order, DST gap included', async () => {
    const { records, run } = runWith(() => undefined, Date.UTC(2026, 2, 28, 1, 30));

    await expect(run).resolves.toEqual({ delivered: 3, late: 0, endedBy: 'limit' });

    expect(records.map((record) => [record.index, record.due, record.wall, record.disambiguation])).toEqual([
      [0, '2026-03-28T01:30:00.000Z', '2026-03-28 02:30:00', 'exact'],
      [1, '2026-03-29T01:00:00.000Z', '2026-03-29 02:30:00', 'gap-roll-forward'],
      [2, '2026-03-30T00:30:00.000Z', '2026-03-30 02:30:00', 'exact'],
    ]);
  });

  it('stamps emittedAt with the time the run actually reached', async () => {
    const { records, run } = runWith(() => undefined, Date.UTC(2026, 2, 28, 1, 30));

    await run;

    expect(records.map((record) => record.emittedAt)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ]);
    expect(records.every((record) => !record.late)).toBe(true);
  });

  it('costs the occurrence when the sink throws: the cursor consumed it before notifying', async () => {
    const failure = new CadenceError('UNEXPECTED', 'the transport is down');
    let transportDown = true;
    const delivered: number[] = [];
    let current = Date.UTC(2026, 2, 28, 1, 30);
    const clock: Clock = { now: () => current };
    const notifier = createLogNotifier({
      sink: (record) => {
        if (transportDown) throw failure;
        delivered.push(record.index);
      },
      clock,
    });
    const cursor = createSeriesCursor(berlin);
    const advance: SleepFn = (ms) => {
      current += ms;
      return Promise.resolve();
    };
    const options = {
      clock,
      sleep: advance,
      notify: (occurrence: Occurrence) => notifier.notify(item(), occurrence),
      limit: 1,
    };

    await expect(runSeries(cursor, options)).rejects.toBe(failure);
    expect(cursor.consumed()).toBe(1);

    transportDown = false;
    await expect(runSeries(cursor, options)).resolves.toEqual({ delivered: 1, late: 0, endedBy: 'limit' });
    expect(delivered).toEqual([1]);
  });
});
