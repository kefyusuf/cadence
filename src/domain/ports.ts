import type { Occurrence } from '../core/recurrence.js';
import type { BoardId, WorkItemId } from './ids.js';
import type { Board, WorkItem } from './model.js';

/** Everything the domain needs from the outside world. No implementation lives here. */
export interface Clock {
  now(): number;
}

export interface IdGenerator {
  next(kind: string): string;
}

export interface BoardStore {
  loadBoard(id: BoardId): Promise<Board | null>;
  listBoards(): Promise<readonly Board[]>;
  saveBoard(board: Board): Promise<void>;
}

export interface WorkItemStore {
  load(id: WorkItemId): Promise<WorkItem | null>;
  listForBoard(boardId: BoardId): Promise<readonly WorkItem[]>;
  save(item: WorkItem): Promise<void>;
}

export interface ScheduleNotifier {
  notify(item: WorkItem, occurrence: Occurrence): Promise<void>;
}
