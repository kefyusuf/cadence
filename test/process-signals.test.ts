import { describe, expect, it } from 'vitest';

import { createProcessSignals } from '../src/adapters/process-signals.js';

/**
 * Nothing here emits a signal: `process.emit('SIGTERM')` would run every other listener in the process,
 * including the test runner's, so the pin is on the two things this adapter actually does — attach to the
 * real `process` object, and let go of it again. That the attach leads somewhere is what the container
 * proves with a real `SIGTERM` (see ADR 0009).
 */
describe('createProcessSignals', () => {
  it('attaches to the process and removes the same listener again', () => {
    const before = process.listenerCount('SIGTERM');
    const signals = createProcessSignals();
    const listener = (): void => {
      /* never called: this test is about registration, not about firing */
    };

    signals.on('SIGTERM', listener);
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    signals.off('SIGTERM', listener);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
