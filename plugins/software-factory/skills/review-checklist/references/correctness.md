# Correctness checks

Questions to ask of each changed function or block. Report only a concrete failing case.

## Inputs and boundaries
- What happens with empty, null, missing, zero, negative, very large, duplicate input?
- Off-by-one on ranges, pagination, slicing, date ranges (inclusive or exclusive end).
- String handling: case, whitespace, Unicode, encoding, locale-dependent formatting.
- Numbers: integer overflow, floating point for money (should be integer minor units or decimal),
  rounding mode, division by zero, unit mix-ups (ms vs s, cents vs units).
- Time: time zones, daylight saving, "now" taken twice in one operation, clock in tests.

## Control flow
- Every branch of a conditional handled, including the default or else case.
- Early returns that skip cleanup, logging or a required side effect.
- Loops that can run zero times or forever; recursion without a bound.
- Async code: missing await, unhandled rejection, work started but never awaited, order assumed
  between parallel calls.

## State and concurrency
- Two requests at once: lost update, double create, double charge. Is there a unique constraint,
  lock, or idempotency key where the spec needs one?
- Caches: invalidated when the source changes; key includes everything that varies the value.
- Partial failure: step 2 fails after step 1 wrote. Is step 1 rolled back or safe to retry?

## Contracts
- Function returns what callers expect in every path (type, nullability, error vs exception).
- Changed defaults: callers relying on the old default now behave differently.
- Serialisation: field names, casing, date formats and enum values match the spec's interface.

## Resource handling
- Files, connections, handles and subscriptions are closed on every path, including errors.
- Temporary files cleaned; no writes outside the expected directory.

## Configuration
- New settings have safe defaults and are documented where the overlay says.
- Feature switches default to the behaviour the spec states.
