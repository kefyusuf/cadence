# cadence

![CI](https://github.com/kefyusuf/cadence/actions/workflows/ci.yml/badge.svg)
![coverage](https://img.shields.io/badge/coverage-99.5%25%20stmts-green)

A recurring-schedule engine and team board. The part that is hard is the part that is
tested first: a rule like *"every day at 02:30, Europe/Berlin"* has to survive the two days a
year when that wall-clock time either does not exist or happens twice.

**Status:** week 4 of a build-in-public schedule — core engine, domain vocabulary, package surface,
the layering gates that keep them apart, the async layer that waits for an occurrence instead of just
computing it, a production image that checks itself, the adapters that implement the domain ports, the
configuration layer that reads the environment in one place, and the HTTP API in front of all of it.
The board UI, cache, queue and observability layers come next; see `docs/adr/`.

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

The API is the layer all of the above was built for: seven routes over the two stores and the engine.
`createApp(deps)` takes the boards store, the work-item store, the clock and the logger switch, and
returns an application that does not listen; `src/server/main.ts` is the one file
that reads the configuration and binds. Every handler *throws*, and one error handler is the only place
a throw becomes a body:

```sh
npm run build && PORT=3132 npm start

curl -X POST 127.0.0.1:3132/boards -H 'content-type: application/json' \
  -d '{"id":"bd_core","name":"Core platform","memberIds":["mb_yusuf"]}'
# 201 {"id":"bd_core","name":"Core platform","memberIds":["mb_yusuf"]}

curl -X POST 127.0.0.1:3132/boards/bd_core/work-items -H 'content-type: application/json' \
  -d '{"id":"wi_deploy","title":"Deploy the release","assigneeId":"mb_yusuf","estimateMinutes":30,
       "schedule":{"tz":"Europe/Berlin","dtStart":1774661400000,"freq":"DAILY"}}'
# 201 {"id":"wi_deploy","boardId":"bd_core","title":"Deploy the release","status":"backlog",
#      "assigneeId":"mb_yusuf","estimateMinutes":30,
#      "schedule":{"tz":"Europe/Berlin","dtStart":1774661400000,"freq":"DAILY"},
#      "createdAt":1791927350868}

curl -X POST 127.0.0.1:3132/boards/bd_core/work-items -H 'content-type: application/json' \
  -d '{"id":"wi_hourly","title":"Wrong frequency",
       "schedule":{"tz":"Europe/Berlin","dtStart":1774661400000,"freq":"HOURLY"}}'
# 400 {"error":{"code":"INVALID_FREQUENCY","message":"freq must be one of DAILY, WEEKLY, MONTHLY, YEARLY, got HOURLY"}}
```

That 400 is week 1's engine error, code and all, forwarded by a boundary that re-implements none of its
rules: the server validates a schedule by building the very series cursor the scheduler would walk, and
reports what the engine says. `dtStart` is epoch milliseconds, which is what the engine's type says and
what the stored rule keeps — send `"2026-03-28T01:30:00.000Z"` and the refusal names the field
(`dtStart must be an integer epoch ms, got 2026-03-28T01:30:00.000Z`), because a message about a
parameter called `after` would be the engine's vocabulary, not the client's.

The rest of the envelope contract is the same shape everywhere: ids declare their kind at the door
(`bd_`, `mb_`, `wi_`), so a board id in a work-item URL is a 400 rather than a 404 that reads like
"it is gone"; a route that does not exist answers `NOT_FOUND` in that envelope, and so does
`DELETE /boards`, because the layer answers 404 where it has no route instead of computing a 405; and a
failure nobody threw — a store whose pool is closed — answers 500 `INTERNAL` with the underlying
message withheld. Reasoning, including the two core defects this boundary found and where they were
fixed, is in [ADR 0008](docs/adr/0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md).

Three entry points, nothing else: `cadence` (recurrence engine, zero dependencies, no I/O),
`cadence/domain` (branded ids, board types, ports for the adapters), and `cadence/scheduler`
(`sleep` and `runSeries` — the only layer that waits). `src/adapters`, `src/config` and `src/server`
are compiled into `dist` and ship in the tarball, but the `exports` map has no key for any of them, so
they stay internal until publishing them is a decision. `cadence/src/...` is closed, and
CommonJS can `require()` all three on Node >= 22.12 — the reasoning is in
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md).

Design decisions and their trade-offs: [ADR 0001](docs/adr/0001-wall-clock-recurrence-over-epoch-arithmetic.md)
(wall-clock arithmetic), [ADR 0002](docs/adr/0002-throw-inside-result-at-the-boundary.md) (errors),
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md) (package shape),
[ADR 0004](docs/adr/0004-cancellation-is-a-value-and-the-clock-is-an-argument.md) (waiting),
[ADR 0005](docs/adr/0005-production-image-ships-dist-and-proves-itself.md) (the production image),
[ADR 0006](docs/adr/0006-the-first-adapter-holds-no-transport-and-the-gate-keeps-it-that-way.md) (the first adapter),
[ADR 0007](docs/adr/0007-the-environment-is-read-in-one-file-and-validated-by-a-pure-function.md) (configuration),
[ADR 0008](docs/adr/0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md) (the HTTP layer).

