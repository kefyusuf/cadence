# ADR 0010 — A stream pulls exactly what its consumer asks for, unless somebody flows it

Status: accepted
Date: 2026-10-14
Deciders: Yusuf Kef
Technical context: `src/core/recurrence.ts` (the lazy `occurrences()` walk), `src/core/cursor.ts`
(`createSeriesCursor`), `test/stream-semantics.test.ts` (new, 20 tests), week 5's slice-2 plan
(`GET /boards/:id/export` as NDJSON)

## Context

ADR 0009 closed with two things still unwired: the scheduler never walks a stored cursor, and the API has
no route that produces more rows than a request contains. The next slice is the second of those — a board
exported as NDJSON, one row per occurrence of every work item's rule — and it is the first place the
engine's laziness meets a consumer that can stop, fail or go slow.

That is a question this repository has never measured. `occurrences()` is a generator and
`createSeriesCursor` walks it one step at a time, so "it is lazy" is a claim about the engine. It is not a
claim about a stream wrapped around the engine: a `Readable` has a buffer, a flow mode and a destroy path,
and each of those decides how much of an *unbounded* rule actually runs. The whole point of a recurring
schedule is that it does not end — `DAILY` with no `count` yields occurrences until the engine's own
candidate guard stops it — so the difference between "lazy" and "pulls exactly what was asked for" is the
difference between an export endpoint and a stalled process.

Two of the intuitions I brought to this were wrong, and both were corrected by the probe rather than by
argument. The measurement harness is small enough to reproduce, so it is printed here rather than kept as
a file that would need its own lint globals:

```js
const source = occurrences(rule)[Symbol.iterator]();
let steps = 0;
let returnedAt = null;
function* walk() {
  try {
    for (;;) {
      const { done } = source.next();      // steps counts ENGINE work, not buffered chunks
      steps += 1;
      if (done) return;
      yield { i: steps };
    }
  } finally { returnedAt = steps; }
}
const stream = Readable.from({ [Symbol.iterator]: walk }, { objectMode: true, highWaterMark: 2 });
```

Everything below is that wrapper plus one question per numbered decision. Run twice on the host
(Node v26.8.2) and once inside `cadence-test` (Node 24.21.0); where a number moved between runs the range
is printed, because it did.

## Decision

1. **A stream does not touch the engine until someone asks, and then it asks for `highWaterMark`.**
   Constructed and left alone for 120 ms: `steps=0`, buffer empty. One `read()` after that pulls exactly
   the buffer's size and hands back one of them:

   | highWaterMark | engine steps after `read()` | still buffered | after one tick |
   | --- | --- | --- | --- |
   | 1 | 1 | 0 | 2 steps, 1 buffered |
   | 2 | 2 | 1 | 3 steps, 2 buffered |
   | 16 | 16 | 15 | 17 steps, 16 buffered |
   | 64 | 64 | 63 | 65 steps, 64 buffered |

   so the honest description of "lazy behind a `Readable`" is *pulls one buffer's worth, refills one row at
   a time*. `highWaterMark` is the only knob, and in object mode it is a memory bound expressed in rows.

2. **`Readable.from`'s defaults are not `Readable`'s defaults, and they are the same on every runtime we
   support.** `Readable.from(iterable)` reports `readableObjectMode=true` and
   `readableHighWaterMark=1` — not `false`/`16384`, and not `true`/`16`, which is what
   `new Readable({objectMode: true})` gives you. Measured identically on host v26.8.2 and in
   `node:22.23.3`, `node:24.21.0`, `node:26.11.1`. The byte-mode *generic* default is not stable across
   those runtimes: `new Readable().readableHighWaterMark` is `65536` in all three images and `16384` on
   the host's v26.8.2, and `stream.getDefaultHighWaterMark()` agrees with each. So the route states its
   mode and its `highWaterMark` in the call, and nothing downstream reasons about defaults. The object-mode
   half of this is pinned by a test — `Readable.from` reports `readableObjectMode` true and a
   `highWaterMark` of 1 where `new Readable({objectMode: true})` reports 16. The byte half deliberately is
   not: pinning 65536 would make the suite wrong on the host and pinning 16384 would make it wrong in every
   image, which is exactly the trap the route is written to avoid.

