# Plan template (tasks and sequencing)

Cap: S 20 lines, M 40, L 80, plus 5 lines per task in the Tasks section.

```markdown
# Plan: <goal title> (<G-id>)

Spec: <path>. Epics: E-0001 <title>, E-0002 <title>.

## Waves
- Wave 1 (parallel): T-0010 (data), T-0011 (backend)
- Wave 2: T-0012 (backend, needs T-0010), T-0013 (frontend, needs T-0011 and G3)
- Wave 3: docs and epic QA run by the factory

## Critical path
T-0010 -> T-0012 -> T-0013 -> epic QA -> review -> docs -> PR. Estimated <n> tasks long.

## Ownership map
| Task | Role | files_owned | files_shared |
|---|---|---|---|
| T-0010 | data-engineer | `db/migrations/2026*_vin*` | |
| T-0011 | backend-engineer | `src/vin/**`, `test/vin/**` | `src/routes.*` |
No two tasks in the same wave own overlapping globs.

## Budget forecast
| Item | Count | Estimate each | Total |
|---|---|---|---|
| code S | 3 | 250k | 750k |
| reviews | 4 | 150k | 600k |
Total <n> of goal budget <limit> (<pct>%). If over: what to cut or split.

## Risks
- R-1: <risk to the schedule or scope> - mitigation: <how>

## Tasks
- T-0010 <title> | data-engineer | S | depends: none | ACs: AC-1, AC-2
  Test plan: migrate up/down/up locally; backfill run twice.
```

Rules:
- Estimates use the config estimate classes the brief gives (code_S, code_M, review, qa, docs,
  fixup); add one review per review group and one QA run for each UI task.
- The plan never changes acceptance criteria or scope. Sequencing changes go through `task replan`.
