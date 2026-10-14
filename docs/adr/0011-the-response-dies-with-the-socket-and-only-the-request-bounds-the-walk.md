# ADR 0011 — The response dies with the socket, and only the request bounds the walk

Status: accepted
Date: 2026-10-14
Deciders: Yusuf Kef
Technical context: `src/server/export-stream.ts` (new), `src/server/create-app.ts` (the `GET /boards/:id/export`
route), `src/server/requests.ts` (`readOccurrenceBound`), `test/export-stream.test.ts` (new, 13 tests),
`test/export-route.test.ts` (new, 17 tests), [ADR 0010](0010-a-stream-pulls-exactly-what-its-consumer-asks-for-unless-somebody-flows-it.md)
(the probe this route was built against)

## Context

ADR 0010 ended by naming the one thing it had not measured: "what Fastify's `reply` does with a stream when
the client disappears mid-body — this probe used raw `Readable`s and no socket." That route is now written,
so the sentence had to be paid for. It is the first body this repository sends that is bigger than the
response that carries it: a board of 40 items with a daily rule, at the door's maximum bound, is 40041 rows.

The plan I went in with came straight out of ADR 0010's consequences: demand-driven `_read`, object mode
with a named `highWaterMark`, a per-item bound from the query, **`destroy()` wired to the request's close**,
and `write()`'s return honoured. Three of those five survived. The wiring did not, and neither did the
`write()` check, because with `reply.send(stream)` nobody in this repository calls `write()` — and the reason
each one fell out is a measurement rather than an argument.

Everything below was taken against the built `dist` over a real socket — `createApp(...).listen()` on an
ephemeral 127.0.0.1 port, `node:http` clients that either read to the end or destroy themselves mid-body —
with three throwaway scripts that are deliberately not committed (a `.mjs` at the repo root would need its own
lint globals, and nothing here is a regression test). The part that decided the shape is this:

```js
// the route's own body, with the counters the route cannot expose over HTTP
app.get('/instrumented', async (request, reply) => {
  const walk = createExportStream(await stores.workItems.listForBoard('bd_core'), { occurrences: 200 });
  seen = walk;
  reply.header('content-type', 'application/x-ndjson; charset=utf-8');
  return reply.send(walk.stream);
});

// a client that leaves 2 KB in
response.on('data', (chunk) => { bytes += chunk.length; if (bytes >= 2000) req.destroy(); });
```

`pulls()` is `cursor.next()` calls — engine work — and `rows()` is what the stream was handed. Those two
counters are the whole point of instrumenting: over HTTP you can see bytes, and bytes do not tell you how
much of an unbounded rule ran to produce them. Run on the host (Node v26.8.2, Windows) and inside
`cadence-test` (Node 24.21.0, Linux); the byte figures matched to the digit across both and the counts of
engine work did not, which is the finding rather than a nuisance.

## Decision

1. **Fastify destroys the source when the socket closes, so the route writes no disconnect handler.** The
   instrumented walk, abandoned by the client at 2026 bytes:

   | | host v26.8.2 | image 24.21.0 |
   | --- | --- | --- |
   | server-side events after the leave | `raw close@107ms`, `stream close@107ms` | `raw close@118ms`, `stream close@119ms` |
   | `stream.destroyed` / `readable` / `readableEnded` | `true` / `false` / `false` | same |
   | pulls at the leave, then at +0 / +20 / +100 / +400 / +1200 / +3000 ms | 1708 → 1802, 1802, 1802, 1802, 1802, 1802 | 4132 → 4132 at every mark |

   `close` and `destroy` land in the same millisecond (`raw close` and `stream close` were 47/47 ms and
   107/107 ms into two host runs, 102/102 and 118/119 in the image), `reply finish` never fires (the body did
   not complete), and the walk does not resume. The buffer sweep in decision 2 ran the same abandoned walk
   through a separate script and froze its hwm-8 case at 1294 instead of 1802 — the pull count at the instant
   of leaving is a race with the socket, and the freeze is not. A `request.raw.on('close', () =>
   stream.destroy())` in the route would be a second owner of a lifecycle Fastify already owns, and a handler
   that fires after the framework's own has nothing left to stop. The comment in `create-app.ts` says this,
   because the absence looks like an omission.

