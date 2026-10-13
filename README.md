# cadence

![CI](https://github.com/kefyusuf/cadence/actions/workflows/ci.yml/badge.svg)
![coverage](https://img.shields.io/badge/coverage-98%25%20stmts-green)

A recurring-schedule engine and team board. The part that is hard is the part that is
tested first: a rule like *"every day at 02:30, Europe/Berlin"* has to survive the two days a
year when that wall-clock time either does not exist or happens twice.

**Status:** week 1 of a build-in-public schedule — core recurrence engine only. The HTTP API,
board UI, cache, queue and observability layers come later; see `docs/adr/`.

## What it does today

```ts
import { nextOccurrence } from './src/core/recurrence.js';

const rule = { tz: 'Europe/Berlin', dtStart: Date.UTC(2026, 2, 28, 1, 30), freq: 'DAILY' };

nextOccurrence(rule, rule.dtStart);
// { instant: 1774746000000,          -> 2026-03-29T01:00:00Z
//   targetWall: { year: 2026, month: 3, day: 29, hour: 2, minute: 30 },
//   disambiguation: 'gap-roll-forward' }   // 02:30 does not exist that night in Berlin
```

Supported: `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`, `interval`, `count`, `byWeekDay`
(Monday-start weeks), `byMonthDay` including negative month-end offsets. Errors are a typed
`CadenceError` code union.

Design decisions and their trade-offs: [ADR 0001](docs/adr/0001-wall-clock-recurrence-over-epoch-arithmetic.md).

## Run it

Local:

```sh
npm ci
npm test              # 39 tests, wall-clock recurrence + DST transitions
npm run test:coverage # 98% statements / 93% branches / 100% functions, gated in vitest.config.ts
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
```

Docker (identical image to CI):

```sh
docker build --target test -t cadence-test .
docker run --rm cadence-test npm test
# or, with the working tree bind-mounted:
docker compose run --rm app npm test
```

## Layout

```
src/core/     clock.ts (wall <-> instant), recurrence.ts (rule -> occurrence), errors.ts
test/         behaviour, DST transitions, validation
docs/adr/     decisions with their consequences
```

`src/core` has zero runtime dependencies and does no I/O — that is what makes the edge cases
cheap to test. `.dockerignore` and `compose.yaml` exist so the test environment is not the host's.

## Not yet

Persistence, HTTP surface, board UI, caching, queueing, metrics. Each lands with its own test
seam rather than as scaffolding.
