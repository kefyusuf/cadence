# ADR 0008 — The HTTP layer throws at the door, and the engine stays the only authority on a rule

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/server/create-app.ts`, `src/server/requests.ts`, `src/server/http-error.ts`,
`src/server/main.ts`, `src/adapters/memory-store.ts`, `src/adapters/system-clock.ts`,
`src/core/recurrence.ts`, `src/core/clock.ts`, `src/core/errors.ts`, `.dependency-cruiser.cjs`,
`vitest.config.ts`, `scripts/verify-package.mjs`, `test/server-app.test.ts`

## Context

Weeks 1 to 4/2 built a layer that can compute the next time something is due, wait for it, and be
configured to do so — and nothing that could ask it over a network. This is the slice that adds the
front door: seven routes over the two stores and the engine, the first runtime dependency in the
project, and the composition root that decides which adapter answers which port.

Two things made this a decision rather than plumbing. The first is that an HTTP request is the least
trustworthy input the system has ever taken: every byte of it is a string someone else typed, and the
domain layer's compile-time guarantees (branded ids, a `WorkItemStatus` union, `tz: string`) say
nothing at all about a JSON body. The second is that putting a front door in front of an engine
reveals what the engine quietly assumed. It assumed two things it did not check, and both are in the
decision below.

The question this ADR answers is where a refusal lives — which layer names it, which shape carries it,
and who is allowed to decide what a valid recurrence is.

## Decision

1. **`fastify` is the first runtime dependency, and it is still the only one.** Chosen over `express`
   for three reasons that this slice uses: `inject()` answers a route without opening a socket (30 of
   the slice's tests never bind a port), Pino comes with it rather than bolted on, and its types are
   written in TypeScript. Adding it moved the production image from zero runtime packages to
   `40 packages in node_modules` — the number `scripts/selfcheck.mjs` prints, measured on Node
   24.21.0 — `354MB` against the previous `330MB` (and the test image `472MB` against its `448MB`), and
   `/app` at `du -sh` `21M`. `dist` is `88 files` / `114955` bytes on both sides of the boundary, which
   is the number worth quoting: `find dist -type f -print0 | xargs -0 cat | wc -c` prints `114955` in
   the host tree and the same `114955` inside the image, where the `build` stage compiles from source on
   its own — the two outputs are identical in total. The same directory prints `143627` under `du -sb`,
   because that counts the seven directories (`dist` and the six layers inside it) at 4096 each as well
   as the 88 files, and the difference is exactly `7 × 4096` — an earlier draft of this ADR quoted the
   `du` figure as the size of `dist`, which is not comparable to anything. The byte total of the files is.
   The `deps-prod` stage comment that predicted this ("when week 4 adds Fastify the directory arrives
   populated and nothing here has to change") turned out true: no build step in the Dockerfile changed.

2. **`createApp(deps)` builds the application and does not listen.** Its argument is the whole
   dependency graph — `BoardStore`, `WorkItemStore`, `Clock`, and the logger switch — and nothing it
   needs is imported from a module that reads the world. So the same function is booted by a test with
   in-memory stores and `logger: false`, and by `src/server/main.ts` with the system clock and the log
   level from configuration. Binding is the entry point's decision because it is the part that varies
   per environment: `127.0.0.1:3000` on a laptop, `0.0.0.0:$PORT` in a container.

3. **Routes throw; the error handler is the boundary.** ADR 0002 says a `Result` is what a boundary
   returns and a `throw` is what happens inside. HTTP is the outermost boundary this repository has,
   and its value form is a response body, so the inside keeps throwing: a route either returns the
   thing it was asked for or throws `HttpError(statusCode, code, message)`. `setErrorHandler` is the
   one place that turns a throw back into `{ error: { code, message } }`, which means every refusal in
   the API has one shape and no route repeats the serialization.

4. **Engine codes are the API's codes.** A schedule the engine refuses is answered with the engine's
   own `code` and `message` — `INVALID_TIME_ZONE`, `INVALID_INTERVAL`, `INVALID_FREQUENCY` cross the
   boundary unchanged. That is deliberate: a caller who can read this package's README can read the
   400 body without a translation table, and the translation table would be a second list of the same
   codes to keep in sync. The one mapping the server adds is direction, not naming: a `CadenceError`
   whose code says the *caller's rule* is wrong is a 400, and one whose code says *this process* gave
   up (`SEARCH_EXHAUSTED`, `UNEXPECTED`) is a 500.

5. **A failure that is not a refusal we wrote is answered without its message.** `the pool is closed`
   is a store's private sentence: it means nothing to the person on the other end of the request and
   something to anyone probing what is behind it. `asHttpError` answers `INTERNAL` with a message of
   our own and logs the real error against the request. Pinned by a test that asserts the response body
   does **not** contain the phrase the stub threw. The withholding is keyed on the status, not on the
   class: an `Error` that arrives carrying a `statusCode` below 500 keeps its message, because the only
   things that do that today are Fastify's own body refusals, whose messages describe the request the
   client just sent — echo of the client's input, not of the server's internals. A 400 from a store
   would therefore leak, and it is listed as the honest limit of this rule rather than pretending the
   branch is airtight.

6. **Ids declare their kind at the door.** `parseId` validates shape and cannot tell a board id from a
   member id — the brand is compile-time only — so the request layer additionally requires each id to
   carry its kind's namespace: `bd_`, `mb_`, `wi_`. Without it, `PATCH /work-items/not_an_id` is a
   perfectly shaped id that no store holds, which answers 404 — "the thing is gone" — when the truth is
   "you pointed at the wrong collection", a 400. `parseId` itself is unchanged on purpose: its tests
   pin `'x'.repeat(64)` as a valid work-item id, and moving the prefix rule in there would have made the
   domain police a convention that only the request boundary needs. The list lives in
   `src/server/requests.ts`, which is also the only file that reads it.

7. **The engine is the only authority on what a recurrence is.** The server does not re-derive the
   rules; it hands the candidate to the engine and reports what comes back. Writing that single call
   is what found two holes in week 1's core, and both were fixed in the core rather than
   papered over at the boundary — a boundary that duplicates a rule is a second rule.

   The call is `createSeriesCursor(candidate)`, and its result is thrown away on purpose:
   `occurrences()` normalises the rule and resolves the anchor when the series is created, so
   constructing the cursor runs every check without pulling an occurrence — and it is the same object
   `runSeries` will walk. The first version of this boundary probed with
   `tryNextOccurrence(candidate, candidate.dtStart)` instead, which was correct about the codes and
   wrong about the message. `nextOccurrence` asserts its `after` argument before it normalises the
   rule, so a client that sent `dtStart: "2026-03-28T01:30:00.000Z"` — the natural JSON spelling of a
   timestamp, and the one this API refuses — got
   `after must be an integer epoch ms, got 2026-03-28T01:30:00.000Z` back from a request that never
   contained the word `after`. Measured against the built `dist/server/main.js` on a real socket
   before the change; after it the same request answers
   `dtStart must be an integer epoch ms, got 2026-03-28T01:30:00.000Z`. Nothing was added to the
   server's own rule set to get there, which is the point: moving the probe to where the engine names
   the field is a *wiring* change, and the alternative — rewriting the engine's message at the door —
   would have been a second place that decides what a `dtStart` is. Pinned by a test that asserts both
   halves: the message contains `dtStart` and does not contain `after`.

   - **An unhandled frequency was not refused.** `periodWalls` switches over the four frequencies with
     no default, so `freq: 'HOURLY'` produced zero candidates every period, and the walk's own
     watchdog only noticed after 4000 of them. Measured against a build with the check removed:
     `without the guard: SEARCH_EXHAUSTED after 18.2 ms`. Now `normalize` checks the value against the
     list the `Frequency` type is derived from, which answers `INVALID_FREQUENCY` in `0.02 ms` — and
     the list is `const FREQUENCIES = [...] as const` with `type Frequency = (typeof
     FREQUENCIES)[number]`, so the type and the runtime check cannot drift apart. New code in
     `CADENCE_ERROR_CODES`, which is now 16 entries.
   - **A rule with no time zone was accepted.** `Intl.DateTimeFormat` reads an absent `timeZone` option
     as "use the host's zone", so `{ dtStart, freq: 'DAILY' }` — a body with the `tz` missing — would
     have been stored as valid and meant a different hour on every machine that ran it. One `typeof`
     guard at the top of `formatterFor` turns that into `INVALID_TIME_ZONE`. The type said `string`;
     the value came from outside, which is exactly when a type is a claim rather than a fact.

   The first two are tested in the core (`test/recurrence.test.ts`, `test/clock.test.ts`) and again
   through HTTP (`test/server-app.test.ts`), because the boundary's promise is that it forwards them.
   The third is a boundary test only — the engine's own message was correct about its own parameter.

8. **The composition root is shipped and not reachable.** `src/server/main.ts` compiles to
   `dist/server/main.js`, travels in the tarball, and is the file the container will run — while
   `import('cadence/server')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, the 13th check in
   `npm run verify:package`. Same asymmetry as `src/adapters` and `src/config`: the exports map, not
   the presence of a file, is what decides the surface.

   `main.ts` is also the only file under `src/` excluded from coverage in `vitest.config.ts`, and the
   exclusion is honest about why: everything it does is either hand the environment to an adapter or
   ask Fastify to bind, and neither is testable from inside a vitest run. What proves it instead is
   running the built entry point:

   ```sh
   PORT=3124 node dist/server/main.js
   # {"level":30, … ,"host":"127.0.0.1","port":3124,"logLevel":"info","environment":"development","msg":"cadence configuration"}
   # {"level":30, … ,"msg":"Server listening at http://127.0.0.1:3124"}
   curl -s http://127.0.0.1:3124/healthz          # {"ok":true}
   curl -s -X POST http://127.0.0.1:3124/boards -H 'content-type: application/json' \
     -d '{"id":"bd_core","name":"Core platform","memberIds":["mb_yusuf"]}'
   # {"id":"bd_core","name":"Core platform","memberIds":["mb_yusuf"]}
   ```

   The first line is ADR 0007's promised mitigation for a misspelled variable, now actually shipped: the
   four settings that were resolved are echoed once before the bind, so `PTOR=8080` shows up as
   `port: 3000` instead of as a mystery. `npm start` is that same `node dist/server/main.js` — re-run
   through the script on `PORT=3133` it answers `/healthz` with `{"ok":true}` and echoes
   `"port":3133` in the first line; the README's transcript is the same built entry point on `3132`.