2. **`highWaterMark` does not bound the engine work; the query does.** Same body, same client that reads
   2087 bytes and leaves, four buffer sizes — and the sweep's numbers came out identical in both runs on both
   environments, which is why they are printed as single figures while decision 1's race is not:

   | `highWaterMark` | pulls at the leave (host) | pulls at the leave (image) | frozen at (host / image) |
   | --- | --- | --- | --- |
   | 1 | 1188 | 3930 | 1287 / 4322 |
   | 8 — what the route uses | 1195 | 3937 | 1294 / 4329 |
   | 64 | 1250 | 3993 | 1350 / 4385 |
   | 1024 | 2205 | 4948 | 2305 / 5340 |

   At hwm 1 — one row of buffer — the engine had already taken **1188 steps** for a body whose first 2 KB the
   client read and the rest nobody wanted. A row of a hundred and fifty-odd bytes goes into the
   socket queue and Node accepts it; the stream's own buffer is emptied into that queue as fast as `_read` can
   fill it, so what limits the walk is the socket's appetite (≈1200 rows here, ≈3900 there — a per-platform
   number, not a property of this code), and `highWaterMark` only adds to it once it is *bigger* than that.
   The honest reading of decision 8 of ADR 0010 ("a cursor in `_read` consumes exactly what it pushes") is
   therefore narrower than it sounded: it is true of the stream, and the stream is not the last consumer.
   The only thing in this route that bounds work is `?occurrences=`, and that is why the door refuses before
   a cursor exists.

3. **The bound is validated at the door, in the same place every other refusal happens.** `occurrences` is
   read by `readOccurrenceBound` in `requests.ts`: absent → 20, non-negative-integer text → the number,
   anything else → 400 `INVALID_OCCURRENCES`, above 1000 → 400 naming the ceiling. `1001` was measured
   against the built tree: `{"error":{"code":"INVALID_OCCURRENCES","message":"occurrences must be at most
   1000, got 1001"}}` with no row written and no cursor built. `DEFAULT_OCCURRENCES` and `MAX_OCCURRENCES`
   moved out of the stream module and into `requests.ts` for that reason — ADR 0008's rule is that the door
   owns what a caller may ask for, and a stream that quietly re-derives a limit is a second authority.
   Duplicate keys (`?occurrences=1&occurrences=2`) arrive as an array at runtime whatever the route's generic
   says, so `readOccurrenceBound` takes `unknown` and refuses it rather than picking one silently. And the
   refusal precedes the store read: `?occurrences=1001` on a board nobody stored is a 400, not a 404, because
   the request is refused at the door before the process looks anything up — pinned by a test, because the
   precedence is an observable part of the contract.

4. **A row is a string, and its size is the same on every runtime.** For the board the README posts (the
   `wi_deploy` item, `Europe/Berlin`, `occurrences=3`), the whole body is 751 bytes and every line is:

   ```
   198B  {"kind":"item","id":"wi_deploy","title":"Deploy the release","status":"backlog",…,"schedule":{"tz":"Europe/Berlin","dtStart":1774661400000,"freq":"DAILY"}}
   162B  {"kind":"occurrence","itemId":"wi_deploy","index":0,…,"at":"2026-03-28T01:30:00.000Z","wall":"2026-03-28T02:30:00","disambiguation":"exact"}
   173B  {"kind":"occurrence","itemId":"wi_deploy","index":1,…,"at":"2026-03-29T01:00:00.000Z","wall":"2026-03-29T02:30:00","disambiguation":"gap-roll-forward"}
   162B  {"kind":"occurrence","itemId":"wi_deploy","index":2,…,"at":"2026-03-30T00:30:00.000Z","wall":"2026-03-30T02:30:00","disambiguation":"exact"}
    51B  {"kind":"done","items":1,"occurrences":3,"bound":3}
   ```

   150.2 bytes per row on average — `746` of JSON plus one newline per row — and identical in the host and the
   image run to the byte, because the unit is a JSON string and not a buffer anyone has to encode. That is the
   payoff of ADR 0010 decision 9: rows are objects in the code and strings in the stream, so `highWaterMark`
   counts rows and the byte question never reaches this file. The occurrence row carries both clocks —
   `instant` and `at` for the instant, `wall` and `disambiguation` for what the rule asked — because the third
   line above is the reason the export exists: a reader with no engine in front of them cannot otherwise tell
   that 02:30 in Berlin happened at 01:00Z. The measurement script's own fixture (40 items titled `Item 0`)
   gives `188/166/177/166/51` and a 753-byte body on the same three rows — the shape is stable, the ids and
   titles are what move.

