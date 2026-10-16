# ADR 0014 — The store that holds rows copies them on the way out, and the row is the only shape its tests agree on

Status: accepted
Date: 2026-10-16
Deciders: Yusuf Kef
Technical context: `src/adapters/memory-store.ts` (work items now held as `WorkItemRow`),
`test/memory-store.test.ts` (`17` tests, `5` of them added or rewritten by this slice),
[ADR 0013](0013-a-store-holds-a-row-the-domain-holds-a-value-and-one-codec-in-the-domain-owns-the-door-between.md)
(decision 8, the sentence this slice exists to close: *"No adapter uses the codec yet"*),
[ADR 0012](0012-a-value-is-shared-not-copied-the-store-clones-what-can-change-and-hands-out-what-cannot.md)
(the copy-on-both-sides contract this keeps, and the `copyItem` it retires for items),
[ADR 0002](0002-throw-inside-result-at-the-boundary.md) (a refusal at a boundary is thrown, not returned).

## Context

ADR 0013 wrote the door between a row and a value, proved the round trip, priced the engine probe, and then
said the honest thing in its decision 8: nothing on the product path uses it. `memory-store.ts` still held
`WorkItem` objects, cloned the schedule on the way in and shared the estimate on the way out, and its suite
asserted `loaded.estimateMinutes` **is** `saved.estimateMinutes` — an assertion only an in-memory store can
afford. The row codec's only other callers were a test and a typecheck script, both written by the same hand
that wrote the codec.

This slice walks that door with a caller. The order was the one the repo has settled into: measure first, with
a throwaway probe and no product code. Four questions, each answered by running rather than by arguing, and
every figure below is either a measurement or says that it is arithmetic on one:

1. `toWorkItemRow` keeps `schedule` **by reference**. If the store holds the row it is handed, does a caller
   who kept the object it saved still have a way to edit what the store holds?
2. The mirror question on the way out: `parseSchedule` returns the object it validated, so does a value
   hydrated from the stored row share that row's array?
3. What does a row cost per read and per write against the shape it replaces?
4. What does it cost to hydrate everything and then filter, against filtering rows and hydrating only what
   matched?

Questions 1 and 2 were the reason to measure at all. Question 1 had the answer ADR 0013 predicted — a leak,
caught by cloning on the way in. Question 2 had an answer nobody had written down: **the same leak, on the
read path**, and the suite as it stood would not have caught it. That is decision 2.

## Decision

1. **Work items are held as rows; boards are still held as values.** `items` is a `Map<WorkItemId, WorkItemRow>`
   and every path into it goes through `toWorkItemRow`, every path out through `parseWorkItemRow`. `boards`
   still holds `Board` and still uses the old `structuredClone` both ways. The file is deliberately not
   symmetric, and the module docstring says so rather than leaving it to be inferred: an item is the record
   this repository has a codec for and a real reason to rehearse (week 11 reads rows off a network), and a
   board has neither. Writing a `BoardRow` to make the two halves of one file match would be a codec with no
   door on the other side.