9. **`nothing-inside-src-imports-the-server`** is the direction gate for the new layer: `core`,
   `domain`, `scheduler`, `config` and `adapters` may not import `src/server`. The existing purity
   rules would not have caught it — a local import is invisible to `core-is-pure`, which only looks at
   packages and builtins — and the edge is the one that would quietly turn the published engine into a
   web server. Fired with two throwaway probes in the real tree, then deleted:

   ```
     error nothing-inside-src-imports-the-server: src/core/__probe.ts → src/server/create-app.ts
     error nothing-inside-src-imports-the-server: src/adapters/__probe.ts → src/server/create-app.ts

   x 2 dependency violations (2 errors, 0 warnings). 45 modules, 80 dependencies cruised.
   ```

   With the probes gone the same command reports 0 violations (45 modules, 81 dependencies). The probe
   that mattered is the `adapters` one: adapters are already allowed to import everything above them, so
   without this rule an adapter reaching for a route would have passed every other gate.

10. **`no-restricted-globals` covers `src/server`, and now that the directory exists the claim is
    checkable rather than predicted.** ADR 0007 rewrote the boundary block to `files: ['src/**/*.ts']`
    with `ignores: ['src/adapters/**']` precisely because `src/!(adapters)/**/*.ts` skipped files
    sitting directly in `src`. `npx eslint --print-config` on the tree as it now stands:

    ```
    src/server/main.ts      -> rule present ("process")
    src/core/index.ts       -> rule present ("process")
    src/adapters/env-config.ts -> absent
    ```

    So `main.ts` cannot read `process.env` — it calls `loadAppConfig()` in `src/adapters` instead — and
    the one file that does read the environment is the one the rule exempts.

