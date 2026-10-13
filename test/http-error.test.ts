import { describe, expect, it } from 'vitest';

import { CadenceError } from '../src/core/errors.js';
import { HttpError, asHttpError, fromCadenceError } from '../src/server/http-error.js';

/** Stands in for whatever a dependency that is not ours throws. */
class FailureWithStatus extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'FailureWithStatus';
    this.statusCode = statusCode;
  }
}

describe('asHttpError', () => {
  it('leaves a refusal that is already an answer alone', () => {
    const error = new HttpError(409, 'CONFLICT', 'already stored');

    expect(asHttpError(error)).toBe(error);
  });

  it('answers a rule the caller cannot follow with the engine code and a 400', () => {
    const failure = asHttpError(new CadenceError('INVALID_TIME_ZONE', 'Unknown IANA time zone: "Mars/Olympus_Mons"'));

    expect(failure).toMatchObject({ statusCode: 400, code: 'INVALID_TIME_ZONE' });
    expect(failure.message).toContain('Mars/Olympus_Mons');
  });

  it('answers a rule it gave up on with a 500, because that is this process failing', () => {
    expect(fromCadenceError(new CadenceError('SEARCH_EXHAUSTED', 'gave up'))).toMatchObject({ statusCode: 500 });
    expect(fromCadenceError(new CadenceError('UNEXPECTED', 'a non-cadence throw'))).toMatchObject({ statusCode: 500 });
  });

  it('keeps the status of a request-shaped failure from elsewhere and calls it a bad body', () => {
    const refusal = asHttpError(new FailureWithStatus(415, 'unsupported media type'));

    expect(refusal).toMatchObject({ statusCode: 415, code: 'INVALID_BODY' });
    // The withholding below is keyed on the status, not the class: a sub-500 message describes the
    // request the client just sent, so it is what the client should read back.
    expect(refusal.message).toBe('unsupported media type');
  });

  it('answers a failure with nothing to say as an internal one, without repeating its message', () => {
    const leaky = new Error('the pool is closed');

    expect(asHttpError(leaky)).toMatchObject({ statusCode: 500, code: 'INTERNAL' });
    expect(asHttpError(leaky).message).not.toContain('pool');
    expect(asHttpError('a thrown string')).toMatchObject({ statusCode: 500, code: 'INTERNAL' });
  });
});
