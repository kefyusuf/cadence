# cadence

![CI](https://github.com/kefyusuf/cadence/actions/workflows/ci.yml/badge.svg)
![coverage](https://img.shields.io/badge/coverage-99.6%25%20stmts-green)

A recurring-schedule engine and team board. The part that is hard is the part that is
tested first: a rule like *"every day at 02:30, Europe/Berlin"* has to survive the two days a
year when that wall-clock time either does not exist or happens twice.

**Status:** built 13–15 October 2026 — core engine, domain vocabulary, package surface,
the layering gates that keep them apart, the async layer that waits for an occurrence instead of just
computing it, the adapters that implement the domain ports, the configuration layer that reads the
environment in one place, the HTTP API in front of all of it, the container that runs it as a service:
an HTTP health probe in, a `SIGTERM` answered by a drain, exit 0 out — and, across those three days,
streams over the lazy engine: first the measurements of what a `Readable` actually pulls, then the route
those measurements were taken for, `GET /boards/:id/export`, with what a real socket does to it, the
estimate grown into the project's first value object, and the row a store with columns holds — the door
between those two shapes, with its cost measured. The board UI, cache, queue and observability layers
come next; see `docs/adr/`.

**Gate (measured, not claimed):** 23 test files · 288 tests · 99.63% statement and 98.38% branch
coverage · 13 ADRs. CI runs typecheck, lint, dependency lint, coverage, build and package
verification on Node 22 and 24, and a second job builds the test and prod images, keeps the prod
container running read-only, unprivileged and with all capabilities dropped until its own
`GET /healthz` probe reports `healthy`, then proves that a `SIGTERM` stops it with exit code 0.

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
`runSeries` consumes before it notifies, so delivery is at-most-once — an outbox is planned, not built.
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

The domain now owns its first value. `estimateMinutes` is not a `number` the door checks — it is an
`Estimate`, frozen the moment it exists, whole minutes at or above zero or nothing at all, with structural
`equals` and a `toJSON` that keeps the wire a bare `30`. `parseEstimate` answers a `unknown` with a `Result`
and the HTTP layer only translates it; `createEstimate` is the same parse with a throw on top. The interface
carries a compile-time brand like `BoardId` does, so a literal shaped like an estimate is not one and a work
item that carries `-3` is not a thing this codebase can say. Reasoning — including the discovery that
`structuredClone` cannot copy a value with methods, and so the store shares the frozen one and deep-clones
only the schedule — is in
[ADR 0012](docs/adr/0012-a-value-is-shared-not-copied-the-store-clones-what-can-change-and-hands-out-what-cannot.md).

A value cannot live in a column, so the domain now owns the door between the two shapes. `WorkItemRow` is
the same eight fields with the brands erased — ids are strings, `status` is a string, the estimate is the
number it was made of — and `parseWorkItemRow` reads a row an outside store handed it by asking the door that
owns each rule, never by re-deriving one:

```ts
import { parseWorkItemRow, toWorkItemRow } from 'cadence/domain';

const row = { id: 'wi_deploy', boardId: 'bd_core', title: 'Deploy the release', status: 'ready',
              assigneeId: 'mb_yusuf', estimateMinutes: 30,
              schedule: { tz: 'Europe/Berlin', dtStart: 1774661400000, freq: 'WEEKLY', byWeekDay: ['MO', 'FR'] },
              createdAt: 1772000000000 };

parseWorkItemRow(row);
// { ok: true, value: { …, estimateMinutes: Estimate, … } } — a value again: it JSON-stringifies to 30,
//   `equals` the estimate that went in, and is not the same object. toWorkItemRow of it is that row.
parseWorkItemRow({ ...row, status: 'archived' });
// INVALID_STATUS    status must be one of backlog, ready, in_progress, blocked, done, got "archived"
parseWorkItemRow({ ...row, schedule: { ...row.schedule, freq: 'HOURLY' } });
// INVALID_FREQUENCY freq must be one of DAILY, WEEKLY, MONTHLY, YEARLY, got HOURLY   <- the engine's own words
parseWorkItemRow({ ...row, estimateMinutes: '30' });
// INVALID_ESTIMATE  estimateMinutes must be a number of minutes, got "30"
parseWorkItemRow({ ...row, id: 'wi_deploy ' });
// INVALID_ID        work-item id must not have leading or trailing whitespace
parseWorkItemRow({ ...row, createdAt: 1.5 });
// INVALID_INSTANT   createdAt must be an integer epoch ms, got 1.5
parseWorkItemRow(null);
// INVALID_WORK_ITEM a work item row must be a JSON object, got null
```

The order is the one ADR 0012 measured and this makes a rule: cloning the item throws `DataCloneError`,
cloning the row is fine, so a store copies the row and hydrates it, never the other way round. Every
refusal above belongs to somebody else — the engine wrote `INVALID_FREQUENCY`, the clock wrote
`INVALID_INSTANT`, the vocabulary wrote `INVALID_STATUS`, the id rule wrote `INVALID_ID` — and the codec
quotes them rather than inventing a second wording. One shape is not a refusal at all: a rule the engine
crashes on (`byWeekDay` spelled as a string, which the engine never type-checks) is this process's problem,
and the route answers 500 `INTERNAL` with the engine's own words withheld. The ports did
not change — `WorkItemStore` still speaks `WorkItem` — because the alternative was every adapter keeping its
own copy of four rules that already have owners. Reasoning, including the two fields this codec deliberately
does not police and what hydrating 100000 scheduled rows costs on three runtimes, is in
[ADR 0013](docs/adr/0013-a-store-holds-a-row-the-domain-holds-a-value-and-one-codec-in-the-domain-owns-the-door-between.md).

The API is the layer all of the above was built for: eight routes over the two stores and the engine.
`createApp(deps)` takes the boards store, the work-item store, the clock and the logger switch, and
returns an application that does not listen; `src/server/main.ts` is the one file that reads the
configuration, binds, and waits for the process to be asked to stop. Every handler *throws*, and one
error handler is the only place a throw becomes a body:

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

That 400 is the engine's own error, code and all, forwarded by a boundary that re-implements none of its
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
message withheld, and so does a door's `UNEXPECTED`: the label `fromThrowable` puts on a throw this
codebase did not write (ADR 0013 decision 9). Reasoning, including the two core defects this boundary
found and where they were fixed, is in
[ADR 0008](docs/adr/0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md).

The eighth route is the first response this service does not have in hand before it answers.
`GET /boards/:id/export` streams NDJSON — one header row per work item, one row per occurrence of its rule,
then a `done` row — over a cursor that advances one row per pull (ADR 0010 decision 8), so the first line
goes out while the last occurrence is still only a rule. The body of the `wi_deploy` item above, at
`occurrences=3`, with each line's own byte count in front of it:

```sh
curl -s '127.0.0.1:3132/boards/bd_core/export?occurrences=3'
# 198B {"kind":"item","id":"wi_deploy","title":"Deploy the release","status":"backlog","assigneeId":"mb_yusuf","estimateMinutes":30,"schedule":{"tz":"Europe/Berlin","dtStart":1774661400000,"freq":"DAILY"}}
# 162B {"kind":"occurrence","itemId":"wi_deploy","index":0,"instant":1774661400000,"at":"2026-03-28T01:30:00.000Z","wall":"2026-03-28T02:30:00","disambiguation":"exact"}
# 173B {"kind":"occurrence","itemId":"wi_deploy","index":1,"instant":1774746000000,"at":"2026-03-29T01:00:00.000Z","wall":"2026-03-29T02:30:00","disambiguation":"gap-roll-forward"}
# 162B {"kind":"occurrence","itemId":"wi_deploy","index":2,"instant":1774830600000,"at":"2026-03-30T00:30:00.000Z","wall":"2026-03-30T02:30:00","disambiguation":"exact"}
#  51B {"kind":"done","items":1,"occurrences":3,"bound":3}
```

`746` bytes of JSON plus a newline per row is a `751`-byte body, `150.2` bytes per row, measured over a real
socket on the host (Node v26.8.2) and byte-for-byte the same in `cadence-test` (Node 24.21.0). A row is a
string here and
not an object someone has to encode, which is why `highWaterMark` can count rows and the byte question never
reaches the route. Those five counts are no longer only a document's claim: `npm test` writes this exact body
and asserts its line lengths and its total, so a change that moves a byte on the wire goes red instead of
quietly making the README wrong — which is how the estimate becoming a value object was shown to be a
non-event for the contract. The occurrence row carries both clocks — `instant`/`at` for the moment, `wall`/
`disambiguation` for what the rule asked — because the third line is the reason the export exists: a reader
with no engine in front of them cannot otherwise tell that 02:30 in Berlin happened at 01:00Z.

`?occurrences=` is the only thing in this route that bounds the walk, and the door validates it before a
cursor exists: absent means `20`, and `1001` is refused with `400 {"error":{"code":"INVALID_OCCURRENCES",
"message":"occurrences must be at most 1000, got 1001"}}` and no row written. That is a measurement, not
caution for its own sake. A client that read 2087 bytes and hung up left the engine `1188` steps in on the
host and `3930` in the image *with a buffer of one row*: `highWaterMark` does not bound work, the socket
queue does (~1200 rows here, ~3900 there), and a buffer only adds to that once it is bigger than it. Read to
the end, 40 daily items at bound `200` is `8041` rows / `1353678` bytes (`219.34` and `275.5` ms on the host,
`231.17` and `229.32` in the image) and at the ceiling bound `1000`, `40041` rows / `6755640` bytes
(`1045.74` and `1753.4`, `1036.13` and `1056.8` ms).

A body produced as it goes cannot announce its own truncation. The response is `transfer-encoding: chunked`
with no `content-length` (measured absent on every response of this route), a client that leaves mid-body
gets `ECONNRESET` on the `200` it was already given, and a walk that fails mid-body arrives the same way —
on the wire those are one event. So completeness is in band or it is nowhere: a reader that never saw the
`done` row has a partial export. The rest of what was measured here — that Fastify destroys the source stream
at the socket close, which is why this route writes no disconnect handler, and that `app.close()` waits for
an abandoned streamed response and can wait for ever on one client shape — is
[ADR 0011](docs/adr/0011-the-response-dies-with-the-socket-and-only-the-request-bounds-the-walk.md).

Three entry points, nothing else: `cadence` (recurrence engine, zero dependencies, no I/O),
`cadence/domain` (branded ids, the estimate value, board types, ports for the adapters), and `cadence/scheduler`
(`sleep` and `runSeries` — the only layer that waits). `src/adapters`, `src/config` and `src/server`
are compiled into `dist` and ship in the tarball, but the `exports` map has no key for any of them, so
they stay internal until publishing them is a decision. `cadence/src/...` is closed, and
CommonJS can `require()` all three on Node >= 22.12 — the reasoning is in
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md).

The streaming work adds no product code at first: it measures what a `Readable` does *around* an engine that is
already lazy, because the route it then made room for — the NDJSON export above — is the first consumer
that can stop, fail or go slow. One `read()` pulls exactly `highWaterMark` engine steps and hands back one of them, then
refills one row per tick. `Readable.from(iterable)` defaults to `objectMode: true` with `highWaterMark: 1`
— not `new Readable()`'s default and not `new Readable({objectMode: true})`'s — and that pair is identical
on the host's v26.8.2 and in `node:22.23.3`, `node:24.21.0` and `node:26.11.1`, while the *byte* default is
not (65536 in the images, 16384 on v26.8.2). The shape that decides the route is a bare `resume()` on a
`DAILY` rule with no `count`: it walked 200000 candidate occurrences — the engine's own `MAX_CANDIDATES`
guard, about 547 years of daily occurrences — in 4614.5 ms on the host (4379 ms on an earlier run of the
same script) and 4360.8 ms inside `cadence-test`,
and a 1 ms interval registered before it fired 6 times (host) and 57 times (image) instead of about 4500,
because the pull never yielded to the timer phase. Politeness to the event loop comes from the consumer
asking, not from the stream. `test/stream-semantics.test.ts` pins the bounded version of every one of those
numbers — 20 tests that count engine steps and event order rather than wall time, so they hold on all three
runtimes — including the five teardown paths (`destroy()`, `destroy(err)`, `break` in `for await`, a
throwing consumer, and a stream nobody ever read, which has no `finally` to reach), the defaults in
decision 2, both `write()`-return loops, and the fact that an `AbortSignal` changes nothing until the route
wires it to `destroy()` itself. The second slice put that last claim against a real socket and the socket
won it: Fastify destroys the source stream at the close on its own, so `GET /boards/:id/export` writes no
disconnect handler and says so in a comment (ADR 0011 decision 1).
`stream.destroyOnAbort` is `undefined` on every runtime the probe checked —
v26.8.2, `node:22.23.3`, `node:24.21.0`, `node:26.11.1` — which is a fact about those runtimes, recorded in
the ADR rather than asserted by a test. Reasoning and the full number tables:
[ADR 0010](docs/adr/0010-a-stream-pulls-exactly-what-its-consumer-asks-for-unless-somebody-flows-it.md).

Design decisions and their trade-offs: [ADR 0001](docs/adr/0001-wall-clock-recurrence-over-epoch-arithmetic.md)
(wall-clock arithmetic), [ADR 0002](docs/adr/0002-throw-inside-result-at-the-boundary.md) (errors),
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md) (package shape),
[ADR 0004](docs/adr/0004-cancellation-is-a-value-and-the-clock-is-an-argument.md) (waiting),
[ADR 0005](docs/adr/0005-production-image-ships-dist-and-proves-itself.md) (the production image),
[ADR 0006](docs/adr/0006-the-first-adapter-holds-no-transport-and-the-gate-keeps-it-that-way.md) (the first adapter),
[ADR 0007](docs/adr/0007-the-environment-is-read-in-one-file-and-validated-by-a-pure-function.md) (configuration),
[ADR 0008](docs/adr/0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md) (the HTTP layer),
[ADR 0009](docs/adr/0009-the-containers-command-is-the-service-and-a-service-is-proved-by-the-request-it-answers.md) (the running service and its signals),
[ADR 0010](docs/adr/0010-a-stream-pulls-exactly-what-its-consumer-asks-for-unless-somebody-flows-it.md) (what a stream pulls, measured),
[ADR 0011](docs/adr/0011-the-response-dies-with-the-socket-and-only-the-request-bounds-the-walk.md) (the streamed route, and what a real socket does to it),
[ADR 0012](docs/adr/0012-a-value-is-shared-not-copied-the-store-clones-what-can-change-and-hands-out-what-cannot.md) (the first value object, and what a store can and cannot copy),
[ADR 0013](docs/adr/0013-a-store-holds-a-row-the-domain-holds-a-value-and-one-codec-in-the-domain-owns-the-door-between.md) (the row a column store holds, and which layer owns the door it comes through).