2. **The copy is on the way out as well as the way in, and that is where the bug was.** Measured with the
   throwaway probe (host, Node v26.8.2, win32), and reproduced on the file that ships by deleting its read-side
   copy and running the suite. Every write below reaches through a
   `readonly` field, which is what the suite's `mutable()` helper is for; the probe cast rather than annotated,
   being a file that was run once and deleted, and the leak it demonstrated is a property of the object graph,
   not of the cast:

   | what a caller does after one `save` | what the store then hands out |
   | --- | --- |
   | `saved.schedule.byWeekDay.push('WE')` | `['MO','FR']` — no leak, the row was cloned on the way in |
   | `loaded.schedule.byWeekDay.push('SU')`, with the read-side copy absent | `['MO','FR','SU']` — **the leak** |
   | `loaded.schedule.dtStart = 1`, with the read-side copy absent | `1`, and the row keeps it — **the leak** |

   With `hydrate` copying the row before it parses, all three read back `['MO','FR']` and `1774661400000`.

   The fourth thing the probe checked is not a mutation but an identity, so it is a sentence rather than a row:
   with the read-side copy absent, two `load` calls of one id handed back **one `schedule` object inside two
   values**, so a caller who edited the days through one load edited the other's too. After the fix the two
   loads share neither the schedule, nor the value, nor the estimate. The whole table was reproduced on the file
   that ships by deleting its read-side copy and running `test/memory-store.test.ts` against it: the same two
   tests go red, with the same two messages, on `785e525333cd60aa53767344f1883cc7`.

   Two tests go red when that copy is deleted, and they are different promises:

   ```
   × the work item store > does not let a caller edit what it holds, from the schedule a load handed back
     → expected { id: 'wi_deploy', …(7) } to deeply equal { id: 'wi_deploy', …(7) }
   × the work item store > hands out a distinct value on every load, and the same record every time
     → expected { tz: 'Europe/Berlin', …(3) } not to be { tz: 'Europe/Berlin', …(3) } // Object.is equality
   ```

   The first is the store's promise to itself — what a caller holds is not what the store holds. The second is
   the promise between two callers of one store, and it needed one assertion to say it:
   `expect(first.schedule).not.toBe(second.schedule)`. The value was already distinct — a parse builds a new
   object literal every time — which is why the test this slice inherited, named *"hands out a distinct object
   on every load"*, saw nothing: it compared values, and passed both before the copy and after it. Why the leak
   survived ADR 0012 is the same story from the other side: the isolation test above already mutated an array
   reached through a **load** and passed, because the store of the time cloned on the way out, so the most
   valuable test in this slice is one that already existed and only had to be kept. The file went from `16`
   tests to `17`: one was added (caller-side isolation on the way in), one was renamed and re-asserted (the
   estimate, which a row store cannot hand back by identity — the old assertion is what an in-memory store can
   say and a row store cannot), and three had their comparison moved onto the row, the load-side isolation test
   among them; it kept its mutation and gained the line that fails above. Five of the seventeen are this
   slice's.

