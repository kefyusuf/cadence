# ADR 0013 — A store holds a row, the domain holds a value, and one codec in the domain owns the door between them

Status: accepted
Date: 2026-10-15
Deciders: Yusuf Kef
Technical context: `src/domain/work-item-row.ts` (new, 27 tests in `test/work-item-row.test.ts`),
`src/domain/schedule.ts` (new), `src/domain/model.ts` (gained `parseStatus`), `src/domain/index.ts`,
`src/core/errors.ts` (the code list, 17 → 20), `src/server/requests.ts` (two doors now delegate),
`src/server/http-error.ts` (decision 9), `test/server-app.test.ts`, `test/http-error.test.ts`,
`test/public-api.test.ts`, `scripts/typecheck-consumer.ts`,
[ADR 0012](0012-a-value-is-shared-not-copied-the-store-clones-what-can-change-and-hands-out-what-cannot.md)
(the question this answers, asked in its first Consequences bullet),
[ADR 0008](0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md)
(who owns a rule and who owns its wording),
[ADR 0002](0002-throw-inside-result-at-the-boundary.md) (a `Result` at every boundary).

## Context

ADR 0012 grew the estimate into a value and left the ports alone: `WorkItemStore.load` still returns a
`WorkItem`, and `memory-store.ts` copies the schedule but hands the `Estimate` back by reference. Its first
Consequences bullet named the debt precisely — an in-memory store can hand back a reference, a store that
reads a column cannot — and said the next value object is "the moment to decide whether the ports should
carry values at all or whether the boundary belongs above the adapter".

This slice is that moment, and it started by measuring rather than by arguing. A throwaway script against
`dist` (host, Node v26.8.2, win32) answered the question the decision hinged on: **of the eight fields of
`WorkItem`, four already had a door** — `id`, `boardId` and `assigneeId` through `parseId`, `estimateMinutes`
through `parseEstimate` — and four had none: `title`, `status`, `schedule`, `createdAt`. `status` was the
surprising one: its rule was written, in `requests.ts`, in the one layer a store never passes through. The
the same measurement, re-run once the codec existed against the fixture `test/work-item-row.test.ts` now
uses, printed `253` bytes for the item and `253` for the row built from it — **byte for byte identical**
(host, Node v26.8.2, win32, off `dist`; the test asserts the two strings are equal). A row is therefore not a
shrunken item; it is the same wire with a different type behind it, which is exactly why the repository had
been producing one implicitly on every socket write and never naming it.

Two more measurements set the shape of the answer. Hydrate-then-clone throws (`DataCloneError`, the value's
`equals` closure) while clone-then-hydrate is fine — so whoever parses decides the order, and the order is a
rule, not a detail. And rebuilding the four guarded fields for 10000 items cost `35.66 ms` against `25.97 ms`
for cloning alone, while adding one engine probe per item pushed the same loop to `88.46 ms`: the engine check
was worth roughly three clones. That is the number this ADR had to decide about, and it is the number its
decision 6 records again against the real implementation.

## Decision

1. **The ports keep carrying values. The boundary moved into the domain, not above the adapter.** Three
   shapes were on the table and one was picked:

   - *The ports speak rows* (`load` returns `WorkItemRow`) — rejected. Every parse call would move into every
     adapter, and the probe above says exactly what that costs: four of eight fields have a rule written
     today, so each new store is handed a list of four checks to remember plus the two the domain has not
     written yet. Three adapters means three copies, and the copies fail differently.
   - *A serializing decorator above the adapter* — rejected. It keeps the port value-typed and puts the door
     in `src/adapters`, which the layering gate is happy about, but the decorator would hold domain rules in
     the layer whose job is transport. `src/domain/estimate.ts` exists because ADR 0012 put the minute-count
     rule in the domain; a week later moving the same rule one layer out would undo it.
   - *A codec in the domain, exported* — picked. `WorkItemRow` is the row type, `toWorkItemRow` and
     `parseWorkItemRow` are its two directions, and every field whose rule already has a door reaches it
     **through that door** — the one exception, `title`, is decision 5's. `src/domain → src/core` is a direction
     the twelve rules in `.dependency-cruiser.cjs` already allow: one forbids cycles, four keep a layer free of
     packages and Node builtins, and seven fix the direction, of which `core-does-not-know-domain` is the one
     that forbids the reverse. The codec therefore uses `parseId`, `parseEstimate`, `parseStatus`,
     `parseSchedule` and core's `assertInstant` rather than re-deriving any of them.

   The ports did not change signature: `load`, `listForBoard` and `save` still speak `WorkItem`. What changed
   is that there is now one place a row becomes a value, and it is in the layer that owns both.

