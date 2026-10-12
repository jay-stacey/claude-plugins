---
name: review-checklist
description: Code-level review checks for software-factory diffs and specs - correctness, tests that can fail, error paths, callers, data integrity, security, performance and scope.
user-invocable: false
---

# Review checklist

Used by the code reviewer, the security reviewer, and the staff engineer when checking a spec.
Work through the sections that apply to the change. Each item is a prompt to look for a concrete
failure; report only what you can tie to a line and a consequence (`critique-method`).

## 0. Before you start

- Read the acceptance criteria, the spec section the task cites, and the overlay conventions.
- Get the change with the brief's `diff_cmd` (read-only git). Review the diff, plus enough
  surrounding code to understand it. You may Grep outside the diff to find callers and patterns,
  but you report only problems the diff causes.
- Look at the CLI check evidence the brief points to (`source: cli`). Do not re-run everything;
  re-run one targeted test through `evidence run` only to confirm a suspicion.

## 1. Acceptance criteria

- Each criterion is implemented, and you can name the line that does it.
- Each criterion has a test that would fail if the feature were removed.
- Nothing in the diff changes behaviour the criteria do not ask for.

## 2. Correctness

- Logic matches the spec: branches, boundaries (off-by-one, empty, max), units, time zones,
  rounding, null and missing values, ordering, concurrency (two requests at once).
- State changes are complete: every path that starts a change finishes or rolls it back.
- Return values and errors from calls are checked, not ignored.
Detail: `references/correctness.md`.

## 3. Tests can fail

- Tests assert outcomes, not just that a mock was called.
- Failure-path tests exist for the error paths the spec names.
- No test was deleted, skipped, weakened or given a longer timeout to pass.
- Test data is local and deterministic (no real network, no clock or random without control).
Detail: `references/tests.md`.

## 4. Error paths

- Invalid input is rejected at the boundary with the repo's error shape.
- Not found, permission denied, conflict and downstream failure each have defined behaviour.
- Errors are not swallowed; logs carry context but no secrets or personal data.
- Timeouts and retries on outbound calls follow the repo pattern; retries are safe to repeat.

## 5. Contracts and callers

- Changed signatures, routes, payloads, events or schemas match the spec's interface section.
- Every existing caller still works (Grep for them). Breaking changes are versioned or flagged.
- Public behaviour changes are reflected where the overlay says docs or changelogs live.

## 6. Data integrity

- Migrations: expand-then-contract, reversible down, no silent data loss, destructive flag when
  needed. Backfills idempotent and batched.
- Writes that must happen together use a transaction or a safe ordering.
- Constraints (unique, not null, foreign keys) match what the code assumes.
Detail: `references/data-integrity.md`.

## 7. Security (code reviewer: obvious issues; security reviewer: all of it)

- Injection (query, command, template), path traversal, SSRF, unsafe deserialisation.
- Authentication and authorisation on every new entry point; checks on the server, not the client.
- Secrets: none in code, config, tests, fixtures or logs.
- New or upgraded dependencies: needed, maintained, licence fits, no known advisory.
- Data deletion and retention follow the constitution.
Detail: `references/security.md` (OWASP Top 10 map).

## 8. Performance

- No query or remote call inside a loop over rows; no unbounded reads without paging.
- No large work on a hot request path the spec marks; no memory growth with input size.
- Indexes exist for new query filters on large tables.
Detail: `references/performance.md`.

## 9. Scope creep

- Every changed file is in `files_owned` or `files_shared`. Anything else is a major.
- No unrequested features, refactors, renames or formatting churn mixed into the change.
- No new dependency the spec does not list.

## 10. Maintainability (report only when it causes a real cost)

- The change follows the nearest existing pattern; a new pattern needs a reason in the spec.
- Dead code, commented-out code and debug output are removed.
- Names say what things are; tricky logic has a short comment saying why.
Skip anything the linter or formatter enforces.
