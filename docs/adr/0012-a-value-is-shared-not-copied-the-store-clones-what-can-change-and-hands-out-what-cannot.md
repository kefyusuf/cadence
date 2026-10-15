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
  tarball 107 files / `54725` bytes on the host. All of it ran again in `cadence-test` (Node 24.21.0) and in a
  clean `node:22-bookworm-slim` (22.23.3) built from this tree: same tests, same lint and dependency counts,
  byte-identical coverage, and the same `54741`-byte tarball on both Linux runtimes. CI ran the tree one edit
  earlier (`de358e9`, run `38736195200`, three jobs, all green in 51s): `99.6 / 98 / 100 / 99.6` for statements,
  branches, functions and lines in both `core (22)` and `core (24)`, `22 files / 259 tests` in the image job, the
  prod container reporting `healthy` on its own `GET /healthz` after 7 seconds read-only, unprivileged and with
  `--cap-drop=ALL`, and `exit code after SIGTERM: 0`. Every environment that packed the tree — the host, both
  images built here, and all three CI jobs — packed **107 files**, and the byte totals split.

  The split is worth recording precisely, because the explanation this slice first wrote down was wrong. It
  said the Linux runtimes sat 15 bytes above the host, which reads as if the runtime moved the number. It does
  not: CI is Linux, and both of its `core` jobs packed byte-for-byte what the Windows host packed at the same
  commit (`54709` each). The gap belongs to the machine, not the OS. `npm pack --dry-run --json` on the host and
  on `cadence-test` gives the whole account: the same `107` paths, the same `185590` content bytes on both sides,
  and three entries whose mode differs — `README.md`, `LICENSE` and `package.json` are `0755` out of a Docker
  Desktop context copied from a Windows tree and `0644` on the host, while the `104` entries under `dist`, built
  inside the image, agree on both sides. Those three headers cost 15 bytes against the README CI packed and 16
  against this one. Nothing in
  what ships differs, which is the fourth independent reason the gzip figure cannot be a repository-wide number;
  `107 files` and `185590` content bytes are the claims that survive a change of machine.

  The push that carried this correction is itself a fourth vote on it. CI ran the rebased tree (`52e2509`, run
  `38740554009`, three jobs, all green) and each of them printed `107 files, 54725 bytes` — the host's figure,
  after the single README edit that moved the host from `54709` to `54725` and this machine's two images from
  `54724` to `54741`. What that run corroborates is the pairing, not the header account: CI's own file modes were
  never sampled, so the mode evidence stays the `npm pack --dry-run --json` comparison above, and what the run
  adds is that a runner this slice did not build, reading a filesystem this slice did not copy, reproduced the
  host's bytes at both commits rather than only the one where the coincidence was first noticed.

  The decision 3 probe was re-run after the rebase, on the host and on both images, and printed the same line
  on all three (`clone ok: {"minutes":30} | instance? false | has equals? undefined`); it was not run inside
  CI, so no claim here depends on CI having seen it.

  Only two of those three runtimes have a build recipe the repository itself carries: the host and
  `--target test`, which is Node 24. The Node 22 figure came from a container this slice assembled on the
  spot, so the recipe is written here rather than left as an assertion — a scratch Dockerfile, deliberately
  not added to the repo, built with `docker build -f n22.Dockerfile -t cadence-n22 .` from the tree root. Note
  that it copies the whole context, `.dockerignore` aside, so it picked up the `LICENSE` without being told;
  the `test` stage had to learn the same fact by name:

  ```dockerfile
  FROM node:22-bookworm-slim
  ENV NODE_ENV=development
  WORKDIR /app
  COPY . /app
  RUN npm ci --no-audit --no-fund && chown -R node:node /app
  USER node
  CMD ["npm", "test"]
  ```

  Without the `chown` the suite cannot start at all: vite writes a timestamped copy of `vitest.config.ts`
  next to the file, and a `node`-owned process pointed at a root-owned `/app` dies with `EACCES` before the
  first test runs. That is the same reason the real `test` stage `chown`s and copy-lists explicitly.

  The `LICENSE` deserves its own paragraph because it moved a measured number while being listed nowhere:
  `files` still names only `dist` and `README.md`, but npm packs a root `LICENSE` whatever the manifest says,
  so the tarball went from 106 files to 107 the day that file appeared. The re-measure then caught something
  second-order and worse than a changed count. The `test` stage copy-lists exactly the files its
  `verify:package` needs, and `LICENSE` had not been added to that list, so the image verified a **106-file**
  tarball while the host and CI's own checkout packed **107** — one script, two package surfaces, and no gate
  able to see the difference, because every number it printed was honest about the directory it was run in.
  Putting `LICENSE` on that one `COPY` is what made the three runtimes agree, and the two Linux runs then
  reported byte-identical tarballs. The `prod` stage was left alone, and the limit of that choice is worth
  stating rather than smoothing over: its `COPY package.json README.md ./` is the same kind of hand-written
  list and it drops the `LICENSE` too. What differs is the claim each layer is asked to prove.
  `verify:package` asserts something about the *published package*, so a file the packer ships and the image
  hides makes the assertion about a surface nobody publishes; `prod` is judged by `selfcheck.mjs`, which
  asserts that `dist`, the one runtime dependency and the entry points resolve for the user who will run them
  — a license text carried into a running container is a packaging question, not a verification question, and
  this slice did not earn the right to answer it. The shape of the failure is ADR 0011 decision 4's, in the
  other direction — a verification assembled by hand from a file list can stay green while measuring a surface
  that no longer exists.

  Those two totals are recorded here rather than in the README for a reason that only showed up while measuring
  them: `verify:package` reports the *gzipped* tarball, and the README is inside that tarball, so a sentence
  quoting the number changes it. The README that said `53498` measured `53500` right after the edit that wrote
  `53498` into it — two bytes, from nothing but the digits — and a doc comment added three directories away
  later moved the whole figure by `216`. Those three observations are the pre-`LICENSE` tree's and no longer
  reproduce; they are kept as the history of how the measurement behaves, not as a number to check. There is
  no fixed point to write down. This file is not packed, so the figures above are the ones a re-run prints on
  the filesystem that packed them — which the mode finding above has now made a necessary qualifier, since the
  same tree prints `54725` or `54741` depending on who copied the files, not on what is in them. ADR 0011
  decision 4 pins byte counts to a call rather than to a document for the first half of this; the README keeps
  only the part that does not move, `107 files`.
