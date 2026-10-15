import { CadenceError, shown } from '../core/errors.js';
import { err, isOk, ok, type Result } from '../core/result.js';

declare const estimateBrand: unique symbol;

/**
 * How long a work item is expected to take, in whole minutes.
 *
 * It is a value, not an entity: two estimates of thirty minutes are the same estimate whether or not
 * they are the same object, and the only way to hold one is through `createEstimate` or `parseEstimate`,
 * so an `Estimate` that exists is always a legal one. The rule lives here and nowhere else: the door
 * builds the value and hands it on without reading it, and the export puts the row on the socket by
 * letting `JSON.stringify` ask the value for its own number. Neither of them decides what a valid number
 * of minutes is.
 */
export interface Estimate {
  /**
   * Nominal, exactly like a branded id: nothing at runtime carries this key, and that is the point. It
   * makes `{ minutes: 30, equals: … }` written by an adapter or a seed script *not* an `Estimate`, so
   * "the only way to hold one is a constructor" is a fact the compiler enforces, not a convention a
   * reviewer has to trust. `build` is the one place that asserts past it, right after the check.
   */
  readonly [estimateBrand]: 'estimate';
  readonly minutes: number;
  /**
   * `null` is the only absent value this is ever handed, because `WorkItem.estimateMinutes` is
   * `Estimate | null` and the door collapses an absent wire field to `null` before a value exists. An
   * `undefined` argument is a type error at the call site rather than a case the value defends against.
   */
  equals(other: Estimate | null): boolean;
  toJSON(): number;
}

const MINIMUM_MINUTES = 0;

function illegal(minutes: number): CadenceError {
  return new CadenceError(
    'INVALID_ESTIMATE',
    `estimateMinutes must be a whole number of minutes, at least zero, got ${shown(minutes)}`,
  );
}

function legal(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= MINIMUM_MINUTES;
}

/** The one shape a value ever takes. The caller has checked the number before this runs. */
function build(minutes: number): Estimate {
  return Object.freeze({
    minutes,
    equals: (other: Estimate | null): boolean => other !== null && minutes === other.minutes,
    toJSON: (): number => minutes,
  }) as Estimate;
}

/**
 * Build an estimate when the caller already holds a number. It defers to `parseEstimate` rather than
 * repeating the check, because a second copy of the predicate is a second place the rule can change —
 * and translates the one refusal back into a throw, which is what ADR 0002 says a caller inside the
 * domain gets.
 */
export function createEstimate(minutes: number): Estimate {
  const parsed = parseEstimate(minutes);
  if (!isOk(parsed)) throw parsed.error;

  return parsed.value;
}

/**
 * Build an estimate from whatever the wire carried. A `unknown` that is not a number is a different
 * refusal from a number that is not whole minutes, so the two messages name the two things the caller
 * actually did wrong — and both land on the same code, the way every door refusal does.
 */
export function parseEstimate(raw: unknown): Result<Estimate, CadenceError> {
  if (typeof raw !== 'number') {
    return err(new CadenceError('INVALID_ESTIMATE', `estimateMinutes must be a number of minutes, got ${shown(raw)}`));
  }
  if (!legal(raw)) return err(illegal(raw));

  return ok(build(raw));
}