3. **Flowing mode over an unbounded rule is an event-loop incident, and the engine's guard is what ends
   it.** One `stream.resume()` on `DAILY` with no `count`, object mode, default `highWaterMark`:

   ```
   steps@20ms=200000  steps@80ms=200000  ms=4614.5
   1ms-interval fired 6x during the pull
   marks=[setImmediate steps=200000 | timeout0 steps=200000]
   errors=[SEARCH_EXHAUSTED:Gave up after 200000 candidate occurrences]
   ```

   200000 candidate occurrences is `MAX_CANDIDATES` in `recurrence.ts` — for a daily rule, roughly 547
   years — and it arrived as the stream's `error` event, not as a hang: the walk ran to the guard and
   stopped there. The host number is the second of two runs of the identical script; the first took 4379 ms,
   which is why the ranges below are quoted at all. Inside `cadence-test` the same script: `ms=4360.8`,
   `1ms-interval fired 57x`. A 1 ms
   timer that should have fired about 4500 times fired 6 (host) and 57 (image) because the pull did not
   yield to the timer phase; `setImmediate` and `setTimeout(0)` were both scheduled before the pull and
   both saw the *finished* count. So the intuition "a stream is automatically polite to the loop" is the
   wrong one: politeness comes from the consumer pulling, not from the stream.
   This is why the export route cannot be `Readable.from(unboundedSeries).pipe(reply)` and why no test in
   the suite runs this shape: the bounded version of the same behaviour is pinned instead (50 rows drained
   before the next tick, `read()` returning `null` while flowing).

4. **A rule shorter than the buffer is materialised in full by the first read — and its end is discovered
   one step later.** `count=15` behind `highWaterMark=16`: 16 steps, 14 buffered, `done@16` and the
   generator's `finally` already reached, all from one `read()`. `count=3` gives 4 steps (three rows plus
   the step that discovers the end). `count=40` behind hwm 16 behaves like any longer series: 16 steps and
   15 buffered at the read, 17 and 16 after a tick. Two things follow for the route. A rule shorter than
   the buffer is generated entirely the moment anyone asks for a row, so "we are streaming it" is not the
   same as "at most a few rows exist" — for a 15-row rule it means all 15 are in the process's memory while
   the consumer has received one. And in object mode the buffer counts rows, so a board whose items each
   produce three rows will have a buffer spanning several items: rows generated is always ahead of rows
   sent, by at most `highWaterMark`, and any progress report has to say which of the two it means.

5. **Destroying the stream closes the walk within one buffer of read-ahead, and a stream nobody read has
   nothing to close.** Three teardown paths, each after the consumer had taken three rows at hwm 2:

   | what the consumer did | engine steps at teardown | generator `finally` reached | what the stream emitted |
   | --- | --- | --- | --- |
   | `stream.destroy()` | 5 | yes, at 5 | `close` |
   | `stream.destroy(err)` | 5 | yes, at 5 | `error`, then `close` |
   | `break` out of `for await` | 4 | yes, at 4 | `error` (`ABORT_ERR`) on the next tick, then `close` |
   | consumer throws inside `for await` | 4 | yes, at 4 | the caller's own message, plus `ABORT_ERR` and `close` |
   | never read, then `destroy()` | 0 | **no** | `close` |

   Every path that started the walk closed it, and none kept running afterwards (steps frozen 60 ms later).
   Two details are the ones that matter for a route. The last row: a generator that never started has no
   `finally` to reach, so "release the cursor on destroy" is only a statement about streams that were
   already pulling. And the `break` row: the `ABORT_ERR` is emitted *asynchronously* — asserted empty
   immediately after the loop and `['ABORT_ERR']` after one tick — so a disconnect handler that expects to
   see the failure synchronously will have already returned.

6. **`destroy()` stops the walk; it does not recall what the buffer already holds.** After abort-and-destroy
   with two rows taken, one buffered row was still handed out and then `read()` returned `null`. For an
   HTTP body this is the difference between a truncated response and a rewound one, and nothing rewinds a
   flushed socket, so the route's contract has to be "the body ends where the connection ended".

