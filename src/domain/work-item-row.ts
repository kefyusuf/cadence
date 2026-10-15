import { assertInstant } from '../core/clock.js';
import { CadenceError, shown } from '../core/errors.js';
import type { Recurrence } from '../core/recurrence.js';
import { err, fromThrowable, isOk, ok, type Result } from '../core/result.js';
import { parseEstimate, type Estimate } from './estimate.js';
import { parseId, type MemberId } from './ids.js';
import { parseStatus, type WorkItem } from './model.js';
import { parseSchedule } from './schedule.js';

/**
 * A `WorkItem` spelled with only the things JSON can carry: the ids as plain strings, the estimate as the
 * number of minutes it was made of, the status as the word it is.
 *
 * This is the shape a store with columns can hold. The value it corresponds to cannot live in a column —
 * `Estimate` carries a comparison method and a phantom brand, and a `NUMBER` holds neither — which is the
 * gap ADR 0012 left open: a store that reads a row had to call `parseEstimate` on the way in and could not
 * `structuredClone` on the way out. With both directions written here, the row and the value cannot
 * disagree about which fields exist or what a legal one looks like.
 */
export interface WorkItemRow {
  readonly id: string;
  readonly boardId: string;
  readonly title: string;
  readonly status: string;
  readonly assigneeId: string | null;
  readonly estimateMinutes: number | null;
  readonly schedule: Recurrence | null;
  readonly createdAt: number;
}

/**
 * Down from the value. The schedule is kept by reference: a projection hands over the rule, it does not
 * rebuild the world around it, and a store that needs a copy of its own is the store's business (ADR 0012).
 */
export function toWorkItemRow(item: WorkItem): WorkItemRow {
  return {
    id: item.id,
    boardId: item.boardId,
    title: item.title,
    status: item.status,
    assigneeId: item.assigneeId,
    estimateMinutes: item.estimateMinutes === null ? null : item.estimateMinutes.minutes,
    schedule: item.schedule,
    createdAt: item.createdAt,
  };
}

/**
 * Up from the row, through the door that owns each rule: the shape of an id, the vocabulary of statuses,
 * whole non-negative minutes, the engine's idea of a followable rule, the clock's idea of an instant.
 *
 * It is handed `unknown` rather than a `WorkItemRow`, because that is what a driver returns and the row
 * type is a promise about it, not a proof of it. It refuses rather than returning a half-formed item: the
 * fields `WorkItem` types as branded or as a value are only branded or a value once this has run.
 *
 * `title` is the one field whose refusal this file writes itself, and only for being a string. How long and
 * how empty a title may be is a request-body rule that lives in `readLabel`; copying it here is the drift
 * ADR 0012 warns about, and ADR 0013 decision 5 records the sentence that is now spelled in two layers.
 */
export function parseWorkItemRow(raw: unknown): Result<WorkItem, CadenceError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err(new CadenceError('INVALID_WORK_ITEM', `a work item row must be a JSON object, got ${shown(raw)}`));
  }

  const row = raw as Partial<WorkItemRow>;

  const id = parseId('work-item', row.id);
  if (!isOk(id)) return id;

  const boardId = parseId('board', row.boardId);
  if (!isOk(boardId)) return boardId;

  const assigneeId = readMember(row.assigneeId);
  if (!isOk(assigneeId)) return assigneeId;

  if (typeof row.title !== 'string') {
    return err(new CadenceError('INVALID_WORK_ITEM', `title must be a string, got ${shown(row.title)}`));
  }

  const status = parseStatus(row.status);
  if (!isOk(status)) return status;

  const estimateMinutes = readEstimate(row.estimateMinutes);
  if (!isOk(estimateMinutes)) return estimateMinutes;

  const schedule = parseSchedule(row.schedule);
  if (!isOk(schedule)) return schedule;

  const createdAt = fromThrowable(() => assertInstant(row.createdAt ?? Number.NaN, 'createdAt'));
  if (!isOk(createdAt)) return createdAt;

  return ok({
    id: id.value,
    boardId: boardId.value,
    title: row.title,
    status: status.value,
    assigneeId: assigneeId.value,
    estimateMinutes: estimateMinutes.value,
    schedule: schedule.value,
    createdAt: createdAt.value,
  });
}

/** A column that is `NULL` and a row that has no such column are the same absence to this domain. */
function readMember(raw: string | null | undefined): Result<MemberId | null, CadenceError> {
  if (raw === undefined || raw === null) return ok(null);

  return parseId('member', raw);
}

function readEstimate(raw: number | null | undefined): Result<Estimate | null, CadenceError> {
  if (raw === undefined || raw === null) return ok(null);

  return parseEstimate(raw);
}
