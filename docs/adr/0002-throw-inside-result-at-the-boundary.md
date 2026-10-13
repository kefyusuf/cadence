# ADR 0002 — Throw inside, `Result` at the boundary

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/core/errors.ts`, `src/core/result.ts`, `src/domain/ids.ts`

## Context

The engine rejects bad input: an unknown IANA zone, an interval of `0`, an id with a space in
it. Three different callers will want to react to that: in-process code that should crash on a
programmer error, an HTTP adapter that has to answer `400` with a code (week 4), and a queue
worker that has to decide retry-or-die (week 12). A single reporting idiom does not serve all
three, and the choice becomes much more expensive to reverse once adapters exist.

## Decision

1. **Internal failure is an exception.** Pure functions `throw` a `CadenceError` carrying a
   `code`. Validation happens eagerly (`normalize()` runs when a series is created, not on the
   first pull) so the stack points at the caller that built the bad rule.
2. **Codes come from one array.** `CADENCE_ERROR_CODES` is the only place a code is written and
   `CadenceErrorCode` is derived from it with `(typeof CADENCE_ERROR_CODES)[number]`, so a new code
   is one line and cannot exist in the type without existing at runtime. `test/errors.test.ts`
   walks the array, and `isCadenceError` rejects an `Error` whose code is outside it.
3. **Boundaries get a value.** `tryNextOccurrence` and `parseId` return `Result<T, CadenceError>`
   instead of throwing. `fromThrowable` bridges the two worlds: a `CadenceError` passes through
   untouched, anything else becomes `UNEXPECTED` with the original attached as `cause` — the
   standard `Error` option, not a bespoke field.
4. **Identity is `isCadenceError`, never `instanceof`.** Two copies of the package (a bundler
   that failed to dedupe, a hoisted monorepo, a vm realm) produce two distinct classes, and
   `instanceof` reports `false` for a genuine error. The helper accepts an `Error` whose `name`
   is `'CadenceError'` and whose `code` is in the known set. It rejects plain objects:
   `{ name: 'CadenceError', code: 'INVALID_ID', message: 'x' }` is *not* an error — measured, so
   an impostor from `JSON.parse` of a log line cannot be trusted downstream.
5. **`Result` is what crosses a serialization boundary.** Measured with `structuredClone`:

   ```
   structuredClone(new CadenceError('INVALID_ID', 'boom', { cause: new TypeError('underlying') }))
   // message 'boom'      kept
   // stack               kept
   // cause               kept (a TypeError)
   // name                'Error'          (was 'CadenceError')
   // code                undefined
   // instanceof CadenceError  false
   // isCadenceError(...)      false
   ```

   An `Error` subclass survives the trip to a worker or a `postMessage` consumer only as text.
   A `Result` is a plain discriminated union, so `{ ok: false, error: { code } }` survives
   intact. Codes are the currency between contexts; error objects stay inside one.

## Consequences

- The HTTP mapping in week 4 is `code -> status`, driven by the same array — no string matching
  on messages.
- `try*` variants exist only where a caller is expected to branch. There is no `tryParseId`
  counterpart to the throwing path: `parseId` is already total, it never throws.
- `test/result.test.ts` throws a raw string on purpose; that one line carries an
  `eslint-disable` for `@typescript-eslint/only-throw-error` because the non-`Error` throw *is*
  the input under test.
- If we ever need to reconstruct a `CadenceError` in another isolate, we will re-throw from the
  code and message rather than try to revive the object.
