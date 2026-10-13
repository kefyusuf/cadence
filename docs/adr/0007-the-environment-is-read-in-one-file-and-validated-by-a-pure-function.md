# ADR 0007 — The environment is read in one file and validated by a pure function

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/config/app-config.ts`, `src/adapters/env-config.ts`, `src/core/errors.ts`,
`eslint.config.js`, `.dependency-cruiser.cjs`, `scripts/verify-package.mjs`, `test/config.test.ts`,
`test/env-config.test.ts`

## Context

Week 4 puts a Fastify server in front of the engine, and a server starts with four things it did not
choose: the address to bind, the port, the log level and the environment name. All four arrive as
strings from `process.env`, which is the least type-checked input in the whole system.

The easy version is `const port = Number(process.env.PORT ?? 3000)` inside the server file. It has
three costs: the server can no longer be constructed without an environment, the rules live wherever
the reading happens, and a typo like `PORT=8O80` becomes `NaN` — which `listen()` then happily
interprets as 0, i.e. "bind a random port". That last one is not hypothetical; it is the reason this
ADR exists.

So the question was where configuration belongs in a hexagonal layout that already has four gated
layers, and what has to be true for that placement to survive the next layer added to it.

## Decision

1. **Configuration is its own layer, `src/config`, and it is not part of the domain.** `src/domain`
   is board vocabulary — members, work items, boards. Configuration is how *this application* is
   assembled, and the reusable engine must not need it. Three rules say so: `config-is-pure` (nothing
   under `src/config` may import a package or a Node builtin), `core-domain-scheduler-do-not-know-config`
   and `config-do-not-know-adapters`. All three were fired by adding throwaway probe files to the real
   tree, running `npx dependency-cruiser src --no-progress` once, and deleting them:

   ```
     error core-domain-scheduler-do-not-know-config: src/scheduler/__probe.ts → src/config/app-config.ts
     error core-domain-scheduler-do-not-know-config: src/domain/__probe.ts → src/config/app-config.ts
     error core-domain-scheduler-do-not-know-config: src/core/__probe.ts → src/config/app-config.ts
     error config-is-pure: src/config/__probe.ts → fs/promises
     error config-do-not-know-adapters: src/config/__probe.ts → src/adapters/env-config.ts

   x 5 dependency violations (5 errors, 0 warnings). 21 modules, 28 dependencies cruised.
   ```

   With the probes gone the same command reports 0 violations. `config-do-not-know-adapters` is the
   one worth reading: `config-is-pure` cannot catch `src/config` importing `src/adapters/env-config.ts`,
   because that is a local import — and that single edge would put a `process.env` read inside the layer
   whose entire purpose is not to have one. The direction gate has to cover the transitive case, not
   just the builtin.

2. **A purity rule over imports was not enough, because `process` is a global.** `config-is-pure`
   can only see module specifiers — `src/config` reading `process.env.PORT` would have been invisible
   to dependency-cruiser, and the gate would have been a decoration. The rule that actually holds the
   line is an ESLint `no-restricted-globals` for `process`. It was fired with the repo's own config, by
   putting the same one-line probe on both sides of the boundary and linting all three at once:

   ```
   E:\projects\cadence\src\__probe.ts
     1:32  error  Unexpected use of 'process'. Only src/adapters reads the environment — take it as an argument  no-restricted-globals

   E:\projects\cadence\src\config\__probe.ts
     1:32  error  Unexpected use of 'process'. Only src/adapters reads the environment — take it as an argument  no-restricted-globals

   ✖ 2 problems (2 errors, 0 warnings)
   ```

   The third probe, `src/adapters/__probe.ts`, is the same line and reports nothing — the exclusion is
   the other half of the proof. Probing against the real config rather than a hand-written minimal one
   is what caught the first version of this rule being wrong: it read
   `files: ['src/!(adapters)/**/*.ts']`, and because `!(adapters)` consumes exactly one path segment, a
   file placed *directly* in `src/` matched no configuration at all — which is where the next slice's
   composition root is a candidate to land. The block now reads `files: ['src/**/*.ts']` with
   `ignores: ['src/adapters/**']`. `npx eslint --print-config <path>` makes that checkable without a
   probe: `no-restricted-globals` is present for `src/index.ts`, `src/server/main.ts`,
   `src/config/x.ts` and `src/scheduler/y.ts`, absent for `src/adapters/env-config.ts` and `test/x.ts`.

3. **The parser takes a record and never touches the platform.** `parseAppConfig(values: StringRecord)`
   returns `Result<AppConfig, CadenceError>`; `StringRecord` is
   `Readonly<Record<string, string | undefined>>`. All the rules are therefore testable without
   mutating a process, and the composition root can be tested by handing over a record.
   `loadAppConfig(env: StringRecord = process.env)` is the whole adapter — one function whose only
   content is a default argument, and the only place in `src/` where the default is what makes the
   environment reachable at all.

4. **The defaults are the safe side of a mistake.** Unset `HOST` binds `127.0.0.1`, not `0.0.0.0`;
   `PORT` is 3000, `LOG_LEVEL` is `info`, `NODE_ENV` is `development`. The failure mode of a forgotten
   variable should be "I cannot reach it from another machine", not "the board is now reachable by
   everyone on the network". `0.0.0.0` is what the container sets on purpose, and it is tested as such.

5. **An empty value means absent.** `HOST=` is not a user typing an invalid hostname, it is what a
   compose file or `FOO=$MAYBE_UNSET` produces. Tested through the adapter against a real
   `process.env.PORT = ''`, which resolves to the default rather than refusing.

6. **One run reports every problem.** Four bad variables produce one `INVALID_CONFIG` whose message
   names all four, because an operator sets these in a single file and needs all four answers before
   the next boot, not one per restart. Measured with
   `{ PORT: 'abc', LOG_LEVEL: 'verbose', NODE_ENV: 'staging', HOST: 'a b' }`.

7. **`localhost:3000` in `HOST` is refused with a message that names `PORT`.** The rule is
   colon-counting, not address parsing: one colon means somebody glued the port onto the host;
   IPv6 literals always have at least two, so `::1` stays valid. No attempt is made to validate an
   IP or resolve a hostname — the charset rule
   (`/^[A-Za-z0-9._:-]+$/`, at most 253 characters) refuses what cannot be a bind address and leaves
   the rest to the syscall.

8. **Case is normalised for the two enum settings, and unknown values are refused rather than
   mapped.** `LOG_LEVEL=INFO` and `NODE_ENV=Production` are accepted and stored lowercased. `prod`
   and `staging` are *not* accepted for `NODE_ENV`: an environment name we have no behaviour for
   means someone's mental model differs from ours, and booting anyway is how a "staging" deploy ends
   up running with production defaults. The consequence is below.

9. **A leading zero is kept, not reinterpreted.** `PORT=03000` yields `3000`. `Number()` on a
   digits-only string cannot produce octal in JavaScript, and rejecting the value would be inventing a
   rule nobody asked for. The test pins it so a future reader treats it as a decision, not an accident.

10. **The port is digits-only *and* in range.** `PORT_PATTERN = /^\d+$/` rejects `80.5`, `+80`, `-1`,
    `3_000`, `0x50` and any padded form before `Number()` runs; then `1..65535` rejects `0`, `65536`,
    `70000` and a 12-digit number. The `NaN`-becomes-port-0 story is over before it starts: there is no
    input that parses to a port we did not name.

11. **A new error code, `INVALID_CONFIG`, went into the union in `src/core/errors.ts` — 15 codes now.**
    It belongs next to the other input rejections, and `isCadenceError` picks it up through the same
    `KNOWN_CODES` set, so a config error that crosses a worker or a duplicated module copy keeps its
    code.

12. **`cadence/config` is not exported.** `dist/config` ships in the tarball — built, packed, and
    simply not reachable — but
    `import('cadence/config')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, now the 12th
    `npm run verify:package` check — the same asymmetry as `src/adapters`: the *shape* of a
    configuration record is not something a consumer may couple to until there is a reason.

