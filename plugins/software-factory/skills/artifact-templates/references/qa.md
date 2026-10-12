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

## Cross-repo goal QA (`qa/<G-id>-goal.md`)

Only for a workspace goal whose epics span two or more repos. Same cap and same rules. Rows are the
goal's success criteria (AC-1..AC-5), tested on the joined flow with every repo running. Use this
shape; the Failures section also names the repo at fault so the CTO can route rework.

```markdown
# Cross-repo QA: <G-id> round <n>

Verdict: pass | fail
Under test: <repo> <branch> at <head_sha>; <repo> <branch> at <head_sha>.
Started with: <repo>: <run command>; <repo>: <run command>. Environment: local.

## Matrix
| AC | Row | Flow across repos | Result | Evidence |
|---|---|---|---|---|
| AC-1 | happy | Neo form -> API decode -> result shown | PASS | EV-2 |
| AC-1 | failure | API 404 -> Neo shows not-found message | FAIL | EV-3 |

## Failures
- F-1 (AC-1, blocker, repo: <repo at fault>): <what happened vs expected>. Repro: <steps>. Evidence: EV-3.

## Regression
Per repo: <repo>: <test command>, EV-5, exit <code>. New failures: none | <test names>.

## Not tested
- <what and why>
```
