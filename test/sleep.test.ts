import { describe, expect, it } from 'vitest';

import { type CadenceError, isCadenceError } from '../src/core/errors.js';
import { sleep, slices } from '../src/scheduler/sleep.js';

const MAX_SLICE = 2 ** 31 - 1;

function timerResources(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

async function rejection(promise: Promise<void>): Promise<CadenceError> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );

  if (!isCadenceError(failure)) throw new Error(`expected a CadenceError, got ${String(failure)}`);
  return failure;
}

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const startedAt = Date.now();
    await sleep(20);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it('accepts a zero delay so a past-due occurrence needs no wait', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('leaves no timer running once it settles', async () => {
    const before = timerResources();
    await sleep(5);

    expect(timerResources()).toBe(before);
  });

  it('cuts a long wait short and reports the abort', async () => {
    const controller = new AbortController();
    const before = timerResources();
    const pending = sleep(60_000, controller.signal);

    controller.abort('stop');
    const failure = await rejection(pending);

    expect(failure.code).toBe('ABORTED');
    expect(failure.cause).toBe('stop');
    expect(timerResources()).toBe(before);
  });

  it('never starts a timer for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const before = timerResources();
    const failure = await rejection(sleep(60_000, controller.signal));

    expect(failure.code).toBe('ABORTED');
    expect(timerResources()).toBe(before);
  });

  it('keeps the default abort reason as the cause', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);

    controller.abort();
    const failure = await rejection(pending);

    if (!(failure.cause instanceof Error)) throw new Error('expected an Error reason');
    expect(failure.cause.name).toBe('AbortError');
  });

  it('resolves a signaled wait that is never aborted and takes its listener back off', async () => {
    // this is what every on-time notification in production does: the timer wins the race
    const controller = new AbortController();
    const before = timerResources();

    await expect(sleep(5, controller.signal)).resolves.toBeUndefined();

    expect(timerResources()).toBe(before);
    expect(controller.signal.aborted).toBe(false);

    controller.abort('after the wait finished');
    const failure = await rejection(sleep(5, controller.signal));

    expect(failure.code).toBe('ABORTED');
    expect(failure.cause).toBe('after the wait finished');
  });

  it('keeps waiting when the delay is past the timer ceiling', async () => {
    // setTimeout clamps a delay above 2**31-1 down to 1 ms and warns, so an unguarded sleep
    // "succeeds" almost instantly. A monthly rule is 30 days out, which is over that ceiling.
    const controller = new AbortController();
    const before = timerResources();
    let settled = false;

    const pending = sleep(MAX_SLICE + 1, controller.signal);
    void pending.then(
      () => { settled = true; },
      () => undefined,
    );

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(settled).toBe(false);

    controller.abort('cleanup');
    const failure = await rejection(pending);

    expect(failure.code).toBe('ABORTED');
    expect(timerResources()).toBe(before);
  });

  it('rejects a delay it cannot schedule', async () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failure = await rejection(sleep(ms));
      expect(failure.code, String(ms)).toBe('INVALID_DELAY');
    }
  });
});

describe('slices', () => {
  it('passes a delay one timer can honour straight through', () => {
    expect(slices(0)).toEqual([0]);
    expect(slices(20)).toEqual([20]);
    expect(slices(MAX_SLICE)).toEqual([MAX_SLICE]);
  });

  it('splits a delay that one timer cannot honour', () => {
    expect(slices(MAX_SLICE + 1)).toEqual([MAX_SLICE, 1]);
    expect(slices(2 * MAX_SLICE + 5)).toEqual([MAX_SLICE, MAX_SLICE, 5]);
  });

  it('loses no milliseconds and leaves no slice past the ceiling', () => {
    for (const ms of [0, 1, 999, MAX_SLICE - 1, MAX_SLICE, MAX_SLICE + 1, 30 * 86_400_000, 3 * MAX_SLICE + 7]) {
      const parts = slices(ms);

      expect(parts.reduce((total, part) => total + part, 0), String(ms)).toBe(ms);
      for (const part of parts) {
        expect(part, `${String(ms)} -> ${String(part)}`).toBeLessThanOrEqual(MAX_SLICE);
        expect(part, `${String(ms)} -> ${String(part)}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
