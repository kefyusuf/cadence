# cadence

![CI](https://github.com/kefyusuf/cadence/actions/workflows/ci.yml/badge.svg)
![coverage](https://img.shields.io/badge/coverage-99%25%20stmts-green)

A recurring-schedule engine and team board. The part that is hard is the part that is
tested first: a rule like *"every day at 02:30, Europe/Berlin"* has to survive the two days a
year when that wall-clock time either does not exist or happens twice.

**Status:** week 4 of a build-in-public schedule — core engine, domain vocabulary, package surface,
the layering gates that keep them apart, the async layer that waits for an occurrence instead of just
computing it, a production image that checks itself, the first adapter implementing a domain port,
and the configuration layer that reads the environment in one place. The HTTP API, board UI, cache,
queue and observability layers come next; see `docs/adr/`.

## What it does today

```ts
import { nextOccurrence } from 'cadence';

const rule = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' };

nextOccurrence(rule, rule.dtStart);
// { instant: 1774746000000, index: 1,   -> 2026-03-29T01:00:00Z
//   targetWall: { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
//   disambiguation: 'gap-roll-forward' }   // 02:30 does not exist that night in Berlin
```

Supported: `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`, `interval`, `count`, `byWeekDay`
(Monday-start weeks), `byMonthDay` including negative month-end offsets. A series is a lazy
`Generator`, and `createSeriesCursor` walks it incrementally instead of re-scanning from the
anchor. Failures are a typed `CadenceError` code union inside the core and a `Result` value at
the boundary — see [ADR 0002](docs/adr/0002-throw-inside-result-at-the-boundary.md).

Waiting is a separate layer, and it takes its clock as an argument:

```ts
import { createSeriesCursor } from 'cadence';
import { runSeries, sleep } from 'cadence/scheduler';

const cursor = createSeriesCursor({ tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 0, 6, 9, 0), freq: 'DAILY' });

const summary = await runSeries(cursor, {
  clock: { now: () => Date.UTC(2026, 0, 8, 12, 0) }, // two days past due, so both are late
  sleep,
  notify: (occurrence) => console.log(occurrence.index, new Date(occurrence.instant).toISOString()),
  limit: 2,
});
// 0 2026-01-06T09:00:00.000Z          <- each notify, in due order
// 1 2026-01-07T09:00:00.000Z
// { delivered: 2, late: 2, endedBy: 'limit' }   cursor.consumed() === 2
```

An `AbortSignal` that fires mid-wait ends the run with `endedBy: 'aborted'` and leaves the
occurrence it was waiting for on the cursor, so a second `runSeries` on the same cursor picks it
up. Cancellation is a value the caller branches on, not an exception —
see [ADR 0004](docs/adr/0004-cancellation-is-a-value-and-the-clock-is-an-argument.md).

The scheduler takes a `(occurrence) => …` callback, and the domain port that knows about work items
is `ScheduleNotifier`. The first adapter for it is a factory with an injected sink, so the
composition is one line:

```ts
import { createLogNotifier } from './src/adapters/log-notifier.js'; // repo-internal, not exported

// clock and sleep step the calendar forward to each due time instead of waiting for it — with the
// real `sleep` this run would take three days.
const notifier = createLogNotifier({ sink: (record) => console.log(JSON.stringify(record)), clock });

await runSeries(cursor, { clock, sleep, notify: (occurrence) => notifier.notify(item, occurrence), limit: 3 });
// {"msg":"cadence.due","itemId":"wi_deploy","boardId":"bd_core","assigneeId":"mb_yusuf","title":"Deploy the release",
//  "index":0,"due":"2026-03-28T01:30:00.000Z","wall":"2026-03-28 02:30:00","tz":"Europe/Berlin",
//  "disambiguation":"exact","emittedAt":"2026-03-28T01:30:00.000Z","late":false}   <- the first record, in full
// then: index 1  due 2026-03-29T01:00:00.000Z  wall 2026-03-29 02:30:00  gap-roll-forward
//       index 2  due 2026-03-30T00:30:00.000Z  wall 2026-03-30 02:30:00  exact
// { delivered: 3, late: 0, endedBy: 'limit' }
```

Both times are in every record on purpose: that rule is daily, so `wall` never moves while `due`
steps 23h then 24h across the spring gap. A sink that throws costs the occurrence it was handed —
`runSeries` consumes before it notifies, so delivery is at-most-once until week 12 adds an outbox.
The reasoning, including the `bindNotifier` helper that was rejected, is in
[ADR 0006](docs/adr/0006-the-first-adapter-holds-no-transport-and-the-gate-keeps-it-that-way.md).

Configuration is read in exactly one place and validated by a function that never touches the
platform, so the rules are testable and a typo cannot reach `listen()`:

```ts
import { loadAppConfig } from './src/adapters/env-config.js'; // also repo-internal

loadAppConfig({ HOST: 'localhost:3000', PORT: '8O80', LOG_LEVEL: 'verbose' });
// CadenceError INVALID_CONFIG, one message naming all three:
//   config refused: HOST looks like host:port — set PORT separately, got "localhost:3000";
//   PORT must be a plain decimal number, got "8O80";
//   LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, got "verbose"

loadAppConfig({});
// { ok: true, value: { host: '127.0.0.1', port: 3000, logLevel: 'info', environment: 'development' } }
```

`8O80` is the case the layer exists for: `Number('8O80')` is `NaN`, and `NaN` passed to `listen()`
means "bind a random port". Unset means the safe default — loopback, not every interface. See
[ADR 0007](docs/adr/0007-the-environment-is-read-in-one-file-and-validated-by-a-pure-function.md).

Three entry points, nothing else: `cadence` (recurrence engine, zero dependencies, no I/O),
`cadence/domain` (branded ids, board types, ports for the adapters that mostly do not exist yet) and
`cadence/scheduler` (`sleep` and `runSeries` — the only layer that waits). `src/adapters` and
`src/config` are compiled into `dist` and ship in the tarball, but the `exports` map has no key for
either, so they stay internal until publishing them is a decision. `cadence/src/...` is closed, and
CommonJS can `require()` all three on Node >= 22.12 — the reasoning is in
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md).

Design decisions and their trade-offs: [ADR 0001](docs/adr/0001-wall-clock-recurrence-over-epoch-arithmetic.md)
(wall-clock arithmetic), [ADR 0002](docs/adr/0002-throw-inside-result-at-the-boundary.md) (errors),
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md) (package shape),
[ADR 0004](docs/adr/0004-cancellation-is-a-value-and-the-clock-is-an-argument.md) (waiting),
[ADR 0005](docs/adr/0005-production-image-ships-dist-and-proves-itself.md) (the production image),
[ADR 0006](docs/adr/0006-the-first-adapter-holds-no-transport-and-the-gate-keeps-it-that-way.md) (the first adapter),
[ADR 0007](docs/adr/0007-the-environment-is-read-in-one-file-and-validated-by-a-pure-function.md) (configuration).

