# Factory CLI commands for role agents

Call form: `node "<cli>" <command> [flags]`, where `<cli>` is the absolute path in the brief.
Add `--json` when you want machine output. Exit codes: 0 ok, 1 validation error, 2 usage error,
4 factory not initialized, 5 revision conflict (someone else changed the record; re-read and retry once).
When the brief gives an exact command (`setup`, `validate`), run that string, not your own version.

## Every role

| Command | Use |
|---|---|
| `worktree prepare --run <run_id>` | The brief's `setup` command. First command in every worktree run. Makes the worktree if missing. Prints `PREPARED <path> <branch> <sha>`. |
| `evidence run --run <run_id> --label <label> -- <command...>` | Run a command and record proof. Label is lowercase kebab: `build`, `lint`, `typecheck`, `unit`, `integration`, `e2e`, `migrate-up`, `migrate-down`, `screenshot-375`, `repro-ac-2`. |
| `handoff validate <handoff_path>` | The brief's `validate` command. Same checks the CLI runs after you finish. |
| `status` | Factory summary, 20 lines or less. |
| `task show <T-id>` | Read one task (yours or a dependency). |
| `goal show <G-id>` | Read the goal: outcome, tier, pod, teams. |
| `baseline show [--team <team>]` | Print the factory baseline (`docs/baseline/factory.md`): repos, open PRs, branches, team work, gates. |
| `cycle show [--team <team>]` | Current and next cycle per team, with committed, done and open counts. |
| `item list [--team <team>] [--class bug\|tech_debt\|chore]` | Open stream items (triage tasks) with priority, cycle and effective status. |
| `item show <T-id>` | One item: class, tracker link, note path, epics. |
| `report data [--since <ISO>] [--team <team>] [--json]` | Build the metrics for a period. Text output is 40 lines or less. Agents read stdout or the brief's `metrics_path`; `--out` is denied. |
| `report list` | Reports, assessments and cycle plans, newest first: `last report: <path\|none> (<age>); last assess <age>`, then `<time> <kind> <path>` rows. |

Notes on `evidence run`:
- Everything after `--` runs through the shell in your current directory (your worktree, so start with `cd_prefix`).
- Use the exact strings from the brief's `commands` (for example `npm test`). The broker allows those.
- One label per kind of proof. Run it again after a fix; the newest entry with a given label counts.
- Exit code, log path and head SHA are recorded for you. Do not copy logs into the handoff.

## staff-engineer (breakdown and triage modes)

| Command | Use |
|---|---|
| `epic new --goal <G-id> --title "<title>" --summary "<summary>" [--depends <E-id>] [--repo <name>] [--team <team>] [--item <T-id>]` | One epic per shippable slice. Prints the new epic id. Triage: `--goal` is the stream goal and `--item` is your triage task; the epic is linked to the item. |
| `task new --file <path.json>` | One task object or an array. Tasks are created as `draft` (in a stream goal: `backlog`). |
| `item new --team <team> --class bug\|tech_debt\|chore --title "<t>" --description "<d>" [--priority P0-P3] [--repo <name>]` | Triage only: report a different bug or debt you found in passing. Prints the new item id. |

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
`team`, `cycle` and `item` (optional): leave them out. The CLI sets `team` from the repo or role, and
code tasks of a triage epic copy the triage task's `cycle` and `priority`.
`repo` (optional): the repo name in workspace mode. Leave it out when the task has an epic, because
the task takes the epic's repo; a different value is rejected. A code or docs task with no epic needs it.
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
| `goal set <G-id> --tier S\|M\|L --needs-ui true\|false --pod '<json>' [--teams <a,b> --lead-team <a>]` | Intake result. Pod: `{"product":"product-manager","tech_lead":"staff-engineer","members":["backend-engineer"]}`. Teams only when config `teams` is set. |
| `goal set <G-id> --teams <a,b> [--lead-team <a>]` | Change a goal's teams later (assess). |
| `task new --file <path.json>` | New rework, fix or research task. |
| `task replan <T-id> --file <path.json>` | Change scope fields, dependencies or role of a task. |
| `task retry <T-id>` | Send a failed task back to `ready` with fresh attempts. |
| `task cancel <T-id>` | Cancel a task that is no longer needed. |
| `task block <T-id> --needs human\|cto\|<role> --question "<text>"` | Block a task on a question (for example a duplicate of a human PR). |
| `task waive <T-id> --finding <F-id> --reason "<text>"` | Waive one MAJOR finding after a stalemate. Blockers cannot be waived. Shown at G4. |
| `epic new ...` | Same as staff-engineer. |
| `item new --team <team> --class bug\|tech_debt\|chore --title "<t>" --description "<d>" [--priority P0-P3] [--repo <name>]` | Add a stream item. Check `item list --team <team>` first. |
| `cycle commit <T-id> --cycle current\|next\|none\|<cycle id>` | Commit a task to a cycle of its team (cycle plans, assess). |
| `note "<text>"` | Log a decision line (reasons). Keep it under 140 characters. |
| `gate list` | See pending gates. |

The CTO never runs `gate decide`, `goal remove`, `pause --stop`, `budget override` or `config set`.
Those need a human. Improvement proposals go in the handoff `proposals[]`; approval applies them.

## Nobody

`git push`, `gh ...`, `gate decide`, `inbox add`, `config set`, `goal remove`, `pr create`, `integrate`,
`baseline collect`, `cycle roll`, `report request`.
The broker denies them. If you think one is needed, say so in `follow_ups` or `open_questions`.
