# ADR 0004 — Cancellation is a value, and the clock is an argument

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/scheduler/sleep.ts`, `src/scheduler/run-series.ts`, `src/core/cursor.ts`, `.dependency-cruiser.cjs`

## Context

Everything written so far is synchronous. Recurrence answers "when is the next occurrence" and
nothing in the package has ever had to *wait* for one. Waiting is where the design gets expensive
to reverse: it drags in a timer, a clock, a cancellation mechanism, and a decision about what
happens to a series that was half-delivered when the process was told to stop. An HTTP handler
(week 4) and a queue worker (week 12) will both have to answer that question, and they answer it
differently — one returns a status, the other decides retry-or-die.

Two idioms were on the table. Cancel as an exception (`throw` on abort, callers `catch`), which is
what `setTimeout`-based helpers and most Promise utilities do. Or cancel as an outcome: the run
returns, and the return value says why it stopped.

## Decision

1. **The wait and the clock are arguments, not globals.**
   `runSeries(cursor, { clock, sleep, notify, signal, limit })`. The loop never calls
   `Date.now()` and never reaches for a timer it was not given, so a test decides exactly what
   "now" is and how long a wait takes. `sleep` is the one module that does touch the host timer,
   and it is behind the `SleepFn` signature so it can be replaced by the caller too.

2. **Layering keeps `scheduler` out of the reusable core.** Two dependency-cruiser rules were
   added: `scheduler-is-pure` (no `npm`/`core` imports under `src/scheduler`) and
   `core-and-domain-do-not-know-scheduler`. A gate that has never failed proves nothing, so both
   were fired on a throwaway copy of the tree:

   ```
   error scheduler-is-pure:                        src/scheduler/probe.ts  -> node:path
   error core-and-domain-do-not-know-scheduler:    src/core/probe.ts       -> src/scheduler/index.ts
   error core-and-domain-do-not-know-scheduler:    src/domain/probe.ts     -> src/scheduler/index.ts
   x 3 dependency violations (3 errors, 0 warnings)
   ```

   The probe tree was deleted; the real one reports no violations, on the host and in the image.
   What is asserted is the zero, not the module count: the same cruise prints 28 modules / 44
   dependencies on the host and 31 / 47 inside the image, while the two trees hold the identical
   24 source files (checked by listing both). The count is environment-dependent, so it goes in
   neither the README nor this document as a target. Note what the rule does *not* catch:
   `sleep.ts` uses the global `setTimeout`, and a global is invisible to an import graph. That
   purity is a review convention; the enforced part is that no module in `src/core` or
   `src/domain` can pull the async machinery in, so the recurrence engine stays loadable in a
   worker that has no timers.

3. **Aborting is a normal ending.** `RunSummary.endedBy` is `'aborted' | 'limit' | 'series-end'`
   and a signal that is already aborted when the run starts returns
   `{ delivered: 0, late: 0, endedBy: 'aborted' }` having called `sleep` zero times, called
   `notify` zero times, and left `cursor.consumed()` at `0`. Nothing was lost, so nothing threw.

4. **The signal, not the rejection, decides what a failed wait means.** The loop catches, then
   asks `signal?.aborted`: if the signal fired the run ends cleanly, otherwise the error is
   someone else's bug and is re-thrown untouched.

   ```ts
   catch (error) {
     if (!signal?.aborted) throw error;
     return { delivered, late, endedBy: 'aborted' };
   }
   ```

   Both arms are tested: a wait that rejects while the signal is aborted ends the run with a
   summary, and a rejection with no abort in flight propagates with its `UNEXPECTED` code intact.
   A caller's abort reason must not be able to impersonate a crash, and a real crash must not be
   swallowed as a shutdown.

5. **A cancelled wait leaves its occurrence on the cursor.** This is why the cursor has `peek`
   separate from `next` (ADR-adjacent, but the seam earns its keep here): `runSeries` waits on
   `peek()` and only calls `next()` once the wait has completed. Measured: a run that delivers
   occurrence `0` and is aborted during the wait for `1` reports `delivered: 1` and
   `consumed(): 1`; a second run on the *same* cursor then waits one day and delivers occurrence
   `1`. An abort is resumable, which is the property a queue worker needs after a redeploy.

6. **Consume before notify.** `cursor.next()` and `delivered += 1` happen *before* `await
   notify(...)`, so a notifier that throws leaves the occurrence consumed and the error
   propagating (`rejects.toBe(boom)`, `consumed(): 1`). Delivery is at-most-once by default.
   Retrying a notification is a policy decision about the outside world and belongs to the
   adapter that talks to it, not to a loop that knows only instants.

7. **`AbortSignal.reason` is preserved as `cause`.** `sleep(60_000, signal)` aborted with
   `'stop'` rejects with `code: 'ABORTED'` and `cause === 'stop'`; aborted with no reason, the
   cause is the platform's `AbortError` (`cause.name === 'AbortError'`). `AbortSignal.reason` is
   typed `any`, so it is carried as `cause` — the standard `Error` field (ADR 0002) rather than a
   bespoke one — and `reasonOf` exists to keep that `any` from leaking into the public signature.

8. **Sub-second lead times do not exist, so a scheduler must not promise them.** ADR 0001 fixed
   occurrences to second resolution, and the effect on a real wait is immediate. Measured against
   the built package, with `base` = 09:00:00.000Z:

   ```
   dtStart +   20ms -> occurrence at 09:00:00.000Z
   dtStart +  987ms -> occurrence at 09:00:00.000Z
   dtStart + 1500ms -> occurrence at 09:00:01.000Z
   ```

   The milliseconds are floored, not rounded and not rejected. A first attempt at the
   real-timer test used a 20 ms lead, and `runSeries` reported `delivered: 1`: the lead had
   become zero and the occurrence was immediately due. `test/recurrence.test.ts` now pins the
   flooring, and the integration test uses a one-second lead.

9. **A wait longer than a host timer is split, not clamped.** `setTimeout` only honours delays
   up to `2 ** 31 - 1` ms (~24.85 days). Above that it does not throw: it sets the delay to
   **1 ms** and emits a `TimeoutOverflowWarning`. Measured against the first version of `sleep`:

   ```
   sleep(2 ** 31)          -> settled within a 10 ms poll   (the delay became 1 ms)
   slices(2 ** 31)         -> [2147483647, 1]               (sums back to 2147483648)
   slices(30 * 86_400_000) -> [2147483647, 444516353]
   ```

   This is not a corner case — a `MONTHLY` rule with the default interval is 28-31 days out, so
   *every* monthly occurrence sits past the ceiling. It surfaced while drafting a README example
   for an occurrence a month away: `runSeries` delivered it on the spot. `sleep` now waits in
   slices of at most the ceiling, and `test/run-series.test.ts` has a month-ahead run that must
   still be waiting when the abort arrives.

   The split is a separate exported function, `slices`, so the arithmetic that decides whether a
   wait is honoured is testable without waiting 25 days for it. `slices` is deliberately **not**
   re-exported from `cadence/scheduler` — `test/public-api.test.ts` pins that barrel to exactly
   `runSeries` and `sleep`, so an internal helper cannot quietly become API.

## Consequences

- 23 async tests (`test/sleep.test.ts` 12, `test/run-series.test.ts` 11) run without a single
  fake timer, and the whole suite of 97 tests finishes in ~1.3 s. The only real time the suite
  spends waiting is a 20 ms sleep, two 5 ms sleeps, a 10 ms poll, and two long waits — one second
  and thirty days — that are both cut short by an abort after 5 ms.
- `src/scheduler` is at 100% of all four coverage metrics; the package sits at 99.16% statements
  / 95.32% branches / 100% functions.
- Timer hygiene is asserted, not assumed: `process.getActiveResourcesInfo()` is counted before
  and after, so a forgotten `clearTimeout` on the abort path would fail the test rather than
  quietly keep a Node process alive. The same pair of checks also proves a wait that *completes*
  takes its listener back off the signal.
- `endedBy` is a three-valued union, so a dashboard reading it must not treat `'aborted'` as a
  failure. Anything that alerts on it will alert on every graceful shutdown.
- A caller can inject a `SleepFn` that does not wait at all, which makes `runSeries` fully
  deterministic in tests — and equally means nothing in the layer stops someone from injecting a
  sleep that lies about how long it waited. The signature is a contract, not a guarantee. Two
  tests run the *shipped* `sleep` through `runSeries` rather than a double, so the pair is proved
  to agree and not merely to be self-consistent.
- A wait is now several timers, so an abort can land between two slices and still be observed on
  the next loop guard. Nothing promises the wait is a single atomic timer; callers must not build
  on that.
- `notify` is still just a callback. `ScheduleNotifier` in `src/domain/ports.ts` has no
  implementation yet: wiring `runSeries` to a `WorkItem` and a real transport is week 4's work,
  and it will need to decide what a `null` board load means.
- `sleep` and `runSeries` are exported from `cadence/scheduler`, so both are public API. Changing
  the abort semantics or the `RunSummary` shape is a breaking change, not an internal refactor.
  `slices` deliberately is not in that barrel.
