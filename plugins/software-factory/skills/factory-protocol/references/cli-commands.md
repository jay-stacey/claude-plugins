# Factory CLI commands for role agents

Call form: `node "<cli>" <command> [flags]`, where `<cli>` is the absolute path in the brief.
Add `--json` when you want machine output. Exit codes: 0 ok, 1 validation error, 2 usage error,
4 factory not initialized, 5 revision conflict (someone else changed the record; re-read and retry once).
When the brief gives an exact command (`setup`, `validate`), run that string, not your own version.

## Every role

| Command | Use |
|---|---|
| `worktree prepare --run <run_id>` | The brief's `setup` command. First command in every worktree run. |
| `evidence run --run <run_id> --label <label> -- <command...>` | Run a command and record proof. Label is lowercase kebab: `build`, `lint`, `typecheck`, `unit`, `integration`, `e2e`, `migrate-up`, `migrate-down`, `screenshot-375`, `repro-ac-2`. |
| `handoff validate <handoff_path>` | The brief's `validate` command. Same checks the CLI runs after you finish. |
| `status` | Factory summary, 20 lines or less. |
| `task show <T-id>` | Read one task (yours or a dependency). |
| `goal show <G-id>` | Read the goal: outcome, tier, pod. |

Notes on `evidence run`:
- Everything after `--` runs through the shell in your current directory (your worktree).
- Use the exact strings from the brief's `commands` (for example `npm test`). The broker allows those.
- One label per kind of proof. Run it again after a fix; the newest entry with a given label counts.
- Exit code, log path and head SHA are recorded for you. Do not copy logs into the handoff.

## staff-engineer (breakdown mode)

| Command | Use |
|---|---|
| `epic new --goal <G-id> --title "<title>" --summary "<summary>" [--depends <E-id>]` | One epic per shippable slice. Prints the new epic id. |
| `task new --file <path.json>` | One task object or an array. Tasks are created as `draft`. |

Write the JSON input file under `<factory_home>/runs/<run_id>/` (for example `tasks.json`) with the
Write tool, then pass its absolute path. The CLI validates size (S or M for code; L is rejected with
"split it"), 1 to 5 acceptance criteria, `files_owned` overlap between tasks of the same epic, and
dependency cycles. Fix the file and run again on exit code 1.

Task object fields you set:
```json
{
  "goal_id": "G-001", "epic_id": "E-0001", "kind": "code", "role": "backend-engineer",
  "title": "Add VIN decode endpoint", "description": "What and why, <= 1200 chars, cites spec sections.",
  "size": "S", "priority": "P1",
  "acceptance_criteria": [{"id": "AC-1", "text": "GET /vin/:vin returns make, model, year for a valid VIN"}],
  "files_owned": ["src/vin/**", "test/vin/**"], "files_shared": ["src/routes.ts"],
  "files_read": ["src/http/errors.ts"], "depends_on": [], "risk_flags": ["input-parsing"],
  "gate_deps": []
}
```
`depends_on` takes task ids. Create tasks with no dependencies first, read the ids the CLI prints,
then create the dependent tasks in a second file. Frontend tasks on a goal with UI get
`"gate_deps": ["G3"]`.

## project-manager (sequence mode)

| Command | Use |
|---|---|
| `task new --file <path.json>` | Add a missing task the breakdown needs (for example a docs or wiring task). |
| `task replan <T-id> --file <path.json>` | Change sequencing fields of a draft task: `depends_on`, `estimate_tokens`, `priority`, `files_owned`, `files_shared`. Never `acceptance_criteria`. |

## cto

| Command | Use |
|---|---|
| `goal set <G-id> --tier S\|M\|L --needs-ui true\|false --pod '<json>'` | Intake result. Pod: `{"product":"product-manager","tech_lead":"staff-engineer","members":["backend-engineer"]}` |
| `task new --file <path.json>` | New rework, fix or research task. |
| `task replan <T-id> --file <path.json>` | Change scope fields, dependencies or role of a task. |
| `task retry <T-id>` | Send a failed task back to `ready` with fresh attempts. |
| `task cancel <T-id>` | Cancel a task that is no longer needed. |
| `epic new ...` | Same as staff-engineer. |
| `note "<text>"` | Log a decision line (waivers, reasons). Keep it under 140 characters. |
| `gate list` | See pending gates. |

The CTO never runs `gate decide`, `goal remove`, `pause --stop`, or `budget override`. Those need a human.

## Nobody

`git push`, `gh ...`, `gate decide`, `inbox add`, `config set`, `goal remove`, `pr create`, `integrate`.
The broker denies them. If you think one is needed, say so in `follow_ups` or `open_questions`.
