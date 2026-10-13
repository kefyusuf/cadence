import { describe, expect, it } from 'vitest';

import { CadenceError } from '../src/core/errors.js';
import { andThen, err, fromThrowable, isOk, mapResult, ok, unwrapOr } from '../src/core/result.js';

describe('Result', () => {
  it('narrows the payload on the ok flag', () => {
    const result = ok(3);
    if (!isOk(result)) throw new Error('expected an ok result');
    expect(result.value).toBe(3);
  });

  it('maps values and passes errors through untouched', () => {
    expect(mapResult(ok(3), (value) => value * 2)).toEqual(ok(6));

    const failure = err(new CadenceError('INVALID_COUNT', 'count must be >= 1'));
    expect(mapResult(failure, (value: number) => value * 2)).toBe(failure);
  });

  it('chains dependent fallible steps with andThen', () => {
    const double = (value: number) => (value > 10 ? err(new CadenceError('INVALID_COUNT', 'too big')) : ok(value * 2));

    expect(andThen(ok(4), double)).toEqual(ok(8));

    const chained = andThen(ok(40), double);
    if (isOk(chained)) throw new Error('expected the second step to fail');
    expect(chained.error.code).toBe('INVALID_COUNT');
  });

  it('unwraps with a fallback', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err(new CadenceError('UNEXPECTED', 'nope')), 9)).toBe(9);
  });
});

describe('fromThrowable', () => {
  it('keeps the original CadenceError instance', () => {
    const original = new CadenceError('INVALID_INTERVAL', 'interval must be >= 1');
    const result = fromThrowable(() => {
      throw original;
    });

    if (isOk(result)) throw new Error('expected a failure');
    expect(result.error).toBe(original);
  });

  it('wraps a non-Error throw and preserves it as cause', () => {
    const thrown = 'just a string';
    const result = fromThrowable(() => {
      /* eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the input under test */
      throw thrown;
    });

    if (isOk(result)) throw new Error('expected a failure');
    expect(result.error.code).toBe('UNEXPECTED');
    expect(result.error.message).toBe(thrown);
    expect(result.error.cause).toBe(thrown);
  });

  it('returns ok for a successful call and forwards the value', () => {
    expect(fromThrowable(() => 'result')).toEqual(ok('result'));
  });
});
