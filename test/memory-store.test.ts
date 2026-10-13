import { describe, expect, it } from 'vitest';

import type { Recurrence } from '../src/core/recurrence.js';
import { parseId } from '../src/domain/ids.js';
import type { Board, WorkItem } from '../src/domain/model.js';
import { createMemoryStores } from '../src/adapters/memory-store.js';
import type { BoardStore, WorkItemStore } from '../src/domain/ports.js';

function branded<K extends string>(kind: K, raw: string) {
  const parsed = parseId(kind, raw);
  if (!parsed.ok) throw new Error(`fixture id refused by the domain rule: ${raw}`);
  return parsed.value;
}

const boardId = branded('board', 'bd_core');
const otherBoardId = branded('board', 'bd_growth');
const itemId = branded('work-item', 'wi_deploy');
const otherItemId = branded('work-item', 'wi_standup');
const memberId = branded('member', 'mb_yusuf');
const secondMemberId = branded('member', 'mb_else');

const daily = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' } as const satisfies Recurrence;
const weekly = { ...daily, freq: 'WEEKLY', byWeekDay: ['MO', 'FR'] } as const satisfies Recurrence;

function board(overrides: Partial<Board> = {}): Board {
  return { id: boardId, name: 'Core platform', memberIds: [memberId], ...overrides };
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: itemId,
    boardId,
    title: 'Deploy the release',
    status: 'ready',
    assigneeId: memberId,
    estimateMinutes: 30,
    schedule: weekly,
    createdAt: 0,
    ...overrides,
  };
}

/** Reaching past `readonly` on purpose: these tests are about what the store keeps from a caller that does. */
function mutable<T>(values: readonly T[]): T[] {
  return values as unknown as T[];
}

function fresh(): { boards: BoardStore; workItems: WorkItemStore } {
  return createMemoryStores();
}

describe('the board store', () => {
  it('reports a board it was never given as null', async () => {
    const { boards } = fresh();

    await expect(boards.loadBoard(branded('board', 'bd_missing'))).resolves.toBeNull();
  });

  it('lists nothing when no board was saved', async () => {
    const { boards } = fresh();

    await expect(boards.listBoards()).resolves.toEqual([]);
  });

  it('saves a board and loads it back whole', async () => {
    const { boards } = fresh();
    const saved = board();

    await boards.saveBoard(saved);

    await expect(boards.loadBoard(boardId)).resolves.toEqual(saved);
  });

  it('lists boards in the order they were saved', async () => {
    const { boards } = fresh();

    await boards.saveBoard(board({ id: otherBoardId, name: 'Growth' }));
    await boards.saveBoard(board());

    const listed = await boards.listBoards();

    expect(listed.map((candidate): string => candidate.name)).toEqual(['Growth', 'Core platform']);
  });

  it('replaces the board saved under an id it already knows', async () => {
    const { boards } = fresh();

    await boards.saveBoard(board());
    await boards.saveBoard(board({ name: 'Core platform v2', memberIds: [memberId, secondMemberId] }));

    const stored = await boards.loadBoard(boardId);

    expect(stored).toEqual({ id: boardId, name: 'Core platform v2', memberIds: [memberId, secondMemberId] });
    await expect(boards.listBoards()).resolves.toHaveLength(1);
  });

  it('does not let a caller edit what it holds, from the side it hands back', async () => {
    const { boards } = fresh();
    await boards.saveBoard(board());

    const loaded = await boards.loadBoard(boardId);
    if (loaded === null) throw new Error('the board was not stored');
    mutable(loaded.memberIds).push(secondMemberId);

    await expect(boards.loadBoard(boardId)).resolves.toEqual(board());
  });

  it('does not let a caller edit what it holds, from the object it was given', async () => {
    const { boards } = fresh();
    const mine = board();

    await boards.saveBoard(mine);
    mutable(mine.memberIds).push(secondMemberId);

    await expect(boards.loadBoard(boardId)).resolves.toEqual(board());
  });
});

describe('the work item store', () => {
  it('reports an item it was never given as null', async () => {
    const { workItems } = fresh();

    await expect(workItems.load(branded('work-item', 'wi_missing'))).resolves.toBeNull();
  });

  it('saves an item and loads it back whole, schedule included', async () => {
    const { workItems } = fresh();
    const saved = item();

    await workItems.save(saved);

    await expect(workItems.load(itemId)).resolves.toEqual(saved);
  });

  it('lists only the items of the board it was asked for, in save order', async () => {
    const { workItems } = fresh();

    await workItems.save(item());
    await workItems.save(item({ id: otherItemId, title: 'Weekly stand-up', boardId: otherBoardId, schedule: daily }));

    const forCore = await workItems.listForBoard(boardId);

    expect(forCore.map((candidate): string => candidate.id)).toEqual([itemId]);
    await expect(workItems.listForBoard(otherBoardId)).resolves.toHaveLength(1);
  });

  it('lists an empty array for a board with no items', async () => {
    const { workItems } = fresh();
    await workItems.save(item());

    await expect(workItems.listForBoard(branded('board', 'bd_empty'))).resolves.toEqual([]);
  });

  it('replaces the item saved under an id it already knows', async () => {
    const { workItems } = fresh();

    await workItems.save(item());
    await workItems.save(item({ status: 'in_progress', assigneeId: null }));

    const stored = await workItems.load(itemId);

    expect(stored).toMatchObject({ status: 'in_progress', assigneeId: null });
    await expect(workItems.listForBoard(boardId)).resolves.toHaveLength(1);
  });

  it('holds a copy of the schedule, not the array the caller kept', async () => {
    const { workItems } = fresh();
    await workItems.save(item());

    const loaded = await workItems.load(itemId);
    const schedule = loaded?.schedule;
    if (schedule === undefined || schedule === null || schedule.byWeekDay === undefined) {
      throw new Error('the item lost its schedule');
    }
    mutable(schedule.byWeekDay).push('SU');

    await expect(workItems.load(itemId)).resolves.toEqual(item());
  });

  it('hands out a distinct object on every load', async () => {
    const { workItems } = fresh();
    await workItems.save(item());

    const first = await workItems.load(itemId);
    const second = await workItems.load(itemId);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('stores an item whose board was never saved, because integrity is not its job', async () => {
    const { boards, workItems } = fresh();

    await workItems.save(item({ boardId: otherBoardId }));

    await expect(boards.loadBoard(otherBoardId)).resolves.toBeNull();
    await expect(workItems.listForBoard(otherBoardId)).resolves.toHaveLength(1);
  });
});