7. **An `AbortSignal` does nothing at all until it is wired, and there is no built-in helper to wire it
   with.** The same stream, same abort:

   | wiring | `stream.destroyed` after abort | walk keeps going | rows still served | event order |
   | --- | --- | --- | --- | --- |
   | nothing attached | `false` | yes (3 → 4 steps) | yes | only the signal's own listener |
   | listener calls `destroy()` | `true` | no, frozen at the abort count | at most the buffered row | `abort-listener` then `close` |

   `typeof stream.destroyOnAbort` is `undefined` on host v26.8.2 and inside `node:22.23.3`, `node:24.21.0`
   and `node:26.11.1`, and `Readable.from` takes no `signal` option — the helper I expected to use does not
   exist on this package's supported range. So the route writes the three lines itself. (Whether an
   unwired-but-`break`en iterator's error can crash a process was measured as *no*: with no `error`
   listener attached, a `break` produced neither an `uncaughtException` nor an `unhandledRejection` on the
   host — Node's own async iterator handles the error it caused.)

8. **A cursor in `_read` consumes exactly what it pushes.** Wiring `cursor.next()` to the stream's `read`
   at hwm 3: three reads gave 3 `next()` calls, a tick later 6 calls, 6 pushes and `cursor.consumed()` 6
   with 3 rows buffered. `consumed() === pushed` is the property that makes the export honest — the
   cursor's one-row peek buffer is invisible from outside, and a stream that reports "N rows sent" can
   claim exactly what the engine advanced. This is the shape the route will use rather than
   `Readable.from(series)`, because it also keeps the cursor the single place the series position lives
   (ADR 0002's lazy walk, ADR 0004's consume-before-notify).

9. **Byte mode is a different unit and a different failure.** Pushing occurrence *objects* into a
   `{objectMode: false}` stream is not silent: the walk took **1** step and the stream emitted
   `ERR_INVALID_ARG_TYPE` — one object, one rejection, no buffering, no partial state. Pushing NDJSON
   *strings* accepts them and changes the unit of `highWaterMark` from rows to bytes: with rows of ~33
   bytes and `highWaterMark: 4096`, one `read()` had pulled 124 steps and 4076 bytes were still buffered
   (host v26.8.2); with the default `Readable.from` hwm of 1 byte, flowing drained all 4000 rows
   (138893 bytes) in under 10 ms with nothing ever buffered. And what `read()` returns in byte mode is
   runtime-dependent: v26.8.2 handed back a single 32-byte row and kept the rest, `node:24.21.0` handed
   back the whole 4 KiB buffer and kept none — which is why the pinned test asserts on the total pulled
   rather than on the shape of one call.

10. **Backpressure works when it is honoured, and ignoring it buys only memory.** Piped into a sink that
    takes 40 ms per chunk at hwm 2, after 850 ms: 19 rows written, 22 engine steps, 2 rows buffered,
    `readableFlowing=false` and 9 `drain` events — the walk stayed one buffer ahead of the slow sink
    (inside the image the same shape gave 22 written / 24 steps). Separately, 2000 rows pushed into a
    sink whose `write()` returns `false`:

    | | rows the sink held at its peak | writes that returned `false` | wall time |
    | --- | --- | --- | --- |
    | ignoring the return | 2000 | 1985 | 6 ms |
    | waiting for `drain` | 15 | 125 | 4 ms |

    Same rows, same sink, and the undisciplined version was not faster — it moved 2000 rows into Node's
    buffer instead of leaving them in the generator, where they cost nothing. That is the whole argument
    for a route that checks `write()`'s return instead of looping over the series. The `125` replaced a `0`
    this table first carried: the probe's counter was sampled on a branch the loop never reaches, and the
    re-measurement now pinned by a test counts 125 refusals out of 2000 writes against a sink that defers
    its callback with `setImmediate` — that pinned loop reproduces `writableLength` 2000 after the
    undisciplined pass and a peak of 15 once it waits for `drain`.

11. **A consumer that works between rows leaves the loop free.** `for await` over hwm 2 with a 50 ms wait
    after each row: steps advanced 2, 4, 5, 6 for rows 1–4 and a 10 ms interval fired 0, 3, 7, 11 times by
    those points (0, 5, 10, 15 inside the image) — one row of engine work per turn of the consumer, timers
    running the whole time. The contrast is decision 3: the same generator, the same wrapper, and the only
    difference is who is asking. Re-measured with a 40 ms wait and pinned as a test on the host: 3 steps and
    2 interval fires after row 1, 4 steps and 5 fires after row 2. The assertions that test makes are floors
    and ceilings only — steps at most three ahead of the rows the consumer has taken, at least two timer
    fires across the ~80 ms it spends waiting — because a test asserting the rate would be a slower version
    of decision 3's incident rather than a pin.

## Consequences

