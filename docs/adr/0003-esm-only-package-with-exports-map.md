# ADR 0003 — One ESM build, an `exports` map, and `require(esm)` instead of a dual build

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `package.json`, `tsconfig.build.json`, `src/*/index.ts`, `scripts/verify-package.mjs`, `.dependency-cruiser.cjs`

## Context

Later weeks add a Fastify adapter, a Vite board UI, a Redis cache and a queue worker. Each of
them imports this code differently: the browser bundle needs tree-shakeable ESM, the worker image
may still be CommonJS, and the UI must not be able to reach the recurrence engine's internals.
Shipping raw TypeScript with no declared surface would let any of them import `src/core/clock.ts`
directly, and layering would become a suggestion.

## Decision

1. **Single ESM output.** `"type": "module"`, `tsc -p tsconfig.build.json` emits `dist/` with
   declarations and maps. No hand-written CommonJS, no bundler, no dual-package shim.
2. **Two entry points, declared by `exports`.** `.` -> `dist/core/index.js`, `./domain` ->
   `dist/domain/index.js`, plus `./package.json`. Every other path is closed. Barrel files are
   curated lists, not `export *`; `test/public-api.test.ts` pins the runtime surface to exactly
   17 names for core and 1 (`parseId`) for domain, so a new export is a deliberate edit.
3. **CommonJS consumers use `require(esm)`.** Measured `PASS` on Node 24.21.0 (container) and
   Node 26.8.2 (host); `engines.node` is `>=22.12.0`, the line where `require(esm)` stopped
   needing a flag. A second build format is the wrong tool for a version floor we can simply
   declare — and the CI matrix (Node 22 and 24) is where a violation surfaces.
4. **`files` is `[dist, README.md]`; `sideEffects: false`.** The tarball contents are measured by
   the pack check. `sideEffects` is the promise to a bundler, kept cheap because the barrels
   contain nothing but re-exports.
5. **Layering is enforced by dependency-cruiser, not prose.** `src/core` and `src/domain` may
   not depend on npm packages or Node builtins; `src/core` may not import `src/domain`; `src/**`
   may not import `test`, `scripts` or `dist`; no cycles. The gates were checked by feeding a
   deliberate violation in (`src/core` importing `node:path` and `src/domain/ids.js`) and reading
   back two `error` verdicts before deleting the probe.
6. **Packaging is verified by execution.** `scripts/verify-package.mjs` runs eight checks against
   the built output: ESM and CommonJS imports of both entry points, the same recurrence result
   through the public surface, deep import rejected with `ERR_PACKAGE_PATH_NOT_EXPORTED`, every
   `exports` target present on disk, the tarball contents (42 files, ~16 kB, identical on the host
   and in the Node 24 image), and a consumer file compiled against `dist/**/*.d.ts` with `--strict`
   and **no** `skipLibCheck` — so a broken declaration fails the build rather than the reader's IDE.

## Consequences

- `verify:package` requires `build` to have run; CI order is typecheck -> lint -> lint:deps ->
  coverage -> build -> verify, and the Docker job runs the same chain inside the image.
- `scripts/typecheck-consumer.ts` is deliberately excluded from the main `tsconfig.json` and from
  the ESLint type-aware block: it imports the *built* package, so making it part of the normal
  typecheck would force a build before every `npm run typecheck`.
- Consumers cannot import internals: `cadence/src/...` is closed, so the only way in is through the
  two barrels. `Intl` is a global and no module rule can keep it out of `src/core`; the conversion
  stays in `clock.ts` because the barrel exposes only `wallClockAt` and `instantFromWallClock`.
- If a real consumer needs Node < 22.12, the fix is a documented dual build, and this ADR is the
  place that reversal gets recorded.
- `compose.yaml` mounts nothing. A named `node_modules` volume under a bind-mounted `/app` never
  received the image's copy — measured as `eslint: not found`, exit 127, even after deleting and
  recreating the volume — so the image *is* the file system and `docker compose run --build` is the
  reload step. Losing hot edits buys a dev loop that cannot drift from `package-lock.json`.
