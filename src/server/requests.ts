import { isOk } from '../core/result.js';
import { createSeriesCursor } from '../core/cursor.js';
import type { Recurrence } from '../core/recurrence.js';
import { parseId, type BoardId, type BrandedId, type MemberId, type WorkItemId } from '../domain/ids.js';
import { WORK_ITEM_STATUSES, type WorkItemStatus } from '../domain/model.js';
import { HttpError, asHttpError, fromCadenceError } from './http-error.js';

type IdKind = keyof typeof NAMESPACES;

/**
 * Every id in a request declares which kind it is. `parseId` checks the shape and cannot tell a board
 * id from a member id — the brand is compile-time only — so a URL that puts `bd_core` where a work
 * item belongs would otherwise reach the store and come back as a 404, which reads like "it is gone"
 * rather than "you asked for the wrong thing". The prefix turns that into a 400 at the door.
 */
const NAMESPACES = { board: 'bd', member: 'mb', 'work-item': 'wi' } as const;

const MAX_LABEL_LENGTH = 200;

/** How many occurrences the export walks for an item whose caller named no number. */
const DEFAULT_OCCURRENCES = 20;

/**
 * The ceiling a caller may ask for, and the only thing standing between an export and ADR 0010
 * decision 3's number: a `DAILY` rule with no `count`, left to flow, walked 200000 candidate
 * occurrences — about 547 years — in 4.4 seconds without once yielding to the timer phase. A bound on
 * produced rows keeps that count out of reach of the row total; how many *candidates* the engine
 * examines for one row stays the engine's own business.
 */
const MAX_OCCURRENCES = 1_000;

// Widened on purpose: `WORK_ITEM_STATUSES` has the union as its element type, so `.includes()` would
// refuse a plain string — and the value being tested here arrived as one.
const KNOWN_STATUSES: readonly string[] = WORK_ITEM_STATUSES;

export interface CreateBoard {
  readonly id: BoardId;
  readonly name: string;
  readonly memberIds: readonly MemberId[];
}

export interface CreateWorkItem {
  readonly id: WorkItemId;
  readonly boardId: BoardId;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly assigneeId: MemberId | null;
  readonly estimateMinutes: number | null;
  readonly schedule: Recurrence | null;
}

export function readBoardId(raw: unknown): BoardId {
  return readId('board', raw);
}

export function readWorkItemId(raw: unknown): WorkItemId {
  return readId('work-item', raw);
}

/** The whole body, once it is known to be a JSON object rather than an array or a scalar. */
function fields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'INVALID_BODY', `the body must be a JSON object, got ${shown(raw)}`);
  }

  return raw as Record<string, unknown>;
}

function readId<K extends IdKind>(kind: K, raw: unknown): BrandedId<K> {
  const parsed = parseId(kind, raw);
  if (!isOk(parsed)) throw fromCadenceError(parsed.error);

  const namespace = `${NAMESPACES[kind]}_`;
  if (!parsed.value.startsWith(namespace)) {
    throw new HttpError(400, 'INVALID_ID', `${kind} id must start with "${namespace}", got "${parsed.value}"`);
  }

  return parsed.value;
}

function readLabel(raw: unknown, code: string, what: string): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, code, `${what} must be a string, got ${shown(raw)}`);
  }

  const text = raw.trim();
  if (text.length === 0) throw new HttpError(400, code, `${what} must not be empty`);
  if (text.length > MAX_LABEL_LENGTH) {
    throw new HttpError(400, code, `${what} must be at most ${String(MAX_LABEL_LENGTH)} characters, got ${String(text.length)}`);
  }

  return text;
}

function readStatus(raw: unknown): WorkItemStatus {
  if (typeof raw !== 'string' || !KNOWN_STATUSES.includes(raw)) {
    throw new HttpError(400, 'INVALID_STATUS', `status must be one of ${WORK_ITEM_STATUSES.join(', ')}, got ${shown(raw)}`);
  }

  return raw as WorkItemStatus;
}

function readMemberIds(raw: unknown): readonly MemberId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'INVALID_ID', `member ids must be an array, got ${shown(raw)}`);

  return raw.map((value: unknown): MemberId => readId('member', value));
}

function readEstimate(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new HttpError(400, 'INVALID_ESTIMATE', `estimateMinutes must be a whole number of minutes, at least zero, got ${shown(raw)}`);
  }

  return raw;
}

function readAssignee(raw: unknown): MemberId | null {
  if (raw === undefined || raw === null) return null;

  return readId('member', raw);
}

/**
 * The engine is the only authority on what a recurrence is, so this asks it rather than repeating its
 * rules. It asks through `createSeriesCursor`, because that is the object the scheduler will actually
 * walk: `occurrences()` normalises the rule and resolves the anchor when the series is created, so
 * constructing a cursor runs every one of the engine's checks without pulling a single occurrence.
 * Probing with `nextOccurrence(rule, rule.dtStart)` did the same checks one level further in, and
 * reported a client that sent `dtStart: "2026-03-28T01:30:00.000Z"` as
 * `after must be an integer epoch ms` — the engine's own parameter name, in a message about a field
 * nobody called `after`.
 */
function readSchedule(raw: unknown): Recurrence | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'INVALID_SCHEDULE', `schedule must be an object or null, got ${shown(raw)}`);
  }

  const candidate = raw as Recurrence;
  try {
    createSeriesCursor(candidate);
  } catch (cause) {
    throw asHttpError(cause);
  }

  return candidate;
}

export function parseCreateBoard(raw: unknown): CreateBoard {
  const body = fields(raw);

  return {
    id: readId('board', body['id']),
    name: readLabel(body['name'], 'INVALID_NAME', 'name'),
    memberIds: readMemberIds(body['memberIds']),
  };
}

export function parseCreateWorkItem(boardId: BoardId, raw: unknown): CreateWorkItem {
  const body = fields(raw);

  return {
    id: readId('work-item', body['id']),
    boardId,
    title: readLabel(body['title'], 'INVALID_TITLE', 'title'),
    status: readStatus(body['status'] ?? 'backlog'),
    assigneeId: readAssignee(body['assigneeId']),
    estimateMinutes: readEstimate(body['estimateMinutes']),
    schedule: readSchedule(body['schedule']),
  };
}

export function parseStatusChange(raw: unknown): WorkItemStatus {
  return readStatus(fields(raw)['status']);
}

/**
 * The bound on how far an export may walk, read at the door rather than assumed further in.
 *
 * The parameter is `unknown` on purpose: a query value is not what its declared type says it is.
 * `?occurrences=1&occurrences=2` arrives as an array, and a route that trusted its own generic would
 * answer with the first value silently — which is exactly the kind of "the caller must have meant N"
 * that decision 3 measured four seconds of.
 */
export function readOccurrenceBound(raw: unknown): number {
  if (raw === undefined) return DEFAULT_OCCURRENCES;

  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(
      400,
      'INVALID_OCCURRENCES',
      `occurrences must be a whole number of rows between 0 and ${String(MAX_OCCURRENCES)}, got ${shown(raw)}`,
    );
  }

  const bound = Number(raw);
  if (bound > MAX_OCCURRENCES) {
    throw new HttpError(400, 'INVALID_OCCURRENCES', `occurrences must be at most ${String(MAX_OCCURRENCES)}, got ${raw}`);
  }

  return bound;
}

/** A value the caller sent, spelled the way it reads in a message about it. */
function shown(raw: unknown): string {
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw === 'string') return `"${raw}"`;

  return raw === null ? 'null' : typeof raw;
}
