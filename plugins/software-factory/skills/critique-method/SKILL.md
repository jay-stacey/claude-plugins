---
name: critique-method
description: How software-factory bench roles judge work - fresh context, severity levels, finding format, no invented gaps, review rounds, verdicts and the 10-finding cap.
user-invocable: false
---

# Critique method

Used by the critic, code reviewer, security reviewer and QA engineer. The goal is a short list of
real problems that would cause a real failure, each one provable and fixable. A review that finds
nothing wrong is a valid result.

## 1. Fresh context

- You are a new instance. You see the artifact or diff, the criteria it must meet, the upstream
  artifacts, the constitution and the overlay. You never see the author's reasoning, transcript or
  self-assessment, and you do not ask for them.
- Judge the work against what was asked (acceptance criteria, PRD, spec, design), not against what
  you would have built.
- You do not edit the work. You write your report and your handoff, nothing else.

## 2. Severity

- `blocker`: an acceptance criterion is not met; data loss or corruption; an exploitable security
  hole; the build or existing callers break; or a plan that cannot work as written. Must be fixed.
  Only the user can override a blocker.
- `major`: a real defect or risk that should be fixed before merge: a missing error path, a missing
  failure-path test, a contract that differs from the spec, an acceptance criterion that cannot be
  tested, a file outside scope. The CTO may waive a major with a logged reason; the user sees it at G4.
- `minor`: worth fixing, low risk. Never blocks. The author may defer it to a follow-up.
- `nit`: preference or polish. Report rarely, at most two per review, never in round 2+.

When unsure between two levels, choose the lower one and say why in the finding.

## 3. Finding format

Each finding has:
- `id`: `F-1`, `F-2`... stable across rounds (round 2 refers to round 1 ids).
- `severity`.
- Location: `file:line` for code; for documents, quote the exact text you attack (one sentence or
  less) or write `missing: <what>` naming the criterion it fails to cover.
- What is wrong, in one or two sentences.
- Why it matters: the concrete failure (who is hurt, how, when).
- Fix: a direction, not a rewrite. One to three sentences.
- Proof of fix: what test, run or text change would show it is fixed.

The same findings go into the handoff `findings` list (`{id, severity, file, line, text, fix}`) and
the report file. Report layout: `references/layout.md`.

## 4. No invented gaps

A finding must name a concrete failure it would cause. Do not report:
- "Consider also..." ideas, features nobody asked for, or a different architecture you prefer.
- Things the linter or formatter already enforces, or pure style the overlay does not require.
- Risks with no path to harm in this change.
- Problems in code or text outside the diff or artifact under review. If you see one, add it to
  `follow_ups`, not `findings`.
Ask yourself: "If the author ignores this, what breaks, for whom?" No answer means no finding.

## 5. The 10-finding cap

At most 10 findings, ranked: blockers first, then majors, then the rest. If you have more, keep the
10 that matter most and say in the report how many lower ones you dropped and of what kind. Many
similar problems become one finding with a list of locations.

## 6. Rounds

- Round 1: full review against the criteria.
- Round 2 and 3 (rework): first check every earlier blocker and major. For each, say closed (cite
  the line or text that fixes it) or still open. Raise a new finding only for new code or text, or for
  a real miss that is a blocker. Do not move the goalposts and do not add nits.
- After round 3 with a blocker or major still open, the task escalates to the CTO with both
  positions. You do not soften a verdict to end the loop.

## 7. Verdicts

- `pass`: no open blocker or major. Minors and nits may remain.
- `fail`: at least one open blocker or major.
- `escalate`: the problem is above the author and you: the artifact conflicts with the PRD, the
  spec or the constitution in a way only a product owner or the user can settle, or the criteria
  themselves are wrong. Put the question in `open_questions` with `to_role` set.

Your handoff `status` is `handed_off` when you finished the review, whatever the verdict.
`blocked` means you could not review (missing artifact, setup failed).

## 8. Checking acceptance criteria

For every criterion in the brief, record `met: true` only when you can point at where it is met
(code line plus a test that would fail without it, or the section of the document). Missing proof
is `met: false` with a finding, not a guess.

## 9. Lanes

The critic works in one lane per task: `prd`, `spec`, `design` or `tasks`. Lane checklists and what
to read for each: `references/lanes.md`. Code and security reviewers use `review-checklist`.
QA uses `evidence-rules` for what counts as a PASS.
