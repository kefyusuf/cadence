import { describe, expect, it } from 'vitest';

import { CADENCE_ERROR_CODES, CadenceError, isCadenceError, shown } from '../src/core/errors.js';

/** Stands in for the same module loaded twice (dual package copy, worker, realm). */
class DuplicatedCadenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CadenceError';
    this.code = code;
  }
}

describe('CadenceError', () => {
  it('stays a real Error with its own name and code', () => {
    const error = new CadenceError('INVALID_TIME_ZONE', 'unknown zone');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CadenceError');
    expect(error.code).toBe('INVALID_TIME_ZONE');
    expect(error.message).toBe('unknown zone');
  });

  it('puts the class name at the head of the stack', () => {
    expect(new CadenceError('UNEXPECTED', 'boom').stack?.split('\n')[0]).toBe('CadenceError: boom');
  });

  it('keeps the original failure as cause', () => {
    const cause = new RangeError('icu said no');
    const error = new CadenceError('INVALID_TIME_ZONE', 'unknown zone', { cause });

    expect(error.cause).toBe(cause);
  });

  it('accepts every published code', () => {
    for (const code of CADENCE_ERROR_CODES) {
      expect(isCadenceError(new CadenceError(code, code))).toBe(true);
    }
  });
});

describe('isCadenceError', () => {
  it('recognises a second copy of the class where instanceof fails', () => {
    const other = new DuplicatedCadenceError('INVALID_INTERVAL', 'from another copy');

    expect(other instanceof CadenceError).toBe(false);
    expect(isCadenceError(other)).toBe(true);
  });

  it('rejects a right-shaped object that is not an Error', () => {
    expect(isCadenceError({ name: 'CadenceError', code: 'INVALID_INTERVAL' })).toBe(false);
  });

  it('rejects an Error carrying an unknown code', () => {
    expect(isCadenceError(new DuplicatedCadenceError('NOT_A_CODE', 'pretender'))).toBe(false);
  });

  it('loses the code and the name through structuredClone, so identity does not survive', () => {
    const cloned = structuredClone(new CadenceError('INVALID_INTERVAL', 'across the wire', { cause: new Error('why') }));

    expect(cloned.message).toBe('across the wire');
    expect(cloned.name).toBe('Error');
    expect(cloned instanceof CadenceError).toBe(false);
    expect(isCadenceError(cloned)).toBe(false);
    expect((cloned as Partial<CadenceError>).code).toBeUndefined();
  });
});

/**
 * The one branch that used to exist twice — `null`, which the HTTP layer spelled `null` and a domain
 * copy spelled `object` — is in here on purpose. Two layers now write refusals about the same values, so
 * the spelling is a rule with one owner and one test, not a detail of whichever module raised last.
 */
describe('shown', () => {
  const CASES: readonly (readonly [unknown, string])[] = [
    [30, '30'],
    [0, '0'],
    [NaN, 'NaN'],
    [true, 'true'],
    ['thirty', '"thirty"'],
    ['', '""'],
    [null, 'null'],
    [{}, 'object'],
    [[30], 'object'],
    [undefined, 'undefined'],
    [() => 0, 'function'],
  ];

  it('names a number, a boolean and a string as itself, and everything else by its type', () => {
    for (const [raw, expected] of CASES) {
      expect(shown(raw), typeof raw).toBe(expected);
    }
  });
});
