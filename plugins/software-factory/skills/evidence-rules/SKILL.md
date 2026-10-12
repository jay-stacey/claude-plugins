---
name: evidence-rules
description: What counts as proof in the software factory - agent versus CLI evidence, PASS/FAIL/BLOCKED, flaky tests, and what is never evidence.
user-invocable: false
---

# Evidence rules

"Done" in the factory is proven, not claimed. These rules say what proof is, who makes it, and what
never counts. They rank with `factory-protocol` above the constitution: an overlay cannot loosen them.

## 1. Two sources of evidence

- `source: agent`: you ran `node "<cli>" evidence run --run <run_id> --label <label> -- <command>`.
  The CLI ran the command, saved the full log, and recorded the exit code and head SHA. You cite the
  id (`EV-3`) in your handoff.
- `source: cli`: the factory's own check runner re-ran `checks.pre_review` (build, lint, test) in a
  clean checkout at your head SHA after your run ended. Nobody can edit it.

Gate decisions and the move from `checking` to `in_review` use only `source: cli`. Your agent
evidence is still required: it shows the reviewer what you ran, and it must agree with the CLI run.
If your evidence passed and the CLI run failed, the task goes back to you with the CLI log.

## 2. What counts as proof

A claim is proven only by a recorded command run whose log shows the claim, at the commit you hand off.

| Claim | Proof |
|---|---|
| It builds | `build` entry, exit 0, at the final commit |
| Lint and types are clean | `lint` and `typecheck` entries, exit 0, at the final commit |
| AC-n works | A test that exercises AC-n, run in a `unit`, `integration` or `e2e` entry, exit 0, and the test name visible in the log |
| AC-n fails safely | A failure-path test (invalid input, not found, denied, dependency down) in a recorded run |
| The UI matches the design | Screenshots at 375, 768 and 1440 widths made by a recorded command (`screenshot-375`...) |
| A migration is reversible | `migrate-up`, `migrate-down`, `migrate-up` entries on the local database, all exit 0 |
| A documented command works | An entry running exactly the documented command |
| A bug is fixed | A test that failed before the fix (red entry) and passes after (green entry) |

More detail per claim: `references/by-claim.md`.

## 3. Results: PASS, FAIL, BLOCKED

Use these words in QA matrices, review reports and acceptance criteria mapping.
- PASS: a recorded run at the head SHA shows the expected behaviour. Cite the evidence id.
- FAIL: a recorded run shows wrong behaviour, or the check cannot pass as written. Cite the id and
  give repro steps.
- BLOCKED: the check could not run (environment missing, dependency down, command not in the
  overlay). Say exactly what is missing. BLOCKED is never PASS, and never silently skipped.

`met: true` in a handoff means PASS. Anything else is `met: false` with the reason in `summary`.

## 4. Freshness

- Evidence must be at the head SHA you hand off. After any new commit, re-run the affected labels.
  The newest entry for a label is the one that counts.
- Evidence from an earlier run, another task, another branch or another machine does not count.
- Evidence from a dirty working tree is weak. Commit, then run.

## 5. Flaky tests

- A test that fails, then passes on an unchanged commit, is flaky. Do not hide it.
- Rule: run it up to 3 times through `evidence run` (labels `unit`, `unit-rerun-1`, `unit-rerun-2`).
  If it passes 2 of 3 and is not related to your change, report it in `follow_ups` with the evidence
  ids, and mark nothing as PASS based on that test alone.
- If the flaky test covers your acceptance criterion, the criterion is not proven: `met: false`.
- Never add retries, sleeps or skips to a test to make it pass. Never mark it "known flaky" yourself.

## 6. Never evidence

None of these prove anything. Do not cite them as proof, and reviewers must reject them:
- "I ran it and it passed" with no evidence id. Logs pasted into the handoff or a report.
- Reading the code and reasoning that it works. Reading the author's tests without running them.
- Output of a command run outside `evidence run`, or with output redirected or truncated.
- A run with a non-zero exit code, or a log that shows skipped or zero tests for the claim.
- A test that cannot fail (asserts nothing, asserts a mock, or catches every error).
- Screenshots or files you made by hand, mockups, or a design file standing in for the built UI.
- Evidence from a non-local environment the overlay does not name.
- The author's self-assessment, a commit message, or a previous reviewer's verdict.

## 7. Good habits

- One label per kind of proof, lowercase kebab: `build`, `lint`, `typecheck`, `unit`, `integration`,
  `e2e`, `migrate-up`, `migrate-down`, `screenshot-375`, `repro-ac-2`, `docs-install`.
- Run the narrow test while you work, then the full `commands.test` once at the end.
- Make test names say which AC they cover (for example include `AC-2` in the name) so the log shows it.
- Cover every label in the brief's `evidence_required`. A missing label fails validation.
- Screenshot rules and file naming: `references/screenshots.md`.
