# ADR 0012 — A value is shared, not copied: the store clones what can change and hands out what cannot

Status: accepted
Date: 2026-10-15
Deciders: Yusuf Kef
Technical context: `src/domain/estimate.ts` (new, 12 tests in `test/estimate.test.ts`),
`src/domain/model.ts`, `src/domain/index.ts`, `src/core/errors.ts` (the code list and `shown`, now pinned by
`test/errors.test.ts`), `src/server/requests.ts`, `src/server/export-stream.ts`, `src/adapters/memory-store.ts`,
`test/memory-store.test.ts`, `test/public-api.test.ts`, `test/export-route.test.ts`, `test/server-app.test.ts`,
`scripts/typecheck-consumer.ts`, [ADR 0008](0008-the-http-layer-throws-at-the-door-and-the-engine-stays-the-only-authority-on-a-rule.md)
(who owns a rule, and who owns its wording), [ADR 0011](0011-the-response-dies-with-the-socket-and-only-the-request-bounds-the-walk.md)
(the byte figures this slice had to leave alone)

## Context

`estimateMinutes` was a bare `number | null` on `WorkItem`, and the only sentence in the repository about
what a legal estimate is lived inside the HTTP door: `readEstimate` threw a 400 when a body carried `30.5`
or `-1`. That is the arrangement ADR 0008 refuses — the door may own *what a caller may ask for*, but a rule
about a domain object belongs to the domain. The consequence was concrete rather than theoretical: nothing
stopped an adapter, a seed script or the scheduler from holding a `WorkItem` with `estimateMinutes: -3`,
because the type permitted it and no code past `requests.ts` ever looked.

So the estimate became the repository's first value object. The plan was a two-hour job: build the value,
point the door at it, change one field. What actually took the week's worth of thinking is the second half —
the in-memory store deep-copies every record on the way in and on the way out, and a value object with
methods on it is not something `structuredClone` can copy. Eight tests failed on the first run after the
field changed, and the reason they failed is the decision this ADR records.

```
DataCloneError | (other) => other !== null && minutes === other.minutes could not be cloned.
```

That message, quoted exactly as the host printed it, names the value's own `equals` closure. Nothing about
it is a bug: `structuredClone` is a data copier, and the estimate is not data.

## Decision

1. **The rule lives in the value; the door keeps only the translation.** `Estimate` is an interface with
   `minutes`, `equals` and `toJSON`, and the only way to hold one is `createEstimate` or `parseEstimate`, both
   of which refuse a number that is not a whole count of minutes at or above zero. `WorkItem.estimateMinutes`
   is now `Estimate | null`, so a half-formed estimate is not a thing that can be written down — which is the
   entire argument for a value object, and the same move `parseId` already makes for ids, where a string that
   has not passed the parser cannot be a `BoardId`.

   That claim needed the second half of the ids trick to be true. An interface alone is a shape, and a shape
   can be satisfied by a literal: `{ minutes: -3, equals: () => true, toJSON: () => -3 }` would have typechecked
   as an `Estimate` and been the illegal value this slice exists to make impossible. So `Estimate` carries a
   phantom key, `readonly [estimateBrand]: 'estimate'` over a `declare const … : unique symbol`, exactly the
   pattern `BrandedId` uses: nothing at runtime ever holds it — one test asserts the own property names are
   `equals`, `minutes`, `toJSON` and the symbol list is empty — and `build` is the single place that asserts
   past it, immediately after the check has run. The type-lie is closed by the compiler, not by a reviewer's
   trust.

   The code that refusal carries had to move too. `INVALID_ESTIMATE` was a string the HTTP layer invented for
   itself; it is now in `CADENCE_ERROR_CODES`, which is **17 entries** as of this slice (ADR 0007 recorded 15,
   ADR 0008 16). `requests.ts` no longer constructs an `HttpError` for an estimate at all: it calls
   `parseEstimate`, and on a refusal hands the `CadenceError` to `fromCadenceError`, which is ADR 0008's
   division of labour with the rule written in the place the rule belongs. One route in the service writes an
   estimate — `POST /boards/:id/work-items` through `parseCreateWorkItem` — and the `PATCH` that moves a card
   copies the value it loaded, so there is no second door left to bypass.

