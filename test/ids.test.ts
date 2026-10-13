import { describe, expect, it } from 'vitest';

import { isOk } from '../src/core/result.js';
import { parseId, type MemberId, type WorkItemId } from '../src/domain/ids.js';

describe('parseId', () => {
  it('accepts ASCII ids that are safe in a URL, a queue key and a log line', () => {
    for (const raw of ['wi_1', 'WI-1', 'a', 'item.2:3', 'x'.repeat(64), '9life']) {
      const result = parseId('work-item', raw);
      expect(isOk(result), raw).toBe(true);
      if (isOk(result)) expect(result.value).toBe(raw);
    }
  });

  it('names the kind in the failure message', () => {
    const result = parseId('board', '');
    if (isOk(result)) throw new Error('expected a failure');
    expect(result.error.code).toBe('INVALID_ID');
    expect(result.error.message).toBe('board id must not be empty');
  });

  it('rejects padded, non-ASCII and punctuation-laden ids', () => {
    for (const raw of [' wi_1', 'wi_1 ', 'iş_1', 'wi 1', 'wi,1', '/wi', 'wi/1', 'wi#1']) {
      expect(parseId('work-item', raw).ok, String(raw)).toBe(false);
    }
  });

  it('rejects an id longer than the storage limit', () => {
    expect(parseId('work-item', 'x'.repeat(64)).ok).toBe(true);
    expect(parseId('work-item', 'x'.repeat(65)).ok).toBe(false);
  });

  it('never throws on junk input', () => {
    const junk: readonly unknown[] = [undefined, null, 0, 1n, true, {}, [], Symbol('s'), () => undefined, Buffer.from('wi')];

    for (const value of junk) {
      const result = parseId('member', value);
      expect(result.ok, `expected ${String(value)} to be rejected`).toBe(false);
      if (!isOk(result)) expect(result.error.code).toBe('INVALID_ID');
    }
  });
});

describe('typed ids', () => {
  it('only lets a parsed string through the branded slot', () => {
    const parsed = parseId('work-item', 'wi_1');
    if (!isOk(parsed)) throw new Error('expected a valid id');

    const id: WorkItemId = parsed.value;
    const rejectable = (value: WorkItemId): string => value;

    expect(rejectable(id)).toBe('wi_1');

    // Compile-time assertion: `tsc --noEmit` fails if the brand ever stops protecting
    // the slot, because @ts-expect-error then has no error on the line below it.
    // @ts-expect-error a raw string is not a WorkItemId
    const raw: WorkItemId = 'wi_1';
    expect(raw).toBe('wi_1');

    // @ts-expect-error two kinds of id are not interchangeable
    const crossed: MemberId = id;
    expect(crossed).toBe('wi_1');
  });
});