3. **`listForBoard` filters rows and hydrates only what matched.** Measured on 5000 rows over 10 boards,
   500 of them matching (host, Node v26.8.2, win32, median of 5 × 20 full sweeps):
   filter-then-hydrate `3606`–`4254 µs` per sweep, hydrate-then-filter `33189`–`36666 µs` — **`7.9`×–`10.2`×**.
   The scan reads `boardId` off the row, which is a string compare, so a query that matches nothing costs a
   sweep and nothing else: `7 µs` for a 1000-row store asked for a board with no items, in all three runtimes
   (decision 7's last column). The value store this replaced paid about the same for that query, because a scan
   that compares a string field costs what a string compare costs whichever shape the record is in — so this is
   not an advantage over it, it is the absence of a penalty, and it only holds because the filter runs first. A
   row store that hydrated everything it scanned would build a thousand values to answer it: that is decision
   7's per-`load` range times the rows swept, `6.3`–`6.9 ms` on the host, which is arithmetic on a measured
   cell rather than a measurement of its own, and it lands where the hydrate-then-filter sweep above already
   puts it. The ordering is not pinned by a test, which Consequences records.
4. **The row is the suite's equality oracle, because two values built from one row are not comparable.**
   `toEqual` compares functions by identity. A hydrated `Estimate` carries its own `equals` closure, so
   `expect(loaded).toEqual(saved)` fails on a store that hydrates — and the failure prints two objects it cannot
   tell apart, because every field the wire carries is equal:

   ```
   AssertionError: expected { id: 'wi_deploy', …(7) } to deeply equal { id: 'wi_deploy', …(7) }

   Compared values have no visual difference.
   ```

   Three assertions in `test/memory-store.test.ts` therefore compare `toWorkItemRow(a)` with `toWorkItemRow(b)`,
   and the one in the isolation test says why in a comment. This is not a workaround for a broken assertion; it
   is the suite discovering the same thing ADR 0012's Consequences said a value object makes visible — two
   `WorkItem`s that mean the same thing are not the same object, and the row is the shape in which they can be
   compared at all. Any future store that hydrates inherits this idiom.

5. **A refusal this store did not produce is thrown, not answered with `null`.** `hydrate` unwraps the way the
   repository's other by-construction unwrap does — `src/domain/estimate.ts:64`, `if (!isOk(parsed)) throw
   parsed.error` — rather than inventing a second spelling of it. The distinction that matters is between
   *produced* and *reachable*: no row this store made can be refused, because every row went through
   `toWorkItemRow` and `test/work-item-row.test.ts` pins the round trip; but `save` validates nothing, because
   the port's argument is already a `WorkItem`, so a caller that hands it a value the domain would refuse — a
   `createdAt` that is not a whole instant, which a fake clock can do and no route can — meets a throw on the
   way back out. The alternative was worse in both directions. Returning `null` would tell the caller *"no such
   item"* when the truth is *"this process cannot read its own data"*, which is the failure ADR 0013 decision 9
   refuses to describe politely. Adding a `STORAGE_CORRUPT` code and a 500 mapping for it is speculative
   generality: nothing in the product path produces one today, and the code list is a measurement (17 → 20 in
   ADR 0013 decision 7), not a wish list. Consequences records the debt and the reason the branch stays
   uncovered.

6. **The cheaper-looking read was measured and rejected.** Hydrating without copying, then cloning only the
   schedule — `{ ...value, schedule: structuredClone(value.schedule) }` — is what ADR 0012's `copyItem` did.
   It is not cheaper here: `structuredClone(row)` is `2.113`–`2.122 µs` and `structuredClone(row.schedule)`
   `1.436`–`1.486 µs` (host, Node v26.8.2, win32, median of 5 × 100000), and the two full read paths came out at
   `6.942`–`7.291 µs` versus `5.664`–`7.163 µs` across four repetitions — the ordering flipped between runs,
   so the difference is inside what this method can resolve. Choosing the row copy does not depend on that
   measurement, and that is the point: cloning the row means the adapter never has to know which fields
   `parseSchedule` hands back by reference. An adapter that clones *"only the mutable field"* has to re-derive
   that list every time the domain's door changes, and the door is allowed to change — it is the thing ADR 0013
   exists to own.

7. **The price is on the record, and it is the price ADR 0013 predicted.** Per operation (host, Node v26.8.2,
   win32, median of 5 × 20000, three repetitions of the whole comparison):

   | | row store | value store | ratio |
   | --- | --- | --- | --- |
   | `save` | `1.902`–`2.009 µs` | `1.208`–`1.229 µs` | `1.57`–`1.63` |
   | `load` | `6.289`–`6.880 µs` | `1.467`–`1.635 µs` | `4.18`–`4.44` |

   And on the two product paths that read a board (each cell is the median of 7 sweeps of 40 `listForBoard`
   calls; the host column is the range across three repetitions of the whole probe, and each image ran it once
   against a store holding the same 1000 records):

   | runtime | 1000 scheduled, row | 1000 scheduled, value | 1000 unscheduled, row | 1000 unscheduled, value | 1000 rows, 0 matched |
   | --- | --- | --- | --- | --- | --- |
   | host, Node v26.8.2, win32 | `6.05`–`7.02 ms` | `1.35` ms | `1.61`–`1.75 ms` | `0.28 ms` | `7 µs` |
   | `cadence-test`, Node 24.21.0, linux | `6.32`–`8.24 ms` | `1.36` ms | `1.62`–`1.96 ms` | `0.23 ms` | `7 µs` |
   | `cadence-n22`, Node 22.23.3, linux | `7.39`–`10.11 ms` | `1.41` ms | `1.72`–`2.09 ms` | `0.24 ms` | `7 µs` |

   ADR 0013 decision 6 said the export route is *"bounded at 1000 rows … so its ceiling is `3.3`–`6.0 ms`"*.
   It landed at `6.05`–`7.02 ms` on the host, and the gap is the one thing the earlier estimate did not
   include: the read-side clone of decision 2, `2.1 µs` a row, which the codec's own measurement had no reason
   to charge. So the honest sentence is a range rather than a number: dividing the table's last two columns by
   their value-store partners gives `4.5`×–`5.2`× on the host, `4.6`×–`6.1`× in the Node 24 image and
   `5.2`×–`7.2`× in the Node 22 one, and a board of a thousand scheduled items costs `6`–`8 ms` on that probe's
   host and Node 24 columns and `7.4`–`10.1 ms` on its Node 22 one — the paragraph below re-prices the same
   board on the file that ships. That is a real cost paid by `GET /boards/:id` and
   `GET /boards/:id/export` on every request, and it buys the only version of this story that survives week 11:
   a store whose reads go through the door that says whether the bytes it was handed are a work item.

   The same sweep, run against the file that ships rather than the copy the probe held, reproduces that row
   column. The harness was a throwaway again — `createMemoryStores` imported out of the `dist` this source
   builds, one board, `1000` items carrying a `WEEKLY` `MO,FR` schedule and a `30`-minute estimate, `40`
   `listForBoard` calls per sweep, `7` sweeps, `3` repetitions per runtime, each cell the range of the sweep
   medians: `5.38`–`9.55 ms` on the host, `5.59`–`8.43 ms` in `cadence-test` and `6.65`–`8.37 ms` in
   `cadence-n22` for a thousand scheduled items, no more than `1.33`–`2.24 ms` for a thousand unscheduled ones,
   and the no-match query still at `7`–`8 µs`. Each runtime's range overlaps the table's, which is what a rename
   and one differently spelled line ought to do. The value column has no counterpart left to measure: this tree
   holds no value-holding item store, so the ratios above stay the probe's arithmetic and this paragraph is the
   shipped file's own price.

## Consequences

- **A row this process cannot read would be answered with `400`, and that is wrong.** `hydrate` throws whatever
  `parseWorkItemRow` refused with, and the doors it walks can write seven codes — `INVALID_ID`,
  `INVALID_WORK_ITEM`, `INVALID_STATUS`, `INVALID_ESTIMATE`, `INVALID_SCHEDULE`, `INVALID_TIME_ZONE`,
  `INVALID_INSTANT` — plus `UNEXPECTED` for a throw the engine wrote itself (grep of the `CadenceError`
  constructors reachable from `parseWorkItemRow`, `src/domain/{ids,model,estimate,schedule,work-item-row}.ts`
  and `src/core/{clock,recurrence}.ts`). `src/server/http-error.ts` maps every one of those except
  `UNEXPECTED` and `SEARCH_EXHAUSTED` to `400`. No route can produce such a row today: the HTTP doors build the
  item they hand to `save`, and `SystemClock` answers a whole millisecond. The port is wider than the routes —
  `WorkItemStore.save` takes a `WorkItem` and `WorkItem.createdAt` is a plain `number`
  (`src/domain/model.ts:58`), so an injected clock that answered `0.5` would put a row in the map that this
  store's own `load` throws on, and the request would be a `400` about a value the server was handed rather than
  one the client sent. The day a row can be corrupted from outside this process — week 11, Redis, a value
  written by another client or by a previous deploy — a store that cannot read its own data must say `500`, and
  the fix is a code the door maps to `500` rather than a new branch in the adapter. That is a two-line change
  with a test, and it is deliberately not made here.
- **`memory-store.ts` is at `100 %` statements and `93.75 %` branches, and the one uncovered branch is the
  refusal.** `vitest`'s text table names line `84` — `if (!isOk(parsed)) throw parsed.error` — in all three
  runtimes. It stays uncovered because every caller in this repository, product and test alike, hands the store
  a value the domain already accepted; a test that reached it would be pinning the store's answer to a caller
  that broke the port's contract, which is the contract week 11 rewrites. Decision 5 is the reasoning; the
  branch is the receipt that the reasoning is not yet a test.
- **`listForBoard`'s ordering is a measured decision that no test pins.** Filtering before hydrating is
  decision 3's `7.9`×–`10.2`×, and swapping `.filter` and `.map` changes no answer any caller can see — the same
  items in the same order either way. It is visible only through a store that can hold a row it cannot read, and
  this one can be made to hold exactly one by `save`, which validates nothing. That is the seam the bullet above
  refuses to test today, so the ordering rests on the measurement and the comment in `hydrate`'s caller rather
  than on a red suite.
- **The suite now pins the row shape, so swapping this adapter for one that holds values is a decision.** Three
  assertions compare `toWorkItemRow(a)` with `toWorkItemRow(b)` and four assert that two holders of one record
  are not the same object — the estimate a save and a load do not share, and the value, schedule and estimate
  two loads do not. A future value-holding store — a cache, say — fails them by design, which is precisely the
  pinning ADR 0010 did for stream defaults: a swap should be a choice somebody made, not something a response
  body noticed.
- **Every gate number moved again, and all three runtimes still agree.** `23` test files / `289` tests (from
  `23` / `288`), coverage `99.63 %` statements (`1092` of `1096`) / `100 %` functions (`116` of `116`) on all
  three, branches `98.18 %` everywhere. The branch *count* is the one figure this slice had to stop claiming
  per runtime: nine coverage runs of the adapter that ships — `3` on the host, `3` in `cadence-test`, `3` in
  `cadence-n22`, each parsed out of its own `lcov.info` — printed `486` of `495` eight times and `487` of `496`
  once, in `cadence-n22`'s first run. Neither count is a property of the runtime that printed it: the same
  image, on consecutive runs, produced both, from a tree whose `md5sum src/adapters/memory-store.ts` was
  unchanged between them. Both counts display as `98.18` in `vitest`'s own table, which floors rather than
  rounds (`486` of `495` is `98.1818 %` and `487` of `496` is `98.1855 %`, so rounding would print `98.19` for
  the second), so the percentage is a runtime fact and the count is a run fact — ADR 0006's branch-percentage
  rule, sharpened: it does not even split by runtime, only by invocation. eslint clean over `56` files
  (unchanged: this slice edited two files and added none). dependency-cruiser `0` violations at
  `64 modules / 137 dependencies` with no
  `dist` and `61 / 131` with it (from `64 / 134` and `61 / 128`): exactly three new edges, which is the whole
  import-line diff of the slice — `src/adapters → src/core` for `isOk`, `src/adapters → src/domain` for the
  codec, and `test → src/domain` for the test that compares rows — and `dist` presence is still the other half
  of the pair. `13` package checks pass over `7` export targets, and the tarball is `115` files and `210019`
  content bytes on every runtime — `61522` bytes gzipped on the host and `61535` in both images. The `13`-byte
  gap is the three tar-header modes ADR 0013 names: `README.md`, `LICENSE` and `package.json` are `0755` in a
  Linux checkout and `0644` on the Windows host, and the other `112` entries are `0644` on all three. This slice
  re-ran that listing rather than inheriting it, and it came out as an account, not a constant: five
  measurements taken across this document's own edits put the same pair at `61449` / `61463` over `209834`
  content bytes, `61451` / `61467` over `209838`, `61458` / `61473` over `209859`, `61474` / `61489` over
  `209911` and the two numbers above over `210019` — gaps of `14`, `16`, `15`, `15` and `13` bytes, the same
  spread ADR 0013 logged when it found these three bits costing `16`, `15` and `17` bytes across its own edits.
  This document does not move those bytes (`docs` is not packed), but the README does, so the pair above was
  taken from images rebuilt after its last edit and from the host packing the same file. Everything in this
  bullet was read off one state of the three files that decide it, and all three runtimes printed the same
  hashes for it: `README.md` = `bc4d350dbda27146b22d9416bcf39cd7`,
  `src/adapters/memory-store.ts` = `785e525333cd60aa53767344f1883cc7`,
  `test/memory-store.test.ts` = `ca77b13fe19175fb48d2e1dd71cf88d8`. Those are the images that ran the gates, and
  the coverage figures above survive them because the adapter and its suite did not change between the two
  states of this document.
- **`src/adapters` is not in the package's exports map, so none of this is importable from outside** — the
  eighth of the thirteen package checks still says `ERR_PACKAGE_PATH_NOT_EXPORTED`. What the slice changes for a
  consumer is the behaviour behind the port, not the port: `WorkItemStore` still speaks values, and
  `scripts/typecheck-consumer.ts` still typechecks against `dist/*.d.ts` unchanged.
- **The probe is not in the repository.** Its durable output is decision 2's table and the three row comparisons
  and four identity assertions in `test/memory-store.test.ts`; both throwaways — the probe and the second
  harness that re-measured the cost column — were deleted after they were run, and the numbers above are their
  `console` output, labelled with the runtime that printed them. What the probe measured was the adapter at
  `md5sum src/adapters/memory-store.ts` = `4e53d9a3f6f17f88bc9eabde141ed923`. The file that ships is
  `785e525333cd60aa53767344f1883cc7`: one helper shorter, the probed copy holding `copy` for the row on the way
  in and `hold` for the row on the way out where the shipped one holds `copy` at both ends, and the refusal
  spelled the way decision 5 says the repository spells it. Neither difference changes what a run can observe,
  and decision 7 does not ask the reader to take
  that on faith for the cost column: the sweep was run again against the shipped file on all three runtimes and
  its row column lands inside the probe's own ranges. The value column and the leak table remain the probe's,
  because the tree that ships holds no value-holding item store to measure, and every gate, coverage and
  package figure above was taken from the shipped file.
