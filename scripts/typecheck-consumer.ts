import {
  CadenceError,
  isCadenceError,
  nextOccurrence,
  ok,
  type Disambiguation,
  type Occurrence,
  type Result,
} from 'cadence';
import { parseId, type BoardId, type BoardStore, type WorkItem } from 'cadence/domain';

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
