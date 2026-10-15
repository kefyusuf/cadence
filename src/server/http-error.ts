import { isCadenceError, type CadenceError } from '../core/errors.js';

/**
 * A refusal the HTTP layer answers with: the status to send, the code to name it by, the message to
 * put in the body. Routes throw these instead of threading a failure type through their return values
 * — the same rule the engine follows (ADR 0002), where the error handler below is the boundary that
 * turns the throw back into a value.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * The engine refuses a rule it cannot follow by code, and every code it uses for a bad rule is a
 * client error. The two codes it uses when it gave up searching are not — there the caller handed over
 * a rule that was legal and the engine ran out of patience, which is this process's problem.
 *
 * `UNEXPECTED` is the code a door gives a throw *it did not write* (`fromThrowable`'s label for anything
 * that is not a `CadenceError`), so it is answered the way `asHttpError` answers an unknown throw: without
 * its message. A door that reports the engine's own words is a door that puts `rec.byWeekDay.map is not a
 * function` in a response body, and ADR 0013 measured a schedule shape that reaches it.
 */
export function fromCadenceError(error: CadenceError): HttpError {
  if (error.code === 'UNEXPECTED') return new HttpError(500, 'INTERNAL', 'the request could not be handled');
  const gaveUp = error.code === 'SEARCH_EXHAUSTED';
  return new HttpError(gaveUp ? 500 : 400, error.code, error.message);
}

function statusCodeOf(cause: Error): number {
  return 'statusCode' in cause && typeof cause.statusCode === 'number' ? cause.statusCode : 500;
}

/**
 * One shape for everything that can reach the error handler, so no route has to know which of the
 * three kinds of failure it just produced.
 *
 * A failure that is not a refusal we wrote is answered without its message: `the pool is closed`
 * tells the caller nothing useful and tells an attacker something.
 */
export function asHttpError(cause: unknown): HttpError {
  if (cause instanceof HttpError) return cause;
  if (isCadenceError(cause)) return fromCadenceError(cause);
  if (cause instanceof Error) {
    const status = statusCodeOf(cause);
    if (status >= 500) return new HttpError(500, 'INTERNAL', 'the request could not be handled');
    return new HttpError(status, 'INVALID_BODY', cause.message);
  }

  return new HttpError(500, 'INTERNAL', 'the request could not be handled');
}
