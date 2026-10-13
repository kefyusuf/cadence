import { describe, expect, it } from 'vitest';

import { createSystemClock } from '../src/adapters/system-clock.js';

describe('the system clock', () => {
  it('reads the machine, to the whole millisecond the port promises', () => {
    const before = Date.now();
    const value = createSystemClock().now();
    const after = Date.now();

    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