2. **Two entry points, one invariant.** `parseEstimate(raw: unknown): Result<Estimate, CadenceError>` is for
   a value that came off a wire and cannot be trusted to be a number; `createEstimate(minutes: number):
   Estimate` is for code that already holds a number and would have to unwrap a `Result` to say what its own
   type already guarantees. The first returns, the second throws, and both refuse rather than produce a value
   that lies about its `minutes`. That is ADR 0002's rule applied to a domain object: throw inside, `Result` at
   the boundary.

   *One* invariant took a second edit to mean. `createEstimate` does not repeat the check: it calls
   `parseEstimate` and throws the `CadenceError` that comes back. Two copies of
   `Number.isInteger(minutes) && minutes >= 0` in the same file is the same drift decision 7 spends itself
   preventing, only smaller — and nothing would have failed when one copy moved. A test pins the consequence
   instead: the message `createEstimate(-1)` throws has to equal the message `parseEstimate(-1)` returns.

   Twelve tests cover the value — a loop over four accepted wire values (`0`, `1`, `30`, `4_096`), a loop over
   ten refusals (`"30"`, `30.5`, `-1`, `NaN`, both infinities, `true`, `null`, `{}`, `[30]`), the two message
   texts, equality as a law rather than a method call, frozenness, the bare-number serialisation, the own-property
   list that proves decision 1's brand exists only in the types, the `DataCloneError` that decision 3 is built
   around, the throw out of `createEstimate` for the four illegal numbers, and the message identity above.
   `test/errors.test.ts` gained an eleven-row table for `shown`, so the spelling both layers write with is
   measured rather than assumed.

3. **A value object is shared, not copied, and the copy stays where mutation is possible.** `memory-store.ts`
   now has two copy paths. Boards keep the generic `copy`, which is `structuredClone`, because a board is
   id, name and an array of ids — data all the way down. A work item goes through `copyItem`:

   ```ts
   function copyItem(item: WorkItem): WorkItem {
     return { ...item, schedule: structuredClone(item.schedule) };
   }
   ```

   The top object is new, the schedule is deep-cloned because `byWeekDay` is an array a caller can still push
   onto, and the `Estimate` is handed over by reference — because a frozen value has no second writer to
   protect against. Sharing is not a fallback forced by the `DataCloneError`; it is the correct answer with an
   error message attached to it. A test pins it: *hands back the estimate it was given, because a value has
   nothing to copy*, asserting reference identity rather than deep equality. The refusal that forced the design
   is pinned in `test/estimate.test.ts` too — `structuredClone(createEstimate(30))` throws something whose
   `name` is `DataCloneError` — so the sentence quoted at the head of this ADR is now something `npm test`
   re-runs on every runtime, not something one terminal printed once on 2026-10-15.

   The alternative that looked tidier was a class, with `equals` and `toJSON` on the prototype so that
   `structuredClone` would succeed. Measured on the host (Node v26.8.2) with a throwaway script, it is worse:

   ```js
   class Est {
     constructor(minutes) { this.minutes = minutes; }
     equals(other) { return other !== null && this.minutes === other.minutes; }
     toJSON() { return this.minutes; }
   }
   const clone = structuredClone(new Est(30));
   console.log(`clone ok: ${JSON.stringify(clone)} | instance? ${clone instanceof Est} | has equals? ${clone.equals}`);
   ```

   ```
   clone ok: {"minutes":30} | instance? false | has equals? undefined
   ```

   Decision 5 complains about evidence that only exists as a printed probe, so the probe is inlined here: six
   lines, no imports, re-runnable with `node` on any of the three runtimes this slice measured. Nothing in the
   tree can pin it, because the class is the option that was rejected — `npm test` proves the closures *do*
   refuse to clone, which is the other half of the same comparison.

   A class instance cloned through `structuredClone` comes back as a plain object that satisfies
   `{ minutes: 30 }`, has lost `equals`, and is not an instance of anything. The store would then hand out
   something that typechecks as an `Estimate` and is not one — a silent wrong value, where the closures fail
   loudly at the first attempt. The closures stay for exactly that reason.

   Also rejected: a `{ minutes }`-only value with no methods, which keeps `structuredClone` happy but deletes
   the two behaviours that make it a value rather than a frozen record, and a reviver or `Estimate.from`
   inside the adapter, which couples a general-purpose store to one domain type and makes the store a place
   that knows domain rules.

4. **`toEqual` compares functions by identity, so two independently built fixtures with methods can never be
   deep-equal.** Half of the eight failures were not the store's fault. `test/memory-store.test.ts` had one
   test that saved `item()` and then asserted a *second* `item()` came back; with `equals` and `toJSON` as own
   properties, those are two different closures and vitest's deep equality is right to say they differ — the
   failure message was `Compared values have no visual difference`, which is what a function comparison looks
   like. The fix was to hold on to the object that was saved and compare against it, which is what the file's
   other tests already did, and which tests the schedule's copy semantics exactly as well. No assertion was
   weakened and no `toMatchObject` was used to dodge the problem.