## Run it

All of this is green on the host (Node v26.8.2), inside the image CI builds (Node 24.21.0) and in a
clean `node:22-bookworm-slim` container with this tree copied in — the same `288 tests in 23 files`, the same
13 package checks over 7 export targets, the same 56 files linted clean, and the same
`64 modules / 134 dependencies` wherever `dist` does not exist yet. Coverage does not split by runtime
either: `1084` of `1088` statements and `486` of `494` branches on all three. The package is the one figure
that still tracks the call: 115 files on every runtime, and a gzipped byte total that moves when this
document is edited, because this document is inside it — and moves again with the filesystem that packed it,
which is why the per-environment totals, and the tar-header modes that explain the gap between them, are
recorded in [ADR 0013](docs/adr/0013-a-store-holds-a-row-the-domain-holds-a-value-and-one-codec-in-the-domain-owns-the-door-between.md)
rather than inherited from the ADR before it, which the tarball does not ship (ADR 0011 decision 4 records why
the bytes follow the call):

```sh
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint          # eslint flat config, type-aware (56 files, 0 errors, 0 warnings)
npm run lint:deps     # dependency-cruiser: no inner layer imports a package or a Node builtin, none reaches src/adapters or src/server, and core, domain and scheduler do not reach src/config either — 0 violations, 61 modules / 128 dependencies with dist present and 64 / 134 without it
npm test              # 288 tests in 23 files: wall-clock recurrence, DST transitions, cancellation, the notifier, configuration, the in-memory stores, the HTTP surface, the stop path, the semantics of a stream over the engine, the NDJSON export stream and that export over a real socket, the estimate as a value, the row a store with columns holds, and the 500 that says nothing about an engine bug
npm run test:coverage # 99.63% statements (1084/1088) / 98.38% branches (486/494) / 100% functions, identical on all three runtimes, gated in vitest.config.ts
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
owned by root so the `node` user can read but not rewrite it, and a command that is the service itself —
354MB against the test image's 472MB, `/app` 21M of it.

```sh
docker build --target prod -t cadence-prod .    # its last step is the self-check, run as the runtime user

