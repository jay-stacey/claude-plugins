# Test adequacy checks

The question for every test: would it fail if the behaviour it claims to cover were broken?

## Coverage of criteria
- Each acceptance criterion has at least one test, findable by name or by what it asserts.
- Each criterion that can fail has a failure-path test (invalid input, not found, denied,
  dependency down, timeout).
- Edge cases the spec names have tests (empty list, maximum size, boundary dates).

## Tests that cannot fail (major)
- Asserts only that a mock was called, with no check of the result or the arguments that matter.
- Asserts on a value the test itself set up (tautology).
- Catches all errors, or asserts "no exception" where a wrong result would also not throw.
- Snapshot created or updated in the same change with no review of its content.
- Conditional assertions that are skipped when the condition is false.

## Tampering (blocker if it hides a failure)
- A test deleted, skipped, marked pending, or its expectation changed to match new wrong output.
- Timeouts raised, retries added, or sleeps inserted to make a test pass.
- Coverage or lint thresholds lowered in config.

## Determinism
- No real network, real clock, real randomness or shared global state without control.
- Order-independent: tests do not rely on running after another test.
- Test data local and seeded; no personal data in fixtures.

## Level
- The test level matches the spec's test strategy: unit for logic, integration for the entry
  point and data layer, e2e for user journeys.
- Integration tests hit the real entry point (route, handler, consumer), not only the inner service.

## Evidence link
- The tests ran in a recorded `evidence run` or CLI check at the head SHA, and the log shows them
  executed (not zero tests, not filtered out).