5. **The wire shape is the value's own business, and the bytes did not move.** `ItemRow.estimateMinutes` is
   typed `Estimate | null` and the row carries the value, not a pre-collapsed number, because `toJSON()` is
   what puts `"estimateMinutes":30` on the socket — the same way the row already carries `schedule` and lets
   `JSON.stringify` describe the rule. This matters twice over: ADR 0011's README body is quoted with per-line
   byte counts, and a value object that changed those bytes would quietly invalidate a document that claims
   to have measured them.

   Unlike ADR 0011's figures, which came from throwaway scripts and are reproducible only by rebuilding them,
   this one is a test. `test/export-route.test.ts` posts the README's exact item — `wi_deploy`, "Deploy the
   release", `backlog`, `mb_yusuf`, `estimateMinutes: 30`, the Berlin `DAILY` rule — asks for
   `?occurrences=3`, and asserts the per-line byte lengths, the total, and the five lines as strings:

   ```
   [198, 162, 173, 162, 51] + 5 newlines = 751 bytes
   ```

   `npm test` is the measurement now. The same five lengths and the same `751`-byte total print green on the
   host (Node v26.8.2, Windows), inside `cadence-test` (Node 24.21.0) and inside a clean
   `node:22-bookworm-slim` (22.23.3), so ADR 0011's cross-runtime claim no longer rests only on the throwaway
   scripts that produced it — the socket runs behind its other figures still do.

6. **A public type has to be constructible from outside.** `WorkItem` ships from `cadence/domain`, and its
   `estimateMinutes` is an `Estimate` — so a consumer that cannot reach `createEstimate` cannot build a work
   item, and the package would be advertising a type nobody outside this repository can hold. The barrel gained
   `createEstimate` and `parseEstimate`, and the domain's pinned runtime surface went from `['parseId']` to
   `['createEstimate', 'parseEstimate', 'parseId']` in `test/public-api.test.ts`, with a test that builds a
   value through the barrel and compares it to one parsed off a wire. ADR 0003's "1 (`parseId`) for domain" is
   that decision's count as of its own slice, the same way ADR 0007 and 0008 record the code list; the sorted
   list the test asserts is the current one, and it is the gate that fails when they disagree.

   The proof that counts is the one a consumer sees, so `scripts/typecheck-consumer.ts` — the file
   `verify:package` typechecks against `dist/*.d.ts` — now holds the value, the comparison, a parse result
   typed `Result<Estimate, CadenceError>`, and a function that narrows `item.estimateMinutes` to its `minutes`.
   If the shipped declarations ever stop letting an outsider hold an estimate, that gate goes red.

7. **One spelling for a value named in a refusal.** `shown()` — numbers and booleans bare, strings quoted,
   `null` named as itself rather than as the `object` `typeof` reports for it, anything else by its type — was
   a private function in `requests.ts`. The domain now writes messages too, so a second copy appeared in
   `estimate.ts`, and the two differed on exactly the `null` branch. Nothing would ever have shown that
   drift from the outside: the door returns `null` for an absent estimate before a message is built, so no
   route could reach the branch it disagrees about. That is the argument for one helper *and* for testing it
   where it lives — `test/errors.test.ts` now holds an eleven-row table of what `shown` prints, including
   `[null, 'null']`. It moved to `src/core/errors.ts`, beside the codes, because spelling a value in a refusal
   is part of how failures are worded rather than part of any one layer. It stays out of the `cadence` barrel:
   the public runtime surface is decision 6's list, not every helper in a module.

## Consequences

- **`estimateMinutes` is `Estimate | null`, and every adapter is now on notice.** An in-memory store can hand
  back a reference; a store that reads a column has to call `parseEstimate` on the way in and cannot
  `structuredClone` on the way out. `copyItem` is the shape that lesson takes, and the next value object makes
  it a rule rather than a one-off — which is the moment to decide whether the ports should carry values at all
  or whether the boundary belongs above the adapter. That question is week 6/2's, not this slice's.
- **`equals` has no caller in the product yet.** It is exercised by `test/estimate.test.ts` and by
  `test/public-api.test.ts` through the barrel, and nothing in `src` compares two estimates. Keeping it is a
  deliberate call: a value object without structural comparison is a frozen record, and the comparison is half
  of what this slice is teaching. It is named here so that the next reviewer finds the admission rather than
  having to discover it. `toJSON`, by contrast, is load-bearing — decision 5 put it on the wire.
