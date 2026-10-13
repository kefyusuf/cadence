import type { Disambiguation, WallClock } from '../core/clock.js';
import type { Occurrence } from '../core/recurrence.js';
import type { WorkItem } from '../domain/model.js';
import type { Clock, ScheduleNotifier } from '../domain/ports.js';

/**
 * One line per due occurrence. Both times are kept on purpose: `due` is the instant the rule
 * resolved to, `wall` is the clock time the rule asked for — on the two DST days a year they
 * differ, and a log that carries only one of them cannot answer "did we fire on time".
 */
export interface NotifierRecord {
  readonly msg: 'cadence.due';
  readonly itemId: string;
  readonly boardId: string;
  readonly assigneeId: string | null;
  readonly title: string;
  readonly index: number;
  readonly due: string;
  readonly wall: string;
  readonly tz: string | null;
  readonly disambiguation: Disambiguation;
  readonly emittedAt: string;
  readonly late: boolean;
}

/** A sink may be async; a `ScheduleNotifier.notify` then waits for it, because the port is a promise. */
export type NotifierSink = (record: NotifierRecord) => void | Promise<void>;

export interface LogNotifierOptions {
  readonly sink: NotifierSink;
  readonly clock: Clock;
}

export function createLogNotifier(options: LogNotifierOptions): ScheduleNotifier {
  const { sink, clock } = options;

  return {
    async notify(item: WorkItem, occurrence: Occurrence): Promise<void> {
      await sink(recordFor(item, occurrence, clock.now()));
    },
  };
}

function recordFor(item: WorkItem, occurrence: Occurrence, now: number): NotifierRecord {
  return {
    msg: 'cadence.due',
    itemId: item.id,
    boardId: item.boardId,
    assigneeId: item.assigneeId,
    title: item.title,
    index: occurrence.index,
    due: new Date(occurrence.instant).toISOString(),
    wall: formatWall(occurrence.targetWall),
    tz: item.schedule?.tz ?? null,
    disambiguation: occurrence.disambiguation,
    emittedAt: new Date(now).toISOString(),
    late: occurrence.instant < now,
  };
}

function formatWall(wall: WallClock): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(wall.year)}-${two(wall.month)}-${two(wall.day)} ${two(wall.hour)}:${two(wall.minute)}:${two(wall.second)}`;
}
