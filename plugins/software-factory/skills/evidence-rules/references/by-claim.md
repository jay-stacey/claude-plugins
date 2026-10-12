# Evidence by claim

For each common claim: the minimum proof, what makes it weak, and what reviewers check.

## Build, lint, typecheck
- Minimum: the exact `commands.build` / `commands.lint` / `commands.typecheck` string through
  `evidence run`, exit 0, at the final commit.
- Weak: a partial build (one package of many) when the overlay's command builds everything.
- Reviewer check: the label's newest entry has the head SHA of the branch.

## Behaviour (an acceptance criterion)
- Minimum: one test per criterion whose name or log line ties it to the criterion, plus one
  failure-path test when the criterion can fail. Run inside the full or targeted test command.
- Weak: a test that only checks a function was called (mock-only), a snapshot updated in the same
  commit without review, a test that would pass with the feature removed.
- Reviewer check: would this test fail if the feature were deleted? If not, it is not proof.

## UI
- Minimum: component or e2e tests for each state the design names, plus screenshots at 375, 768 and
  1440 widths from a recorded command (see screenshots.md).
- Weak: one width only, populated state only, screenshots from the mockup HTML instead of the app.
- QA check: each design state is reachable in the running app and matches the approved mockup.

## API or contract
- Minimum: an integration or contract test that calls the real entry point (route, handler, message
  consumer) and asserts status, shape and error body.
- Weak: calling the inner service only, so routing, validation and serialisation are untested.

## Data
- Minimum: `migrate-up`, `migrate-down`, `migrate-up` on the local database from the overlay;
  backfill run twice on the same data with the same result (idempotent); a row count or checksum
  before and after.
- Weak: up only; backfill tested on an empty table; no proof the down step restores the schema.
- Never: a connection string that is not the overlay's local database.

## Bug fix
- Minimum: a test that reproduces the bug (red entry, label `repro-<id>`) at a commit before the fix,
  then the same test green after the fix.
- Weak: a green test only; a test added after the fix that never failed.

## Documentation
- Minimum: every command the doc tells a reader to run, run exactly as written through `evidence run`
  in a clean worktree, exit 0, output matching what the doc shows.
- Weak: running a variant of the command, or running it in a pre-configured shell.

## Security fix
- Minimum: a local test that sends the malicious input (injection string, traversal path, oversized
  body, missing token) and asserts it is rejected.
- Never: probing a remote or shared environment.

## Performance claim
- Minimum: a repeatable local measurement command with before and after numbers in the logs, same
  data size, same machine. Otherwise state "not measured", not "faster".
