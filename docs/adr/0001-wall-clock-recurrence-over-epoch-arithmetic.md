# ADR 0001 — Wall-clock recurrence over `Intl`, not epoch arithmetic

Status: accepted
Date: 2026-10-13
Deciders: Yusuf Kef
Technical context: `src/core/clock.ts`, `src/core/recurrence.ts`

## Context

A recurring schedule ("every working day at 02:30, Europe/Berlin") is a statement about
*local wall-clock time*, but instants are the only thing a database and a queue can store.
The two disagree twice a year:

- **Spring forward** removes an hour. `02:30` on 2026-03-29 does not exist in Berlin.
- **Fall back** repeats an hour. `02:30` on 2026-10-25 happens twice in Berlin.

Adding 86 400 000 ms per day solves neither: the wall time drifts by an hour after every
transition. Reading the offset from a table solves both but adds a dependency and a data
freshness problem. `Temporal` (`temporal.api.weekday` era proposals aside) is not yet
available in the Node versions we target, so conversion has to go through
`Intl.DateTimeFormat` with an IANA zone name.

## Decision

1. **Series generation is calendar arithmetic on wall-clock fields.** Candidate dates are
   built from `(year, month, day)` in the target zone, then each candidate is resolved to an
   instant. Time-of-day comes from the anchor, so a daily 09:00 job keeps firing at 09:00 local
   and the *distance between instants* absorbs the shift (23 h on spring-forward day, 25 h on
   fall-back day).
2. **A gap rolls forward.** If the requested wall time does not exist, the occurrence resolves
   to the transition instant itself and is reported as `disambiguation: 'gap-roll-forward'`.
   Silently dropping a schedule is worse than firing it 30 minutes early.
3. **A fold takes the earlier offset.** If the wall time matches two instants, we return the
   first one (`'earlier-offset'`). Deterministic and matches "the meeting is at 02:30, the
   first time it comes around".
4. **A missing day skips the occurrence, it is not clamped.** `byMonthDay: [31]` in February
   yields nothing, matching RFC 5545. `byMonthDay: [-1]` is the supported way to say
   "month end". Skipped occurrences do not consume `count` or `index`.
5. **`nextOccurrence(rule, after)` is strictly after.** Callers cursor with the previous
   occurrence's `instant` and can never re-emit it.
6. **Conversion runs at second resolution.** Sub-second components of `dtStart` are dropped;
   a schedule that fires at 09:00:00.500 is a cron problem, not a domain rule.
7. **The search walks periods linearly behind a 200 000 candidate guard** instead of computing
   a starting period. Arithmetic fast-forward would be faster for a cursor 40 years out, but
   `index` (the occurrence's position in the series) would no longer be derivable. A 40-year
   daily walk costs ~14 600 iterations and measures ~450 ms on Node 26; `SEARCH_EXHAUSTED` is the
   backstop for absurd input (two guards: 200 000 candidates, and 4 000 empty periods for rules such
   as "every year on 29 February" whose candidates are mostly missing days).

## Consequences

- Callers must read the *actual* local time from `instant`, never from `targetWall`: in a gap
  `targetWall` is the requested time and `instant` is the resolved one.
- Validation is explicit and typed: `CadenceError` with a `code` union, so HTTP adapters can
  map codes to status codes without string matching (that mapping is a later week).
- `Intl` behaviour is ICU-version dependent. The CI matrix pins Node 22 and 24 rather than
  trusting the host, and the Lord Howe test (`30`-minute transition) is the tripwire for a
  platform difference in offset resolution.
- `count` bounded series scan from the anchor; a caller combining a huge `count` with a far
  cursor is the one case where this design costs real time. Revisit with property-based tests
  in week 8 if it shows up in a profile.
