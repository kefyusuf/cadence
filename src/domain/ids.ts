import { CadenceError } from '../core/errors.js';
import { err, ok, type Result } from '../core/result.js';

declare const brand: unique symbol;

export type BrandedId<K extends string> = string & { readonly [brand]: K };

export type BoardId = BrandedId<'board'>;
export type MemberId = BrandedId<'member'>;
export type WorkItemId = BrandedId<'work-item'>;

const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Ids stay ASCII so they survive a URL, a queue key and a log line unchanged; that is
 * why `iş_1` is rejected rather than encoded.
 */
export function parseId<K extends string>(kind: K, raw: unknown): Result<BrandedId<K>, CadenceError> {
  if (typeof raw !== 'string') {
    return err(new CadenceError('INVALID_ID', `${kind} id must be a string, got ${typeof raw}`));
  }
  if (raw !== raw.trim()) {
    return err(new CadenceError('INVALID_ID', `${kind} id must not have leading or trailing whitespace`));
  }
  if (raw.length === 0) {
    return err(new CadenceError('INVALID_ID', `${kind} id must not be empty`));
  }
  if (raw.length > MAX_ID_LENGTH) {
    return err(new CadenceError('INVALID_ID', `${kind} id must be at most ${String(MAX_ID_LENGTH)} characters`));
  }
  if (!ID_PATTERN.test(raw)) {
    return err(new CadenceError('INVALID_ID', `${kind} id must match [A-Za-z0-9][A-Za-z0-9._:-]*, got "${raw}"`));
  }

  return ok(raw as BrandedId<K>);
}
