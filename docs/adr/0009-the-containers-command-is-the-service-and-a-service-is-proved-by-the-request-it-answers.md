# ADR 0009 — The container's command is the service, and a service is proved by the request it answers

Status: accepted
Date: 2026-10-14
Deciders: Yusuf Kef
Technical context: `Dockerfile` (the `prod` stage), `compose.yaml`, `.github/workflows/ci.yml`,
`src/server/main.ts`, `src/server/shutdown.ts`, `src/adapters/process-signals.ts`,
`scripts/selfcheck.mjs`, `test/shutdown.test.ts`, `test/process-signals.test.ts`,
`test/server-app.test.ts`

## Context

ADR 0008 closed with a consequence it could not act on: the HTTP layer existed, and the production image
still ran `node scripts/selfcheck.mjs` as both its `CMD` and its `HEALTHCHECK`. That was honest — an image
whose command is a self-check proves it can answer a probe, not that a service is up — and it was written
as a promise that week 4's last slice would flip it. This is that slice.

The flip is not one line, because a container has exactly one command and the command is now something
that must stay alive. Three things follow and each one is a decision below: what happens to the proof the
command used to carry, what the health probe is allowed to claim, and who is allowed to touch the process
when the container is told to stop.

The third turned out to be the interesting one. Writing the stop path meant learning what `SIGTERM` means
to a process that is PID 1, and the answer is not what the intuition says. Two of the claims in the
comments I first wrote were wrong, and both were corrected by measurement rather than by argument: that
removing the listeners "puts the default action back" (decision 5), and that closing a server with an idle
keep-alive socket would wait forever unless Fastify were told to force it (decision 6). They are recorded
here with the numbers.

## Decision

1. **The prod command is `node dist/server/main.js`, and the package proof moved to build time.**
   `RUN node scripts/selfcheck.mjs` now sits in the `prod` stage, after `USER node`. The proof did not get
   weaker, it got earlier and unavoidable: an image that cannot load itself can no longer be built. It runs
   as the user that will run it, so a file the runtime user cannot read is a build failure rather than a
   container that starts and then cannot serve. The build log carries it:

   ```
   #18 [prod 7/7] RUN node scripts/selfcheck.mjs
   #18 0.730 selfcheck ok: node v24.21.0 | image NODE_ENV=production, 40 packages in node_modules | entry
         points cadence, cadence/domain, cadence/scheduler | DST gap 2026-03-29T01:00:00.000Z | real wait
         waited 459 ms, delivered at 2026-10-14T03:34:19.001Z | real abort endedBy aborted, 0 delivered
   ```

   Six checks, one of which waits for a real wall-clock instant and one of which aborts a real wait — that
   is what `cadence/scheduler` asks of an image, and none of it needs a port. The step is `7/7` in a build
   that has to run it, and the numbers inside that line are one run's: the real wait goes to the next whole
   second, so it has printed 459 ms, 575 ms and 1 ms in three builds of this slice.

2. **The health probe is an HTTP request, made by Node, to the route a load balancer would call.**
   `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/healthz')
   .then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"`. Shell form so the port comes from the
   environment the image sets; `fetch` because this image installs no curl and adding one would move the
   runtime dependency count off the one package it has been held at (`40 packages in node_modules`,
   `354MB`, unchanged from the slice before this one).

   A probe that cannot fail is not a probe, so the same image was run with a command that does not serve —
   `node -e "setInterval(() => {}, 1000)"`, same healthcheck, `--health-interval=1s`:
   `starting` at 1, 2 and 3 seconds, `unhealthy` from 4 onward. With the real command the same poll reads
   `healthy` within 2s, and 1s when the set was re-measured on the final tree. The negative control is the
   half of the evidence that makes the positive one mean anything.

   Those runs published the container on whatever host port was free — `3135`, `3138`, `3141`, `3142` —
   because another process on this machine held 3000 while this slice was written. The image cannot tell the
   difference: the probe addresses `process.env.PORT`, which is 3000 inside the container in every one of
   them, and only the host's own socket differs. That is why decision 3 splits the two layers.

3. **The image binds every interface; compose publishes loopback only.** ADR 0007's default of
   `127.0.0.1` was a rule about a laptop, and inside a PID namespace loopback reaches nothing outside it —
   so the `prod` stage sets `ENV HOST=0.0.0.0`, `ENV PORT=3000` and `EXPOSE 3000`, and `compose.yaml` maps
   `"127.0.0.1:3000:3000"`. Splitting it this way keeps the decision where the knowledge is: the image
   cannot know who is allowed to reach it, and the file that publishes a port can. What ADR 0007 refused —
   being reachable from the network without anyone choosing that — is still refused, one layer up, by the
   binding to the host's loopback.

