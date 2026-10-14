/**
 * The one file that reaches for the process's signals, in the same way `env-config.ts` is the one file
 * that reads `process.env`: `no-restricted-globals` bans the `process` global everywhere under `src/`
 * except here, so a listener is something the composition root is handed, not something a route can
 * attach on its own.
 *
 * The two signal names are spelled here as well as in `src/server/shutdown.ts` on purpose. Importing
 * that module would be an adapter reaching up into the server, which `nothing-inside-src-imports-the-server`
 * refuses, and the duplication is not unchecked: the object this returns is only accepted by
 * `waitForStopSignal` where `main.ts` passes it, and both interfaces declare their members as properties
 * holding functions, so widening the signal list on the server side alone stops compiling here. Measured:
 * adding `SIGUSR1` to `StopSignal` makes `npm run typecheck` fail with `Type '"SIGUSR1"' is not assignable
 * to type '"SIGTERM" | "SIGINT"'`, which is the one drift that would otherwise cost a listener nobody
 * attached.
 */
export interface ProcessSignals {
  on: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
  off: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void;
}

export function createProcessSignals(): ProcessSignals {
  return {
    on: (signal, listener) => {
      process.on(signal, listener);
    },
    off: (signal, listener) => {
      process.off(signal, listener);
    },
  };
}
