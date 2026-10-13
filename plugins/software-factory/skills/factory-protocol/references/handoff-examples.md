# Handoff examples by role class

All handoffs are JSON written with the Write tool at the brief's `handoff_path`, then checked with
the brief's `validate` command. `to_role` is always `cto`. Empty lists stay as `[]`, unused objects
as `null`. Paths in `report_path` and `files_touched` for docs are relative to `factory_home`.

## Builder (backend, frontend, data, devops, tech writer)

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000123", "task_id": "T-0042", "from_role": "backend-engineer", "to_role": "cto",
  "status": "handed_off",
  "verdict": null,
  "summary": "Added GET /vin/:vin with input validation and a decoder service.\nInvalid VIN returns 400 with the field error; unknown VIN returns 404.\nBuild, lint and unit tests pass at the final commit.",
  "acceptance_criteria": [
    {"id": "AC-1", "met": true, "evidence": ["EV-3"]},
    {"id": "AC-2", "met": true, "evidence": ["EV-3"]}
  ],
  "evidence": ["EV-1", "EV-2", "EV-3"],
  "files_touched": ["src/vin/decoder.ts", "src/vin/route.ts", "test/vin/decoder.test.ts", "src/routes.ts"],
  "branch": "factory/T-0042-vin-decode-endpoint",
  "commits": ["3f9c2a1", "a81d0e4"],
  "findings": [],
  "report_path": null,
  "open_questions": [
    {"id": "Q-1", "to_role": "staff-engineer", "blocking": false,
     "question": "Spec does not say whether VIN lookup is case sensitive.",
     "assumed": "Upper-cased input before lookup; covered by a unit test."}
  ],
  "follow_ups": [],
  "destructive": null,
  "resume_note": ""
}
```

## Planner (product manager, staff engineer, project manager, UI/UX designer)

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000031", "task_id": "T-0003", "from_role": "staff-engineer", "to_role": "cto",
  "status": "handed_off",
  "verdict": null,
  "summary": "Spec written for tier M. Every PRD criterion traces to a component and a test level.\nTwo alternatives recorded. Risk flags: input-parsing, new-dependency.",
  "acceptance_criteria": [{"id": "AC-1", "met": true, "evidence": []}],
  "evidence": [],
  "files_touched": ["docs/G-001-vin-lookup/spec.md"],
  "branch": null, "commits": [],
  "findings": [],
  "report_path": "docs/G-001-vin-lookup/spec.md",
  "open_questions": [],
  "follow_ups": [{"title": "Rate limit the public decoder", "kind": "research", "reason": "Out of scope for this goal; abuse risk noted in spec Risks."}],
  "destructive": null,
  "resume_note": ""
}
```
For planning tasks, `acceptance_criteria` are the task's own criteria (for example "spec traces
every PRD AC"). `met` may have empty evidence because the artifact itself is the proof and a reviewer
or the human gate checks it.

## Bench reviewer (code reviewer, security reviewer, critic)

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000130", "task_id": "T-0042", "from_role": "code-reviewer", "to_role": "cto",
  "status": "handed_off",
  "verdict": "fail",
  "summary": "One major finding: the 404 path leaks the upstream error text.\nAC-1 and AC-2 are implemented and tested.",
  "acceptance_criteria": [
    {"id": "AC-1", "met": true, "evidence": []},
    {"id": "AC-2", "met": false, "evidence": []}
  ],
  "evidence": [],
  "files_touched": ["docs/G-001-vin-lookup/reviews/T-0042-code-reviewer-r1.md"],
  "branch": null, "commits": [],
  "findings": [
    {"id": "F-1", "severity": "major", "file": "src/vin/route.ts", "line": 41,
     "text": "Unknown VIN returns the upstream message verbatim, which AC-2 forbids (\"generic not-found message\").",
     "fix": "Map the upstream error to the shared NotFound error; add a test asserting the body text."}
  ],
  "report_path": "docs/G-001-vin-lookup/reviews/T-0042-code-reviewer-r1.md",
  "open_questions": [], "follow_ups": [], "destructive": null, "resume_note": ""
}
```

## QA engineer

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000210", "task_id": "T-0060", "from_role": "qa-engineer", "to_role": "cto",
  "status": "handed_off",
  "verdict": "pass",
  "summary": "All 4 criteria pass on the integrated epic branch at 9d1e0b2.\nEach has a happy and a failure row with run evidence. No regressions in the full suite.",
  "acceptance_criteria": [
    {"id": "AC-1", "met": true, "evidence": ["EV-2", "EV-3"]},
    {"id": "AC-2", "met": true, "evidence": ["EV-4", "EV-5"]}
  ],
  "evidence": ["EV-1", "EV-2", "EV-3", "EV-4", "EV-5"],
  "files_touched": ["docs/G-001-vin-lookup/qa/E-0001.md"],
  "branch": null, "commits": [],
  "findings": [],
  "report_path": "docs/G-001-vin-lookup/qa/E-0001.md",
  "open_questions": [], "follow_ups": [], "destructive": null, "resume_note": ""
}
```

