import { loadAppConfig } from '../adapters/env-config.js';
import { createMemoryStores } from '../adapters/memory-store.js';
import { createSystemClock } from '../adapters/system-clock.js';
import { isOk } from '../core/result.js';
import { createApp } from './create-app.js';

/**
 * The composition root: the only file that decides which implementation answers which port, and the
 * only one that is allowed to be untestable — everything it does is either reading the environment
 * (an adapter) or opening a socket (Fastify), and both are proven where they are. `npm run build`
 * compiles it and `node dist/server/main.js` runs it; `cadence/server` stays off the package surface,
 * which `scripts/verify-package.mjs` checks.
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

const address = await app.listen({ host: config.value.host, port: config.value.port });
app.log.info(`cadence listening at ${address}`);
