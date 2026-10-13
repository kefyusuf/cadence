# ADR 0005 — The production image ships `dist` and proves itself

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `Dockerfile`, `compose.yaml`, `.dockerignore`, `.github/workflows/ci.yml`, `scripts/selfcheck.mjs`, `eslint.config.js`

## Context

The `test` target existed and worked: every gate ran inside it, as the non-root `node` user. What
did not exist was anything deployable. Adding a `prod` target is trivial in the wrong way — copy
the tree, install everything again, add a `HEALTHCHECK` line that looks like hardening.

Two things made that tempting version actually wrong. First, the package has **no runtime
dependencies at all**: `package.json` has no `dependencies` field, and `npm ls --omit=dev --depth=0`
prints `(empty)`. Second, there is no server yet — Fastify is week 4 — so a production container
today has no process to be healthy. A `HEALTHCHECK` on an image whose command exits is decorative
unless someone runs it and reads the result.

So the question was not "how do we shrink the image" but "what does this image contain, who owns it
at runtime, and what would have to be true for a health check to mean something".

## Decision

1. **`prod` ships the build output, built inside the image.** The Dockerfile is now
   `deps` → `deps-prod` → `build` → `test` → `prod`. `build` runs `tsc -p tsconfig.build.json` and
   `prod` copies `/app/dist` out of it, so the artifact never depends on a directory the host
   happened to leave behind — `dist` is in `.dockerignore` precisely so that a stale host build
   cannot leak into the context.
   Measured contents of `/app` in the prod image: `dist` (52 files), `package.json`, `README.md`,
   `node_modules`, `scripts/selfcheck.mjs` — 272K on disk.

2. **The runtime install is `npm ci --omit=dev`, and the interesting part is what it installed.**
   The first build of `prod` failed with
   `failed to calculate checksum of ref …: "/app/node_modules": not found` — `npm ci --omit=dev`
   for this package leaves no `node_modules` behind, because there is nothing to install. Rather
   than deleting the `COPY`, the stage now ends in `&& mkdir -p node_modules`. That keeps the
   instruction a stable contract: when week 4 adds Fastify the directory arrives populated and
   nothing in the `prod` stage has to change.

3. **Code is root-owned; the process is not.** `prod` copies without `--chown` and then switches to
   `USER node`, so the runtime user reads the code it executes and cannot rewrite it. This is the
   opposite of the `test` target, which `chown`s everything to `node` because vitest writes
   `coverage/` into the tree. Verified by trying to tamper:

   ```
   $ docker run --rm --entrypoint sh cadence-prod -c 'printf x >> dist/core/index.js; echo "write exit=$?"'
   sh: 1: cannot create dist/core/index.js: Permission denied
   write exit=2
   ```

   `id -u` in the image is `1000`, `whoami` is `node`, and `docker inspect` reports `User=node`.

4. **Health is a script, and one definition of "this image works" is used three times.**
   `scripts/selfcheck.mjs` is the prod `CMD`, the `HEALTHCHECK` command, and the CI probe. It runs
   six steps and prints them: node version against the `engines` floor, image shape
   (`NODE_ENV=production`, no dev tooling in `node_modules`, package count), the three entry points,
   a DST gap resolution, a real wait, and a real abort. It exits non-zero on the first failing step
   and lists all of them otherwise.

   Two of those steps cannot be replaced by a unit test, which is the reason the script exists at
   all: the published `exports` map has to resolve inside a runtime image that has no build
   tooling, and the shipped `sleep` has to actually wait with real timers under whatever the base
   image's `NODE_VERSION` happens to be.

5. **The self-check imports the package by its published name.** `import('cadence')` works because
   Node resolves a package to itself through its own `exports` map. That is deliberately the same
   specifier the week 4 server will use, so a broken `exports` or a mis-copied `dist` fails here
   instead of failing in a deployment. Output from inside the image:

   ```
   selfcheck ok: node v24.21.0 | image NODE_ENV=production, 0 packages in node_modules |
   entry points cadence, cadence/domain, cadence/scheduler | DST gap 2026-03-29T01:00:00.000Z |
   real wait waited 407 ms, delivered at 2026-10-13T11:54:11.002Z | real abort endedBy aborted, 0 delivered
   ```

6. **The first version of the check asserted the wrong contract, and the run said so.**
   It waited for an occurrence one second ahead and asserted the delivery happened at least
   1000 ms after the run started. On the host it failed:
   `real wait: delivered after 935 ms, expected at least 1000`. That was my expectation being wrong,
   not the engine's: the wait is only the lead that was *left* when the run started, and the
   contract is wall-clock — never deliver before the instant. The assertion is now
   `deliveredAt >= target`, and the runs deliver 1–2 ms past the second boundary
   (`…:45.001Z`, `…:11.002Z`) rather than early.

7. **`HEALTHCHECK` is exercised, not just declared.** The directive is
   `--interval=30s --timeout=5s --start-period=5s --retries=3`. Because the image's command is a
   one-shot, CI starts the same image with a keep-alive command and the interval shortened to 1s,
   then polls `.State.Health.Status` until it flips:

   ```
   health after 1s: starting
   health after 2s: starting
   health after 3s: healthy
   ```

   Docker's own health log records `ExitCode: 0` and one check costing 877 ms (start 11:52:06.153,
   end 11:52:07.030). What that proves is narrow and worth stating exactly: the command exists, runs
   as the image's user, and succeeds *inside this image*. It does not yet prove liveness of a
   service, because there is no service — the same line becomes that proof when the command is a
   server, without the Dockerfile changing.

8. **The constraints are declared in Compose, not only run by hand.** The `prod` service carries
   `read_only: true`, `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]`. The check
   passes under all three (`docker compose run --rm --build prod`, exit 0) — the runtime writes
   nothing, so a read-only root filesystem costs it nothing.

9. **`eslint.config.js` gained two globals.** `AbortController` and `setTimeout` had to be added to
   the block for `**/*.{js,mjs,cjs}`, because that block declares its globals by hand while the
   TypeScript side gets them from `@types/node`. The first `npm run lint` after adding the script
   reported both as `no-undef`.

10. **`.dockerignore` now ignores what no target uses** — `docs/`, `.gitignore`, `.gitattributes`.
    Measured context: 254295 bytes before, 232952 after.

## Consequences

- `cadence-prod` is 330MB against `cadence-test`'s 448MB. The difference is the dev tree, and the
  prod image is the one that has to be re-examined when a runtime dependency first appears.
- The self-check is **not** covered by vitest. Nothing in `npm test` runs it, so a check that
  asserts the wrong thing keeps CI green — decision 6 is the example of how that shows up: only by
  running it. It is executed in CI inside the image, which is the only honest seam for it.
- Every health check creates a real timer about one second ahead and one that is aborted after
  20 ms. At the 30s interval an 877 ms check is under 3% duty. If that ever matters, the fix is a
  cheaper check, not a fake clock — the point of the script is that it uses the real one.
- The `image` step fails on the host **by design**, because a checkout legitimately has
  devDependencies: `selfcheck failed (1): image: dev tooling in the image: typescript, vitest,
  eslint, dependency-cruiser`. A check that cannot fail is worth nothing, so this one is left
  strict and the host is expected to fail it.
- Week 4 replaces the prod `CMD` with the server and adds an HTTP probe; `selfcheck.mjs` stays as
  the image smoke test that CI runs directly. If the recurrence behaviour changes, this file is
  where the engine's guarantees meet the base image's `NODE_VERSION` and time zone database.