11. **A method this server does not implement is a 404 in the same envelope, not a 405.** Measured
    against the built app: `DELETE /boards` answers
    `{"error":{"code":"NOT_FOUND","message":"no route for DELETE /boards"}}`. Chosen over hand-writing a
    405 because Fastify's router already treats an unrouted path-and-method pair as not found, and
    because "there is no DELETE here" is literally true — the alternative would be a second error shape
    to document and to test. Pinned by a test that compares the whole body, so the envelope's exact
    shape (`error`, then `code` and `message`, nothing else) is a claim with a check behind it.

12. **Four of the five ports now have an adapter, and the fifth is the honest gap.**
    `BoardStore` and `WorkItemStore` are the in-memory stores from `464a903`, `ScheduleNotifier` is
    `log-notifier.ts`, `Clock` is `createSystemClock()` in `src/adapters/system-clock.ts` — three lines
    whose only job is to be the place `Date.now()` is reached, with a test that pins it to the whole
    millisecond the port promises. `IdGenerator` has no implementation because every route today takes
    its id from the caller: the client names the board, the server does not. That is a decision to
    revisit the moment a POST-without-id is a requirement, not an oversight to leave uncommented.

## Consequences

- Measured after this change, host Node v26.8.2 — `187 tests` in `16 files`, `43 files` linted with 0
  errors, 0 dependency violations (`45 modules / 81 dependencies`), coverage `99.51` statements /
  `97.39` branches / `100` functions / `99.51` lines, `13` package checks, tarball `90 files` /
  `37966 bytes`. Inside the test image on Node 24.21.0 the same set runs green with the same test,
  lint, coverage and package-check numbers and a tarball of `90 files` / `37975 bytes`, but
  `48 modules / 87 dependencies` cruised. An earlier draft of this bullet attributed that gap to a
  difference between Windows and Linux module resolution. It does not, and the review that caught it
  proved the alternative on both platforms: the count is a function of whether `dist` exists at the
  moment of cruising, which is precisely what ADR 0006 decision 9a already documents. The mechanism,
  restated because it is easy to get backwards: `scripts/selfcheck.mjs` and
  `scripts/typecheck-consumer.ts` import `cadence`, `cadence/domain` and `cadence/scheduler`, and
  neither environment has a `node_modules/cadence` for them to land in (`ls -d node_modules/cadence`
  fails on both). With `dist/` present those three specifiers resolve into `dist/**`, which the exclude
  pattern drops, so the cruise reports `45 modules / 81 dependencies`; with `dist/` absent they cannot
  resolve at all, and dependency-cruiser keeps each as its own orphan node plus an unresolvable edge —
  `48 / 87`. Same command, same tree, one directory: `mv dist /tmp/dist-hidden && npm run lint:deps`
  prints `48 modules, 87 dependencies` on the Windows host, and inside a fresh `cadence-test` container
  `npm run lint:deps` prints `48 / 87` before `npm run build` and `45 / 81` after it. The Node 22
  container below cruised `48 / 87` for the same reason — lint:deps runs before build there too. So the
  host's `45 / 81` and the image's `48 / 87` are both correct, for the state each tree was in, and the
  sentence this draft started with ("that gap is not the drift ADR 0006 decision 9a documents") was the
  mistake: it is exactly that drift, and the rule it implies still holds — **the violation count is the
  comparable number and the module count is not**, and a difference between `45/81` and `48/87` is
  never a regression.
  On Node 22 the rest of the set is identical: a clean `node:22-bookworm-slim` container with this tree
  copied in runs `13 of 13` package checks, `187 tests` and the same coverage line, which is what CI's
  `22` leg will report.