2. **The row is JSON in both directions, and the round trip is the invariant.** `WorkItemRow` is the eight
   fields with the brands erased: ids are `string`, `status` is `string`, `estimateMinutes` is `number | null`,
   `schedule` stays `Recurrence | null` because that type is already primitives all the way down. The fixture
   row is `253` bytes (host, Node v26.8.2), and `JSON.stringify` of it equals `JSON.stringify` of the item it
   came from — a test says so, because "the row is what the item already wrote" is the claim the whole codec
   rests on. The test that matters is not that each field survives but that the two directions are
   inverses: `toWorkItemRow(parseWorkItemRow(row))` equals `row`, and the item that comes back has an estimate
   that `equals` the original and is **not** the original.

   A row that omits `assigneeId` or `estimateMinutes` is a row carrying an absence, not a broken row: the two
   nullable fields read `undefined` and `null` the same way, because a store with two columns and a store with
   a sparse hash both need that to be true, and a test pins both spellings.

   ADR 0012's clone lesson is pinned here rather than restated: in all three runtimes the probe printed
   `valueCloneThrows: yes` for the item and cloned its row cleanly (`2.10`–`3.16 µs` per row on the host). The
   store clones the row, then hydrates. There is no order in which it may do the opposite.

3. **`status` finally has a door, and the HTTP wording did not move.** `parseStatus` lives beside
   `WORK_ITEM_STATUSES` in `src/domain/model.ts` — the list and the check are one file, so the vocabulary
   cannot grow a word the check does not know. `readStatus` in `requests.ts` became three lines that call it
   and translate the `Result`, and the sentence `status must be one of backlog, ready, in_progress, blocked,
   done, got …` moved character for character. That is checkable without trusting this document:

   ```sh
   git show 9624a00:src/server/requests.ts | grep -n 'status must be one of\|schedule must be an object'
   grep -n 'status must be one of' src/domain/model.ts
   grep -n 'schedule must be an object' src/domain/schedule.ts
   ```

   The two lines differ only in `HttpError(400, …)` versus `CadenceError(…)`. What the client reads is the
   rendered body, and that is now pinned at the HTTP layer rather than asserted in prose:
   `test/server-app.test.ts` checks the exact 400 bodies for `'shipping'`, `'daily'`, `42` and `[]`.

4. **`schedule` is validated by asking the engine, with exactly one check kept back.** `parseSchedule` refuses
   a non-object and otherwise probes with `createSeriesCursor`, the same object the scheduler walks — the
   engine stays the only authority on what a recurrence is (ADR 0008), and `requests.ts` now delegates both
   halves instead of owning the first and borrowing the second.

   The one check it keeps is the one the engine cannot make on the caller's behalf. Handed `"PT5M"`, the engine
   reads `.freq` off a string, finds `undefined`, and answers `freq must be one of DAILY, WEEKLY, MONTHLY,
   YEARLY, got undefined` — the engine's own parameter name in a message about a field that never had one.
   That is precisely the defect ADR 0008 removed from the door when `dtStart: "2026-03-28T01:30:00.000Z"` was
   being reported as `after must be an integer epoch ms`; a row store would have inherited it straight back.