## Run it

All of this is green on the host (Node v26.8.2), inside the image CI builds (Node 24.21.0) and in a
clean `node:22-bookworm-slim` container with this tree copied in — the same 187 tests, 13 package
checks and coverage line on all three:

```sh
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint          # eslint flat config, type-aware (43 files, 0 errors, 0 warnings)
npm run lint:deps     # dependency-cruiser: no inner layer imports a package or a Node builtin, none reaches src/adapters or src/server, and core, domain and scheduler do not reach src/config either
npm test              # 187 tests in 16 files: wall-clock recurrence, DST transitions, cancellation, the notifier, configuration, the in-memory stores, the HTTP surface
npm run test:coverage # 99.51% statements / 97.39% branches / 100% functions, gated in vitest.config.ts
npm run build         # tsc -> dist with declarations and maps
npm run verify:package # 13 checks against the built package, not the source tree
npm start             # node dist/server/main.js — needs the build above, and reads HOST/PORT/LOG_LEVEL
```

```sh
docker build --target test -t cadence-test .
docker run --rm cadence-test npm test
docker run --rm cadence-test sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"
```

The `prod` target is a different shape: `dist` built inside the image by a `build` stage, one runtime
dependency (`fastify`, which arrives as 40 top-level `node_modules` directories and nothing else), code
owned by root so the `node` user can read but not rewrite it, and a self-check instead of a test run —
354MB against the test image's 472MB, `/app` 21M of it.

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
               it to an injected sink), env-config.ts (the one file that reads process.env),
               memory-store.ts (BoardStore and WorkItemStore over one pool, copying on the way in
               and the way out), system-clock.ts (the Clock port as `Date.now()`) — internal: dist has
               them, the exports map does not
src/server/    requests.ts (one body in, validated by the engine, not re-derived), http-error.ts (the
               throw the handlers use and the one translation of it), create-app.ts (the routes, over
               injected ports), main.ts (the composition root: the only file that both reads the
               configuration and binds) — internal too, and the only layer that may reach every other
test/          behaviour, DST transitions, validation, cancellation, configuration, public surface
scripts/       verify-package.mjs (the package surface), typecheck-consumer.ts,
               selfcheck.mjs (what the prod image runs as CMD and HEALTHCHECK)
Dockerfile     deps -> deps-prod -> build -> test -> prod
docs/adr/      decisions with their consequences
```

`src/core`, `src/domain`, `src/scheduler` and `src/config` import no packages and no Node builtins;
`src/core` and `src/domain` may not reach the scheduler; none of `src/core`, `src/domain`,
`src/scheduler` or `src/config` may import `src/adapters`, and nothing under those five directories may
import `src/server` — the composition root reaches down into every layer and nothing reaches up into it.
The `adapters` edge matters because importing `src/adapters/env-config.ts` would hand the pure
configuration layer a `process.env` read through the back door; the `server` edge matters because it
would put `fastify`, and then the whole HTTP surface, inside a package that promises zero dependencies.
Add to those the rule that no file under `src/` outside `src/adapters` may touch the `process` global,
and all of it is enforced by `npm run lint:deps` and `npm run lint`, not by a comment. That is what
makes the edge cases cheap to test, keeps the engine usable from a browser bundle later, and is the
reason an adapter can be swapped without the engine noticing.

## Not yet

Four adapters exist — the notifier, the environment reader, the in-memory stores and the system clock.
Of the ports in `src/domain/ports.ts`, `ScheduleNotifier`, `BoardStore`, `WorkItemStore` and `Clock` have
implementations and `IdGenerator` does not, because every route today takes its id from the caller: the
client names the board, the server does not. Board UI, durable persistence, caching, queueing and
metrics are still to come, and the HTTP layer is built against the in-memory stores — that is the seam,
not the persistence story: everything they hold is gone when the process is. Each lands with its own
test seam rather than as scaffolding.

Nothing on the HTTP surface is authenticated. Whoever can reach the port can create a board and move an
item; what limits that today is that the default bind is loopback and `compose.yaml` publishes no ports.
Week 5 owns the member identity the `mb_` ids are waiting for. The mutation surface is `PATCH` only —
no delete, no reorder, no bulk move — and a concurrent write is a last-writer-wins race, because the
stores keep no version.

The configuration layer knows four variables. It deliberately ignores everything else, which means a
misspelled name (`PTOR=8080`) boots with the default rather than warning — the mitigation ADR 0007
promised is in `main.ts` now: the resolved `AppConfig` is the first thing the process logs, so the
wrong value is one line into a boot instead of a mystery.

Delivery is at-most-once: `runSeries` advances the cursor before it notifies, so a sink that throws
loses that occurrence and a retry replays from the next one. Making that at-least-once needs stored
progress and a retry — week 12, not a wrapper around the notifier.

The scheduler is not wired to the API yet: a work item can carry a rule, and the routes will refuse a
bad one, but nothing walks the cursor the store holds. The prod image has no service to keep alive
either — its `CMD` and its `HEALTHCHECK` run the same self-check, so it proves the image is capable of
answering a probe, not that a server is up. Both flip in week 4's last slice, when the command becomes
the Fastify process and the probe becomes `/healthz`.
