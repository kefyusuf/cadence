import { CadenceError } from '../core/errors.js';

/**
 * `setTimeout` clamps a delay above 2**31-1 ms (~24.8 days) down to 1 ms and only warns, so a
 * month-long wait would otherwise resolve immediately and deliver an occurrence a month early.
 */
const MAX_SLICE_MS = 2 ** 31 - 1;

/**
 * The waits a `sleep` of `ms` is made of, each short enough for a host timer to honour. The
 * slices add back up to `ms`, so no part of the delay is lost in the split.
 *
 * Not exported from `cadence/scheduler`: it is here so the arithmetic is testable without
 * waiting days for a timer.
 */
export function slices(ms: number, ceiling = MAX_SLICE_MS): readonly number[] {
  if (ms <= ceiling) return [ms];

  const out: number[] = [];
  let remaining = ms;

  while (remaining > ceiling) {
    out.push(ceiling);
    remaining -= ceiling;
  }

  out.push(remaining);
  return out;
}

/**
 * A wait that can be cut short. Cancellation is observed through the signal, and the value given
 * to `AbortController.abort(reason)` is preserved as the `cause` of the rejection.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isInteger(ms) || ms < 0) {
    throw new CadenceError('INVALID_DELAY', `delay must be a whole number of milliseconds, got ${String(ms)}`);
  }

  if (signal?.aborted) {
    throw new CadenceError('ABORTED', `sleep of ${String(ms)} ms was never started`, { cause: reasonOf(signal) });
  }

  for (const slice of slices(ms)) {
    await wait(slice, signal);
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CadenceError('ABORTED', `wait of ${String(ms)} ms was cancelled`, { cause: reasonOf(signal) }));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

/** `AbortSignal.reason` is typed `any`; the reason is whatever the aborter passed. */
function reasonOf(signal: AbortSignal | undefined): unknown {
  return signal?.reason;
}