4. **The stop path is a listener the server asks for, through an adapter, after the bind.**
   `waitForStopSignal(source, signals)` lives in `src/server/shutdown.ts`; it resolves with the first
   signal name and removes every listener it added. `createProcessSignals()` lives in
   `src/adapters/process-signals.ts`. Two existing gates forced that split rather than one file:
   `no-restricted-globals` (ADR 0007, extended over `src/server` in ADR 0008) means `main.ts` cannot call
   `process.on`, and `nothing-inside-src-imports-the-server` means the adapter cannot import the interface
   it satisfies. So the shape is declared by the consumer, implemented independently by the adapter, and
   checked where they meet — `main.ts` is the only file that knows both. The signal names are spelled in
   both places for the same reason and the duplication is not unchecked, but the check needed one syntactic
   decision: both interfaces declare their members as **properties holding functions**, not as method
   signatures, because TypeScript compares method parameters bivariantly and function-property parameters
   contravariantly (`strictFunctionTypes`, which `strict` turns on). Written as methods, the two interfaces
   would agree no matter what either side listed. Verified by breaking it on purpose — adding `SIGUSR1` to
   `StopSignal` in `src/server/shutdown.ts` alone, with `src/adapters/process-signals.ts` untouched:

   ```
   src/server/main.ts(46,40): error TS2345: Argument of type 'ProcessSignals' is not assignable to
   parameter of type 'SignalSource'.
     Types of property 'on' are incompatible.
       Type '"SIGUSR1"' is not assignable to type '"SIGTERM" | "SIGINT"'.
   ```

   which is the direction that matters: a signal the server asks for and the adapter cannot attach would
   otherwise arrive as a listener nobody ever attached, and the container would ignore the stop request
   that the whole slice exists to answer.

   Registration happens after `listen()` resolves, so a stop request is always a request to stop a server
   that is serving. The consequence — decision 5's fourth row — is that a signal arriving during boot is
   ignored, which is stated rather than papered over.

5. **PID 1 is not a normal citizen of the signal world, and the listener is the only reason the container
   stops.** Four cases, all measured in this repository's own image:

   | what was running | signal | result |
   | --- | --- | --- |
   | `cadence-prod`, listener registered | `docker stop --time 5` (SIGTERM) | `cadence stopping on SIGTERM`, exit **0**, `docker stop` returned in **497 ms** |
   | `cadence-prod`, listener registered | SIGINT via `docker kill --signal` | `cadence stopping on SIGINT`, exit **0** |
   | `node -e "setInterval(() => {}, 1000)"` as PID 1, no listener ever | SIGTERM | **still running** after 2 s |
   | the same script started with `--init`, so Node is a child | SIGTERM | exited **143** |

   The third and fourth rows are the finding: the kernel applies no default disposition to PID 1, so a
   Node process that never installs a `SIGTERM` handler ignores `docker stop` for the entire grace period
   and is then killed. A comment I wrote first said the opposite — that removing the listeners "puts the
   default action back" — and the first row's own container refutes it: after this shutdown path has
   started, a *second* `SIGTERM` is ignored, and the escalation a supervisor reaches for is `SIGKILL` at
   the end of the grace period. `--init` (or `init: true` in compose) is the alternative that restores the
   default disposition; it is not needed here because the handler is doing something strictly better than
   the default — answering the request by draining.

   The listeners are still removed, and that is not tidiness: it is what keeps the second signal from
   starting a second shutdown.

6. **`forceCloseConnections` was measured and not set.** A graceful close can hang on a client that holds
   an idle keep-alive socket, and Fastify has an option for exactly that. It is not set, because on the
   runtime floor this package requires it is already what happens: inside `node:24-bookworm-slim`, a
   `server.close()` with one idle keep-alive socket still counted as live resolved in **0 ms**, with and
   without a preceding `closeIdleConnections()` call. Node has closed idle keep-alives itself since v19 and
   `engines.node` is `>=22.12.0`, so the option would be a second mechanism for something the floor already
   guarantees.

   What stays is the property, pinned by a test (`closing > does not wait for a client that has gone
   quiet`, raced against a 500 ms timer so a regression fails instead of hanging). The property is what the
   stop path depends on and the runtime does not owe us — pinning it is cheaper than discovering it during
   a deploy.

7. **The log line reports what was asked for, not what the framework returned.** Measured in the container,
   before this change: Fastify logged `Server listening at http://127.0.0.1:3000` *and*
   `Server listening at http://172.17.0.2:3000`, while `listen()` resolved to the first — so our line read
   `cadence listening at http://127.0.0.1:3000` about a process serving every interface. A log that names
   the wrong address is the kind that sends someone to the wrong file, so the line is built from the
   settings that were resolved: `cadence listening on 0.0.0.0:3000` in the container,
   `cadence listening on 127.0.0.1:3136` on a laptop started with `PORT=3136 npm start`.