5. **A streamed body cannot announce its own truncation, so the last row does.** The body ends with
   `{"kind":"done","items":…,"occurrences":…,"bound":…}`, and a reader that never sees it has a partial
   export. Measured why nothing else can carry that: an abandoned client gets `ECONNRESET` (host and image,
   both runs) with the status it was already given — `200` — and a walk that refuses mid-body gets the same
   `ECONNRESET`. On the wire those are one event. `transfer-encoding: chunked` with no `content-length`
   (measured: `content-length` absent on every response) means there is no declared size to compare against
   either, and the server's own lifecycle gives nothing back either: for the abandoned body, the only events
   that had fired three seconds later were `raw close` and `stream close` — no `reply finish`, no
   `stream end`, no `onResponse`. So completeness is in band or it is nowhere: the `done` row is the only
   signal a `curl | jq` user can act on, and the counters it carries (`items`, `occurrences`) are the
   engine's, not a byte count.

6. **A mid-body failure keeps the status it already sent and arrives as a reset.** The cheapest deterministic
   way to make the engine refuse while a body is open is a rule the engine can start and cannot follow:
   `YEARLY` anchored at `9999-12-31T09:00Z` Europe/Berlin, which yields one occurrence and then hits
   `produced === 0 && period > 4000` in `recurrence.ts`. Over the socket, `occurrences=10`:

   ```
   status=200  error=ECONNRESET  ms=3.36, 2.88 and 2.61 (host) / 2.59, 2.56 (image)
   body lines: the item row, then index 0 — and no done row
   server-side order: stream error → stream close → raw close   (all within 2–3ms)
   ```

   The two rows that were flushed stay delivered; the refusal cannot become a 500 because the status line
   went out with the first chunk. Throwing out of `_read` and calling `this.destroy(err)` measured
   identical here — buffered rows first, then the error — which is why the route does neither explicitly:
   the walk's own `CadenceError` is allowed to leave `nextRow()` and the stream machinery handles it. A
   separate probe confirmed the order on all four combinations of throw-versus-destroy cross
   `for await`-versus-`read`.

7. **Both abandoned shapes leave a working server.** After the client that left 2 KB into a 1.35 MB body, and
   after the walk that threw at 2 ms, `GET /healthz` answered `200 {"ok":true}` on both runtimes, and the
   instrumented stream was `destroyed=true`. The pin for this is in the route test rather than in prose,
   because a route that dies with its abandoned request is a leak someone else will pay for.

8. **The order of the two completion events is not something to lean on.** For the 5-row body both
   environments printed `stream end → reply finish → stream close → raw close`, all inside 3–5 ms. For the
   8041-row body the host printed `stream end → stream close → reply finish → raw close` in both of its runs
   while the image kept `reply finish` before `stream close` in both of its own — and every one of those four
   events landed in the same millisecond. What *is* stable is that `stream end` comes first when the body
   completes, and that an abandoned body produces neither `end` nor `finish` at all (decision 1). The tests
   therefore assert the events that exist and their presence, never a position in that list.

