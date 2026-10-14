/**
 * The signals this process treats as a request to stop. Named here rather than taken from Node's
 * `Signals` union: the seam describes what *this service* answers to, and a stop request spelled
 * `SIGTERM2` should not compile.
 */
export type StopSignal = 'SIGTERM' | 'SIGINT';

/**
 * The part of the operating system this code can see: attach a listener to a named signal, let go of
 * it again. `node:process` already satisfies this shape, which is why `src/adapters/process-signals.ts`
 * does not import it — the direction gate forbids an adapter from reaching up into `src/server`, so the
 * two are checked against each other at the place that wires them together, in `main.ts`.
 *
 * The members are written as properties holding functions, not as method signatures, and that is the
 * whole reason the check works: TypeScript compares method parameters bivariantly and function-property
 * parameters contravariantly (`strictFunctionTypes` is on with `strict`), so a signal added to
 * `StopSignal` on this side only stops compiling instead of quietly attaching nothing.
 */
export interface SignalSource {
  on: (signal: StopSignal, listener: () => void) => void;
  off: (signal: StopSignal, listener: () => void) => void;
}

/**
 * Resolves with the name of the first signal that arrives, and takes every listener back with it.
 *
 * The removal is not tidiness, it is what keeps a second stop request from starting a second shutdown.
 * What it does *not* do is put the old behaviour back: inside a container this process is PID 1, and the
 * kernel applies no default disposition to PID 1, so once the listener is gone a further `SIGTERM` is
 * simply ignored. Measured: a plain `node -e "setInterval(() => {}, 1000)"` as PID 1 sat through
 * `docker kill --signal=SIGTERM`, while the same script started with `--init` exited 143. The escalation
 * a supervisor reaches for is therefore SIGKILL at the end of the grace period, and the close that
 * follows this promise has to fit inside it.
 *
 * It never rejects: a signal is not an error, it is the request to stop.
 */
export function waitForStopSignal(
  source: SignalSource,
  signals: readonly StopSignal[],
): Promise<StopSignal> {
  return new Promise<StopSignal>((resolve) => {
    const attached = new Map<StopSignal, () => void>();

    for (const signal of signals) {
      const listener = (): void => {
        for (const [name, handler] of attached) source.off(name, handler);
        attached.clear();
        resolve(signal);
      };

      attached.set(signal, listener);
      source.on(signal, listener);
    }
  });
}