8. **CI now checks the service, in one container.** The step that ran the prod image as a one-shot
   self-check is gone, because that proof moved into the build. What replaced it starts the image once with
   all three hardening flags (`--read-only --cap-drop=ALL --security-opt no-new-privileges:true`), polls
   Docker's health status for the image's own probe, then `docker stop --time 5` and asserts
   `.State.ExitCode = 0`. The exit code is the discriminator: a process that handles `SIGTERM` and closes
   exits 0, one that had to be killed by the grace period exits 137. The same sequence run by hand produced
   the numbers in decision 5, and the engine's own refusal crossed the same socket:

   ```
   POST /boards/bd_core/work-items  {"schedule":{"tz":"Europe/Berlin","dtStart":"2026-03-28T01:30:00.000Z","freq":"DAILY"}}
   -> {"error":{"code":"INVALID_INSTANT","message":"dtStart must be an integer epoch ms, got 2026-03-28T01:30:00.000Z"}}
   ```

   which is ADR 0008 decision 7's field-naming claim, restated over a real port in the image that ships.

## Consequences

- Measured after this change on the host (Node v26.8.2): `193 tests` in `18 files`, `47 files` linted with
  0 errors, 0 dependency violations (`49 modules / 85 dependencies` with `dist` present), coverage
  `99.52` statements / `97.44` branches / `100` functions / `99.52` lines, `13` package checks, tarball
  `98 files`. Inside `cadence-test` on Node 24.21.0 the same set gives the same test, lint, coverage and
  check counts; `49 / 85` after its own build and `52 / 91` before one, which is the `dist`-presence
  mechanism ADR 0006 decision 9a documents and not a platform difference. A clean
  `node:22-bookworm-slim` container with this tree copied in runs `193 tests`, `52 / 91` and `13 of 13`
  checks — CI's `22` leg. `dist` is `96 files` / `124014` bytes of file content in the host tree and the
  same `124014` inside the image; `du -sb` there prints `152686`, which is `124014 + 7 × 4096` — seven
  directory inodes, not extra code.
- `shutdown.ts` is at 100 on all four coverage measures, and `process-signals.ts` joins the adapters that
  are: the directory is `100 / 100 / 100 / 100`. `main.ts` stays the one excluded file and it is now a
  longer file, which is only honest while something else proves that file runs — so the container above is
  not optional evidence.
- **The image stops on request, which is a property it did not have.** Decision 5's third row is the
  counterfactual: without the handler, `docker stop` would have been a ten-second wait followed by
  SIGKILL, and anything holding a lock or mid-write would have learned nothing about why.
- **Compose runs the same path one layer out, and the numbers agree.** With the tracked file's host mapping
  moved to a free port in an untracked second file, `docker compose --profile prod up -d --build prod`
  reached `healthy` 5s after the container started — that is the image's own `--start-period=5s`, not a
  slower boot, which is why CI passes `--health-interval=1s` — then `curl` from the host answered
  `{"ok":true}` and `docker compose stop prod` returned in **635 ms** with exit code **0**. `docker run`
  with all three hardening flags, measured twice on the final tree: `healthy` on the first 1s poll,
  `docker stop --time 5` in **490 ms** and then **555 ms**, exit code **0** both times. Decision 5's
  497 ms was the same command one build earlier; what is stable across the four is the exit code, not the
  milliseconds.
- **In-flight requests are not proven to drain.** `app.close()` is what drains them and the idle-socket
  test is what bounds it, but there is no slow route in this API to have been in flight when the signal
  arrived. Demonstrating that needs either a deliberately slow endpoint or a raw socket test against the
  real server — a slice of its own, not a comment.
- **`/healthz` is a liveness answer, not a readiness one.** It says this process answers HTTP. It does not
  say a store has loaded, a queue is connected or a migration ran, and today there is nothing to load —
  the stores are in-memory and empty until a request fills them. The distinction becomes real the week a
  durable adapter arrives, and `compose.yaml` will need `depends_on: condition: service_healthy` then.
- **The published port widens the reach of "nothing is authenticated".** ADR 0008 could say compose
  publishes no ports; it now publishes `127.0.0.1:3000`, so anyone with a local process on this machine can
  create a board and move an item. Loopback is still not the network, and week 5's member identity is still
  the answer.
- **A stop request during boot is ignored.** Deliberate (decision 4), and the honest shape of it is that
  `listen()` either resolves or the process throws and exits non-zero, so the window is a few milliseconds
  wide and ends in the supervisor's SIGKILL if it is ever hit. `init: true` would close the gap by giving
  the process a disposition to fall back on; it is not added for a window this small.
- The scheduler is still not wired to the API: a work item carries a rule, the routes refuse a bad one, and
  nothing walks the cursor the store holds. `IdGenerator` still has no adapter. Both are unchanged by this
  slice.