## Run it

All of this is green on the host and inside the image CI uses:

```sh
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint          # eslint flat config, type-aware (33 files)
npm run lint:deps     # dependency-cruiser: no inner layer imports a package or a Node builtin, none reaches src/adapters, and core, domain and scheduler do not reach src/config either
npm test              # 133 tests, wall-clock recurrence, DST transitions, cancellation, the notifier, configuration
npm run test:coverage # 99% statements / 96% branches / 100% functions, gated in vitest.config.ts
npm run build         # tsc -> dist with declarations and maps
npm run verify:package # 12 checks against the built package, not the source tree
```

```sh
docker build --target test -t cadence-test .
docker run --rm cadence-test npm test
docker run --rm cadence-test sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"
```

The `prod` target is a different shape: `dist` built inside the image by a `build` stage, zero
runtime packages, code owned by root so the `node` user can read but not rewrite it, and a
self-check instead of a test run — 330MB against the test image's 448MB.

```sh
docker build --target prod -t cadence-prod .
docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges:true cadence-prod
```

That second command prints one line and exits: it is `scripts/selfcheck.mjs`, the image's `CMD`,
its `HEALTHCHECK`, and the probe CI runs — which is why all three agree on what "this image works"
means. [ADR 0005](docs/adr/0005-production-image-ships-dist-and-proves-itself.md) records what it
checks and what the check got wrong the first time.

Or through Compose. There is no bind mount: the image *is* the file system, so `--build` is what
picks up your edits (the rebuild copies sources; the dependency layer stays cached).

```sh
docker compose run --rm --build app npm test
docker compose run --rm --build app sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"
docker compose run --rm --build prod    # the self-check, under read_only + cap_drop: ALL
```

## Layout

```
src/core/      clock.ts (wall <-> instant), recurrence.ts (rule -> occurrence),
               cursor.ts, errors.ts, result.ts, index.ts
src/domain/    ids.ts (branded ids + parseId), model.ts, ports.ts (the shapes adapters implement)
src/scheduler/ sleep.ts (a cancellable wait), run-series.ts (walk a cursor in due order), index.ts
src/config/    app-config.ts (AppConfig and the rules that produce it — takes a record, never
               reads the platform)
src/adapters/  log-notifier.ts (a ScheduleNotifier that renders one record per occurrence and hands
               it to an injected sink), env-config.ts (the one file that reads process.env) —
               internal: dist has them, the exports map does not
test/          behaviour, DST transitions, validation, cancellation, configuration, public surface
scripts/       verify-package.mjs (the package surface), typecheck-consumer.ts,
               selfcheck.mjs (what the prod image runs as CMD and HEALTHCHECK)
Dockerfile     deps -> deps-prod -> build -> test -> prod
docs/adr/      decisions with their consequences
```

`src/core`, `src/domain`, `src/scheduler` and `src/config` import no packages and no Node builtins;
`src/core` and `src/domain` may not reach the scheduler; none of `src/core`, `src/domain`,
`src/scheduler` or `src/config` may import `src/adapters` — that last edge matters, because importing
`src/adapters/env-config.ts` would hand the pure configuration layer a `process.env` read through the
back door; and no file under `src/` outside `src/adapters` may touch the `process` global — enforced by
`npm run lint:deps` and `npm run lint`, not by a comment. That is what makes the edge cases cheap to
test, keeps the engine usable from a browser bundle later, and is the reason an adapter can be
swapped without the engine noticing.

## Not yet

Two adapters exist — the notifier and the environment reader. Of the ports in `src/domain/ports.ts`,
`ScheduleNotifier` has an implementation and `Clock`, `IdGenerator`, `BoardStore` and `WorkItemStore`
do not; the HTTP surface, board UI, persistence, caching, queueing and metrics are all still to come.
Each lands with its own test seam rather than as scaffolding.

The configuration layer knows four variables. It deliberately ignores everything else, which means a
misspelled name (`PTOR=8080`) boots with the default rather than warning — the startup log line that
echoes the resolved config is the fix, and it arrives with the server.

Delivery is at-most-once: `runSeries` advances the cursor before it notifies, so a sink that throws
loses that occurrence and a retry replays from the next one. Making that at-least-once needs stored
progress and a retry — week 12, not a wrapper around the notifier.

The prod image has no service to keep alive either: its `HEALTHCHECK` runs the same self-check the
`CMD` does, so it proves the image is capable of answering a probe, not that a server is up. That
flips in week 4, when the command becomes the Fastify process and the probe becomes an endpoint.
