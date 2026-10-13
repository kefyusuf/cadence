import type { BoardId, WorkItemId } from '../domain/ids.js';
import type { Board, WorkItem } from '../domain/model.js';
import type { BoardStore, WorkItemStore } from '../domain/ports.js';

export interface MemoryStores {
  readonly boards: BoardStore;
  readonly workItems: WorkItemStore;
}

/**
 * The two ports over one pool, because a board and its items are only ever useful together.
 *
 * Nothing here is clever: `listForBoard` scans. A store that indexed by board would be a second
 * implementation to keep honest, and the week's question is what the HTTP layer needs from a
 * `BoardStore`, not how fast an in-memory map can be made.
 */
export function createMemoryStores(): MemoryStores {
  const boards = new Map<BoardId, Board>();
  const items = new Map<WorkItemId, WorkItem>();

  return {
    boards: {
      loadBoard: (id: BoardId): Promise<Board | null> => Promise.resolve(copyOrNull(boards.get(id))),
      // Map's own order, which is the order things were saved: pinned by a test so that swapping
      // this adapter for one that sorts is a decision rather than a surprise in a response body.
      listBoards: (): Promise<readonly Board[]> => Promise.resolve([...boards.values()].map(copy)),
      saveBoard: (record: Board): Promise<void> => {
        boards.set(record.id, copy(record));
        return Promise.resolve();
      },
    },
    workItems: {
      load: (id: WorkItemId): Promise<WorkItem | null> => Promise.resolve(copyOrNull(items.get(id))),
      listForBoard: (boardId: BoardId): Promise<readonly WorkItem[]> =>
        Promise.resolve([...items.values()].filter((candidate: WorkItem): boolean => candidate.boardId === boardId).map(copy)),
      save: (record: WorkItem): Promise<void> => {
        items.set(record.id, copy(record));
        return Promise.resolve();
      },
    },
  };
}

/**
 * Copies on the way in *and* on the way out. A store that holds the caller's object has two writers
 * for one record, and the aliasing would be invisible until the day the adapter is replaced by one
 * that goes over a network — where the caller keeps a value that nothing can change anymore.
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function copyOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : copy(value);
}