## CTO (intake or escalation)

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000400", "task_id": "T-0099", "from_role": "cto", "to_role": "cto",
  "status": "handed_off",
  "verdict": "pass",
  "summary": "Escalation for T-0042 (3 failed attempts on the same flaky integration test).\nDecision: new task T-0101 to stabilise the test fixture, T-0042 depends on it, then retry.\nCommands: task new (T-0101), task replan T-0042, task retry T-0042.",
  "acceptance_criteria": [],
  "evidence": [],
  "files_touched": ["runs/R-000400/tasks.json"],
  "branch": null, "commits": [],
  "findings": [],
  "report_path": null,
  "open_questions": [],
  "follow_ups": [],
  "destructive": null,
  "resume_note": ""
}
```
For a decision only a human can make, the CTO sets `verdict: "escalate"`, `status: "blocked"` and adds
an `open_questions` entry with `to_role: "user"` and `blocking: true` that states both options.

## CTO report (with improvement proposals)

`report` and `assess` runs may add `proposals[]` (at most `reports.max_proposals`). Each proposal
opens one `improvement` gate; the user's approval applies it. Rules and allowed config keys:
`cto-playbook` references/report.md.

```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000512", "task_id": "T-0140", "from_role": "cto", "to_role": "cto",
  "status": "handed_off",
  "verdict": "pass",
  "summary": "Periodic report for 2026-10-12 09:00 to 2026-10-13 09:00 written.
Headline: G-002 is 9 of 14 tasks done; two tasks blocked on gate G2 for 31 h.
Two proposals: raise the code_S estimate, add a lint note to the frontend overlay.",
  "acceptance_criteria": [],
  "evidence": [],
  "files_touched": ["docs/reports/2026-10-13-0900-periodic.md"],
  "branch": null, "commits": [],
  "findings": [],
  "report_path": "docs/reports/2026-10-13-0900-periodic.md",
  "open_questions": [],
  "follow_ups": [],
  "destructive": null,
  "resume_note": "",
  "proposals": [
    {"id": "P-1", "title": "Raise the code_S estimate to match real runs",
     "why": "code_S runs used 2.1x their estimate (median 520k vs 250k tokens, 9 runs), so intake budget checks run low.",
     "change": {"kind": "config", "patch": {"budget.estimates.code_S": 500000}},
     "expected_effect": "Budget forecasts match real spend within 20%.", "risk": "low"},
    {"id": "P-2", "title": "Frontend engineer runs lint before every handoff",
     "why": "First-pass review rate for frontend-engineer is 40% (4 of 10); 5 of the 6 failed reviews had lint findings.",
     "change": {"kind": "overlay_note", "role": "frontend-engineer", "note": "Run the lint command through evidence run before you write the handoff; fix every finding first."},
     "expected_effect": "First-pass review rate for frontend tasks above 70%.", "risk": "low"}
  ]
}
```
An `assess` handoff has the same shape, with `report_path` set to the assessment and usually no
proposals. A `cycle_plan` handoff lists every `cycle commit` it ran in `summary` and has no proposals.
