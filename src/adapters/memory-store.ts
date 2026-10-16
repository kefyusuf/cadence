import { isOk } from '../core/result.js';
import type { BoardId, WorkItemId } from '../domain/ids.js';
import type { Board, WorkItem } from '../domain/model.js';
import type { BoardStore, WorkItemStore } from '../domain/ports.js';
import { parseWorkItemRow, toWorkItemRow, type WorkItemRow } from '../domain/work-item-row.js';

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
 *
 * Boards are held as values and work items as rows, which is not a symmetry the file claims: an item is
 * held the way the week-11 store will hold it, so the codec is exercised by a real caller rather than only
 * by its own tests, and `listForBoard` filters rows before hydrating any of them — the scan reads the
 * board id off the row and builds a value only for the items it is going to return.
 */
export function createMemoryStores(): MemoryStores {
  const boards = new Map<BoardId, Board>();
  const items = new Map<WorkItemId, WorkItemRow>();

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
      load: (id: WorkItemId): Promise<WorkItem | null> => {
        const row = items.get(id);

        return Promise.resolve(row === undefined ? null : hydrate(row));
      },
      listForBoard: (boardId: BoardId): Promise<readonly WorkItem[]> =>
        Promise.resolve(
          [...items.values()]
            .filter((row: WorkItemRow): boolean => row.boardId === boardId)
            .map(hydrate),
        ),
      save: (record: WorkItem): Promise<void> => {
        items.set(record.id, copy(toWorkItemRow(record)));
        return Promise.resolve();
      },
    },
  };
}

/**
 * Copies on the way in *and* on the way out, for a board's fields and a work item's row alike. A store
 * that holds the caller's object has two writers for one record, and the aliasing would be invisible
 * until the day the adapter is replaced by one that goes over a network — where the caller keeps a value
 * that nothing can change anymore. A row needs it at both ends for the same reason seen from each side:
 * `toWorkItemRow` hands over the schedule it was given instead of rebuilding it, and `parseSchedule`
 * hands back the object it checked, so neither side of the door owns a copy of its own (ADR 0014). And
 * cloning a row is exactly what cloning a value is not: the estimate's method makes `structuredClone`
 * throw, the row's number does not (ADR 0013).
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Up through the domain's door, never around it. The refusal this unwraps is not one the store's own
 * data can produce — every row in the map went through `toWorkItemRow`, and the round trip is asserted in
 * `test/work-item-row.test.ts` — so it is thrown rather than translated: a store that answered `null`
 * would tell the caller the item is gone when the truth is that this process cannot read its own data.
 * `save` validates nothing, because the port's argument is already a `WorkItem`, so a caller that hands
 * this store a value the domain would refuse meets a throw on the way back out; ADR 0014 records that
 * answer as week 11's debt rather than pretending the branch cannot be reached.
 */
function hydrate(row: WorkItemRow): WorkItem {
  const parsed = parseWorkItemRow(copy(row));
  if (!isOk(parsed)) throw parsed.error;

  return parsed.value;
}

function copyOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : copy(value);
}