docker run -d --name cadence --read-only --cap-drop=ALL --security-opt no-new-privileges:true \
  --health-interval=1s --health-start-period=1s --health-retries=3 -p 127.0.0.1:3000:3000 cadence-prod
curl -s http://127.0.0.1:3000/healthz            # {"ok":true} — the image's own probe read "healthy" 1s after start
docker stop --time 5 cadence                     # SIGTERM -> "cadence stopping on SIGTERM" -> exit 0, 555ms later
```

3000 is the port the image sets and the file publishes, and it is what a reader types; the numbers above
were taken with that same container published on `127.0.0.1:3141`, because something else on this machine
already held 3000. The container cannot tell the difference — it answers `POST /boards` with a 201 and the
engine's own `INVALID_INSTANT` refusal with a 400 through either mapping, which is the point of
`EXPOSE 3000` living in the image and the host mapping living in you.

Two of those four lines are the image's proof, and neither is a test run: the build's last step and the
container's health status. The build ends with `scripts/selfcheck.mjs` — it used to be the `CMD`, which was
a way of saying the container had no service yet; now a package that cannot load itself is a build that does
not finish. The `HEALTHCHECK` is an HTTP
request to `/healthz` made by Node's own `fetch`, because this image installs no curl and a runtime
dependency for one probe would cost more than the probe is worth; run the same image with a command that
does not serve and it goes `starting, starting, starting, unhealthy` at 1s intervals, which is what makes
the 1s `healthy` above mean something. And the `SIGTERM` answer exists because PID 1 does not: a Node
process that never registers a handler ignores `docker stop` for the whole grace period and is then
killed, measured here as a plain `node -e "setInterval(...)"` sitting through `docker kill
--signal=SIGTERM` while the same script under `--init` exited 143.
[ADR 0005](docs/adr/0005-production-image-ships-dist-and-proves-itself.md) records what the self-check
covers and what it got wrong the first time;
[ADR 0009](docs/adr/0009-the-containers-command-is-the-service-and-a-service-is-proved-by-the-request-it-answers.md)
records the flip, the four signal measurements, and the Fastify option that was measured and then not set.

Or through Compose. There is no bind mount: the image *is* the file system, so `--build` is what
picks up your edits (the rebuild copies sources; the dependency layer stays cached).

```sh
docker compose run --rm --build app npm test
docker compose run --rm --build app sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"