5. **Two fields are deliberately not policed, and both are pinned rather than quiet.** `createdAt` goes
   through core's `assertInstant` — the clock's rule, no new sentence, `INVALID_INSTANT`. `title` is checked
   only for being a string: how long and how empty are request-body rules, written once in `readLabel`, and a
   second copy in the domain is the drift ADR 0012's `shown` story is about. The consequence is stated plainly
   by a test: `hydrate({ ...row, title: '' })` succeeds. A row store can hand back an untitled item, and if
   that ever needs fixing it is fixed by moving the label rule into the domain once, not by adding a check in
   a third place. The same test file pins the other known gap: the codec checks an id's *shape*, not its
   namespace, so `bd_core` in the work-item slot passes — the `wi_` prefix is what the URL's door enforces.

   The cost of that line is named rather than glossed: `title must be a string, got …` is now written in two
   layers, because `readLabel` builds the same sentence from the same `shown` for the same field. That is a
   real second copy, and it is the smaller of the two available wrong answers — the alternative was to move
   the whole label rule, length and blankness included, into the domain on the strength of one `typeof`, and
   that rule is a request-body rule that the board name, the member name and the work-item title all share.
   When a row store exists and this sentence has to be trusted, the fix is to give `readLabel` the domain's
   wording, not to add a third place that says it.

6. **The engine probe stays, and its price is on the record.** Measured with the real codec, after the probe
   had moved out of `requests.ts`: 100000 parses per run, the fixture above (`WEEKLY` with two weekdays,
   `Europe/Berlin`), five runs per invocation, three invocations per runtime, each in its own process, warmed
   by 2000 parses first, and the ranges below are the minimum and maximum across those invocations.

   | runtime | build the row | hydrate a whole row | hydrate a row with no schedule | `createSeriesCursor` alone | share |
   | --- | --- | --- | --- | --- | --- |
   | host, Node v26.8.2, win32 | `0.0088`–`0.0256 µs` | `3.31`–`4.54 µs` | `0.126`–`0.157 µs` | `3.15`–`3.54 µs` | `95.7`–`96.7 %` |
   | `cadence-test`, Node 24.21.0, linux | `0.012`–`0.036 µs` | `3.52`–`4.41 µs` | `0.119`–`0.195 µs` | `3.25`–`4.42 µs` | `95.5`–`96.6 %` |
   | `cadence-n22`, Node 22.23.3, linux | `0.0020`–`0.041 µs` | `4.34`–`6.02 µs` | `0.141`–`0.222 µs` | `4.11`–`7.19 µs` | `95.7`–`96.8 %` |

   `share` is `(whole row − no schedule) / whole row`, not the `createSeriesCursor` column over the whole row:
   the two agree inside the noise, and what the probe-alone run does not pay is the three `parseId` calls and
   the object literal. So hydrating a hundred thousand scheduled items costs `0.33`–`0.60 s` and the same
   hundred thousand unscheduled ones `12`–`22 ms`, and building the row is two orders of magnitude cheaper
   than reading it back. Almost all of that is one `Intl` anchor read per row inside `occurrences()` — the
   engine resolving the rule's start time in its time zone, which is the thing it is for and the thing that
   cannot be skipped by a caller who does not know what the column holds.

   The probe stays. Every other answer available was worse: trusting the column re-opens the door ADR 0012
   closed (a `VARCHAR` holding `{"freq":"HOURLY"}` would surface as a scheduler crash three layers away from
   the row that caused it), and validating lazily at first pull moves the refusal from parse time to walk
   time, which is ADR 0008's argument against an engine that answers after 4000 periods. What the number buys
   is the right to say where it lands: today the only product path that could hydrate at scale is the export
   route, bounded at 1000 rows by ADR 0011 decision 3, so its ceiling is `3.3`–`6.0 ms`. When the Redis adapter
   arrives it will page or cache, and this table is the reason rather than a guess.

