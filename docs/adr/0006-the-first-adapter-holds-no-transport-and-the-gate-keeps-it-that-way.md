# ADR 0006 — The first adapter holds no transport, and the gate keeps it that way

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/adapters/log-notifier.ts`, `src/domain/ports.ts`, `src/scheduler/run-series.ts`,
`.dependency-cruiser.cjs`, `scripts/verify-package.mjs`, `test/log-notifier.test.ts`

## Context

`src/domain/ports.ts` has declared `ScheduleNotifier` since week 2:

```ts
export interface ScheduleNotifier {
  notify(item: WorkItem, occurrence: Occurrence): Promise<void>;
}
```

Nothing implemented it. `runSeries` takes a bare `notify: (occurrence) => void | Promise<void>`
instead, which is the right shape for a scheduler — it must not know what a `WorkItem` is — but it
means the port was unproven: an interface nobody implements is only a guess about the seam.

Two facts made the "obvious" implementation wrong. `WorkItem` has **no destination field** — it
carries `assigneeId`, `estimateMinutes` and a `schedule`, and nothing that says where a notification
should go (`src/domain/model.ts`). And the record has to describe *time* in a way a generic logger
cannot: the whole reason this project exists is that an occurrence has an instant and a wall clock,
and those two disagree twice a year.

So the question was what belongs in the first adapter, and what has to be true for the layering to
survive the adapters that follow it.

## Decision

1. **The adapter renders a record and hands it to an injected sink; it owns no I/O.**
   `createLogNotifier({ sink, clock })` returns a `ScheduleNotifier`. The sink is
   `(record: NotifierRecord) => void | Promise<void>` — stdout, pino, a queue client, or an array in
   a test. That is forced by `WorkItem` having no channel field: there is nothing to open a
   connection *to*, and inventing one in the adapter would be a domain decision smuggled into an
   implementation. Week 4 passes its logger's `info` as the sink and keeps transport in the config
   layer, which is where the address actually lives.

2. **A record carries both `due` and `wall`, because either one alone is a lie twice a year.**
   `due` is the instant the rule resolved to, `wall` is the clock time the rule asked for. Measured
   from a real run of the Berlin 02:30-daily rule across the spring gap:

   ```
   index 0  due 2026-03-28T01:30:00.000Z  wall 2026-03-28 02:30:00  exact
   index 1  due 2026-03-29T01:00:00.000Z  wall 2026-03-29 02:30:00  gap-roll-forward
   index 2  due 2026-03-30T00:30:00.000Z  wall 2026-03-30 02:30:00  exact
   ```

   The rule is daily; `due` moves 23h then 24h, while `wall` never moves. `disambiguation` and `tz`
   travel with them so an operator can answer "did this fire on time, and what did the rule ask
   for" from one line, without re-deriving the rule.

3. **`tz` is read from the item's schedule and is `null` when the item has none.** An unscheduled
   `WorkItem` can still be delivered — `runSeries` walks a cursor the caller built, and the item is
   just what it hands to `notify`. The record must describe that case instead of throwing on
   `item.schedule.tz`, so the field is `item.schedule?.tz ?? null`, and a test asserts both branches.

4. **Absent means `null`, and it stays in the JSON.** `assigneeId` is `MemberId | null` in the
   domain, and the record keeps it as a plain-string key with value `null` rather than omitting it.
   With `exactOptionalPropertyTypes` on, an omitted key and a `null` key are different types, and a
   log pipeline that filters "unassigned work" needs the key to exist either way. Asserted three
   ways: `toHaveProperty('assigneeId', null)`, `JSON.parse(JSON.stringify(record))` equals the
   record, and the serialized string contains no `undefined`.

5. **Branded ids are flattened to strings at the record boundary.** `MemberId` is a branded
   `string`, so `JSON.stringify` would render it correctly by accident — the type says so
   explicitly instead, and `typeof record.itemId === 'string'` is a test. The brand is a compile-time
   distinction; it has no business in an output format.

6. **An async sink is awaited, because the port returns a promise.** `notify` is
   `await sink(record)` — not a cast to satisfy `@typescript-eslint/require-await`. A sink that
   writes to a socket is the case the port was designed for, and the notifier must not resolve
   before it completes. The run-through-`runSeries` tests below drive it with an async sink.

7. **Rejected: a `bindNotifier(item, notifier)` adapter for `RunOptions['notify']`.** The
   composition is one line — `notify: (occurrence) => notifier.notify(item, occurrence)` — and it
   appears in the tests verbatim. A helper had nowhere honest to live: in `src/adapters` it would
   import the scheduler's options type for no benefit, and in `src/scheduler` it would make the
   waiting layer know a domain port it does not need. `runSeries` stays on
   `(occurrence) => …` and the caller closes over the item.

8. **A sink failure costs that occurrence, and there is a test that shows it.** `runSeries` does
   `cursor.next(); delivered += 1; await notify(upcoming)` — it consumes before it notifies, so
   delivery is at-most-once. The test throws from the sink on the first occurrence, then repairs the
   transport and runs again on the same cursor:

   ```
   rejects.toBe(failure)            // the run dies with the sink's error, identity intact
   cursor.consumed() === 1          // index 0 is gone from the cursor
   second run => { delivered: 1, late: 0, endedBy: 'limit' }, delivered indexes [1]
   ```

   Repeating index 0 would mean *at-least-once*, which needs durable state: which occurrences have
   been handed off, and a retry. That is week 12's outbox, and the reason it is a store rather than
   a wrapper around the notifier. `index` is in the record so the pair `(itemId, index)` can name an
   occurrence — positionally, so it is only stable while the rule behind the cursor is.

9. **The direction is gated, and the gate is proven by firing it.** New rule
   `core-domain-scheduler-do-not-know-adapters`: nothing under `src/(core|domain|scheduler)` may
   import `src/adapters`. A clean run proves nothing on its own, so the rule was run against a
   throwaway copy of the tree with one deliberate violation in each of the three layers:

   ```
   error core-domain-scheduler-do-not-know-adapters: src/scheduler/probe.ts → src/adapters/log-notifier.ts
   error core-domain-scheduler-do-not-know-adapters: src/domain/probe.ts → src/adapters/log-notifier.ts
   error core-domain-scheduler-do-not-know-adapters: src/core/probe.ts → src/adapters/log-notifier.ts

   x 3 dependency violations (3 errors, 0 warnings). 17 modules, 23 dependencies cruised.
   ```

   Against the real tree: `✔ no dependency violations found (31 modules, 53 dependencies cruised)`.
   The copy and its probe files were deleted afterwards.

9a. **The module count is not the violation count, and it moved between environments for a reason
    worth knowing.** The same `npm run lint:deps` printed `31 modules, 53 dependencies` on the host
    and `34 modules, 59 dependencies` in a fresh `cadence-test` image. The difference is
    `scripts/selfcheck.mjs`, which imports the package by its published name: on the host `dist`
    exists, so `cadence` resolves into an excluded path and the dependency disappears; in the image
    `dist` is built later (CI runs `npm run build`), so the specifier cannot resolve and
    dependency-cruiser keeps it as its own node with `dependencyTypes: ["unknown"]`,
    `couldNotResolve: true` — three nodes and six edges, one per entry point. Reproduced by hand:

    ```
    mv dist .disthold/dist  →  (34 modules, 59 dependencies cruised)
    mv .disthold/dist dist  →  (31 modules, 53 dependencies cruised)
    ```

    No rule in the config targets `unknown` or unresolvable dependencies from `scripts/`, so the gate
    reads the same either way — but this is the kind of number that will be quoted in a week-8
    comparison, and it is only comparable inside one tree state. `test/` and `src/` are unaffected:
    they import each other by relative path.

10. **`src/adapters` is compiled and shipped, but not importable from outside.** The `exports` map
    gains no key for it, so `import('cadence/adapters')` fails with
    `ERR_PACKAGE_PATH_NOT_EXPORTED` — now the 11th `npm run verify:package` check, next to the
    existing deep-import check. It still travels in the tarball (`58 files`) because `files` allowlists
    `dist`. The asymmetry is deliberate: publishing a type is a contract decision, and the adapter's
    surface — `NotifierRecord`, `NotifierSink` — becomes API only when something outside this repo
    needs to build a sink. Until then the repo imports it by relative path, and the gate in decision
    9 is what keeps that one-directional.

11. **"Late" is strictly past the instant.** `late = occurrence.instant < now`, so an occurrence
    delivered exactly at its due time is not late. Tested at the boundary: `instant − 1` false,
    `instant` false, `instant + 1` true. It matches how `runSeries` counts `late`, which uses the
    same comparison against the same injected clock — a record that disagreed with the summary about
    lateness would be the more confusing bug of the two.

## Consequences

- Measured after this change: `110 tests` in `10 files`, `29 files` linted with 0 errors and 0
  warnings, 0 dependency violations (`31 modules / 53 dependencies` on a tree with `dist` built,
  `34 / 59` on one without it — decision 9a), `11` package checks, coverage `99.2%` statements /
  `95.47%` branches / `100%` functions, with `adapters/log-notifier.ts` at `100` on all four.
- The adapter is **stateless**: no dedup, no idempotency key, no buffering. Two runs over the same
  span of the same rule produce the same records, and one run that crashes and restarts on a fresh
  cursor re-delivers whatever the new cursor yields. Deciding that is correct is week 12's job, and
  it will need persistence, not a change to this file.
- One record per occurrence, one sink call per record. Nothing batches. If a board with hundreds of
  scheduled items makes that loud, the sink is where the batching goes — the adapter's shape does
  not change.
- `cadence/adapters` remaining closed means the first external consumer of a sink type will be the
  one that opens it. When that happens it deserves its own ADR rather than an `exports` entry added
  to make a demo work.
- The README's "not yet" list loses its first entry and gains the honest one: adapters now exist,
  and `BoardStore`, `WorkItemStore`, `Clock` and `IdGenerator` still have no implementation.
