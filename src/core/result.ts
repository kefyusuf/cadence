import { CadenceError, isCadenceError } from './errors.js';

export type Result<T, E = CadenceError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return isOk(result) ? result.value : fallback;
}

export function mapResult<T, T2, E>(result: Result<T, E>, map: (value: T) => T2): Result<T2, E> {
  return isOk(result) ? ok(map(result.value)) : result;
}

export function andThen<T, T2, E>(
  result: Result<T, E>,
  next: (value: T) => Result<T2, E>,
): Result<T2, E> {
  return isOk(result) ? next(result.value) : result;
}

/** Turns a throwing call into a `Result`, keeping the original failure as `cause`. */
export function fromThrowable<T>(run: () => T): Result<T, CadenceError> {
  try {
    return ok(run());
  } catch (error) {
    if (isCadenceError(error)) return err(error);
    const message = error instanceof Error ? error.message : String(error);
    return err(new CadenceError('UNEXPECTED', message, { cause: error }));
  }
}