9. **What the route costs when it is not abandoned.** Bodies read to the end. The first row is the README's
   one-item board, run against the fixture script; the other two are `40` daily items from the measurement
   script, two runs on the host and two inside the image at the time of writing and a third host run after the
   documents were finished — different fixtures, so different bytes per row:

   | bound | items | rows | bytes | host v26.8.2 | image 24.21.0 |
   | --- | --- | --- | --- | --- | --- |
   | 3 (the README's board) | 1 | 5 | 751 | 1.79, 1.33 ms | 4.01, 1.31 ms |
   | 200 | 40 | 8041 | 1353678 | 218.52, 219.34, 275.5 ms | 231.17, 229.32 ms |
   | 1000 (the ceiling) | 40 | 40041 | 6755640 | 1042.83, 1045.74, 1753.4 ms | 1036.13, 1056.8 ms |

   The bytes are identical across environments, across runs and down to the row (decision 4), and the
   milliseconds are not identical on the host, which is why the range is printed rather than the prettier
   half — ADR 0010 set that precedent for the same reason. Nothing in the suite asserts about them.
   Client-side framing was 8059 chunks on every host run and 8062 inside the image for 8041 rows, with a
   biggest chunk of 190 bytes — roughly one row per `read`, which is a fact about a loopback socket and not
   about a network.

10. **`app.close()` waits for a streamed body, and one client shape can hold it open — on Linux only.** Five
    ways for a reader to stop, each followed by `app.close()` with an 8 s ceiling on the wait:

    | what the client did | host v26.8.2 | image 24.21.0 | clean `node:22-bookworm-slim` 22.23.3 |
    | --- | --- | --- | --- |
    | `reader.cancel()` once ~2 KB had been read | 5 ms (closed), 6 ms on the re-run | 11 ms (closed) | 13 ms (closed) |
    | `body.cancel()` with nothing read | 4 ms (closed) | 9 ms (closed) | 13 ms (closed) |
    | `req.destroy()` after 2 KB | 5 ms (closed) | 10 ms (closed) | 12 ms (closed) |
    | `body.cancel()` with nothing read, **then a second request read to its end** | 1 ms (closed), 0 ms on the re-run | **8000 ms, still open** | **8001 ms, still open** |
    | one row then `req.destroy()` | 3 ms (closed), 4 ms on the re-run | 23 ms (closed) | 25 ms (closed) |

    The first row's byte count is not a fixed number: that loop reads until it has *seen* 2000 bytes and a
    cancelled `fetch` hands back whatever chunks had already arrived, so one host run reported 63081 bytes and
    another 2012. What is fixed is which side of the ceiling each runtime lands on.

    The fourth row is not a client leaving: it is a client that stopped reading and then asked again, and the
    response Fastify still had open for the first one is a response `close()` will wait for. It reproduced on
    both Linux runtimes and not on Windows, which is a difference in when a cancelled `fetch` actually hangs
    up the socket — and it is the reason this slice's own test suite failed in the `node:22` container before
    it was fixed: the assertion that read the headers with `fetch`, cancelled the body and then re-read the
    same URL with `node:http` burned vitest's whole 10 s `afterEach` hook. The route is not at fault and the
    test shape was, so the tests now open one `node:http` connection per assertion and read or destroy it
    deliberately — and the same run of the probe answers *why* that is worth writing down: the second read on
    the host resolved `done` having received `1337518` of the `1353678` bytes that body is, which is decision 5
    happening for real. What *is* a product fact is the first half of the row: `app.close()` drains a streamed
    response, and an abandoned one is a drain that can wait for ever. `forceCloseConnections` cannot be
    passed to `close()` — measured `AVV_ERR_CALLBACK_NOT_FN` on all three runtimes, it is an instance option —
    so setting it belongs to the drain slice that ADR 0009 left open, not to this one.

## Consequences

- **`GET /boards/:id/export` is the eighth route and the first streamed body.** It answers 404 before opening
  a stream, refuses a bound it cannot honour before opening one, sets `content-type: application/x-ndjson;
  charset=utf-8` itself, and returns `reply.send(stream)` — no `await`, no collection, no buffer. The stream
  names its own mode and read-ahead in the call (`objectMode: true`, `EXPORT_HIGH_WATER_MARK = 8` rows), which
  is decision 2's argument for stating both rather than inheriting them. `src/server`
  stays internal (ADR 0003's `exports` map has no key for it), and `export-stream.ts` imports only
  `src/core` and `src/domain`, so the dependency gate still describes it as a layer that reaches down.
- **Thirty new tests, none of which asserts a wall-clock number.** `test/export-stream.test.ts` (13)
  drives the stream directly and owns the counters: mode and buffer stated in the call, `rows()` equal to
  `1 + readableLength` with the buffer never above hwm, exactly `bound` pulls on a rule that would walk for
  ever, `pulls() === 0` for a bound of 0 and for a stream nobody read, the Berlin gap pair row for row, a
  short rule discovered one pull after its last row, `pulls()` and `rows()` frozen after `destroy()`, and a
  walk that refuses delivering its buffered rows before the error with no `done` row.
  `test/export-route.test.ts` (17) drives the app: the content type and the line-per-row body, the 404, the
  honoured and default bounds, the six refused `?occurrences=` shapes plus the duplicate key, that a refused
  bound outranks a missing board, an unscheduled
  item keeping only its header, and three over a real socket — the whole 8000-occurrence body with its
  `done` row, a client that leaves mid-body (`status 200`, `error !== null`, body starting `{"kind":"item"`,
  `/healthz` still answering), and the year-9999 item. The socket tests assert existence and order of rows,
  never counts reached after a timer, for the reason decision 2's spread shows.
- **`destroy()`-on-close is not wired, and that is a change to ADR 0010's list rather than an omission.**
  ADR 0010's consequences promised "destroy() wired to the request's close (decision 7)". Measured against a
  real socket, Fastify does it first (decision 1 above). The wiring stays out until something disproves that
  — the shape of the disproving case is a proxy that closes the request without closing the socket, which is
  week 8's observability problem, not this route's.
- **Neither is `write()`'s return value checked here, because this route never writes to a socket.** ADR
  0010's fifth shape decision belongs to whoever calls `write()`, and with `reply.send(stream)` that is
  Fastify's own pump. The half that is this repository's — not producing faster than the consumer takes — is
  done inside `_read`, which is decision 8's demand-driven pull, and decision 2 measured what the rest of
  that chain costs: a socket queue that absorbs ~1200 rows before anyone pauses the source.
- **Measured on the final tree**: host — `243 tests` in `21 files`, `51 files` linted with 0 errors and 0
  warnings, 0 dependency violations (`56 modules / 98 dependencies` with `dist` present, `59 / 104` with it
  moved away), coverage `99.58` statements / `97.94` branches / `100` functions / `99.58` lines, `13` package
  checks, exports `7` targets, tarball `102 files / 50156` bytes. Inside `cadence-test` (Node 24.21.0): the
  same `243 tests` in `21 files`, the same coverage line to the last digit, `59 / 104` before its own build and
  `56 / 98` after it, `13` checks, tarball `102 files / 50168` bytes. In a clean `node:22-bookworm-slim`
  container built for the purpose (`v22.23.3`, this tree copied in): `243 tests` in `21 files`, `59 / 104`
  before its build and `56 / 98` after it, the same coverage line, `13` checks, tarball `102 files / 50168`
  bytes.
- **The byte figure belongs to the packer, not to the tree.** The three environments above agree on
  `102 files` and disagree on bytes — `50156` on the host, `50168` in both local Linux containers — with the two
  Linux runs identical to each other. That gap is gzip, not content. `package.json`'s `files` list is `dist`
  and `README.md`, so `docs/` (this file included) never enters the tarball and editing an ADR cannot move the
  number; only the README can. The file count is the claim.
- **The CI run repeated the contract, and its byte figure followed the call, not the OS.** Run `38626828754`
  (a `push` of this commit, `success`, three jobs `core (22)` / `core (24)` / `docker` all on `ubuntu-24.04`,
  `0` failed and `0` skipped steps, `0` annotations on every check-run): `21 files / 243 tests` and the same
  coverage line `99.58 / 97.94 / 100 / 99.58` in all three jobs, `lint:deps` at the without-`dist` pair
  `59 / 104` (it runs before `build` in the matrix, so this is decision (a) of ADR 0010's consequences, not a
  contradiction of the host's `56 / 98`), and `verify:package` at `7 targets` and a `102 files` tarball. The
  byte figure it printed was `50156` — the host's number, from a Linux runner, not the `50168` the two local
  Linux containers produced. That is the sharper form of the sentence above: the bytes track the invocation
  and its compressor, not the operating system, which is exactly why the claim this document makes is `102
  files` and every byte pair here is labelled with where it was run.
- **The socket tests are one connection per assertion, and that is a test-shape rule this slice earned**
  (decision 10). A `fetch` whose body is cancelled is not a tidy way to ask for headers: on Linux it can leave
  the response open, and the next request on the same test then makes `app.close()` wait for it until the hook
  times out. `node:http` with an explicit `req.destroy()` has no such residue, which is why `pull()` and
  `readThenLeave()` both open and hang up their own connection.
- **Not measured, and not claimed**: a real network (every number here is 127.0.0.1, and decision 2's
  pull-ahead is explicitly a socket-buffer quantity), TLS, several exports in flight at once, a durable store
  behind the same `_read` (where the bound becomes a query limit and hwm a concurrency question — week 11),
  and authentication (the route is unauthenticated like the rest of the surface: whoever can reach the port
  can read a whole board's schedule).
