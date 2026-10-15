import { CadenceError, shown } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';
import type { Recurrence } from '../core/recurrence.js';
import type { Estimate } from './estimate.js';
import type { BoardId, MemberId, WorkItemId } from './ids.js';

/**
 * A runtime list, not only a type: the HTTP layer has to check a string it was handed against the
 * statuses the domain knows, and a `type` cannot be iterated. Transitions are a later decision —
 * this is the vocabulary, not the state machine.
 */
export const WORK_ITEM_STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'done'] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

// Widened on purpose: `WORK_ITEM_STATUSES` has the union as its element type, so `.includes()` would
// refuse a plain string — and the value being tested here arrived as one.
const KNOWN_STATUSES: readonly string[] = WORK_ITEM_STATUSES;

/**
 * The vocabulary's own door. Until now the list was checked only in the HTTP body parser, which meant a
 * row store reading a `status` column had nothing to read it through — the one field of `WorkItem` whose
 * rule was written in a layer that a store never passes.
 *
 * The message is the wording the door has used since week 4, character for character: two layers naming
 * the same refusal differently is a bug a caller reads, not a detail.
 */
export function parseStatus(raw: unknown): Result<WorkItemStatus, CadenceError> {
  if (typeof raw !== 'string' || !KNOWN_STATUSES.includes(raw)) {
    return err(
      new CadenceError('INVALID_STATUS', `status must be one of ${WORK_ITEM_STATUSES.join(', ')}, got ${shown(raw)}`),
    );
  }

  return ok(raw as WorkItemStatus);
}

export interface Member {
  readonly id: MemberId;
  readonly displayName: string;
  readonly timeZone: string;
}

export interface Board {
  readonly id: BoardId;
  readonly name: string;
  readonly memberIds: readonly MemberId[];
}

export interface WorkItem {
  readonly id: WorkItemId;
  readonly boardId: BoardId;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly assigneeId: MemberId | null;
  readonly estimateMinutes: Estimate | null;
  readonly schedule: Recurrence | null;
  readonly createdAt: number;
}
