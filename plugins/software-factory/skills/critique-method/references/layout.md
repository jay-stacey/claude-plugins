# Review and critique file layout

Markdown at the path in the brief's `output_paths`. 60 lines or less (QA files follow the QA
template in `artifact-templates`). Plain words. No praise section.

```markdown
# <Critique|Code review|Security review>: <artifact or task id> round <n>

Verdict: pass | fail | escalate
Scope: <artifact path, or diff command and head SHA>
Criteria checked: AC-1 met, AC-2 not met (F-1), AC-3 met

## Blockers
- F-1 `src/orders/create.ts:57` - Order total ignores the discount the PRD requires (AC-2).
  Why: customers are charged the full price. Fix: apply the discount before tax in `calcTotal`.
  Proof: a test with a discounted order asserting the total.

## Majors
- F-2 ...

## Minors
- F-3 ...

## Earlier findings (round 2+)
- F-1 closed: `src/orders/create.ts:61` now applies the discount; test `AC-2 discount` added.
- F-2 open: no failure-path test yet.

## Could not verify
- <what you could not check and why, for example "no local e2e command in the overlay">

## Questions
- <only if verdict is escalate, or a criterion is ambiguous>

## Rationale
<= 80 words: why this verdict.
```

Rules:
- Empty sections say "None." Do not delete headings.
- Quote document text exactly, in quotation marks, one sentence or less.
- Every finding here also appears in the handoff `findings` list with the same id and severity.
- Dropped findings over the cap: one line at the end of Minors, for example
  "4 further minors on naming dropped (cap 10)."