- The new files are at 100 on all four measures: `create-app.ts`,
  `requests.ts`, `http-error.ts`, `system-clock.ts`; `model.ts` lost its coverage exclusion because the
  status list is runtime code, and `main.ts` gained the one described in decision 8.
- **`dtStart` is epoch milliseconds, and an ISO string is refused.** JSON has no date type, so every
  client picks a spelling, and accepting both would mean a body that says `"2026-03-28T01:30:00.000Z"`
  and a stored rule that says `1774661400000` — two representations of the same field in the same
  round-trip. The engine's `Recurrence.dtStart` is a `number`, so that is what the API takes. The cost
  is that the natural-looking request fails; the 400 says which field and what it expected. If an ISO
  form ever becomes a requirement it belongs in `readSchedule` as a conversion before the engine sees
  it, which is a door change, not a core change.
- The route test file needs one app per test, not one per request. The first version built a fresh app
  inside the helper that made every call, which meant each request got its own empty store and a test
  that posted twice was asserting about two different servers — the 409 test could not have failed for
  the reason it claims. `beforeEach` now owns the instance.
- **Nothing here is authenticated.** Whoever can reach the port can create a board, move an item, and
  read the whole board list. The blast radius is limited today by two other decisions: the default bind
  is loopback (ADR 0007 decision 4) and `compose.yaml` publishes no ports yet. Week 5 owns the member
  identity that the `mb_` ids are waiting for.
- **The server is not what the container runs yet.** `CMD` and `HEALTHCHECK` still point at the
  self-check, so the image proves it can answer a probe rather than that a service is up. That is task
  4/4: `CMD ["node", "dist/server/main.js"]`, a real HTTP probe against `GET /healthz`, published ports
  in compose, and graceful shutdown on `SIGTERM` — which cannot live in `src/server`, because
  `process` is gated (decision 10), so it arrives as a signals adapter in `src/adapters`.
- **`PATCH` changes the status and nothing else**, by design: the keys it does not know are ignored, so
  a client that sends a whole item back after editing the title gets a 200 and no rename. There is no
  `PUT`, no `DELETE`, no pagination, and no optimistic concurrency — two clients moving the same item
  race, and the later write wins silently. Each needs its own slice and its own tests, not a flag.
- The stores are in-memory, so a restart empties the board and two processes do not share one. The
  ports are what the HTTP layer asked for (`loadBoard`/`listBoards`/`saveBoard`,
  `load`/`listForBoard`/`save`), which is the point: the durable adapter will be written against a
  shape that a real caller already needed, and `save` being an upsert is the one demand worth
  questioning before a database has to satisfy it.