- **The eight failures were the design's feedback, not noise.** Two of them (the store's clone, the fixture's
  `toEqual`) would have been invisible in a language where the value is a struct, and one of them (the class
  alternative silently cloning to a shapeless object) is a trap that this repository would have walked into
  without measuring. That is the argument for doing value semantics *after* the ports and adapters exist: the
  seam is where a wrong value shows up.
- **`shown` is now core's, so a domain message and a door message cannot drift.** The cost is an import:
  `requests.ts` reaches for `src/core/errors.js` next to the `core/result.js` and `core/cursor.js` it already
  reached for, so it gained an edge, not a dependency it did not have — the door was never a self-contained
  file. The gate has no rule about `server → core` because it needs none: `nothing-inside-src-imports-the-server`
  forbids the other direction, and inner layers are free to be reached down into.
- **Nothing about the HTTP contract changed.** Same status, same code, same key, same bytes for the README's
  body. One door message got more precise: a value that is not a number is now refused as
  `estimateMinutes must be a number of minutes, got "thirty"` instead of the whole-minutes sentence, and
  `test/server-app.test.ts` pins the four sentences the door writes (`"30"`, `true`, `30.5`, `-1`) so the
  wording is a contract again. The other thing worth naming is a change no route can reach: an absent estimate
  leaves `readEstimate` as `null` before a message is ever built, so the `null` branch the two copies of `shown`
  disagreed about was never observable from the door — which is the clearest argument in this slice for testing
  the shared helper directly, in `test/errors.test.ts`, instead of hoping a route walks into it.
- **Measured on the final tree** (the whole gate chain re-run after every file above was in place, and then
  again after this slice was rebased onto the `LICENSE` that landed on `main` while it was being written):
  typecheck clean; eslint clean over 53 files, 0 errors and 0 warnings; dependency-cruiser 0 violations —
  `58 modules, 108 dependencies` with `dist` present and `61 / 114` without it, the latter being what a fresh
  container reports; `259 tests in 22 files`, which is the 243 this slice started from plus 12 in
  `test/estimate.test.ts` and one each in `test/memory-store.test.ts`, `test/public-api.test.ts`,
  `test/export-route.test.ts` and `test/errors.test.ts`; coverage `99.60%` statements (`1003` of `1007`) /
  `98.00%` branches (`443` of `452`) / `100%` functions; `verify:package` 13 checks over 7 export targets,
  tarball 107 files / `54709` bytes on the host. All of it ran again in `cadence-test` (Node 24.21.0) and in a
  clean `node:22-bookworm-slim` (22.23.3) built from this tree: same tests, same lint and dependency counts,
  byte-identical coverage, and the same tarball on both Linux runtimes at `54724` bytes — 15 more than the
  host's, which is a packaging difference over the same 107 files, not a difference in what ships. The
  decision 3 probe printed its recorded line on all three, not only on the host.

  The `LICENSE` deserves its own paragraph because it moved a measured number while being listed nowhere:
  `files` still names only `dist` and `README.md`, but npm packs a root `LICENSE` whatever the manifest says,
  so the tarball went from 106 files to 107 the day that file appeared. The re-measure then caught something
  second-order and worse than a changed count. The `test` stage copy-lists exactly the files its
  `verify:package` needs, and `LICENSE` had not been added to that list, so the image verified a **106-file**
  tarball while the host and CI's own checkout packed **107** — one script, two package surfaces, and no gate
  able to see the difference, because every number it printed was honest about the directory it was run in.
  Putting `LICENSE` on that one `COPY` is what made the three runtimes agree, and the two Linux runs then
  reported byte-identical tarballs. The `prod` stage is deliberately untouched: it ships `dist`, not the npm
  tarball, so whether a running container should carry the license text is a different question with a
  different answer, and this slice did not earn it. The shape of the failure is ADR 0011 decision 4's, in the
  other direction — a verification assembled by hand from a file list can stay green while measuring a surface
  that no longer exists.

  Those two totals are recorded here rather than in the README for a reason that only showed up while measuring
  them: `verify:package` reports the *gzipped* tarball, and the README is inside that tarball, so a sentence
  quoting the number changes it. The README that said `53498` measured `53500` right after the edit that wrote
  `53498` into it — two bytes, from nothing but the digits — and a doc comment added three directories away
  later moved the whole figure by `216`. There is no fixed point to write down. This file is not packed, so the
  figures above are the ones a re-run prints, which is the same reason ADR 0011 decision 4 pins byte counts to
  a call rather than to a document; the README keeps only the part that does not move, `107 files`.
