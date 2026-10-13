# cadence

![CI](https://github.com/kefyusuf/cadence/actions/workflows/ci.yml/badge.svg)
![coverage](https://img.shields.io/badge/coverage-99%25%20stmts-green)

A recurring-schedule engine and team board. The part that is hard is the part that is
tested first: a rule like *"every day at 02:30, Europe/Berlin"* has to survive the two days a
year when that wall-clock time either does not exist or happens twice.

**Status:** week 3 of a build-in-public schedule — core engine, domain vocabulary, package
surface, the layering gates that keep them apart, and the first async layer that waits for an
occurrence instead of just computing it. The HTTP API, board UI, cache, queue and observability
layers come later; see `docs/adr/`.

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

Three entry points, nothing else: `cadence` (recurrence engine, zero dependencies, no I/O),
`cadence/domain` (branded ids, board types, ports for adapters that do not exist yet) and
`cadence/scheduler` (`sleep` and `runSeries` — the only layer that waits). `cadence/src/...` is
closed, and CommonJS can `require()` all three on Node >= 22.12 — the reasoning is in
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md).

Design decisions and their trade-offs: [ADR 0001](docs/adr/0001-wall-clock-recurrence-over-epoch-arithmetic.md)
(wall-clock arithmetic), [ADR 0002](docs/adr/0002-throw-inside-result-at-the-boundary.md) (errors),
[ADR 0003](docs/adr/0003-esm-only-package-with-exports-map.md) (package shape),
[ADR 0004](docs/adr/0004-cancellation-is-a-value-and-the-clock-is-an-argument.md) (waiting).

## Run it

All of this is green on the host and inside the image CI uses:

```sh
npm ci
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run lint          # eslint flat config, type-aware (26 files)
npm run lint:deps     # dependency-cruiser: core, domain and scheduler import nothing, and nothing in core or domain reaches the scheduler
npm test              # 97 tests, wall-clock recurrence, DST transitions, cancellation
npm run test:coverage # 99% statements / 95% branches / 100% functions, gated in vitest.config.ts
npm run build         # tsc -> dist with declarations and maps
npm run verify:package # 10 checks against the built package, not the source tree
```

```sh
docker build --target test -t cadence-test .
docker run --rm cadence-test npm test
docker run --rm cadence-test sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"
```

Or through Compose. There is no bind mount: the image *is* the file system, so `--build` is what
picks up your edits (the rebuild copies sources; the dependency layer stays cached).

```sh
docker compose run --rm --build app npm test
docker compose run --rm --build app sh -c "npm run lint && npm run lint:deps && npm run build && npm run verify:package"
```

## Layout

```
src/core/      clock.ts (wall <-> instant), recurrence.ts (rule -> occurrence),
               cursor.ts, errors.ts, result.ts, index.ts
src/domain/    ids.ts (branded ids + parseId), model.ts, ports.ts (adapters plug in here)
src/scheduler/ sleep.ts (a cancellable wait), run-series.ts (walk a cursor in due order), index.ts
test/          behaviour, DST transitions, validation, cancellation, public surface
scripts/       verify-package.mjs, typecheck-consumer.ts
docs/adr/      decisions with their consequences
```

`src/core`, `src/domain` and `src/scheduler` import no packages and no Node builtins, and neither
`src/core` nor `src/domain` may reach the scheduler — enforced by `npm run lint:deps`, not by a
comment. That is what makes the edge cases cheap to test and keeps the engine usable from a
browser bundle later.

## Not yet

Adapters (the ports in `src/domain/ports.ts` still have no implementations — `runSeries` takes a
`notify` callback rather than a `ScheduleNotifier`), persistence, HTTP surface, board UI, caching,
queueing, metrics. Each lands with its own test seam rather than as scaffolding.