- **The route's shape is decided by these numbers, before it is written**: demand-driven `_read` over a
  cursor (decision 8), object mode with an explicit `highWaterMark` (decision 2), a bound on how many
  occurrences per item taken from the request rather than assumed (decision 3's 200000), `destroy()` wired
  to the request's close/abort (decision 7), and `write()`'s return value honoured (decision 10). Slicing
  the route any other way would re-introduce a number measured here.
- **`test/stream-semantics.test.ts` is the durable form of the probe.** 20 tests, all bounded: they count
  engine steps and event order, and the waits are loop-turn barriers rather than measurements, so none of
  them asserts how long the engine takes. They ran green on host v26.8.2, inside `cadence-test` on 24.21.0,
  and in a clean `node:22-bookworm-slim` container built for the purpose (20/20 there too). Four things the
  review of this slice caught and fixed before it was committed. The slow-sink test originally slept 30 ms
  and asserted `written < 20`: on a machine whose timers fire early that is a real failure, so it now stops
  when the third row reaches the sink and asserts the read-ahead there (measured: 5 engine steps, 2 rows
  buffered, `written + 3` as the bound) instead of a count reached after a wall clock. `destroy(err)` —
  decision 5's second row — was in the README's enumeration of what the tests pin without being a test; it
  is now, and it pins the order too (`STORE_CLOSED`, then `close`). Decisions 2, 10 and 11 had no pin at
  all, so each has one now: the object-mode defaults, the two `write()`-return loops, and the yielding
  consumer, while the byte-mode default stays unpinned on purpose (decision 2) and `MAX_CANDIDATES` is still
  burned only by the probe (decision 3). And the README's claim that the tests pin `destroyOnAbort` being
  `undefined` was wrong — no test asserts an absence of a property the route does not use; that fact lives
  in decision 7 with the four runtimes it was checked on, and what the suite pins is the behaviour: an
  unwired signal changes nothing, a wired one closes the walk.
  One expectation was rewritten rather than relaxed by the runtime matrix: the byte-mode test asserted on
  `readableLength`, which is 4076 on v26.8.2 and 0 on 24.21.0 because `read()` returns the whole buffer
  there — decision 9. `ABORT_ERR` (decision 5) held on all three.
- **Measured on the final tree, and re-measured after every README edit, because the README ships in the
  tarball**: host — `213 tests` in `19 files`, `48 files` linted with 0 errors and 0 warnings, 0 dependency
  violations (`52 modules / 89 dependencies` with `dist` present, `55 / 95` with it moved away), coverage
  `99.52` statements / `97.45` branches / `100` functions / `99.52` lines, `13` package checks, exports
  `7` targets, tarball `98 files / 44060` bytes. Inside `cadence-test` (Node 24.21.0): the same
  `213 tests`, the same `48 / 0 / 0` lint line, the same coverage line to the last digit, `13` checks,
  `55 / 95` before its own build, tarball `98 files / 44072` bytes. In a clean `node:22-bookworm-slim`
  container built from this tree (`v22.23.3`): `213 tests` in `19 files`, `55 / 95`, `13` checks, the same
  coverage line. Across the four pairs taken while this slice was written the two tarballs came out 12, 10,
  11 and 12 bytes apart on a file list identical at `98` — so that difference is the compressor, not the
  entries, which is why the honest half of the number is the file count. The module counts depend on `dist`
  exactly as ADR 0006 decision 9a says, and the pair moved by one when the new test file gained its
  `node:events` import.
- **Nothing about the engine changed.** `occurrences()` and `createSeriesCursor` were already lazy; this
  slice measured what a `Readable` does *around* them, which is why the diff is one test file, one ADR and
  the README's numbers.
- **Not measured, and deliberately not claimed**: what Fastify's `reply` does with a stream when the client
  disappears mid-body — this probe used raw `Readable`s and no socket. That is the next slice's measurement,
  and decision 6 ("the body ends where the connection ended") is a claim about Node's buffer, not about a
  response this repository has sent. Also unmeasured: a durable store behind the same `_read`, where
  `highWaterMark` becomes a concurrency question rather than a memory one (week 11).
- **The engine's `SEARCH_EXHAUSTED` guard is now load-bearing in a way it was not before.** Decision 3 is
  the first time it was reached by accident rather than by a test that wanted it: a `resume()` on an
  unbounded daily rule walks 547 years and stops there. An API that streams must not be able to reach it,
  because its error text describes a search, not a limit the caller was given.
