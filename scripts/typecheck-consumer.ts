import {
  CadenceError,
  isCadenceError,
  nextOccurrence,
  ok,
  type Disambiguation,
  type Occurrence,
  type Recurrence,
  type Result,
  type SeriesCursor,
} from 'cadence';
import {
  createEstimate,
  parseEstimate,
  parseId,
  parseSchedule,
  parseStatus,
  parseWorkItemRow,
  toWorkItemRow,
  type BoardId,
  type BoardStore,
  type Clock,
  type Estimate,
  type WorkItem,
  type WorkItemRow,
  type WorkItemStatus,
} from 'cadence/domain';
import { runSeries, sleep, type RunSummary, type SleepFn } from 'cadence/scheduler';

export const probe: Result<Occurrence | null, CadenceError> = ok(
  nextOccurrence({ tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 0, 6, 9, 0), freq: 'DAILY' }, 0),
);

export const disambiguation: Disambiguation = 'gap-roll-forward';

export const identityCheck: (value: unknown) => boolean = isCadenceError;

export function boardName(store: BoardStore, raw: unknown): Promise<string | null> {
  const parsed = parseId('board', raw);
  if (!parsed.ok) throw parsed.error;

  const id: BoardId = parsed.value;
  return store.loadBoard(id).then((board) => board?.name ?? null);
}

export type ItemSchedule = Pick<WorkItem, 'id' | 'boardId' | 'schedule'>;

/**
 * A `WorkItem` carries an `Estimate`, so the shipped types have to let a caller hold one: the value, the
 * two ways of making it, the comparison, and the number underneath. Proved here rather than in a test
 * because only this file typechecks against `dist/*.d.ts`.
 */
export const halfHour: Estimate = createEstimate(30);

export const sameAsThirty: boolean = halfHour.equals(createEstimate(30));

export const fromTheWire: Result<Estimate, CadenceError> = parseEstimate('30');

export function minutesOf(item: WorkItem): number | null {
  return item.estimateMinutes === null ? null : item.estimateMinutes.minutes;
}

/**
 * The row is the shape a store with columns holds, and the codec is the only way back up to a `WorkItem`:
 * proved against `dist/*.d.ts` because an adapter written outside this repository cannot be handed a brand
 * it did not parse. `JSON.parse` returns `unknown`, which is the point — the door takes what a driver gives.
 */
export function rowOf(item: WorkItem): WorkItemRow {
  return toWorkItemRow(item);
}

export const fromTheDriver: Result<WorkItem, CadenceError> = parseWorkItemRow(JSON.parse('{}'));

export const statusOf: Result<WorkItemStatus, CadenceError> = parseStatus('ready');

export const scheduleOf: Result<Recurrence | null, CadenceError> = parseSchedule(null);

/** The shipped wait satisfies the port a caller is meant to inject. */
export const injectedSleep: SleepFn = sleep;

/** A cursor from `cadence` feeds a run in `cadence/scheduler`: the two entry points compose. */
export function drainOne(
  cursor: SeriesCursor,
  clock: Clock,
  signal: AbortSignal,
): Promise<RunSummary> {
  return runSeries(cursor, {
    clock,
    sleep: injectedSleep,
    notify: (occurrence: Occurrence) => {
      void occurrence.instant;
    },
    signal,
    limit: 1,
  });
}