## Consequences

- Measured after this change — these belong to this slice, and every later slice moves them; the
  README carries the current totals: `133 tests` in `12 files`, `33 files` linted with 0 errors and 0
  warnings, 0 dependency violations (`35 modules / 61 dependencies` with `dist` present, `38 / 67`
  without it — the drift ADR 0006 decision 9a documents), `12` package checks, coverage
  `99.31` statements / `96.07` branches / `100` functions / `99.31` lines on both Node 24.21.0 in the
  image and the host's v26.8.2, with `config/app-config.ts` and `adapters/env-config.ts` at 100 on all
  four. The prod image is `/app` 332K with `dist` at 64 files across five layers.
- The server's composition root will call `loadAppConfig()` and `throw` when the result is `err` —
  ADR 0002's rule that a `Result` is for boundaries and a `CadenceError` code is what a human reads.
  Nothing between the ports and the environment will get to read it.
- **Unknown variables are ignored**, so `PTOR=8080` boots with port 3000 and no warning. Accepted for
  now, because a real environment carries variables this process has no business knowing about
  (`PATH`, `HOME`, the container runtime's own). The cheap mitigation is the one the next slice
  ships: log the resolved `AppConfig` once at startup, so a wrong value is visible without a
  validation rule for every key that exists.
- **`NODE_ENV=staging` will not boot.** A staging deployment has to set `NODE_ENV=production` and
  carry its own stage name in a variable we ignore — otherwise we would be inventing behaviour for a
  name we did not choose. If staging needs distinct behaviour later, it gets a setting, not a string.
- Adding a fifth setting is now a fixed-cost move: a rule in `src/config`, a case in the refusal
  tests, and nothing anywhere else can read the environment to skip that work.
- **The globals rule exempts `src/adapters` as a directory, not `env-config.ts` as a file.** A second
  adapter that read `process.env` would pass every gate, so "one file reads the environment" is a
  convention the tooling enforces one level coarser than the claim. Kept at directory granularity on
  purpose — an adapter is the layer that is allowed to touch the platform, and naming files in a lint
  config means editing the config every time one is added. If a second reader ever appears, the check
  worth writing is a `verify:package`-style count of `process.env` occurrences under `src/`, not a
  narrower lint rule.
- How the measurements above were produced, so a reader can falsify them rather than trust them:
  `npm run typecheck && npm run lint && npm run lint:deps && npm test && npm run test:coverage && npm run build && npm run verify:package`
  on the host (Node v26.8.2), then `docker build --target test` followed by
  `docker run --rm cadence-test sh -c "npm run lint && npm run lint:deps && npm test && npm run build && npm run verify:package"`
  and the same set through `docker compose run --rm --build app` (Node 24.21.0), and finally
  `docker run --rm --read-only --cap-drop=ALL --security-opt no-new-privileges:true cadence-prod`
  for the prod image. All of it was re-run after a review closed two gaps in these very gates — the
  `src/*.ts` blind spot in decision 2 and the missing `config-do-not-know-adapters` edge in
  decision 1 — and the numbers are from that re-run.
