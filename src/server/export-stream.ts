import { Readable } from 'node:stream';

import { createSeriesCursor, type SeriesCursor } from '../core/cursor.js';
import type { Occurrence } from '../core/recurrence.js';
import type { Disambiguation } from '../core/clock.js';
import type { Estimate } from '../domain/estimate.js';
import type { WorkItem, WorkItemStatus } from '../domain/model.js';

/**
 * Rows held in the buffer, not bytes. ADR 0010 decision 9 measured a 4 KiB *byte* buffer sitting on
 * 124 engine steps, so a byte `highWaterMark` is not a read-ahead anyone would choose for a series.
 */
export const EXPORT_HIGH_WATER_MARK = 8;

export interface ItemRow {
  readonly kind: 'item';
  readonly id: string;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly assigneeId: string | null;
  /** The value itself: `toJSON` is what puts a bare number on the wire, the way `schedule` stays a rule. */
  readonly estimateMinutes: Estimate | null;
  /** The rule as it is stored: the export describes the board, it does not re-derive it. */
  readonly schedule: WorkItem['schedule'];
}

export interface OccurrenceRow {
  readonly kind: 'occurrence';
  readonly itemId: string;
  /** The engine's own position in the series, so a skipped day is not silently renumbered. */
  readonly index: number;
  readonly instant: number;
  /** `instant` as an ISO string, for a reader who has no engine in front of them. */
  readonly at: string;
  /** The wall clock the rule asked for — what `instant` had to be moved to reach. */
  readonly wall: string;
  readonly disambiguation: Disambiguation;
}

/**
 * The body's last line, and the only in-band proof that it is complete. ADR 0010 decision 6: nothing
 * rewinds a flushed socket, so a reader that never sees this row has a truncated export — and cannot
 * tell from the wire alone whether the walk ran out or the connection did.
 */
export interface DoneRow {
  readonly kind: 'done';
  readonly items: number;
  readonly occurrences: number;
  readonly bound: number;
}

export type ExportRow = ItemRow | OccurrenceRow | DoneRow;

export interface ExportOptions {
  readonly occurrences: number;
  readonly highWaterMark?: number | undefined;
}

export interface ExportStream {
  readonly stream: Readable;
  /** Lines written into the stream. `rows()` minus what the consumer has taken is the buffer. */
  rows(): number;
  /** `cursor.next()` calls: the engine steps this export actually took. */
  pulls(): number;
}

/**
 * A board as a stream of NDJSON lines, pulled one row at a time.
 *
 * ADR 0010's consequences name this shape: `_read` asks the walk for exactly one row (decision 8, so
 * `pulls()` is the engine's count and not a buffer's), object mode with the buffer named in the call
 * (decision 2), a bound that came from the request (decision 3), and rows that are strings so the byte
 * unit never enters the picture (decision 9). A walk that refuses — a rule past the engine's year
 * ceiling — throws out of `_read`, which measured identical to `destroy(err)`: the buffered rows are
 * delivered first and the error follows.
 */
export function createExportStream(items: readonly WorkItem[], options: ExportOptions): ExportStream {
  const bound = options.occurrences;
  let written = 0;
  let pulled = 0;
  let occurrences = 0;

  // The walk is a position, not a queue: buffering the rows it will produce would be the memory cost
  // this stream exists to avoid.
  let itemAt = 0;
  let headerWritten = false;
  let takenForItem = 0;
  let cursor: SeriesCursor | null = null;
  let ended = false;

  function nextItem(): void {
    itemAt += 1;
    headerWritten = false;
    takenForItem = 0;
    cursor = null;
  }

  function nextRow(): ExportRow | null {
    for (;;) {
      const item = items[itemAt];
      if (item === undefined) {
        if (ended) return null;
        ended = true;

        return { kind: 'done', items: items.length, occurrences, bound };
      }

      if (!headerWritten) {
        headerWritten = true;

        return {
          kind: 'item',
          id: item.id,
          title: item.title,
          status: item.status,
          assigneeId: item.assigneeId,
          estimateMinutes: item.estimateMinutes,
          schedule: item.schedule,
        };
      }

      if (item.schedule === null || takenForItem >= bound) {
        nextItem();
        continue;
      }

      cursor ??= createSeriesCursor(item.schedule);
      const occurrence = cursor.next();
      pulled += 1;
      if (occurrence === null) {
        // A rule shorter than the bound: its end is discovered one pull after its last row.
        nextItem();
        continue;
      }

      takenForItem += 1;
      occurrences += 1;

      return occurrenceRow(item.id, occurrence);
    }
  }

  const stream = new Readable({
    objectMode: true,
    highWaterMark: options.highWaterMark ?? EXPORT_HIGH_WATER_MARK,
    read() {
      const row = nextRow();
      if (row === null) {
        this.push(null);
        return;
      }

      written += 1;
      this.push(`${JSON.stringify(row)}\n`);
    },
  });

  return {
    stream,
    rows: (): number => written,
    pulls: (): number => pulled,
  };
}

function occurrenceRow(itemId: string, occurrence: Occurrence): OccurrenceRow {
  const { year, month, day, hour, minute, second } = occurrence.targetWall;

  return {
    kind: 'occurrence',
    itemId,
    index: occurrence.index,
    instant: occurrence.instant,
    at: new Date(occurrence.instant).toISOString(),
    wall: `${String(year)}-${pair(month)}-${pair(day)}T${pair(hour)}:${pair(minute)}:${pair(second)}`,
    disambiguation: occurrence.disambiguation,
  };
}

function pair(value: number): string {
  return String(value).padStart(2, '0');
}
