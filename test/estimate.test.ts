import { describe, expect, it } from 'vitest';

import { isCadenceError, shown } from '../src/core/errors.js';
import { isOk } from '../src/core/result.js';
import { createEstimate, parseEstimate } from '../src/domain/estimate.js';

/** The name of whatever a call threw, so a refusal can be pinned without importing a class this file cannot name. */
function thrownName(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    return error instanceof Error ? error.name : typeof error;
  }

  return 'did not throw';
}

/**
 * The estimate is a value: two `30` minutes are the same estimate even though they are two objects, and
 * no legal number ever produces an illegal one. `parseEstimate` is what the door calls with a `unknown`
 * straight off the wire; `createEstimate` is the same invariant once the caller swears the number is a
 * number. Both must refuse the value rather than let a half-formed `Estimate` exist, because the type is
 * the only place the rule "whole minutes, never negative" is written.
 */
describe('parseEstimate', () => {
  it('accepts a whole number of minutes, zero included', () => {
    for (const minutes of [0, 1, 30, 4_096]) {
      const result = parseEstimate(minutes);
      expect(isOk(result), String(minutes)).toBe(true);
      if (isOk(result)) expect(result.value.minutes).toBe(minutes);
    }
  });

  it('refuses a value that is not a whole number of minutes', () => {
    for (const raw of ['30', 30.5, -1, NaN, Infinity, -Infinity, true, null, {}, [30]]) {
      const result = parseEstimate(raw);
      expect(isOk(result), `expected ${shown(raw)} to be rejected`).toBe(false);
      if (!isOk(result)) expect(result.error.code).toBe('INVALID_ESTIMATE');
    }
  });

  it('names the offending value in the refusal', () => {
    const result = parseEstimate(30.5);
    if (isOk(result)) throw new Error('expected a failure');

    expect(result.error.message).toBe('estimateMinutes must be a whole number of minutes, at least zero, got 30.5');
  });

  it('quotes a string it was handed, the way the door does everywhere else', () => {
    const result = parseEstimate('thirty');
    if (isOk(result)) throw new Error('expected a failure');

    expect(result.error.message).toBe('estimateMinutes must be a number of minutes, got "thirty"');
  });
});

describe('Estimate as a value', () => {
  it('makes two estimates of the same length equal without making them the same object', () => {
    const a = createEstimate(30);
    const b = createEstimate(30);

    expect(a).not.toBe(b);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  it('treats equality as reflexive, and reads a different length or an absent one as unequal', () => {
    const thirty = createEstimate(30);
    const forty = createEstimate(40);

    expect(thirty.equals(thirty)).toBe(true);
    expect(thirty.equals(forty)).toBe(false);
    expect(thirty.equals(null)).toBe(false);
    expect(thirty.minutes).toBe(30);
  });

  it('is frozen the moment it exists', () => {
    const estimate = createEstimate(30);

    expect(Object.isFrozen(estimate)).toBe(true);
    expect(Object.isExtensible(estimate)).toBe(false);
  });

  it('carries its brand only in the types, so nothing on the wire or in a copy has to explain it', () => {
    const estimate = createEstimate(30);

    expect(Object.getOwnPropertyNames(estimate).sort()).toEqual(['equals', 'minutes', 'toJSON']);
    expect(Object.getOwnPropertySymbols(estimate)).toEqual([]);
  });

  it('refuses to be cloned, which is the fact the store was built around', () => {
    expect(thrownName(() => structuredClone(createEstimate(30)))).toBe('DataCloneError');
  });

  it('serialises to the bare number, so the wire never sees the object', () => {
    expect(createEstimate(30).toJSON()).toBe(30);
    expect(JSON.stringify({ estimateMinutes: createEstimate(30) })).toBe('{"estimateMinutes":30}');
    expect(JSON.stringify({ estimateMinutes: null })).toBe('{"estimateMinutes":null}');
  });
});

describe('createEstimate', () => {
  it('throws the domain error rather than build an illegal value', () => {
    for (const minutes of [-1, 30.5, NaN, Infinity]) {
      let caught: unknown = null;
      try {
        createEstimate(minutes);
      } catch (error: unknown) {
        caught = error;
      }

      expect(isCadenceError(caught), String(minutes)).toBe(true);
      if (isCadenceError(caught)) expect(caught.code).toBe('INVALID_ESTIMATE');
    }
  });

  it('reports exactly what the parse reports, because it is the parse', () => {
    const parsed = parseEstimate(-1);
    if (isOk(parsed)) throw new Error('expected a failure');

    let thrown: unknown = null;
    try {
      createEstimate(-1);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isCadenceError(thrown)).toBe(true);
    if (isCadenceError(thrown)) expect(thrown.message).toBe(parsed.error.message);
  });
});
