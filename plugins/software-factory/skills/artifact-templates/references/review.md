# Code and security review template

Cap: 60 lines. Same base layout as `critique-method` references/layout.md, with a Test adequacy
section for code reviews and a Category per finding for security reviews.

```markdown
# <Code|Security> review: <T-id or E-id> round <n>

Verdict: pass | fail | escalate
Scope: `<diff_cmd from the brief>` at <head_sha>. Files: <count>. Checks: CLI evidence <ids>.
Criteria: AC-1 met (`src/a.ts:40`, test `AC-1 ...`), AC-2 not met (F-1)

## Blockers
- F-1 `path:line` - <what is wrong>. Why: <concrete failure>. Fix: <direction>.
  Proof: <test or run that shows it is fixed>.
  (security) Category: A03 Injection. Exploit path: <who, how, what they gain>.

## Majors
None.

## Minors
- F-2 ...

## Earlier findings (round 2+)
- F-1 closed at `path:line` | still open: <why>

## Test adequacy
<Would the tests fail if the feature broke? Missing failure-path tests? 2-4 lines.>

## Could not verify
None.

## Rationale
<= 80 words.
```

Rules: max 10 findings; each with `file:line`; nothing outside the diff (use `follow_ups`); no
linter-enforced style; never print a secret value (security: file:line and secret type only).