7. **The code list went 17 → 20, and the count is a measurement.** `INVALID_STATUS`, `INVALID_SCHEDULE` and
   `INVALID_WORK_ITEM` moved from `HttpError` strings the door invented into `CADENCE_ERROR_CODES`, because a
   refusal the domain writes has to be a domain code — `isCadenceError` reads that array, so a code outside it
   would make the error unrecognisable across a duplicated module (ADR 0002's reason for the list existing).
   `CADENCE_ERROR_CODES.length` printed `20` off `dist/core/index.js` on the host. ADR 0007 recorded 15,
   ADR 0008 16 and ADR 0012 17; the array is the truth and each ADR's number is its own date's.

8. **No adapter uses the codec yet, and that is the honest part of this decision.** `memory-store.ts` is
   untouched: it still clones the schedule, shares the estimate, and `test/memory-store.test.ts` still asserts
   `loaded.estimateMinutes` **is** `saved.estimateMinutes`. The row codec has one future caller — the
   persistence adapter that reads columns — and it is not in this repository yet (week 11). To keep it from
   being dead code dressed as an interface, two gates reach it the way a stranger would:
   `test/public-api.test.ts` builds a row literal, hydrates it through `cadenceDomain` and asserts the round
   trip, and `scripts/typecheck-consumer.ts` — which `verify:package` typechecks against `dist/*.d.ts` —
   holds `toWorkItemRow`, `parseWorkItemRow(JSON.parse('{}'))`, `parseStatus` and `parseSchedule` with their
   declared types. If the shipped declarations stop letting an outsider write a store, those two go red.

   The domain's pinned runtime surface went from `['createEstimate', 'parseEstimate', 'parseId']` to seven
   names, with `parseSchedule`, `parseStatus`, `parseWorkItemRow`, `toWorkItemRow` added.
   `WORK_ITEM_STATUSES` stayed out: a consumer needs the doors, and the runtime array exists so the domain can
   check a word, not so an outsider can enumerate one.

9. **A throw the engine did not write is still answered without its message, and the codec found the shape
   that writes one.** Moving the probe out of `requests.ts` changed who catches it. The door used to
   `try/catch` around `createSeriesCursor` and hand the failure to `asHttpError`, which answers any failure
   this codebase did not write with `500 INTERNAL the request could not be handled` — the rule and its reason
   are both in that file's own comment ("`the pool is closed` tells the caller nothing useful and tells an
   attacker something"). `parseSchedule` cannot throw, so such a failure reaches it as `fromThrowable`'s
   `UNEXPECTED`, and `fromCadenceError` passed every `CadenceError` message straight through. The difference
   is not hypothetical: the engine checks the tokens inside `byWeekDay` but never that the field is an array.

   ```sh
   # host, Node v26.8.2, against the built package
   node -e "const {createSeriesCursor} = require('./dist/core/index.js');
   try { createSeriesCursor({ tz: 'Europe/Berlin', dtStart: 0, freq: 'WEEKLY', byWeekDay: 'MO' }) }
   catch (e) { console.log(e.constructor.name, '|', e.message) }"
   # TypeError | rec.byWeekDay.map is not a function
   ```

   So `fromCadenceError` now answers `UNEXPECTED` the way `asHttpError` answers an unknown throw — the status
   kept, the message withheld — and the shape is pinned at all three levels: `test/work-item-row.test.ts` that
   the door labels it `UNEXPECTED` and keeps the `TypeError` as the `cause`, `test/http-error.test.ts` that the
   answer says nothing about it, and `test/server-app.test.ts` that a `POST` carrying exactly that body gets
   `500 INTERNAL`. The engine's missing guard is a separate defect with a separate owner (ADR 0008 is the rule
   it bends); what this slice refused is to be the change that put an internal property name into a response
   body while moving a check that had nothing to do with it.

## Consequences

- **Ports still speak values, so a row store has a job to do — and now exactly one place to do it.** The
  Redis adapter of week 11 reads `GET`, `parseWorkItemRow`, hands back a `WorkItem`, and writes with
  `toWorkItemRow`. If it turns out to need a different shape — hash fields instead of one JSON string — that
  is a second codec beside this one, not a rule inside the adapter.