docker compose --profile prod up -d --build prod      # read_only + cap_drop: ALL, published on 127.0.0.1:3000
docker compose --profile prod logs prod --tail 2
docker compose --profile prod stop prod               # the same graceful stop: 0.6s, exit code 0
docker compose --profile prod rm prod
```

`127.0.0.1:3000` is the only host port the file publishes; the image itself binds `0.0.0.0`, because
inside a container loopback reaches nobody outside it and the file that publishes a port is the one that
knows who may connect. The `up`, `stop` and `rm` lines above were run against this file with the host half
moved to `3142` in an untracked second file — `ports: !override`, because plain `ports` in a second compose
file *appends* to the list and Docker then tries to bind both — which is also the clean way to move the
mapping when something on your machine already owns 3000. A dev server will. The container reached `healthy`
5s after it started, which is the image's own `--start-period=5s` rather than a slower boot: the interval is
30s, so CI passes `--health-interval=1s` and watches the same probe answer sooner.

## Layout

```
src/core/      clock.ts (wall <-> instant), recurrence.ts (rule -> occurrence),
               cursor.ts, errors.ts, result.ts, index.ts
src/domain/    ids.ts (branded ids + parseId), estimate.ts (whole minutes, frozen, the first value),
               model.ts, ports.ts (the shapes adapters implement)
