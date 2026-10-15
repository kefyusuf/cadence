import { CadenceError, shown } from '../core/errors.js';
import { createSeriesCursor } from '../core/cursor.js';
import type { Recurrence } from '../core/recurrence.js';
import { err, fromThrowable, ok, type Result } from '../core/result.js';

/**
 * The domain's door onto the engine's rules.
 *
 * It checks one thing itself — that the field is an object at all — and asks for everything else. The
 * engine is the only authority on what a recurrence is (ADR 0008), so a door that validated `freq` or
 * `interval` here would be a second copy of a rule free to change underneath it. The check it does keep
 * is the one the engine cannot make on the caller's behalf: handed a string it reads `.freq` off it, finds
 * `undefined`, and answers `freq must be one of DAILY, WEEKLY, MONTHLY, YEARLY, got undefined` — the
 * engine's own parameter name in a message about a value that never had one. ADR 0008 removed exactly that
 * confusion from the HTTP door, and a row store would have inherited it straight back.
 *
 * Asking through `createSeriesCursor` rather than `nextOccurrence` is the same choice the door made:
 * building a cursor runs every check and reads the anchor without producing an occurrence, so a refusal
 * costs the caller nothing but the walk they were about to reject anyway.
 */
export function parseSchedule(raw: unknown): Result<Recurrence | null, CadenceError> {
  if (raw === undefined || raw === null) return ok(null);

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(new CadenceError('INVALID_SCHEDULE', `schedule must be an object or null, got ${shown(raw)}`));
  }

  const candidate = raw as Recurrence;

  return fromThrowable(() => {
    createSeriesCursor(candidate);
    return candidate;
  });
}
