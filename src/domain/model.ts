import type { Recurrence } from '../core/recurrence.js';
import type { BoardId, MemberId, WorkItemId } from './ids.js';

export type WorkItemStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done';

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