src/scheduler/ sleep.ts (a cancellable wait), run-series.ts (walk a cursor in due order), index.ts
src/config/    app-config.ts (AppConfig and the rules that produce it — takes a record, never
               reads the platform)
src/adapters/  log-notifier.ts (a ScheduleNotifier that renders one record per occurrence and hands
               it to an injected sink), env-config.ts (the one file that reads process.env),
               memory-store.ts (BoardStore and WorkItemStore over one pool, copying on the way in
               and the way out), system-clock.ts (the Clock port as `Date.now()`), process-signals.ts
               (the `process` global as the one object that can attach and detach a stop listener) —
               internal: dist has them, the exports map does not
src/server/    requests.ts (one body in, validated by the engine, not re-derived — and the occurrence bound
               the export takes from the query), http-error.ts (the throw the handlers use and the one
               translation of it), export-stream.ts (the board as NDJSON rows, one objectMode pull per row
               over a series cursor, with `rows()` and `pulls()` counters on it), create-app.ts (the routes,
               over injected ports), shutdown.ts (waitForStopSignal: a promise that settles on the first
               signal and lets go of every listener it attached), main.ts (the composition root: the
               only file that reads the configuration, binds, and waits to be asked to stop) — internal
               too, and the only layer that may reach every other
test/          behaviour, DST transitions, validation, cancellation, configuration, public surface,
               the stream semantics a route would inherit (pull-ahead, teardown, backpressure), the export
               stream itself and the export route over a real socket
