import type { Clock } from '../domain/ports.js';

/**
 * The one implementation of `Clock`: it reads the system clock and nothing else. Everything above it
 * takes a `Clock` as an argument, which is what makes a run whose schedule depends on "now" testable
 * at a fixed instant — `scripts/selfcheck.mjs` and the REST tests both hand over their own.
 */
export function createSystemClock(): Clock {
  return { now: (): number => Date.now() };
}
