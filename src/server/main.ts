import { loadAppConfig } from '../adapters/env-config.js';
import { createMemoryStores } from '../adapters/memory-store.js';
import { createProcessSignals } from '../adapters/process-signals.js';
import { createSystemClock } from '../adapters/system-clock.js';
import { isOk } from '../core/result.js';
import { createApp } from './create-app.js';
import { waitForStopSignal } from './shutdown.js';

/**
 * The composition root: the only file that decides which implementation answers which port, and the
 * only one that is allowed to be untestable — everything it does is either reading the world (an
 * adapter: the environment, the process's signals) or opening a socket (Fastify), and both are proven
 * where they are. `npm run build` compiles it and `node dist/server/main.js` runs it; `cadence/server`
 * stays off the package surface, which `scripts/verify-package.mjs` checks.
 *
 * A refused configuration is thrown rather than printed: `no-console` is a rule here, and node already
 * reports an uncaught error on stderr with a non-zero exit — which is what a container supervisor reads.
 */
const config = loadAppConfig();
if (!isOk(config)) throw config.error;

const app = createApp({
  ...createMemoryStores(),
  clock: createSystemClock(),
  logger: { level: config.value.logLevel },
});

// ADR 0007's mitigation for a variable nobody spelled right: the settings that were actually resolved
// are printed once, before the bind, so `PTOR=8080` shows up as `port: 3000` rather than as a mystery.
app.log.info(config.value, 'cadence configuration');

// What Fastify returns for a `0.0.0.0` bind is the first address it found, which is the loopback one —
// measured in the container, where it logged both `127.0.0.1:3000` and `172.17.0.2:3000` and resolved to
// the first. A line that says `listening at http://127.0.0.1:3000` on a process serving every interface
// is the kind of log that sends someone to the wrong file, so the settings that were asked for are the
// ones that get reported.
await app.listen({ host: config.value.host, port: config.value.port });
app.log.info(`cadence listening on ${config.value.host}:${String(config.value.port)}`);

// Registering the listener is the only reason a container built `FROM node` can be stopped at all: as
// PID 1 the process takes no default action for `SIGTERM`, so without a listener `docker stop` would sit
// out its grace period and end in SIGKILL. Asking after the bind keeps the ordering honest — a stop
// request that arrives while the server is still starting is ignored, and it is the supervisor's SIGKILL
// that ends that process — and the listeners go away as soon as the answer starts, so a second request
// cannot begin a second shutdown.
const signal = await waitForStopSignal(createProcessSignals(), ['SIGTERM', 'SIGINT']);
app.log.info(`cadence stopping on ${signal}`);

await app.close();