scripts/       verify-package.mjs (the package surface), typecheck-consumer.ts,
               selfcheck.mjs (the prod image's last build step, run as its runtime user)
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
reason an adapter can be swapped without the engine noticing. The two rules together also decide where an
interface lives: `main.ts` may not call `process.on`, and the adapter may not import the shape declared in
`src/server/shutdown.ts` — so the consumer declares it, the adapter matches it, and only `main.ts` knows
both. That is why the signal names are spelled in two files, and why the duplication is not unchecked: a
`SignalSource` the adapter does not satisfy is a build error, not a runtime surprise.

## Not yet

Five adapters exist — the notifier, the environment reader, the in-memory stores, the system clock, and
the one that hands the process's signals to the server. Of the ports in `src/domain/ports.ts`,
`ScheduleNotifier`, `BoardStore`, `WorkItemStore` and `Clock` have implementations and `IdGenerator` does
not, because every route today takes its id from the caller: the client names the board, the server does
not. The fifth satisfies an interface `src/server` declares rather than a domain port, because a stop
signal is a process lifecycle concept and not a board concept. Board UI, durable persistence, caching,
queueing and metrics are still to come, and the HTTP layer is built against the in-memory stores — that is
the seam, not the persistence story: everything they hold is gone when the process is. Each lands with its
own test seam rather than as scaffolding.

Nothing on the HTTP surface is authenticated. Whoever can reach the port can create a board and move an
item, and since this slice can read a whole board's schedule out of it as NDJSON; what limits that today is
the host half of the mapping — the image binds every interface and
`compose.yaml` publishes `127.0.0.1:3000`, so a process on this machine can reach it and a machine on the
network cannot. The member identity the `mb_` ids are waiting for is not built yet. The mutation surface is
`PATCH` only — no delete, no reorder, no bulk move — and a concurrent write is a last-writer-wins race,
because the stores keep no version.

The configuration layer knows four variables. It deliberately ignores everything else, which means a
misspelled name (`PTOR=8080`) boots with the default rather than warning — the mitigation ADR 0007
promised is in `main.ts` now: the resolved `AppConfig` is the first thing the process logs, so the
wrong value is one line into a boot instead of a mystery.

Delivery is at-most-once: `runSeries` advances the cursor before it notifies, so a sink that throws
loses that occurrence and a retry replays from the next one. Making that at-least-once needs stored
progress and a retry — planned, not built — not a wrapper around the notifier.

The scheduler is not wired to the API yet: a work item can carry a rule, the export walks that rule for as
long as the caller asks, and the routes refuse a bad one, but nothing advances the cursor a store holds on a
timer. `GET /boards/:id/export` is a read of the whole rule, not a delivery — the half that waits for the next
occurrence and notifies a sink is still `runSeries`'s, and still unwired.

What the export did change is the drain story. ADR 0009 left it open because no route was slow enough to still
be running when a signal arrived; this one is, and measuring it gave the other half of the sentence.
**`app.close()` waits for a streamed response**, and one client shape — a `fetch` body cancelled with nothing
read, then a second request read to its end — held that wait for the full 8000 ms ceiling in both Linux
runtimes while the host closed in 1 ms (ADR 0011 decision 10). `forceCloseConnections` is not something you
hand to `close()` — measured `AVV_ERR_CALLBACK_NOT_FN` on all three runtimes — it is an instance option, so
bounding the drain is a decision about how the app is constructed and belongs with a slow-route-in-flight test,
not with this slice.

`/healthz` is a **liveness** answer, not a readiness one: it says this process serves
HTTP, not that a store loaded or a migration ran, and today there is nothing to load. And a stop request
that arrives during boot is ignored, because the listener is registered after `listen()` resolves — the
window is a few milliseconds wide and ends in the supervisor's `SIGKILL` if it is ever hit, so `init: true`
is the way to close it if that ever matters.
