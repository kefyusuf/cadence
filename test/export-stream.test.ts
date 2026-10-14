import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { EXPORT_HIGH_WATER_MARK, createExportStream } from '../src/server/export-stream.js';
import type { ExportRow, OccurrenceRow } from '../src/server/export-stream.js';
import type { Recurrence } from '../src/core/recurrence.js';
import { parseId, type BoardId } from '../src/domain/ids.js';
import type { WorkItem } from '../src/domain/model.js';

function branded<K extends string>(kind: K, raw: string) {
  const parsed = parseId(kind, raw);
  if (!parsed.ok) throw new Error(`fixture id refused by the domain rule: ${raw}`);

  return parsed.value;
}

const boardId: BoardId = branded('board', 'bd_core');

/** The rule week 3 measured across the Berlin gap: 02:30 every day, starting the day before it opens. */
const daily = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' } as const satisfies Recurrence;
const twice = { ...daily, count: 2 } as const satisfies Recurrence;
/**
 * A rule the engine can start but not follow: past year 9999 the yearly period yields no candidate, and
 * after 4000 empty ones the walk gives up. Measured at 12 ms, so the failure is reachable inside a body
 * without the suite having to wait for `MAX_CANDIDATES`.
 */
const pastTheCeiling = { tz: 'Europe/Berlin', dtStart: Date.UTC(9999, 11, 31, 9, 0), freq: 'YEARLY' } as const satisfies Recurrence;

function item(id: string, schedule: Recurrence | null, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: branded('work-item', id),
    boardId,
    title: `Item ${id}`,
    status: 'ready',
    assigneeId: null,
    estimateMinutes: null,
    schedule,
    createdAt: 0,
    ...overrides,
  };
}

/** One line of the body, read back as the row it was written from. */
function row(line: string): ExportRow {
  return JSON.parse(line) as ExportRow;
}

/** Rows in a test are read for their fields, so a row of the wrong kind is a fixture bug, not an expectation. */
function asOccurrence(exported: ExportRow): OccurrenceRow {
  if (exported.kind !== 'occurrence') throw new Error(`expected an occurrence row, got ${exported.kind}`);

  return exported;
}

/** A loop-turn barrier: destroy is observed on the next tick, not synchronously (decision 5). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Drain the whole stream into its lines. Every row is a string, so the join is the wire format. */
async function lines(stream: Readable): Promise<string[]> {
  const collected: string[] = [];
  for await (const chunk of stream) collected.push(chunk as string);

  return collected;
}

describe('the export stream’s shape', () => {
  it('states its mode and its buffer in the call rather than inheriting a default', () => {
    const asked = createExportStream([item('wi_a', null)], { occurrences: 5, highWaterMark: 3 });
    const defaultd = createExportStream([item('wi_a', null)], { occurrences: 5 });

    // ADR 0010 decision 2: `Readable.from` and `new Readable({objectMode: true})` disagree about the
    // buffer (1 vs 16) and the byte default is not even stable across the supported runtimes, so the
    // route names both numbers itself and nothing downstream has to know what a default is.
    expect(asked.stream.readableObjectMode).toBe(true);
    expect(asked.stream.readableHighWaterMark).toBe(3);
    expect(defaultd.stream.readableHighWaterMark).toBe(EXPORT_HIGH_WATER_MARK);
  });

  it('hands the consumer exactly what it counted, and buffers at most one buffer', async () => {
    const walk = createExportStream([item('wi_a', daily)], { occurrences: 30, highWaterMark: 4 });
    // `read()` is typed `any` in node's streams API; the object-mode contract is a string per row.
    const first = walk.stream.read() as string | null;

    expect(typeof first).toBe('string');
    // Rows written and rows taken can never differ by more than the buffer, because each `_read` pushes
    // one row: this is decision 8's `pushed === consumed`, restated for a stream that is not `from()`.
    expect(walk.rows()).toBe(1 + walk.stream.readableLength);
    expect(walk.stream.readableLength).toBeLessThanOrEqual(4);
    await lines(walk.stream);
  });

  it('pulls exactly as many engine steps as the bound allows, on a rule that would walk for ever', async () => {
    const walk = createExportStream([item('wi_a', daily)], { occurrences: 3, highWaterMark: 2 });
    const body = await lines(walk.stream);

    // A `DAILY` rule with no `count` is the rule that walked 200000 candidates in decision 3. Here the
    // walk is asked for three rows and takes three steps: the guard is unreachable through this route.
    expect(body.filter((line: string): boolean => row(line).kind === 'occurrence')).toHaveLength(3);
    expect(walk.pulls()).toBe(3);
  });

  it('takes zero steps when the caller asked for zero rows', async () => {
    const walk = createExportStream([item('wi_a', daily)], { occurrences: 0 });
    const body = (await lines(walk.stream)).map(row);

    expect(body.filter((r) => r.kind === 'occurrence')).toHaveLength(0);
    expect(walk.pulls()).toBe(0);
    expect(body.at(-1)).toEqual({ kind: 'done', items: 1, occurrences: 0, bound: 0 });
  });
});

