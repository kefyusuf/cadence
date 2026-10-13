import type { Recurrence } from '../core/recurrence.js';
import type { BoardId, MemberId, WorkItemId } from './ids.js';

/**
 * A runtime list, not only a type: the HTTP layer has to check a string it was handed against the
 * statuses the domain knows, and a `type` cannot be iterated. Transitions are a later decision —
 * this is the vocabulary, not the state machine.
 */
export const WORK_ITEM_STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'done'] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

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
  readonly estimateMinutes: number | null;
  readonly schedule: Recurrence | null;
  readonly createdAt: number;
}