- **Hydrate-then-clone is illegal and clone-then-hydrate is the recipe.** Measured in three runtimes: the item
  throws `DataCloneError`, its row clones. ADR 0012's `copyItem` stays correct *because* it clones before a
  value exists on the way out; a store that starts from a hydrated value and then reaches for
  `structuredClone` has to be written the other way round.
- **Every gate number moved, and all three runtimes still agree.** `23` test files / `288` tests (from `22` /
  `259`), coverage `99.63 %` statements (`1084` of `1088`) / `98.38 %` branches (`486` of `494`) / `100 %`
  functions (`116` of `116`), identical on the host, in `cadence-test` and in `cadence-n22`; eslint clean over
  `56` files (from `53`); dependency-cruiser `0` violations at `64 modules / 134 dependencies` with no `dist`
  and `61 / 128` with one (the `61` is what ADR 0012 recorded, because `scripts/typecheck-consumer.ts` resolves
  `cadence` into `dist` once it exists); `verify:package` still 13 checks over 7 export targets, tarball now
  `115` files on every runtime — `60090` bytes gzipped on the host, `60104` on both Linux runtimes, `205854`
  content bytes on all three.
- **A route can now answer `500 INTERNAL` for a rule nobody wrote, and that is the old answer, not a new
  one.** Decision 9 is the one place this slice changed the HTTP layer's behaviour rather than its plumbing:
  `fromCadenceError` withholds the message of an `UNEXPECTED` failure, which is what `asHttpError` already did
  for a throw it did not recognise. `test/server-app.test.ts` pins the body for the `byWeekDay: "MO"` shape,
  and `test/http-error.test.ts` pins the rule for every other door that may one day hand a bug up.
- **ADR 0012's mode-bit account is still the explanation, and this slice re-ran it rather than inheriting it.**
  `npm pack --dry-run --json` on the host lists `115` entries, every one of them mode `0644`; the same command
  in either Linux image, after the build those stages do not run for themselves, lists the same `115` paths and
  the same `205854` content bytes with `112` entries at `0644` and three at `0755` — `README.md`, `LICENSE` and
  `package.json`, the same three, and the eight new `dist` files this slice added are not among them — two
  modules times the `.js`, `.js.map`, `.d.ts` and `.d.ts.map` that `tsconfig.build.json` asks for, which is
  also how the tarball went from `107` files to `115`. Those three
  headers are the whole `14`-byte gap (`60104` against `60090`). It was `16` bytes at ADR 0012, `15` at the
  commit before that, and `17` at an intermediate edit of this very slice, which is what an account of gzip
  headers looks like: the entries do not change, the price of changing them does, and nobody should read a
  constant into it. Both Linux runtimes are the ones ADR 0012 named — `--target test` for 24.21.0 and the
  scratch `n22.Dockerfile` its Consequences section prints in full for 22.23.3; neither file is in this repo,
  which is why the recipe is on the record instead.
- **Two refusal sentences changed layers with their rules, and their bytes are pinned at the HTTP layer.**
  The contract a client reads is unchanged for every route: each refusal the door used to write for itself it
  now asks the domain for, word for word, and the one shape where the plumbing could have answered
  differently — a throw the engine did not write — is answered the way it was before, which is decision 9
  rather than luck. `INVALID_STATUS` and `INVALID_SCHEDULE` are now also reachable as domain codes from a
  store, which is the point.
- **The `title` and namespace gaps are documented holes, not oversights.** An empty title hydrates, and a
  board id in a work-item slot hydrates. Both are asserted in `test/work-item-row.test.ts`, so widening either
  rule is a decision with a test to change rather than a discovery.
- **One more module pair is public API.** `cadence/domain` now exports seven runtime names instead of three.
  ADR 0003's "one (`parseId`) for domain" is now two slices out of date in the same way ADR 0007 and 0008's
  code counts are; `test/public-api.test.ts`'s sorted list is the gate that fails when they disagree.