describe('the export stream’s rows', () => {
  it('writes every item header before any occurrence of the next item', async () => {
    const body = (await lines(createExportStream([item('wi_a', null), item('wi_b', null)], { occurrences: 5 }).stream)).map(row);

    expect(body.map((r) => r.kind)).toEqual(['item', 'item', 'done']);
  });

  it('gives an unscheduled item a header and nothing else', async () => {
    const body = (await lines(createExportStream([item('wi_a', null)], { occurrences: 5 }).stream)).map(row);
    const header = body[0];

    expect(header).toEqual({
      kind: 'item',
      id: 'wi_a',
      title: 'Item wi_a',
      status: 'ready',
      assigneeId: null,
      estimateMinutes: null,
      schedule: null,
    });
  });

  it('carries the engine’s own truth in an occurrence row', async () => {
    const body = (await lines(createExportStream([item('wi_a', daily)], { occurrences: 2 }).stream)).map(row);
    const pulled = body.filter((r) => r.kind === 'occurrence').map(asOccurrence);

    // The pair week 3 recorded for the Berlin gap: the wall clock the rule asked for never moves, and
    // the instant is what actually happened to it.
    expect(pulled.map((r) => [r.itemId, r.index, r.at, r.wall, r.disambiguation])).toEqual([
      ['wi_a', 0, '2026-03-28T01:30:00.000Z', '2026-03-28T02:30:00', 'exact'],
      ['wi_a', 1, '2026-03-29T01:00:00.000Z', '2026-03-29T02:30:00', 'gap-roll-forward'],
    ]);
    expect(pulled.map((r) => r.instant)).toEqual([Date.parse('2026-03-28T01:30:00.000Z'), Date.parse('2026-03-29T01:00:00.000Z')]);
  });

  it('writes a rule shorter than the bound out in full and counts it exact', async () => {
    const walk = createExportStream([item('wi_a', twice), item('wi_b', null)], { occurrences: 5 });
    const body = (await lines(walk.stream)).map(row);
    const done = body.at(-1);

    expect(body.filter((r) => r.kind === 'occurrence')).toHaveLength(2);
    // Decision 4: the end of a series is discovered one pull after its last row, so a walk of two rows
    // is three steps. `pulls()` is the engine's count and `done.occurrences` is the body's.
    expect(walk.pulls()).toBe(3);
    expect(done).toEqual({ kind: 'done', items: 2, occurrences: 2, bound: 5 });
  });

  it('exports an empty board as a body that says so', async () => {
    const body = (await lines(createExportStream([], { occurrences: 5 }).stream)).map(row);

    expect(body).toEqual([{ kind: 'done', items: 0, occurrences: 0, bound: 5 }]);
  });
});

describe('the export stream’s endings', () => {
  it('ends with a done row that counts what it sent', async () => {
    const body = (
      await lines(createExportStream([item('wi_a', daily), item('wi_b', null)], { occurrences: 3 }).stream)
    ).map(row);

    expect(body.at(-1)).toEqual({ kind: 'done', items: 2, occurrences: 3, bound: 3 });
  });

  it('stops pulling when the stream is destroyed, and its body never reaches the done row', async () => {
    const walk = createExportStream([item('wi_a', daily)], { occurrences: 50, highWaterMark: 2 });
    const taken = [walk.stream.read(), walk.stream.read()];
    const body = taken.filter((chunk: string | null): chunk is string => chunk !== null).map(row);
    const stepsAtDestroy = walk.pulls();
    const rowsAtDestroy = walk.rows();

    walk.stream.destroy();
    await wait(20);

    expect(body.map((r) => r.kind)).toEqual(['item', 'occurrence']);
    expect(walk.stream.destroyed).toBe(true);
    // Decision 6: destroying stops the walk but cannot recall what the buffer already held, and the
    // walk does not carry on afterwards.
    expect(walk.pulls()).toBe(stepsAtDestroy);
    expect(walk.rows()).toBe(rowsAtDestroy);
  });

  it('has nothing to close when nobody ever read it', () => {
    const walk = createExportStream([item('wi_a', daily)], { occurrences: 50 });
    walk.stream.destroy();

    // Decision 5's last row: a generator that never started has no `finally` to reach, and here the
    // generator is not even created — the cursor is built by the first pull that needs one.
    expect(walk.pulls()).toBe(0);
  });

  it('lets a walk that fails mid-body surface as a stream error, not as a clean end', async () => {
    const walk = createExportStream([item('wi_ceiling', pastTheCeiling)], { occurrences: 10 });
    const collected: string[] = [];
    let caught: unknown = null;

    try {
      for await (const chunk of walk.stream) collected.push(chunk as string);
    } catch (error: unknown) {
      caught = error;
    }

    const body = collected.map(row);
    expect(body.map((r) => r.kind)).toEqual(['item', 'occurrence']);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('SEARCH_EXHAUSTED');
    // The row that says "this body is complete" is the one that never arrives.
    expect(body.some((r) => r.kind === 'done')).toBe(false);
  });
});
