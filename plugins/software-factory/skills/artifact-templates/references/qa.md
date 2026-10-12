# QA template

Cap: S 40 lines, M 80, L 150.

```markdown
# QA: <T-id or E-id> round <n>

Verdict: pass | fail
Under test: <branch> at <head_sha>. Started with: <run command from the overlay>.
Environment: local. Data: <seeded test data source>.

## Matrix
| AC | Row | Check | Result | Evidence |
|---|---|---|---|---|
| AC-1 | happy | Valid VIN returns make, model, year | PASS | EV-2 |
| AC-1 | failure | Malformed VIN returns field error, no data | PASS | EV-3 |
| AC-2 | happy | ... | FAIL | EV-4 |
| AC-2 | failure | ... | BLOCKED | none: e2e command missing in overlay |

## Failures
- F-1 (AC-2, blocker): <what happened vs expected>. Repro: <numbered steps or command>. Evidence: EV-4.

## Regression
Full suite: <command>, EV-5, exit <code>. New failures: none | <test names>.

## Not tested
- <what and why: blocked, out of scope, needs non-local environment>
```

Rules:
- Every AC has at least one happy row and one failure row.
- PASS needs an evidence id from running the software at the head SHA (`evidence-rules`).
- Verdict pass only when every row is PASS. Any FAIL row is a finding. Any BLOCKED row on an AC
  makes the verdict fail and goes into `open_questions`.
- Epic QA covers every AC of every task in the epic plus the goal-level ACs the epic serves.
