# software-factory build contracts (v1)

This file is the build spec every component codes against. `design.md` explains why; this file says
exactly what. If they disagree, this file wins. Change it only on purpose, and update every consumer.

## 0. Spike findings (M0, 2026-10-12, Claude Code 2.1.296, Windows 11)

Verified by a throwaway plugin with headless and background sessions:

1. A PreToolUse hook that returns `permissionDecision: "allow"` lets a background subagent run Bash,
   Edit and Write with no prompt, in default permission mode. `deny` + reason reaches the agent as a
   tool error and it adapts. The permission broker design works.
2. **SubagentStop exit 2 does NOT resume a background subagent.** The hook fires, but the agent ends
   anyway (it finishes through an internal `SubagentHandback`). Design change: handoff validation is
   done by `factory collect` after the run ends. An invalid handoff creates a `fixup` run (same task,
   same branch, feedback = the validation errors), up to 2 times, then the task fails. Agents also
   self-check with `factory handoff validate` before finishing.
3. `isolation: worktree` creates `<repo>/.claude/worktrees/agent-<agent_id>` on branch
   `worktree-agent-<agent_id>` from the default branch. A worktree with commits is KEPT after the agent
   ends, and the task branch stays checked out there. So `factory collect` must remove the agent
   worktree (`git worktree remove --force`) and delete the `worktree-agent-*` branch once the task
   branch is recorded; `worktree prepare` must also remove any worktree that holds the task branch.
4. Windows path length: worktree creation fails with `fatal: '$GIT_DIR' too big` when the repo path is
   very long (~170+ chars). `factory doctor` warns when `repo path + 60` exceeds 240 characters and
   suggests `git config core.longpaths true`.
5. Hook payloads (field names verified):
   - all: `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, hook_event_name`.
   - PreToolUse(Agent): `tool_input{description, prompt, subagent_type, run_in_background}, tool_use_id`.
   - PostToolUse(Agent): `tool_response{isAsync, status, agentId, description, resolvedModel, prompt,
     outputFile, canReadOutputFile, canContinueAgent}`.
   - SubagentStart: `agent_id, agent_type` (`<plugin>:<agent>`). No prompt.
   - SubagentStop: `agent_id, agent_type, stop_hook_active, agent_transcript_path, background_tasks`.
   - Hooks inside a subagent carry `agent_id` and `agent_type`; main-thread hooks do not.
   - Hook env includes `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
     `CLAUDE_CODE_SESSION_ID`.
6. Subagent transcripts: `<projects>/<slug>/<session_id>/subagents/agent-<agent_id>.jsonl` plus
   `agent-<agent_id>.meta.json` with `agentType, worktreePath, worktreeBranch, description, toolUseId,
   spawnDepth, requestShape`. The runtime decorates `description` (adds a name prefix), so match the
   `[T-0001]` tag anywhere in it, not at the start. Usage: dedupe assistant lines by `message.id`.
7. Background sessions need a trusted workspace. `claude --bg` in an untrusted folder refuses to start.
8. Engine: `/loop /<plugin>:tick` (self-paced) in a background session ran 4 ticks unattended: the
   plugin skill ran, `ScheduleWakeup` re-armed each time, and the loop ended on `STOP`. A requested
   60 s delay fired after about 118 s. Each idle tick cost 3-4 model requests, about 30k
   billed-equivalent tokens on a machine with an 85k-token base context (mostly MCP tool lists).
   Budget: active cadence 270 s = about 0.4M/hour; waiting cadence 1800-3600 s = about 30-60k/hour.
   Booked as dispatcher overhead, never against a goal. `tick begin` debounce (`SKIP`) keeps idle
   ticks to 2 requests. Engine decision: `/loop` self-paced. Plugin monitor wake is deferred (v1.1).

## 1. Locations

- Plugin root `P` = `${CLAUDE_PLUGIN_ROOT}`. CLI = `node "<P>/scripts/factory.mjs"`. Node >= 20, no deps.
- Factory home `H` = `<main checkout>/.factory`, found by `git rev-parse --path-format=absolute
  --git-common-dir` -> parent dir -> `.factory`. Env `FACTORY_HOME` overrides (tests).
- Briefs embed absolute paths for `H` and the CLI, so agents never compute them.
- Plugin data `D` = `${CLAUDE_PLUGIN_DATA}` (hooks know it; the CLI gets it via `run/machine.json`,
  written by the SessionStart hook). The HMAC key lives at `D/hmac/<sha256(H) first 16>.key`.

## 2. Files under `H`

```
config.json  config.schema.json  constitution.md  org.md     (committed)
roles/<role>.md                                              (committed overlays)
docs/G-001-<slug>/{prd.md, spec.md, plan.md, design/, critique/, reviews/, qa/, questions/, release-notes.md}
goals/G-001.json  epics/E-0001.json  tasks/T-0001.json  gates/GATE-0001.json
runs/R-000001/{run.json, brief.md, handoff.json, result.json, checkpoint.md, evidence/index.jsonl, evidence/*.log}
state/{factory.json, index.json, counters.json, usage.jsonl, ledger.jsonl, budget.json}
inbox/*.json  inbox/processed/  inbox/rejected/
events/events.jsonl  events/archive/
sync/{map.json, state.json, outbox.jsonl, log-YYYY-MM.jsonl, preview.md}     (M5)
setup/{answers.json, scan.json}
run/{lease.json, mutex/, human-intent.json, machine.json, cto-checkpoint.md, control-center.json, control-center.log, checks/}
worktrees/                                                   (CLI-managed integration worktrees)
```

`.factory/.gitignore` (written by `init`): `*`, then `!.gitignore !config.json !config.schema.json
!constitution.md !org.md !roles/ !roles/** !docs/ !docs/** !setup/ !setup/answers.json !sync/
!sync/map.json`.

Atomic writes: write `<file>.tmp-<pid>`, then rename; retry 5x with backoff on EPERM/EBUSY.
Mutations take the mutex: `mkdir run/mutex` holding `owner.json {pid, token, at}`; break only if the
pid is dead or the lock is older than 120 s. Event and usage appends are single `appendFileSync` lines
(<= 4 KB), lock-free.

## 3. Records (all JSON, snake_case)

Common: `schema` (e.g. `"factory/task@1"`), `id`, `rev` (int, +1 per write), `created_at`, `updated_at`.

### Goal `goals/G-001.json`
`title (<=80), slug, outcome (<=600), success_criteria[] (1-7), constraints[], priority (P0..P3),
tier (S|M|L|null), needs_ui (bool|null), status, status_reason, pod {product, tech_lead, members[]},
docs {prd, spec, plan, design}, gates {G1, G2, G3} (gate ids), gate_policy {G1?,G2?,G3?,G4?},
budget {limit_tokens, warn_pct, stop_pct}, created_by {kind: human|tracker, via: cli|dashboard|tracker|setup},
epics[]`.
Goal status: `draft | planning | awaiting_g1 | active | paused | budget_blocked | done | cancelled`.

### Epic `epics/E-0001.json`
`goal_id, title, slug, summary, depends_on[], status, branch, base_branch, pr {number, url, state,
head_sha, review_decision, mergeable, merged_at} | null, gates {G4}, tasks[]`.
Epic status: `draft | building | integrating | qa | review | docs | pr_open | changes_requested | done | cancelled`.

### Task `tasks/T-0001.json`
`goal_id, epic_id|null, kind, title (<=80), description (<=1200), role, size (S|M|L),
priority, acceptance_criteria [{id: "AC-1", text}], ac_version, files_owned[], files_shared[],
files_read[], depends_on[], gate_deps[] ("G1"|"G2"|"G3"), gate ("G1"|"G2"|"G3"|null), risk_flags[],
reviews_required [[role,...],...], reviews {role: {verdict, run_id, round, at}}, status, status_reason,
attempts, max_attempts (3), rework_count, max_rework (3), fixups, estimate_tokens, model_override,
branch, base_ref, current_run_id, runs[], blocked {reason, question_id, needs: human|cto|role, since} | null,
resume_from {branch, commit, checkpoint_path} | null, feedback [{source, ref, path, at}], answers[]`.

Task kinds and default role:

| kind | role | produces | notes |
|---|---|---|---|
| intake | cto | goal tier, needs_ui, pod, budget check | first task of every goal |
| prd | product-manager | docs/.../prd.md | gate G1; Critic review only for tier L |
| spec | staff-engineer | docs/.../spec.md (+ Data section) | gate G2; reviews [["critic"]] (+ security-reviewer if risk) |
| mockup | ui-ux-designer | docs/.../design/ | gate G3; reviews [["critic"]]; only if needs_ui |
| breakdown | staff-engineer | epics + code tasks (status draft) via CLI | after G2 |
| sequence | project-manager | depends_on, estimates, plan.md | after breakdown; on done, draft tasks -> backlog |
| code | backend-engineer, frontend-engineer, data-engineer, devops-release | commits on task branch | worktree |
| docs | tech-writer | commits | one per epic, after epic review |
| qa_epic | qa-engineer | docs/.../qa/E-0001.md | on integrated epic branch |
| review_epic | code-reviewer (opus) | docs/.../reviews/E-0001.md | after qa_epic |
| pr_feedback | staff-engineer | rework tasks | when the PR gets changes requested |
| escalation | cto | decision via CLI | failed task, stalemate, replan |
| research | any planner | doc | optional |

Task status: `draft, backlog, ready, in_progress, checking, in_review, changes_requested, verified,
integrated, awaiting_approval, done` + side `blocked, paused, deferred, failed, cancelled`.

Reviews for code tasks (profile lean): `[["code-reviewer"]]` (+ `security-reviewer` in the same group
when `risk_flags` is not empty), then `[["qa-engineer"]]` only when the task role is
`frontend-engineer`. Profile thorough: code review on opus and QA for every code task.

### Run `runs/R-000001/run.json`
`task_id, goal_id, epic_id, kind (author|review|qa|fixup|integrate|escalation), role, subagent_type,
model, status (dispatching|running|suspect|completed|failed|deferred|orphaned|stopped), session_id,
agent_id, tool_use_id, dispatched_at, started_at, ended_at, isolation (worktree|none), worktree_path,
branch, head_sha, brief_path, handoff_path, estimate_tokens, round, review_role|null, exit {reason, message}|null`.

### Gate `gates/GATE-0001.json`
`type (G1|G2|G3|G4|budget|destructive|tracker), subject {kind: goal|epic|task, id}, goal_id, status
(pending|approved|rejected|changes_requested|superseded), opened_at, opened_by {run_id|null, actor},
artifact {paths[], pr_url?, summary (<=600), diffstat?}, request {add_tokens_suggested?, action?, impact[]?, inbox_id?},
decision {by, via (cli|dashboard|tracker|github), at, notes, add_tokens?} | null, auto (bool)`.

### Handoff `runs/<id>/handoff.json` (written by the agent with the Write tool)
```json
{
  "schema": "factory/handoff@1",
  "run_id": "R-000123", "task_id": "T-0042", "from_role": "backend-engineer", "to_role": "cto",
  "status": "handed_off | blocked | partial | failed",
  "verdict": "pass | fail | escalate | null",
  "summary": "<= 10 lines, plain words",
  "acceptance_criteria": [{"id": "AC-1", "met": true, "evidence": ["EV-1"]}],
  "evidence": ["EV-1", "EV-2"],
  "files_touched": [], "branch": "factory/T-0042-x", "commits": ["<sha>"],
  "findings": [{"id": "F-1", "severity": "blocker|major|minor|nit", "file": "", "line": 0, "text": "", "fix": ""}],
  "report_path": "docs/G-001-x/reviews/T-0042-code-reviewer-r1.md",
  "open_questions": [{"id": "Q-1", "to_role": "staff-engineer", "blocking": true, "question": "", "assumed": ""}],
  "follow_ups": [{"title": "", "kind": "", "reason": ""}],
  "destructive": null,
  "resume_note": ""
}
```
Agent final message: exactly one line `HANDOFF <abs path to handoff.json> <status>`.

### Evidence `runs/<id>/evidence/index.jsonl`
`{id: "EV-1", label, command, cwd, exit_code, log_path, head_sha, source: agent|cli, started_at, ended_at}`.
`factory evidence run` writes `source: agent`. The check runner writes `source: cli`. Gate decisions
and `checking -> in_review` use only `source: cli` entries.

### Inbox request `inbox/<yyyymmddThhmmssZ>-<id8>-<type>.json`
`schema: "factory/inbox@1", id, created_at, source (dashboard|cli|tracker|setup), actor {kind: human|tracker|system, name?},
type, payload, dedupe_key?, needs_confirmation (false), auto_apply (false), sig?`.
Types and payloads:
- `gate.decide {gate_id, decision: approve|changes|reject, notes, add_tokens?}` (sig required)
- `goal.add {title, outcome, success_criteria[], priority, budget_tokens?, constraints[]?, notes?}`
- `goal.activate {goal_id}`, `goal.pause {goal_id}`, `goal.resume {goal_id}`
- `goal.remove {goal_id, confirm_text, discard: false}` (sig required; confirm_text must equal goal_id)
- `factory.pause {mode: drain|now}`, `factory.resume {}`, `factory.stop {}` (sig required for stop)
- `budget.override {goal_id, add_tokens, note}` (sig required)
- `task.note {task_id, text}`, `task.answer {task_id, question_id, text}`, `task.retry {task_id}`,
  `task.cancel {task_id}`, `task.pause {task_id}`
- `sync.now {}` and `tracker.* / sync.*` kinds (M5).
`sig` = hex HMAC-SHA256 over `type + "\n" + canonical JSON(payload) + "\n" + id` with the HMAC key.
After processing: move to `processed/` or `rejected/` with `result {status: applied|rejected|superseded|gated, reason, tick, gate_id?}`.
`needs_confirmation` requests become a `tracker` gate.

### Event line `events/events.jsonl`
`{v: 1, id (ulid-ish), ts, type, source (cli|hook|server|sync|reconcile), session_id?, actor {kind, role?, run_id?, agent_id?},
goal_id?, epic_id?, task_id?, run_id?, msg (<=140), data {}}`.
Types: `tick.started, tick.finished, lock.acquired, lock.stolen, lock.released, factory.status,
inbox.processed, goal.status, epic.status, task.created, task.status, run.dispatched, run.started,
run.ended, run.lost, run.deferred, msg.dispatch, msg.handoff, msg.question, msg.answer,
msg.review_request, msg.review_result, msg.rework, msg.escalation, msg.approval_request,
msg.approval_result, evidence.rejected, gate.opened, gate.decided, budget.warned, budget.blocked,
budget.overridden, pr.opened, pr.updated, pr.merged, sync.completed, sync.conflict, sync.failing`.
`msg.*` data: `{from: {role, run_id?}, to: {role, run_id?}, ref_path?}`. Role `cto` = dispatcher; `user` = human.

### Usage `state/usage.jsonl` (latest line per key wins; key = agent_id, or session_id for scope session)
`{v: 1, ts, source (hook|reconcile), scope (agent|session), agent_id?, session_id, agent_type?, run_id?,
task_id?, goal_id?, role?, status (running|finished|lost), requests, by_model {<model>: {input, output,
cache_read, cache_creation, requests}}}`.
Ledger `state/ledger.jsonl`: `{ts, kind: reserve|release|override, goal_id, run_id?, tokens, by}`.
Billed-equivalent tokens = `input*w.input + output*w.output + cache_creation*w.cache_creation + cache_read*w.cache_read`,
default weights `{input: 1, output: 1, cache_creation: 1.25, cache_read: 0.1}`.
Goal spend = sum over its runs: running -> max(estimate, live snapshot); finished/lost -> snapshot.
`state/budget.json` is derived: `{goals: {G-001: {limit, spent, reserved, pct, warned_at, blocked_at}}, overhead, unattributed}`.

### Factory state `state/factory.json`
`{status: stopped|running|pausing|paused, status_changed_at, status_reason, pause_mode, tick {count,
last_begin_at, last_end_at, last_error, consecutive_errors, cadence_s, next_wakeup_at}, dispatcher
{session_id, since}, backoff_until, versions {plugin, schema}}`.
Lease `run/lease.json`: `{session_id, acquired_at, renewed_at, ttl_s: 4500, host, pid}`.

### Index `state/index.json`
Rebuilt on every mutation: `{rev, goals: {id: {status, title, priority}}, epics: {id: {goal_id, status}},
tasks: {id: {goal_id, epic_id, status, role, kind, priority, depends_on, gate_deps, files_owned,
current_run_id, updated_at}}, runs_active: [run_id], gates_pending: [gate_id]}`.

### Config `config.json`
```json
{
  "version": 1,
  "project": {"name": "", "kind": "existing", "default_branch": "main", "remote": {"provider": "github", "owner": "", "repo": ""}},
  "stack": [], "commands": {"install": null, "build": null, "test": null, "lint": null, "typecheck": null, "run": null, "e2e": null},
  "roles": {"active": ["cto", "product-manager", "...all 14"]},
  "gates": {"G1": {"enabled": true, "approvers": ["owner"]}, "G2": {"enabled": true}, "G3": {"enabled": true}, "G4": {"enabled": true}},
  "budget": {"tier_defaults": {"S": 5000000, "M": 15000000, "L": 40000000}, "warn_pct": 80, "stop_pct": 100,
             "weights": {"input": 1, "output": 1, "cache_creation": 1.25, "cache_read": 0.1},
             "estimates": {"intake": 150000, "prd": 300000, "spec": 500000, "mockup": 300000, "breakdown": 300000, "sequence": 150000,
                           "code_S": 250000, "code_M": 600000, "review": 150000, "qa": 300000, "docs": 200000, "escalation": 200000, "fixup": 150000},
             "hard_kill": false},
  "concurrency": {"total": 5, "builders": 3, "reviewers": 2, "planners": 2, "per_role": {"qa-engineer": 1, "devops-release": 1}, "max_goals_building": 3},
  "checks": {"pre_review": [], "post_merge": []},
  "delivery": {"mode": "github", "base_branch": "main", "remote": "origin"},
  "reviews": {"profile": "lean"},
  "recovery": {"orphan_after_s": 1800},
  "cadence": {"active_s": 270, "waiting_s": [900, 1800, 3600], "paused_s": 1800, "inbox_s": 120},
  "sync": {"min_interval_s": 60, "full_every_ticks": 30},
  "tracker": {"provider": "none"},
  "notifications": {"desktop": true},
  "control_center": {"port": 47610, "open_browser": true, "show_cost": false},
  "worktree": {"include_files": []}
}
```
`checks.pre_review` defaults to `[commands.build, commands.lint, commands.test]` minus nulls.

## 4. CLI surface (`node <P>/scripts/factory.mjs <cmd>`)

Global flags: `--json` (machine output), `--home <path>`. Exit codes: 0 ok, 1 validation, 2 usage,
3 lease held by another session, 4 not initialized, 5 rev conflict. Text output is terse.

| Command | Behavior |
|---|---|
| `init` | Create layout, `.gitignore`, `state/factory.json` (stopped), counters, default config if missing. Idempotent. |
| `doctor [--quick] [--reindex]` | Node >= 20, git, `.factory` valid, config valid, gh auth (github mode), path length, transcript parser self-test. `--reindex` rebuilds index and budget. |
| `config get [key]` / `config set <key> <json>` / `config merge <file>` / `config validate` | Dotted keys. `merge` deep-merges, keeps unknown keys. |
| `setup save <section> <file>` | Merge one section into `setup/answers.json`. |
| `start --session S [--takeover]` | Lease, status running, paused tasks -> ready, print next step. |
| `pause [--goal G] [--now] [--stop] --session S` | drain: status pausing; `--now`: print run ids to TaskStop, then `run checkpoint` each; `--stop`: also release lease and set stopped. Needs human intent for `--stop`. |
| `resume` | Same as start without lease change. |
| `status [--goal G]` | <= 20 lines. |
| `tick begin --session S` | Lease renew/steal, debounce (`SKIP n`), recovery, collect, telemetry reconcile, budget check, event rotation. Prints <= 8 lines. |
| `tick plan --session S` | Apply inbox, flow advance, deps, choose, reserve, render briefs. Prints `DISPATCH {json}` lines then `SYNC due|skip`. |
| `tick end --session S [--loop]` | Counters, notifications, summary <= 12 lines, last line `SCHEDULE <s>` or `NONE`. |
| `goal new --title --outcome --criteria <c>... [--priority] [--budget] [--constraint <c>...]` | Creates goal `planning` + intake task. Prints id. |
| `goal show|list|impact|activate|pause|resume|remove G [--discard] [--confirm G]` | `remove` needs human intent or a signed request. |
| `goal set G --tier S|M|L --needs-ui bool --pod <json>` | CTO only (run role check). |
| `epic new --goal G --title --summary [--depends E]` / `epic show|list` | |
| `task new --file <json>` (one task or array) / `task show|list|move|retry|cancel|answer|replan` | Validates size, ACs (1-5), files_owned overlap, cycles. `move` enforces the transition table. |
| `run show R` / `run checkpoint R` / `run stop R` | |
| `handoff validate <path>` | Same checks `collect` runs. |
| `evidence run --run R --label L -- <cmd...>` | Runs the command (shell), tees to `evidence/<label>-<n>.log`, appends index line with exit code and head SHA. |
| `gate list|show` / `gate decide <id> --decision approve|changes|reject [--notes] [--add-tokens N] [--via cli]` | Needs human intent. |
| `budget show|override G --add N` | |
| `inbox add --type T --payload <json>` / `inbox process` / `inbox list` | `add` signs human-authority types only with human intent. |
| `events tail [--n 50]` / `note "<text>"` | |
| `worktree prepare --run R` / `worktree prune [--task T|--epic E|--all-done]` | See section 6. |
| `integrate --epic E` | Deterministic serial merge of integrated-ready tasks into the epic branch + post_merge checks. |
| `pr create --epic E` / `pr poll` | gh. |
| `collect` | Apply finished runs (also run inside `tick begin`). |
| `checks run --run R` (internal, spawned detached) | Re-run `checks.pre_review` at head SHA in a CLI worktree; write `source: cli` evidence. |
| `telemetry reconcile` | Parse transcripts of active/finished runs into usage.jsonl. |
| `watch [--interval 5]` | For a plugin monitor: prints one line when an inbox file appears or a run finishes. |
| `dashboard start|stop|status|open|restart` | Delegates to `<P>/control-center/server/cli.mjs`. |
| `hook <event>` | Same as `scripts/hooks/<event>.mjs`. |

`DISPATCH` line:
```json
{"run_id":"R-000123","subagent_type":"software-factory:backend-engineer","model":"sonnet","description":"[T-0042] add VIN decoder","prompt":"FACTORY_RUN=R-000123 task=T-0042 goal=G-001 role=backend-engineer attempt=1\nRead and follow your brief: C:/repo/.factory/runs/R-000123/brief.md\nWhen done, write your handoff file, run the validate command in the brief, then reply with one line: HANDOFF <path> <status>"}
```

## 5. Flow engine (deterministic, `lib/flow.mjs`, run in `tick plan` and `collect`)

1. `goal.add` -> goal `planning`, budget = `tier_defaults.M` until intake sets the tier; task `intake` (cto).
2. intake done -> goal tier/needs_ui/pod set by the CTO via `goal set`; budget limit re-set from tier
   unless the user gave one; create `prd` (gate G1, reviews `[["critic"]]` only for tier L).
3. Task with `gate` set reaches `in_review` pass (or has no reviews) -> status `awaiting_approval`,
   open gate (or auto-approve if the gate is disabled, `auto: true`).
4. G1 approved -> goal `active`; create `spec` (gate G2; reviews critic [+ security-reviewer if risk]).
   Tier S: G1 and G2 are presented together; `spec` is created right after `prd` hands off, and both
   gates open together.
5. G2 approved -> create `breakdown` (staff-engineer); if `needs_ui` create `mockup` (gate G3).
6. breakdown done -> create `sequence` (project-manager). sequence done -> all `draft` code tasks ->
   `backlog`. Frontend tasks carry `gate_deps: ["G3"]` when needs_ui.
7. Code task: ready -> in_progress (author run) -> handoff -> `checking` (check runner) -> pass ->
   `in_review` (review groups in order) -> all pass -> (QA group if required -> `verified`) ->
   ready for integration -> `integrate` merges -> `integrated`. Any reviewer fail -> `changes_requested`
   -> `ready` (rework, same branch, findings in feedback). Checks fail -> `changes_requested` with the log.
8. All code tasks of an epic `integrated` -> epic `qa` -> task `qa_epic` -> pass -> epic `review` ->
   `review_epic` -> pass -> epic `docs` -> `docs` task -> integrated -> `pr create` -> epic `pr_open`, gate G4.
   Fail at qa_epic/review_epic -> new code rework tasks via the CTO escalation.
9. PR merged -> epic `done`, its tasks `done`, worktrees pruned; goal `done` when all epics done.
10. Budget: before each dispatch `spent + reserved + estimate > limit * stop_pct/100` -> goal
    `budget_blocked`, gate `budget` (once). 80% -> `budget.warned` once.
11. Failures: attempts >= max -> task `failed` + `escalation` task (cto). Rework > max -> escalation.
    Usage-limit / overload errors -> run `deferred`, attempts unchanged, `backoff_until` set.

Choosing work: candidates sorted by goal priority, then stage (integrate > review/qa > fixup/rework >
gate-producing > build > planning), then dependents count, then age. Skip when goal not active (except
intake/prd for planning goals), slot class full (builders: backend/frontend/data/devops/tech-writer;
reviewers: code-reviewer/security-reviewer/critic/qa-engineer; planners: cto/product-manager/
project-manager/staff-engineer/ui-ux-designer), files overlap a running run, budget blocked, backoff.

## 6. Delivery

- Epic branch `factory/E-0001-<slug>` from `<remote>/<base>` (local base when no remote); task branch
  `factory/T-0042-<slug>` from the epic branch (or `resume_from.commit`). Slugs: lowercase kebab, <= 30.
- `worktree prepare --run R` (first command in every worktree brief), run from inside the agent's
  native worktree: remove any other worktree holding the task branch; `git switch` (or `-C`) the task
  branch; merge `merge_first`; reviewers/QA get `git switch --detach <head_sha>`; record
  `worktree_path`, `branch`; write `run/branch-locks/<branch>.json`.
- `collect` for an author run: read head SHA of the task branch, record commits, remove the agent
  worktree and its `worktree-agent-*` branch, spawn the check runner. Agents never push.
- Check runner: `git worktree add --detach H/worktrees/checks-<run> <sha>`, copy `worktree.include_files`,
  run `checks.pre_review` sequentially, write evidence (`source: cli`), remove the worktree, write
  `run/checks/<run>.json {status: pass|fail, failed_command}`. Next tick moves the task.
- `integrate --epic E`: CLI worktree `H/worktrees/E-0001`; `git merge --no-ff` each ready task branch in
  dependency order; on conflict `git merge --abort` and create a `devops-release` integrate run; run
  `checks.post_merge`; push the epic branch only after the PR exists.
- `pr create`: `git push -u <remote> <epic branch>`; `gh pr create --base <base> --head <branch>
  --title "[factory] E-0001 <title>" --body-file <generated>`; body uses `Refs` links.
- `pr poll`: `gh pr view <n> --json state,mergedAt,reviewDecision,mergeable,headRefOid`.
- No remote / no gh: `delivery.mode = local`; G4 artifact = `git log --oneline base..branch` + diffstat;
  merged when `git merge-base --is-ancestor <head> <base>`.
- Agents never run `git push`, `gh pr merge`, `gh api` (broker denies).

## 7. Hooks (`hooks/hooks.json`)

Form: `{"type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<file>.mjs"], "timeout": N}`.
Every script: read stdin JSON; if `CLAUDE_PROJECT_DIR/.factory` (resolved via git common dir) does not
exist, exit 0 at once; lazy-import libs; never throw (log to `run/hook-errors.log`, exit 0).
"Factory context" = `agent_type` starts with `software-factory:` OR (`agent_id` absent AND
`session_id` == lease holder).

| Event | Matcher | File | Timeout | Behavior |
|---|---|---|---|---|
| SessionStart | `startup\|resume\|compact\|clear` | session-start.mjs | 10 | Write `run/machine.json` (non-secret `CLAUDE_PLUGIN_OPTION_*`, plugin data dir, plugin root). If this session holds the lease (or the factory is running and lease stale) print additionalContext <= 15 lines. |
| UserPromptSubmit | (none) | prompt.mjs | 10 | If the prompt starts with `/software-factory:approve`, `:remove-goal`, `:pause` (or `/approve`, `/remove-goal`, `/pause`), write `run/human-intent.json {session_id, command, at, nonce}` valid 15 min. |
| PreToolUse | `Agent` | pre-agent.mjs | 10 | Only when `tool_input.subagent_type` starts with `software-factory:`. Deny if no `FACTORY_RUN=` line, run not `dispatching`, factory not running, goal not active (except planning kinds), or a pending pause/stop inbox file exists. |
| PostToolUse | `Agent` | post-agent.mjs | 10 (async) | Parse `FACTORY_RUN=` from `tool_input.prompt`; bind `tool_response.agentId` + `tool_use_id` to the run; run -> `running`; emit `run.started` + `msg.dispatch`. |
| PreToolUse | `Bash\|Edit\|Write\|MultiEdit\|NotebookEdit\|Read` | broker.mjs | 10 | Only for `software-factory:*` agents (section 8). Main session: deny `Edit/Write` to `.factory/{state,run,inbox}/**` and `.factory/**/*.json` except via CLI; otherwise exit 0. |
| SubagentStop | `software-factory:.*` | subagent-stop.mjs | 60 | Write usage snapshot for the agent (status finished); mark the run `completed`; emit `run.ended` + `msg.handoff`. Never exit 2. |
| PreCompact | (none) | precompact.mjs | 10 | If lease holder: write `run/cto-checkpoint.md`, rebuild index. |
| SessionEnd | (none) | session-end.mjs | 5 | If lease holder: set lease `renewed_at` to 0. |
| Stop | (none) | stop.mjs | 15 (async) | Main thread + lease holder only: session usage snapshot (cursor-based). |

## 8. Permission broker (`scripts/hooks/broker.mjs`, `lib/broker.mjs`)

Applies only when `agent_type` starts with `software-factory:`, EXCEPT `software-factory:setup-interviewer`,
which returns `pass` (it is a human-attended interview, not a run, so normal Claude Code permissions
apply and the user answers any prompt). Run context = the run whose
`agent_id` matches (fallback: the newest `running` run of that role). Decision `allow` or `deny`+reason;
never "ask".
- Read: allow, except paths under the plugin data dir or matching `.env*`, `*.pem`, `*.key`, `id_*`.
- Edit/Write/MultiEdit/NotebookEdit: allow when the path is inside the run's worktree AND matches
  `files_owned` or `files_shared` (author code runs); planners/bench: allow only `H/docs/**`
  output paths in the brief and `H/runs/<run>/**`. Deny everything under `H/` that is JSON state.
- Bash: split on `&&`, `||`, `;`, `|` and check each part; allow when every part is one of:
  the CLI (`node "<P>/scripts/factory.mjs" ...` with an allowed subcommand for the role);
  an exact `config.commands.*` string or `checks.*` string, optionally prefixed by `cd "<worktree>" &&`;
  read-only git (`status, diff, log, show, rev-parse, branch --list, ls-files, merge-base, blame, grep`);
  in the run's worktree: `git add, git commit, git switch, git checkout -- <file>, git restore, git stash`
  (author runs) and `git merge` (devops-release integrate runs); `ls, cat, head, tail, wc, pwd, echo,
  grep, rg, find` without output redirection; package manager install commands from `commands.install`.
  Deny: `git push`, `gh`, `curl`, `wget`, `Invoke-WebRequest`, `node -e`, `python -c`, `rm -rf` outside
  the worktree, writes to `H/`, anything with `>` into `H/`, and everything else ("not on the factory
  allow list; ask in open_questions").
Allowed CLI subcommands per role: everyone `handoff validate, evidence run, worktree prepare, status,
task show, goal show`; cto adds `goal set, task new, task replan, task retry, task cancel, epic new, note,
gate list`; staff-engineer adds `epic new, task new`; project-manager adds `task new` (sequence edits via
`task replan`).

## 9. Agent body contract (every role file)

1. Find `FACTORY_RUN=` in the prompt. Read the brief at the given absolute path. No brief -> write
   nothing, reply `HANDOFF none blocked`.
2. Read `constitution`, then `overlay`, from the brief.
3. Worktree roles: run the brief's `setup` command first (`worktree prepare`).
4. Do the work. Use only the commands the brief and the broker allow. Evidence through `evidence run`.
5. Write `handoff.json` at `handoff_path` (Write tool). Run the brief's `validate` command; fix errors.
6. Reply with exactly one line: `HANDOFF <handoff_path> <status>`.

## 10. Skills contract

- `tick` (model-invocable, user-invocable): run `tick begin`; if it prints `SKIP`, go to step 5 with its
  number; call `factory-sync` `sync_tick` when `tick plan` printed `SYNC due` (M5); run `tick plan`; for
  each `DISPATCH` line call `Agent` with `subagent_type`, `model`, `description`, `prompt`,
  `run_in_background: true`; run `tick end`; if this turn is a `/loop` iteration, schedule the next
  wakeup with the printed seconds (or stop the loop on `NONE`). Never reason about task content.
- `start` (user only): `doctor --quick`, `start --session ${CLAUDE_SESSION_ID}`, then invoke the `loop`
  skill with `/software-factory:tick` (self-paced), and say: "This session is now the factory
  dispatcher. Keep it open."
- Others per design section 7.

## 11. Tests

`node --test plugins/software-factory/test` (core) and `plugins/software-factory/control-center/test`.
Fixtures under `test/fixtures/`. Use `FACTORY_HOME` + a temp git repo (`git init` in `os.tmpdir()`;
keep paths short). No network. gh calls are injected through `FACTORY_GH` (path to a fake script) in tests.

## 12. Contract amendments (A1, 2026-10-12, from the agent-library review)

These override earlier sections where they differ.

1. Brief fields add: `setup` (exact command or null), `validate` (exact command:
   `node "<cli>" handoff validate "<handoff_path>"`), `checks_result` ({status, evidence_index}|null, for
   reviewers: points at the check runner's `source: cli` evidence), `integrate`
   ({epic_branch, task_branches[], conflict_files[]}|null, for devops-release integrate runs; for those
   runs `files_owned` = `conflict_files`), `risk_flags[]`.
2. CLI adds (and the broker allows per role):
   - `task replan <T> --file <json>` (cto, project-manager): merge fields; editing `acceptance_criteria` bumps `ac_version`.
   - `task waive <T> --finding <F-id> --reason "<text>"` (cto only; MAJOR findings only; logged and shown at G4).
   - `task block <T> --needs human|cto|<role> --question "<text>"` (cto).
   - Read-only for every role: `status`, `task show`, `task list`, `goal show`, `epic show`, `epic list`, `budget show`, `gate list`, `events tail`.
3. Commands config adds `commands.migrate_up`, `commands.migrate_down`, `commands.screenshot`, and
   `commands.extra[]` (user-listed safe commands, asked in /setup). Broker rule: a Bash part is allowed
   when it equals a `commands.*` / `commands.extra[]` / `checks.*` string, OR starts with one of those
   strings followed by extra arguments that contain no shell operators, redirection, backticks or `$(`.
   For `factory.mjs evidence run ... -- <cmd>`, the broker applies the same rule to `<cmd>`.
   QA may start `commands.run` with `run_in_background: true` and stop it with the shell-kill tool.
4. Writes: every role may write the paths listed in its brief's `output_paths` and `H/runs/<own run>/**`.
   Code authors may also write inside their worktree within `files_owned`/`files_shared`. Tech Writer
   gets `output_paths` = [`docs/G-xxx/release-notes.md`] plus repo doc globs in `files_owned`.
5. Handoff adds `risk_flags[]` (staff-engineer spec runs). `collect` adds a `security-reviewer`
   group to that spec task when non-empty, and the staff engineer copies flags onto code tasks in
   breakdown. Security reviewer in spec mode has no worktree (`setup: null`).
6. QA verdict: any FAIL -> `fail`; no FAIL but any BLOCKED -> `escalate` with `status: blocked`; else `pass`.
7. Tools: product-manager, project-manager, ui-ux-designer and critic have `Bash` (CLI only via the broker);
   cto has `Write` (handoff only via the broker).

## 13. Contract amendments (A2, 2026-10-12, from the delivery build)

1. Tests run with globs (Node 24 rejects a folder argument):
   `node --test "plugins/software-factory/test/**/*.test.mjs" "plugins/software-factory/control-center/test/**/*.test.mjs"`.
2. Secret-file rule: `id_*` means SSH key names only (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, with or without `.pub`).
3. Broker hook matcher: `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Read|Glob|Grep`. PowerShell is
   denied for factory agents. Glob/Grep are denied on secret paths and the plugin data dir.
4. Broker denials (fixed): `git stash pop|apply|drop|clear`, `git switch` to any branch other than the
   run's own, `git commit --no-verify`, `git -c`, `$(...)` and backticks anywhere, heredocs, `find -exec|-delete`,
   `rg --pre`, writes to `run.json`, `result.json`, `brief.md` or `evidence/**` in the own run folder.
   Agent body contract adds: commit with a plain `git commit -m "<message>"`; never use `$(...)`,
   backticks or heredocs.
5. Integrate runs may write inside the CLI-managed integration worktree under `H/worktrees/`.
6. Broker ctx adds `cwd` (hook payload cwd) and `integrate` ({conflict_files}). CORE writes
   `run/branch-locks/<branch>.json` in `worktree prepare`.
7. `worktree.prepare` with `detachSha` returns `{branch: null, detached: true}`. `prCreate` may return
   `existing: true`. `mergeTasks` accepts `runDir` for post-merge evidence.

## 14. Contract amendments (A3, 2026-10-12, from the skills build)

1. Tick order (replaces §5 step 2 and §10 order): `tick begin` -> on `SKIP <n>` schedule n and stop ->
   `tick plan` (prints `DISPATCH` lines and `SYNC due|skip`) -> dispatch -> `sync_tick` only on `SYNC due`
   (its inbox files are applied next tick) -> `tick end`.
2. CLI output: `pause --now|--stop` and `goal remove` print `STOP <run_id> <agent_id>` per running run.
   `doctor` exits 0 with warnings, non-zero on failure (4 = not initialized). `goal new --criteria` repeats.
3. Dispatcher rule: a background agent's completion notice triggers one `/software-factory:tick` that does
   not call `ScheduleWakeup`. `start` states the rule; the SessionStart hook repeats it after compaction.
4. Skills that call the CLI use `allowed-tools: Bash(node:*)`. That approval lasts only for the turn that runs the skill.
5. Tracker config is an open object until M5: `provider, mode, scope, goal_mapping, labels, status
   (awaiting_sync_release | pending_credentials | ready)`.

## 15. Contract amendments (A4, 2026-10-12, from the dashboard build)

1. `inbox.processed` event data is `{request_id, type, outcome: applied|rejected|superseded|gated, reason, gate_id?}`.
2. Gate `artifact.paths[]`, task/run `report_path` and brief `output_paths[]` are relative to the factory home `H`
   (for example `docs/G-001-x/prd.md`). Repo files are given as `repo:<relative path>`.
3. The dashboard signs every inbox request. It never sends `factory.stop`.

## 16. Contract amendments (A5, 2026-10-12, from the core build)

1. `verified` on a task means "all required reviews passed; ready to integrate". In the lean profile, QA
   verifies the epic (`qa_epic`), and only a QA pass moves an epic to `verified`. Profile `thorough` adds
   task-level QA, so task `verified` then also means QA passed.
2. Extra record fields: task `pending_kind, gate_id, head_sha, checked_run_id, findings, waivers,
   conflict_files, verdict, subject_task_id`; goal `budget.user_set, status_before_block,
   status_before_pause`; run `output_paths, merge_first, detach_ref, collected_at, usage_final`.
3. G1-G3 gates have `subject.kind = task` (the producing task). Rejecting G1-G3 cancels that task and
   pauses the goal for a CTO replan.
4. A failed `qa_epic` or `review_epic` returns the epic to `building` and opens a CTO escalation. A new
   QA task is created once the rework is integrated.
5. `tick plan` integrates verified task branches every tick. A failed post-merge check creates a
   devops-release fix task.
6. `note` emits `factory.status` with `data.note`.
7. Timing: `tick begin` skips when the last tick was under 20 s ago and nothing is pending; `SKIP n` is at
   least 60. A usage-limit stop sets a 30-minute backoff. PR polling runs at most every 5 minutes per epic.
8. Inbox files are applied in `created_at` order.
9. `tick plan` may print `INBOX n ...` and `BUDGET blocked ...` lines before the `DISPATCH` lines.
10. Brief extras: `run_kind, review_role, attempt, run_dir, evidence_cmd, findings_open, head_sha`.
11. Broker: Glob and Grep are checked for secret paths and patterns and for the plugin data folder.
12. Config adds `models {all: null|model, by_role: {role: model}}` (model = opus|sonnet|haiku|inherit|claude-*).
    Order: task `model_override` > `models.by_role[role]` > `models.all` > built-in role model.

## 17. Contract amendments (A6, 2026-10-12, from the end-to-end run)

1. Platform fact: Claude Code blocks an agent with `isolation: worktree` from writing any file outside
   its worktree ("This agent is isolated in the worktree ..."), whatever the broker says. So worktree
   roles write their handoff and outputs to `<worktree>/.factory-out/` at the same relative paths.
   The brief shows `handoff_path` as `<worktree>/.factory-out/handoff.json`, adds an `outbox` field,
   and `validate` is `handoff validate --run R`. `worktree prepare` adds `.factory-out/` to the shared
   `info/exclude`. `collect` imports the outbox (handoff to the run folder, files matching
   `output_paths` to the factory home), reports skipped files, then deletes the outbox.
2. The broker allows any write under `<worktree>/.factory-out/` for a run with a worktree.
3. Node 24 `node --test <folder>` fails; the sample repo test scripts and docs use globs.

## 18. Contract amendments (A7, 2026-10-12, from the sync build)

1. Inbox types add `sync.scope_blocked`. Payloads for `tracker.*` / `sync.*` are defined in
   `scripts/lib/tracker.mjs` (the processor) and `servers/factory-sync/core/requests.mjs` (the writer).
2. `sync/state.json` uses snake_case keys (`first_sync_approved`, `last_pull_at`, `health`, `cursor`,
   `status_map`, `backoff_until`). `config.tracker.status_map` overrides the stored map.
3. Tracker config keys: `provider, mode (two_way|push_only|intake_only|dry_run), scope, goal_mapping,
   labels {managed, role_prefix, intake}, status (pending_credentials|ready), status_map, push_kinds,
   create_in, trusted_editors, human_status_changes, max_writes_per_tick, max_ops_before_confirm,
   alert_after_failures, redaction.extra_patterns, allow_tracker_approvals (false)`.
4. §14.5 `awaiting_sync_release` is dropped.
5. `sync_tick` modes: `delta | full | dry_run | rebuild_map`.
6. Draft goals are never dispatched; `goal.activate` makes them `planning`.
7. Sync emits `sync.completed` (when work happened), `sync.failing` (on entering failing health) and
   `sync.conflict` events with counts only.
8. The sync server ships as plain ES modules with no build step.
9. Not in this release: GitHub Projects v2 status field (GitHub uses open/closed plus labels), and Linear
   `project` goal mapping (Linear uses parent issues).

## 19. Contract amendments (A8, 2026-10-12, from the end-to-end run)

1. QA check scripts: the broker lets `qa-engineer` run `node <worktree>/.factory-out/qa/<file>.(m|c)js`
   and `node --test <that file>` with plain arguments only. `collect` copies `.factory-out/qa/**` to
   `runs/<id>/qa-scripts/` as evidence.
2. The imported handoff's `report_path` is rewritten from the outbox path to the home-relative path.
3. A valid handoff resets the task's fix-up counter, so one run's failures never use up another's allowance.
4. A headless (`claude -p`) dispatcher session keeps the lease while its background agents run and
   ticks on their completion notices after `-p` has returned. Another session must not tick until that
   lease is released or stale.
5. The hook timing test runs only with `FACTORY_PERF=1`; exit code and silence are always tested.

## 20. Contract amendments (A9, 2026-10-12, workspace mode and CLI worktrees)

These override earlier sections where they differ. Goal: one factory drives several git repos that
live side by side in a plain folder (a "workspace"), and one goal can span them (for example API work
in `dealerpull-api` plus UI work in `project-neo`). Classic single-repo setups keep working unchanged.

### 20.1 Locations

1. Workspace = a folder that is not itself a git repo and holds git repos (depth 1, or depth 2 under a
   plain sub-folder). Its factory home is `<workspace>/.factory`. `init --workspace` creates it at cwd.
2. Home lookup (`paths.findHome`, `paths.existingHome`): `FACTORY_HOME`; else `<main checkout>/.factory`
   when that folder exists; else the nearest ancestor of cwd that holds `.factory/config.json`
   (`paths.workspaceHome`); else `<main checkout>/.factory` (not created yet). So a CLI worktree at
   `<workspace>/.factory/worktrees/R-000123` resolves to the workspace home even though its git common
   dir belongs to a repo.
3. `paths.repoRoot(home)` keeps meaning "the folder that holds `.factory`". Code must not use it for git,
   commands or delivery. It uses `lib/repos.mjs` instead.
4. `.factory/` in a workspace is not inside any repo, so nothing is committed by default. Setup tells the
   user they may `git init` the `.factory` folder itself to share config, constitution and docs.

### 20.2 Config

```json
{
  "workspace": {"enabled": true, "default_repo": "dealerpull-api"},
  "repos": {
    "dealerpull-api": {
      "path": "dealerpull-api",
      "stack": ["dotnet"],
      "commands": {"install": null, "build": "dotnet build", "test": "dotnet test", "lint": null, "typecheck": null,
                   "run": "dotnet run --project src/Api", "e2e": null, "migrate_up": null, "migrate_down": null,
                   "screenshot": null, "extra": []},
      "checks": {"pre_review": [], "post_merge": []},
      "delivery": {"base_branch": "main", "remote": "origin", "mode": "github"},
      "remote": {"provider": "github", "owner": "org", "repo": "dealerpull-api"},
      "include_files": []
    }
  }
}
```

- `path` is relative to the workspace root (or absolute). Default: the repo name.
- Per repo, `checks.pre_review` defaults to `[build, lint, test]` minus nulls. `delivery` falls back to
  top-level `delivery`, then `default_branch`, then `main`/`origin`/`github`. `include_files` falls back
  to `worktree.include_files`.
- Workspace mode is on when `workspace.enabled` is true and `repos` is not empty. Then top-level
  `project.remote`, `stack`, `commands` and `checks` are unused (setup leaves them empty).
- Classic mode: `repos.list()` returns one implicit repo named `project.name` (or the folder name) at
  `repoRoot(home)` built from the top-level keys, so all code can use the same `repos.*` calls.
- API (`scripts/lib/repos.mjs`): `isWorkspace(cfg)`, `list(home, cfg)`, `names`, `defaultName`,
  `get(home, cfg, name|null)` (throws exit 1 on an unknown name), `nameFor(home, cfg, {task, epic, run})`,
  `forRecord(home, cfg, {task, epic, run})`, `allCommandStrings(home, cfg)`, `runWorktreeDir(home, runId)`,
  `validName(name)`. A resolved repo is `{name, path, rel, stack, commands, checks {pre_review, post_merge},
  delivery {mode, base_branch, remote}, remote {provider, owner, repo}, include_files}`. `path` is absolute
  with forward slashes.

### 20.3 Records

- Epic adds `repo` (string|null). An epic belongs to exactly one repo: its branch, integration worktree,
  post-merge checks and PR all live there. `epic new --goal G --title T --summary S --repo <name>`.
  In workspace mode `--repo` is required; in classic mode it is optional and ignored (stored null).
- Task adds `repo` (string|null). `task new` sets it from the task file, else from the epic, else null.
  A task with an epic must have the epic's repo (validation error otherwise). In workspace mode every
  code and docs task must resolve to a repo (an epic, or `repo` in the task file).
- Run adds `repo` (string|null, copied from the task's resolved repo at dispatch, null for planner runs
  without a repo) and `worktree_path` is set at dispatch (20.4).
- One goal may have epics in several repos. Epic `depends_on` may name epics in other repos.
- Epic status adds `goal_qa`. Task kind adds `qa_goal` (role qa-engineer, an epic-check kind with
  `epic_id: null`). Repo resolution order everywhere: `task.repo` > `epic.repo` > `run.repo` > default repo.

### 20.4 Worktrees: the CLI makes every worktree (replaces §0.3, §6 bullets 2-3, §17.1 first sentence)

1. No agent file uses `isolation: worktree` any more. Claude Code can only make worktrees for the
   session's own repo, which cannot serve several repos.
2. `ROLE_INFO[role].isolation` stays `worktree` for the 8 worktree roles; it now means "the CLI gives this
   run a worktree". At dispatch the run gets `worktree_path = <home>/worktrees/<run id>` (from
   `repos.runWorktreeDir`) and `repo`.
3. `worktree prepare --run R` (the brief's `setup` command, run from any cwd) creates the worktree when it
   is missing: `git -C <repo.path> worktree add --detach <worktree_path> <start>` where `<start>` is the
   detach ref/SHA for reviewers and QA, else the task branch when it exists, else
   `resume_from.commit || base_ref || epic.branch`. Then it runs the existing prepare logic with
   `cwd = worktree_path` and `repoRoot = repo.path` (free the branch from other worktrees, switch/create,
   merge `merge_first`, or detach). It adds `.factory-out/` to the repo's shared `info/exclude`. It prints
   `PREPARED <worktree_path> <branch|detached> <sha>`. Running it twice is safe.
4. The brief gives the real absolute `worktree` path (no `<worktree>` placeholder) and a `cd_prefix`
   field `cd "<worktree_path>" && `. Agents start every Bash command with that prefix (subagent shells
   may not keep a cwd between calls) and use absolute paths with Read/Edit/Write.
5. The outbox protocol (§17.1, §17.2, §19) is unchanged: worktree runs still write their handoff and
   outputs to `<worktree_path>/.factory-out/`, and `collect` imports them.
6. `collect` removes the run worktree with `worktree.remove({repoRoot: repo.path, dir: worktree_path})`
   wherever it used to remove the native agent worktree. Runs recorded before A9 (worktree path under
   `.claude/worktrees/agent-*`) still go through `removeAgentWorktree`.
7. `control.mjs`, `recovery.mjs` and `worktree prune` use `run.worktree_path` and the run's repo.
8. CLI-made checks and integration worktrees stay at `<home>/worktrees/checks-<run>` and
   `<home>/worktrees/<E-id>`, created from the epic's repo.

### 20.5 Repo-aware delivery (replaces repo-root use in §6)

- Epic branch from `<repo.delivery.remote>/<repo.delivery.base_branch>` in the epic's repo (local base
  when no remote ref). `epic.base_branch` = the repo's base branch.
- Check runner: `checks run --run R` runs the repo's `checks.pre_review` in a detached worktree of the
  repo, copying the repo's `include_files`. `integrate` runs the repo's `checks.post_merge`.
- File overlap (`choose`, `task new` validation) compares tasks only within the same repo and lists
  files with `lsFiles(repo.path)`.
- `pr create`: push and `gh pr create` with `cwd = repo.path`, base = repo base branch, remote = repo
  remote. The PR body adds a "Same goal, other repos" list with the other epics of the goal (repo, epic
  id, PR url when one exists). `pr poll` and `markMerged` use the epic's repo. Local delivery mode is
  per repo.
- Doctor (workspace mode): every repo path exists and is a git work tree; warns when
  `<home>/worktrees/R-000000` + 120 is over 240 characters; gh auth once if any repo is in github mode.
- `status` and the dashboard show the repo next to each epic and code task when in workspace mode.

### 20.6 Cross-repo QA (`qa_goal`)

1. Applies when a goal's non-cancelled epics span two or more repos. Otherwise nothing changes.
2. Where §5 step 8 would run `pr create` after the docs task is integrated, the epic instead moves to
   `goal_qa` and waits.
3. When every non-cancelled epic of the goal is in `goal_qa` (and no open `qa_goal` task exists), the flow
   creates one `qa_goal` task: role qa-engineer, `epic_id: null`, `repo: null`, title
   `Cross-repo QA for <goal id>`, acceptance criteria = the goal's success criteria (max 5, as AC-1..),
   output `docs/<goal docs>/qa/<goal id>-goal.md`.
4. Dispatch: the run's `worktree_path` is `<home>/worktrees/<run id>` used as a parent folder. `worktree
   prepare --run R` makes one detached worktree per epic at `<worktree_path>/<repo name>` on that epic's
   branch head, and records `run.repo_worktrees = [{repo, epic_id, path, branch, head_sha}]`. The brief
   adds `repo_worktrees` and `commands_by_repo {<repo>: commands}`. The outbox is
   `<worktree_path>/.factory-out/` (plain folder, not a git worktree).
5. The broker treats every `repo_worktrees[].path` as inside the run's worktree, allows each listed repo's
   commands, and allows `cd` into any of them. QA writes nothing in the repo worktrees; only the outbox.
6. Verdict pass: every epic of the goal in `goal_qa` runs `pr create` (§6) and moves to `pr_open` with its
   own G4 gate. Each G4 gate's summary names the cross-repo QA report.
7. Verdict fail: open a CTO escalation (`qa_goal failed; create rework tasks in the right epics`), and
   leave the epics in `goal_qa`. When the CTO adds rework code tasks to an epic, that epic returns to
   `building` (the normal rework path: integrate, `qa_epic`, `review_epic`, then back to `goal_qa`; a docs
   task is created only if the epic has none that is done). When all epics are back in `goal_qa`, a new
   `qa_goal` task is created (step 3). Verdict escalate: same as `qa_epic` escalate.
8. Budget estimate key `qa_goal` (default 400000). Slot class reviewers.
9. Collect removes all repo worktrees of a `qa_goal` run (each with its repo) and then the parent folder.

### 20.7 Setup

1. Phase 0: when cwd is not a git repo, run `scan-repo.mjs --workspace <cwd>`. It prints JSON
   `{root, repos: [{name, path (relative), default_branch, remote_url|null, kind}]}` for git repos at depth 1
   (and depth 2 under folders that are not repos), skipping `node_modules`, dot-folders and folders that
   are git worktrees of another repo. If it finds repos, ask: "Workspace mode with these N repos
   (Recommended) / Pick one repo instead / Stop". Workspace: `factory init --workspace`. Never `git init`
   a folder that holds repos.
2. Scan: `scan-repo.mjs --root <repo> --out .factory/setup/scan-<repo>.json` per repo. The interviewer
   reads each repo's top docs (README, CLAUDE.md or AGENTS.md) only, not every doc, to stay fast.
3. Interview: one repos question (which repos the factory may change; default all with a detected stack),
   one commands confirmation per repo that has a detected stack, asked together in as few calls as the
   4-question limit allows, then the usual sections. Config mapping writes `workspace` and `repos.*`.
4. Overlays and the constitution list the repos with their stacks and commands in a "Repos" table.

### 20.8 Agents and skills

- Every brief in workspace mode adds `workspace: true` and `repos: [{name, path, stack, base_branch}]`.
  Code-run briefs add `repo {name, path, base_branch}`, `worktree`, `cd_prefix`, and `commands` from that
  repo.
- staff-engineer: the spec has a "Repos" section (which repo owns which component). Breakdown makes one
  epic per repo per deliverable slice (`epic new --repo`), and cross-repo contracts (API shape) are
  stated in the spec and in both epics' task descriptions.
- project-manager: sequences across repos with epic `depends_on` and task `depends_on`.
- qa-engineer: `qa_goal` mode runs each repo's `commands.run` in the background from its repo worktree,
  then tests the joined flow against the goal's success criteria.
- cto: intake notes which repos a goal touches; escalations after `qa_goal` failure name the repo.
- tech-writer: docs for an epic stay inside that epic's repo.

### 20.9 Build notes (from the workspace build)

1. `init --workspace [--repos a,b]` refuses inside a git repo (exit 2). `--repos` checks each folder is a
   git repo, records its current branch as `default_branch`, sets `workspace.enabled` and `default_repo`
   (the first repo). Without `--repos`, `workspace.enabled` stays false until setup merges `repos`.
2. `run.isolation` is `worktree` only when the run really gets a CLI worktree: code and docs tasks,
   integrate runs and epic or goal checks. A spec-mode security-reviewer run is `none` and writes
   straight to the home (no outbox).
3. `qa_goal` prepare prints `PREPARED <parent> detached <n> repos`, then one `REPO <name> <path> <sha12>`
   line per repo. `run.repo_worktrees` is planned at dispatch with `head_sha: null` and filled by prepare.
   Two epics of one goal in the same repo get worktrees `<repo>` and `<repo>-<epic id>`.
4. Epic adds `goal_qa_at` (when it last entered `goal_qa`). After a failed `qa_goal`, a new one is
   created when every pending epic is in `goal_qa` and at least one re-entered it after the failure.
   Epics that got no rework never leave `goal_qa`. Pending epics exclude `pr_open`, `done`,
   `changes_requested` and `cancelled`. If the goal no longer spans 2 or more repos, epics waiting in
   `goal_qa` go straight to `pr create`.
5. Collect also removes CLI worktrees after reviews, deferred runs and closed tasks. A rejected
   handoff ("no new commits") and a blocked integrate run keep their worktree as `task.kept_worktree`,
   and the next run of that task reuses it, so unsaved work survives. Recovery also finds a handoff
   left in the outbox.
6. Brief `repo` is null for workspace planner runs and for `qa_goal`. `workspace` is always a boolean.
7. Broker: a run with a worktree is pinned to it. Every project, read-only shell and git command must
   run inside the run's worktree (or its `repo_worktrees`): the folder is the leading `cd` target, else
   the hook cwd, and for git its `-C` folder. Factory CLI calls are allowed from any folder, and a
   `--home` argument must equal the real home. Briefs add `--home "<H>"` to `setup`, `validate` and
   `evidence_cmd`. `evidence run` executes in the agent's folder when it is inside the run's worktrees,
   else in `run.worktree_path`. Home lookup checks `<X>/.factory/worktrees/` first, then the repo's own
   `.factory`, then a workspace home above the repo only when its config lists that repo. Plain `init`
   always targets the repo's own `.factory`.
   Runs without a repo allow every repo's commands. `qa_goal` runs may read and `cd` in every
   repo worktree and write only the outbox, their run folder and `output_paths`. The main-session
   state guard ignores `H/worktrees/**`.
8. `repos.<name>.stack` holds the scanner's stack objects (`path, language, frameworks,
   package_manager`), the same shape as top-level `stack`.

## 21. Contract amendments (A10, 2026-10-13, teams, streams, baseline, cycles and CTO reports)

These override earlier sections where they differ. Why (from testing 0.2.0): the CTO and the teams
ignored work already in flight (open pull requests, branches, in-progress tracker issues); the factory
only built goals, never bugs or tech debt; and Linear sync handled one team and no projects, so work
that spans teams did not sync. Every new behaviour is off or inert until its config turns it on, except
the CTO reports and the baseline, which are on by default. Classic and workspace setups without
`teams` keep working unchanged.

### 21.1 Goal kinds

1. Goal adds `kind`: `goal` (default; a missing value means `goal`) | `stream` | `ops`.
2. `ops`: exactly one per factory, title `Factory operations`, created on demand by `ensureOps(home)`
   (first `tick plan` that needs it). Status `active` at birth. No intake, no gates, never `done`.
   Holds the CTO's standing work: task kinds `assess`, `report`, `cycle_plan` (21.5-21.7). Outcome and
   success criteria are filled by the CLI (one criterion: "The team gets a baseline, plans and reports on
   time"). Docs folder `docs/ops/`.
3. `stream`: one per team that has repos, created on demand by `ensureStreams(home)` when
   `streams.enabled` (21.4). Title `<team name> maintenance`, `team: <team id>`, status `active`, never
   `done`. Holds bug and tech-debt work. Docs folder `docs/streams/<team id>/`.
4. `advanceGoal` for `ops` and `stream` goals skips R1-R6 (intake, PRD, gates, breakdown, sequence) and
   R12 (goal done), and never couples epics through `goal_qa` (cross-repo QA): stream epics each ship on
   their own. Code tasks created in a stream goal start in `backlog`, not `draft`, and a stream epic
   moves to `building` (with `ensureEpicBranch`) when its first task is created.
5. Stream epic pipeline: integrate -> `qa_epic` -> `review_epic` only when `streams.epic_review` is
   true (default false; every task already had a code review) -> no `docs` task -> `pr create` -> G4.
6. `concurrency.max_goals_building` counts only `kind: goal` goals. `tick end` and `status` list
   `kind: goal` goals first; streams and ops get one compact line each (21.10).
7. Budget windows. Goal `budget` adds `window_start` (ISO|null). When set, goal spend counts only runs
   with `dispatched_at >= window_start`. `ops`: the window rolls at each UTC midnight, limit
   `ops.budget_tokens_per_day` (default 2,000,000). `stream`: the window rolls at each cycle start of
   its team (21.6), or every 7 days when cycles are off; limit `streams.budget_tokens_per_window`
   (default 15,000,000). A roll clears `budget_blocked` for that goal (status back to `active`) and
   supersedes its open budget gate.
8. `schedule()` (tick end): stream and ops goals count as "open" only while they hold open tasks. When
   nothing else is open, the next wake is the time until the next report is due (21.7), capped at the
   largest `cadence.waiting_s`; `NONE` only when reports are off or nothing happened since the last
   report (no events other than tick events).

### 21.2 Teams

Config adds `teams`, an object keyed by team id (lowercase kebab, <= 30):

```json
"teams": {
  "product":     {"name": "Product", "kind": "product", "parent": null, "repos": [],
                  "roles": ["product-manager", "ui-ux-designer"], "tracker": {"team_key": "PRO"}},
  "engineering": {"name": "Engineering", "kind": "engineering", "parent": null, "repos": [],
                  "roles": ["staff-engineer", "project-manager"], "tracker": {"team_key": "ENG"}},
  "neo":         {"name": "NEO", "kind": "engineering", "parent": "engineering",
                  "repos": ["project-neo"], "roles": [], "tracker": {"team_key": "NEO"}},
  "api":         {"name": "Backend Services", "kind": "engineering", "parent": "engineering",
                  "repos": ["dealerpull-api"], "roles": [], "tracker": {"team_key": "OPS"}}
}
```

- `kind`: `product | engineering | support | other`. `parent`: another team id or null (deeper chains
  are allowed and walked). `repos`: repo names from `repos.list()`. `roles`: role ids this team owns
  when no repo decides (planner roles). `tracker.team_key`: the tracker team (Linear team or sub-team
  key) or null; `tracker.team_id` is filled by discovery and never asked.
- Validation: ids valid; `parent` exists and has no cycle; each repo exists and belongs to at most one
  team; each role belongs to at most one team; `team_key` is a string or null.
- No `teams` (or `{}`): one implicit team `{id: "core", name: project.name, kind: "engineering",
  parent: null, repos: <every repo>, roles: [], tracker: {team_key: tracker.scope.team_key || null}}`.
- API `scripts/lib/teams.mjs`: `list(home, cfg)`, `ids(home, cfg)`, `get(home, cfg, id)` (throws exit 1
  when unknown), `explicit(cfg)` (true when `teams` is non-empty), `forRepo(home, cfg, repo)` (the
  deepest team that lists the repo), `forRole(home, cfg, role)`, `resolve(home, cfg, {task, epic,
  goal})`, `trackerKey(home, cfg, teamId)` (the team's key, else the nearest parent's key, else null),
  `ancestors(home, cfg, id)`.
- Resolution order: `task.team` > `epic.team` > `forRepo(resolved repo)` > `forRole(task.role)` >
  `goal.lead_team` > `goal.team` (streams) > `goal.teams[0]` > the team that owns the default repo >
  the first team.
- Records: task adds `team` (set at creation from the resolution order). Epic adds `team` (from its
  repo, or given). Goal adds `teams[]` and `lead_team` (the CTO sets them at intake with `goal set G
  --teams a,b --lead-team a`; the CLI also adds the team of every new epic or task of a `kind: goal`
  goal to `teams[]`). Stream goals carry `team`.
- A goal that spans teams is a normal goal whose `teams[]` has 2+ entries: its PRD task belongs to the
  team that owns `product-manager` (by role), spec and breakdown to the lead team or the team that owns
  `staff-engineer`, and each epic and code task to the team of its repo. That is how one project runs
  across a product team and several engineering sub-teams.

### 21.3 Linear multi-team sync

1. Multi-team mode is on when the provider is `linear` and at least one team has `tracker.team_key`.
   Otherwise the single `tracker.scope.team_key` behaviour of A7 is unchanged.
2. `tracker.goal_mapping`: `parent_issue` (default, A7 behaviour) | `project`. With `project`, a goal is
   a Linear project whose `teamIds` are the tracker teams of `goal.teams` (lead team first; at least
   the lead team). When `goal.teams` grows, the project's teams are updated. Its tasks are issues with
   `projectId` set, each created in the tracker team of `task.team` (`trackerKey`), not as sub-issues.
   With `parent_issue` in multi-team mode, the goal issue lives in the lead team and each task issue in
   its own team, as a sub-issue of the goal issue.
3. Discovery is per team: states, labels, active and next cycle. Status maps are per team key
   (`sync/state.json` `status_maps {<key>: {...}}`; `tracker.status_map` may be keyed by team key, a flat
   map applies to every team). Labels are ensured and cached per team.
4. Scope key in multi-team mode is `linear:teams`. Map entries add `team` (tracker key). The scope guard
   blocks an op only when its entry's team is not a configured key. Adding a team never resets
   first-sync approval. Removing an approved team resets it (a new preview is needed), and its entries
   stay blocked (A7 `sync.scope_blocked`). Only `sync_tick` changes the stored scope key.
5. Pull covers every configured team key: delta by `updatedAt`, mapped ids (any team; an issue that moved
   between configured teams is not "missing"), intake-labelled issues (paginated), stream items (21.4),
   and, with `goal_mapping: project`, projects in those teams that carry the intake label (project
   labels) -> `tracker.intake {kind: "project", ...}` with `teams: [<team_key>...]`.
6. Linking instead of creating. Goals and tasks may carry `tracker_ref {provider, remote_id, key, url,
   kind: issue|project}`. The push planner links such a record (map entry, no create) instead of creating
   a new item. `tracker.intake` now stores `tracker_ref` on the draft goal it creates, so the source
   issue or project is linked. The `tracker.intake` payload adds `remote_id, key, url, kind, teams[]`.
7. What is pushed: `kind: goal` goals and their tasks as before (`push_kinds`). Stream and ops goals are
   never pushed. A stream item (a `triage` task with `tracker_ref`) is linked and its status is pushed
   from its effective status (21.4.6). Stream code tasks and ops tasks are never pushed. A `triage` task
   without `tracker_ref` is created in its team's tracker team when `push_kinds` includes `triage`
   (default `push_kinds` adds `triage`).
8. Snapshot. Each full pull writes `sync/snapshot.json`:
   `{v: 1, at, teams: {<key>: {name, counts {triage, backlog, unstarted, started, completed, canceled},
   in_progress: [{key, title, state, url, cycle_number|null}] (<= 20, started issues), cycle
   {tracker_id, number, starts_at, ends_at}|null}}}`. The baseline reads it (21.5). Counts cover open
   issues updated in the last 90 days.
9. `tracker_discover` accepts `scopeHint.list_teams: true` and prints one line per team
   `TEAM <key> <name> parent=<key|-> id=<id>` after a `TEAMS <n>` line (no scope check), and accepts
   `scopeHint.team_keys: [...]`, which checks every key (`SCOPE_NOT_FOUND <key>` + `available:` for the
   first missing one), stores per-team discovery and prints `READY linear <n> teams (<keys>)`.
10. No new op may close or remove anything in the tracker (the core test that bans those words stays).

### 21.4 Work streams (bugs and tech debt)

Config adds:

```json
"streams": {"enabled": false, "teams": [], "capacity_pct": 30,
            "budget_tokens_per_window": 15000000, "epic_review": false,
            "pull": "intake_label",
            "classes": {"bug": {"labels": ["bug", "Bug"]},
                        "tech_debt": {"labels": ["tech-debt", "Tech Debt", "tech debt"]},
                        "chore": {"labels": []}}}
```

1. `teams: []` means every team with repos. One stream goal per listed team.
2. Item = one `triage` task (new task kind, role `staff-engineer`, run kind `author`, no worktree, no
   reviews, no acceptance criteria required in the handoff) in the team's stream goal. Fields: `item
   {class: bug|tech_debt|chore, tracker_ref|null, reported_by: human|tracker|agent}`, `priority` (P0..P3,
   default P2), `team`, `cycle` (21.6), `item_epic_ids[]`. Output path
   `docs/streams/<team>/items/<task id>.md`.
3. Creating items: `factory item new --team <id> --class bug|tech_debt|chore --title <t> --description
   <d> [--priority P1] [--repo R] [--tracker <json tracker_ref>]` (human, cto, staff-engineer), inbox
   type `item.add {team, class, title, description, priority?, repo?, tracker_ref?}` (dashboard, CLI,
   tracker), and agent `follow_ups` with `kind: bug|tech_debt|chore` from any handoff when streams are on
   (collect turns each into an item in the team of the reporting task, `reported_by: agent`, deduped by
   title within the team). `item list [--team] [--class]` and `item show <T>` are read-only. A tracker
   item (same `tracker_ref.remote_id`) is never created twice.
4. Triage run (staff-engineer): reads the item, the team baseline and the code; writes the item note
   (repro or evidence, root cause, fix plan, risk); then either creates the fix with `epic new --goal
   <stream goal> --repo R --title <t> --summary <s> --item <triage task>` plus `task new` (code tasks,
   1-3, normal size and file rules), or hands off `blocked` with a question to the human (needs info,
   won't fix, duplicate). `epic new --item T` sets `epic.item_task_id = T` and appends the epic id to the
   triage task's `item_epic_ids[]`.
5. Pull from the tracker (multi-team or single-team Linear): an unmapped, open issue in a configured team
   that carries a class label becomes `tracker.backlog_item {remote_id, key, url, team_key, class, title,
   body, author_id, priority, cycle_tracker_id|null}` (auto-applied, `dedupe_key:
   backlog:<remote_id>`) when `streams.enabled` and `streams.pull` allows it: `intake_label` (default) =
   it also carries the intake label; `cycle` = it is in its team's active cycle; `all` = every such issue.
   The CLI applies it as `item new` with `tracker_ref` and `reported_by: tracker`; the body is kept only
   when `author_id` is a trusted editor (A7), else replaced by "See <url>".
6. Effective status of an item (used by sync and the dashboard), `streams.itemStatus(home, task)`:
   triage task not `done` -> its own status; `done` with epics -> every epic `done` or `cancelled`
   and at least one `done` = `done`; all `cancelled` = `cancelled`; any `pr_open` = `in_review`;
   otherwise `in_progress` (an epic id that cannot be read counts as open). `done` without epics ->
   `done`.
7. Capacity. In `choose`, a builder candidate from a stream goal is skipped while stream builder runs
   (running + chosen this tick) >= max(1, floor(`concurrency.builders` x `capacity_pct` / 100)) AND at
   least one `kind: goal` builder candidate is waiting. P0 items ignore the cap. With cycles on, a stream
   task (triage or code) is dispatched only when its `cycle` is its team's current cycle or it is P0
   (21.6). Code tasks created by triage inherit the triage task's `cycle` and `priority`.

### 21.5 Baseline (current state of repos, teams and in-flight work)

1. `factory baseline collect [--quiet]` writes `state/baseline.json`, `docs/baseline/factory.md` and
   `docs/baseline/teams/<team>.md` (deterministic markdown, <= 80 lines each) and emits
   `baseline.collected`. `tick begin` runs it when `baseline.enabled` (default true) and the last collect
   is older than `baseline.collect_every_s` (default 3600); `start` runs it every time and sets
   `assess_requested`. It never fails a tick: errors go into the file.
2. `state/baseline.json`: `{v: 1, at, repos: {<repo>: {team, base_branch, head_sha, recent_commits_7d,
   open_prs: [{number, title, url, head, author, draft, review_decision, updated_at, files[] (<= 50),
   factory: bool}] (<= 30), pr_error|null, branches: [{name, ahead, behind, last_commit_at}] (local,
   non-factory, ahead of base, <= 20), factory_branches}}, factory: {goals {<status>: n}, teams: {<team>:
   {tasks {<status>: n}, blocked: [{task_id, title, since, needs}], items_open, cycle|null}},
   gates_pending: [{id, type, age_h}]}, tracker: <sync/snapshot.json teams>|null}`.
   `factory: true` marks PRs whose head branch starts with `factory/`. The PR `author` is a login only.
3. `gh.prList({cwd, limit})` = `gh pr list --state open --limit <n> --json
   number,title,url,headRefName,author,isDraft,reviewDecision,updatedAt,files`. No remote, local
   delivery mode or no gh -> `open_prs: []`, `pr_error` says why.
4. Briefs (every run that resolves a team) add `team {id, name, tracker_key}` and `team_baseline`
   (home-relative path, null when no baseline yet). Code runs add `wip_conflicts: [{pr, url, title,
   files[]}]`: open non-factory PRs of the run's repo whose files intersect the task's `files_owned`
   (glob match). Every agent reads `team_baseline` at start-up; builders must not silently overwrite
   work in a conflicting PR (they name it in the handoff summary). `choose` does not block on conflicts.
5. `assess` task (kind `assess`, role cto, ops goal, run kind `escalation` so no acceptance criteria are
   required). Created by the flow when `baseline.enabled` and a baseline exists and either
   `assess_requested` is set or the last assess is older than `baseline.assess_every_h` (default 24).
   One open assess at most; creating it clears `assess_requested`. Brief adds `baseline_path`
   (`state/baseline.json` copied to `runs/<id>/baseline.json`, home-relative) and `team_baselines[]`.
   Output `docs/baseline/assessment-<YYYY-MM-DD>.md`. The CTO reconciles plans with work in flight
   (human PRs that overlap planned files, in-progress tracker issues that duplicate factory tasks, stale
   factory branches, blocked work) and may run `item new`, `task replan`, `task block`, `cycle commit`,
   `goal set --teams`, `note`. Handoff `proposals[]` allowed (21.7.4).
6. Intake, escalation and cycle_plan briefs also carry `baseline_path` (the live
   `state/baseline.json`, home-relative) when one exists.

### 21.6 Cycles

Config adds `cycles {enabled: false, source: "tracker"|"local" (default "tracker" when the provider is
linear, else "local"), length_days: 14, anchor: "2026-01-05", plan_at_start: true, review_at_end: true}`.

1. `state/cycles.json`: `{v: 1, updated_at, teams: {<team id>: {previous, current, next}}}`; each cycle
   is `{id: "<team>-<number>", team, number, name|null, starts_at, ends_at, source, tracker_id|null}` or
   null. Times are ISO; local cycles start at 00:00 UTC.
2. Local source: cycles of `length_days` from `anchor`, numbered from 1, same dates for every team.
   Tracker source: sync raises `tracker.cycles {teams: {<team_key>: {current: {tracker_id, number, name,
   starts_at, ends_at}|null, next: ...|null}}}` (auto-applied, dedupe by content hash) after discovery
   and on each full pull; the CLI maps keys to team ids (every team whose `trackerKey` is that key) and
   writes the file. A team with no tracker cycle falls back to local.
3. `cycle roll` (inside `tick begin` when cycles are on, also a CLI command) refreshes local cycles and
   detects transitions per team (current id changed since the last roll): emits `cycle.started` /
   `cycle.ended`; on start, rolls that team's stream budget window and, when `plan_at_start`, creates a
   `cycle_plan` task (ops goal, role cto, `team`, run kind `escalation`); on end, when `review_at_end`,
   creates a `report` task with `report_type: cycle_review` and that `team`. The first roll after cycles
   are enabled records the current cycles and creates `cycle_plan` tasks (no `cycle_review`). Unfinished
   tasks committed to the ended cycle keep their `cycle` value (the plan decides carryover).
4. `cycle commit <T> --cycle current|next|none|<cycle id>` (cto, human) sets `task.cycle` (for the
   task's team). With the tracker source, sync pushes the issue's `cycleId` (field `cycle`, set by the
   factory). A human change of an issue's cycle arrives as `tracker.field_update {field: "cycle", value:
   <tracker cycle id|null>}` and the CLI maps it to `task.cycle` (null when it is not a known cycle).
5. A tracker item that is in its team's active cycle when it is pulled gets `cycle` = current.
6. `choose`: when cycles are on, candidates in their team's current cycle sort before others of the
   same priority and stage; stream tasks follow 21.4.7. Goal work is never blocked by cycles.
7. `cycle show [--team T]` (read-only, every role) prints the current and next cycle per team with
   committed, done and open counts.
8. `cycle_plan` brief: `cycle`, `next_cycle`, capacity hint (builder slots, stream window budget left),
   the team's open items and goal tasks (ids, priority, size, status, cycle), and `baseline_path`.
   Output `docs/cycles/<team>-<number>-plan.md`. The CTO commits work with `cycle commit`.

### 21.7 CTO reports and self-improvement

Config adds `reports {enabled: true, every_h: 24, idle_min_h: 4, idle_min_events: 10, max_proposals:
5}`, `baseline {enabled: true, collect_every_s: 3600, assess_every_h: 24}` and `ops
{budget_tokens_per_day: 2000000}`.

1. `report` task: kind `report`, role cto, ops goal, run kind `escalation`, fields `report_type:
   periodic|idle|cycle_review|requested`, `report_period {from, to}`, `team|null`. One open report at
   most. Output `docs/reports/<YYYY-MM-DD>-<HHmm>-<report_type>.md`.
2. When the flow creates one (in `tick plan`, after `choose`; then `choose` runs again so it can
   dispatch in the same tick):
   - periodic: `reports.last_at` is null and the factory has run at least one task, or now - `last_at`
     >= `every_h`;
   - idle: nothing was chosen this tick, no active runs, no open cto task, now - `last_at` >=
     `idle_min_h`, and at least `idle_min_events` non-tick events since `last_at`;
   - cycle_review: 21.6.3;
   - requested: `factory report request` (human intent not needed; it only spends ops budget) or inbox
     `report.request {}`.
   `report_period.from` = `last_at` (or the first event), `to` = now.
   `state/factory.json` adds `reports {last_at, last_path, last_type, last_task_id}` and `baseline
   {last_collect_at, last_assess_at, assess_requested}`.
3. Metrics: `factory report data [--since ISO] [--team T] [--out <file>] [--json]` builds
   `metrics.json` (read-only; every role may run it): period; per goal and per team: tasks created, done,
   open by status; items opened and closed by class; median and p90 hours ready -> done for code tasks
   (from `task.status` events); first-pass review rate; rework count; fix-up runs; failed tasks;
   escalations; blocked tasks with age; gates pending with age; PRs opened and merged; tokens total, by
   role, by kind, by goal, dispatcher overhead, unattributed; estimate vs actual ratio by kind (finished
   runs); budget pct per goal; ticks and idle ticks. Text output <= 40 lines. Dispatch of a report run
   writes it to `runs/<id>/metrics.json`; the brief adds `metrics_path`, `report_type`, `report_period`,
   `team`, `baseline_path` and `last_report` (previous report path or null).
4. Report body (template in cto-playbook): headline (3 lines), progress, work in flight and blockers,
   cost, quality, process review (what slowed the team, with evidence), proposals. Handoff adds
   `proposals[]` (<= `max_proposals`): `{id: "P-1", title (<= 80), why (<= 400, cites metrics),
   change: {kind: "config", patch: {<dotted key>: <json value>}} | {kind: "overlay_note", role, note (<=
   300)} | {kind: "advice"}, expected_effect (<= 200), risk: low|medium|high}`. `handoff validate`
   checks this shape for every run that has `proposals`.
5. `collect` for a report or assess run: writes `reports.*` (report) or `baseline.last_assess_at`
   (assess), emits `report.published {path, report_type, proposals: n}` (report only), sends a desktop
   notification ("CTO report ready"), and opens one gate per proposal: type `improvement`, subject
   `{kind: task, id}`, goal = ops goal, `artifact {paths: [report path], summary: "<P-id> <title>:
   <why>"}`, `request {action: "proposal", proposal}`.
6. Deciding an `improvement` gate (human intent, as every gate): approve applies the change.
   `config`: each key must start with an allowed prefix (`concurrency.`, `cadence.`, `budget.estimates.`,
   `budget.warn_pct`, `reviews.profile`, `models.by_role.`, `models.all`, `streams.capacity_pct`,
   `streams.budget_tokens_per_window`, `streams.pull`, `streams.epic_review`, `ops.budget_tokens_per_day`,
   `reports.`, `baseline.`, `cycles.plan_at_start`, `cycles.review_at_end`), then `config set` and
   `config validate`; any failure rejects the whole patch (config unchanged) and the reason goes into the
   gate decision notes. `overlay_note`: appends `- <YYYY-MM-DD> <note> (from <report path>)` under `##
   Local notes` in `roles/<role>.md` (adds the heading if missing; the role must be a known role).
   `advice`: recorded only. Reject or changes: recorded. Event `improvement.decided {gate_id,
   proposal_id, decision, applied}`.
7. Gate types add `improvement`. Inbox types add `item.add`, `report.request`, `cycle.commit {task_id,
   cycle}`. Event types add `report.published`, `improvement.decided`, `cycle.started`, `cycle.ended`,
   `baseline.collected`, `item.created`.

### 21.8 New task kinds, CLI and broker

| kind | role | run kind | goal | output |
|---|---|---|---|---|
| assess | cto | escalation | ops | docs/baseline/assessment-<date>.md |
| report | cto | escalation | ops | docs/reports/<date>-<HHmm>-<type>.md |
| cycle_plan | cto | escalation | ops | docs/cycles/<team>-<number>-plan.md |
| triage | staff-engineer | author | stream | docs/streams/<team>/items/<T>.md |

Budget estimates add `assess: 250000, report: 250000, cycle_plan: 200000, triage: 250000`. Slot class
comes from the role (planners). Ops and stream tasks never block a goal. `assess`, `report` and
`cycle_plan` are allowed while the ops goal is `active` (it always is unless budget-blocked).

CLI adds: `baseline collect|show`, `item new|list|show`, `cycle show|roll|commit`, `report data|request|
list`, `goal set ... --teams a,b --lead-team a`, `epic new ... --item T --team X`, `task new` accepts
`team`, `cycle` and `item` in the file.

Broker (CLI subcommands): every role adds read-only `baseline show`, `cycle show`, `item list`, `item
show`, `report data`, `report list`. cto adds `item new`, `cycle commit` and the new `goal set` flags.
staff-engineer adds `item new` (follow-up bugs found while triaging). Writes: the CTO may write its
`output_paths` (already the rule); staff-engineer triage writes its item note (`output_paths`).

### 21.9 Setup

1. New interview call "Teams" (asked when the tracker is Linear, or in workspace mode; skipped for a
   classic repo with no tracker): first `tracker_discover` with `scopeHint.list_teams: true`; the
   interviewer proposes a team map (a product team for product roles, the parent engineering team for
   staff-engineer and project-manager, one sub-team per repo matched by name and scan hits) and asks
   up to 4 questions: confirm the team map (Recommended) or adjust; goal mapping (`project` recommended
   when 2+ teams); bugs and tech-debt streams (on at 30% capacity recommended / on at 15% / off); cycles
   (sync from Linear recommended when Linear / local 2 weeks / off). Then `tracker_discover` with
   `scopeHint.team_keys` -> `READY` sets `tracker.status: ready`.
2. The call limit becomes 7 calls (8 in workspace mode). Config mapping adds `teams`, `streams`,
   `cycles`, `tracker.goal_mapping`. Reports and baseline are on by default and named in the summary.
3. `org.md` adds a "Teams" table (team, parent, tracker key, repos, roles). The constitution names the
   teams in its "Repos" section.

### 21.10 Status, dashboard and skills

1. `status`: after the factory line, one `teams:` line (team id, current cycle number and days left)
   when cycles are on; goal rows only for `kind: goal`; one `streams:` line (`<team> <open items>
   open, <in progress> building`) when streams are on; one `ops:` line (last report age and path, last
   assess age); still <= 20 lines.
2. Dashboard: a Reports view (reports, assessments, cycle plans and team baselines from `docs/`, newest
   first, opened in the artifact viewer); `improvement` gates in Approvals with the proposal (title, why,
   change, risk); a team filter next to the repo filter; goal kind badges; current cycle chip per team.
3. Skills: `new-item` (user: add a bug, tech-debt item or chore to a team stream), `report` (user: show the
   latest CTO report and pending proposals; `--now` requests one; `--baseline` shows the factory
   baseline). `status` and `start` mention reports and the baseline.

### 21.11 Build notes (from the A10 build)

These override 21.1-21.10 where they differ.

1. "One open report at most" is per team: `team: null` is the factory-wide report, and each team may
   have one open `cycle_review`. Team report paths add `-<team>`:
   `docs/reports/<YYYY-MM-DD>-<HHmm>-<type>-<team>.md`.
2. An assessment is due only when `start` asked for one or a previous assessment exists and is older
   than `assess_every_h`. A home that never ran `start` gets no assessment on its own.
3. "The factory has run at least one task" (first periodic report) means a collected, completed run of
   a task whose kind is not `report`. Events that do not count as "something happened" are `tick.*` and
   `lock.*`; the check reads the last 500 events.
4. The broker denies `report data --out` for agents; they read stdout or the brief's `metrics_path`.
5. `item new` from the CLI records `reported_by: human` whoever runs it; only `collect` follow-ups
   record `agent`. `item new` exits 1 with `streams are off; set streams.enabled true` when streams are
   off. It prints `ITEM <T> <team> <class> <prio>`, or `EXISTS <T> (<reason>)` for a duplicate.
6. `report request` emits `factory.status` with `data.report_requested`; factory.json `reports` adds
   `requested_at`; `baseline` adds `last_assess_path`.
7. Cycle-plan briefs carry `capacity {builder_slots, stream_builder_slots, stream_window_budget_left}`
   and `team_work[]`. Tasks add `output_rel` (the home-relative output path of ops and triage tasks).
8. Sync keeps its own copy of the team rules (`trackerKey` with the parent walk) and of `itemStatus` in
   `servers/factory-sync/core/teams.mjs`. Tracker keys are upper case on both sides and compared
   case-insensitively.
9. Linked records (`tracker_ref`) are never overwritten: the sync pushes only status, cycle, comments and
   PR links to them, adds no managed or role labels and runs no parent-move check.
10. Projects get no status push and no comments. Their text goes in Linear `content`; `description`
    holds a short summary (Linear's 255-character limit). The footer lookup uses `searchableContent`.
11. `sync/snapshot.json` is written in single-team mode too, only when `baseline.enabled` is not false,
    at most every 10 minutes outside `mode: full`, and best effort (it never changes sync health).
    `counts` cover every state type for issues updated in the last 90 days, including completed and
    canceled. Titles that fail the privacy scan show as `(title hidden: <kinds>)`. A team with more than
    1,000 issues gets `truncated: true`.
12. `tracker.cycles` is raised only after first-sync approval and in every mode except `dry_run`.
    `tracker.backlog_item` is also raised in `intake_only` mode. An issue in a stream team with a class
    label and the intake label that fails the `streams.pull` rule becomes neither an item nor a goal.
13. Payloads: `tracker.intake` keeps `remote_key` next to `key`; the backlog body is markdown cut at
    4,000 characters; `cycle_tracker_id` is the issue's cycle whatever it is, and the CLI maps it.
    In `cycle` and `all` pull modes the stream queries run on full pulls only; delta pulls catch
    updates.
14. After a human cycle change the sync does not push the old cycle back before the CLI applies the
    change. Linking a task with no cycle never clears the issue's cycle. `goal_mapping: project` also
    works in single-team mode.
15. `tracker_discover` with `team_keys` prints one line per team after `READY`
    (`<KEY> <name>: <n> states, <n> labels, cycle <n>|no active cycle`). The MCP output cap rises to 120
    lines only for that tool when it reports more.
16. Dashboard: `baseline_summary` is `{at, repos: [{repo, team, open_prs, non_factory_prs, branches,
    pr_error}]}` and `config.teams` is an array of `{id, name, kind, parent, repos, tracker_key}`.
    Reports are ordered by file modified time.
17. Linked records (21.3.6) move forward only: the sync pushes a status to a linked issue or goal only
    when the target state ranks higher than the remote one, never moves a remote canceled state, and
    never pushes a canceled state; a factory cancel posts one comment instead. Linking checks the issue's
    team in single-team mode too (`sync.scope_blocked` when outside the scope).
18. Project lookup by footer lists each configured team's projects and matches the footer locally (no
    workspace-wide search). `set_teams` sends the project's current teams plus the new ones.
19. A delta pull that hits its page cap does not advance the cursor. A rejected `tracker.backlog_item`
    is raised again on a later full pull or when the stream config changes.
20. Core review fixes: the cycle gate applies only to the first author dispatch of stream `triage` and
    `code` tasks; failed reports and assessments count as open and the due checks use the last attempt
    time; `__proto__`, `constructor` and `prototype` key segments are rejected everywhere; the factory's
    own baseline, report, improvement, cycle and ops-goal events do not count as activity; `schedule()`
    counts only work `choose` could pick; with tracker cycles, a team waits for tracker data instead of
    falling back to local cycles; `goal set --teams/--lead-team` works from any active CTO run; agents
    cannot set `tracker_ref` (`item new --tracker` is human-only and `task new` drops it); quoted human
    text in baselines is fenced as data; a removed stream or ops goal is not re-created.
21. More core review details. Noise events (not activity): `tick.*`, `lock.*`, `baseline.*`, `report.*`,
    `improvement.*`, `cycle.*`, budget window events (`data.window`), report requests, error events and
    every event of the ops goal. Periodic reports and stale assessments also need activity since the last
    one or the last attempt. A report wake is never sooner than `cadence.active_s`. The cycle gate holds
    nothing when the team has no current cycle, and tasks in an item's epic inherit the item's cycle.
    With tracker cycles, a team whose sync is ready (`provider linear`, `tracker.status ready`) is
    `pending` until `tracker.cycles` arrives (`cycle show`: `current none (waiting for tracker cycles)`).
    `cycle_plan` tasks carry `plan_cycle`, not `cycle`. factory.json adds `reports.last_attempt_at`,
    `reports.last_cycle_review_at {<team>: iso}`, `reports.last_cycle_review_attempt_at` and
    `baseline.last_assess_attempt_at`; a cycle review never sets `reports.last_at`. With the ops goal
    removed, reports, assessments and cycle plans are off. Errors in follow-ups and report bookkeeping
    emit `factory.status` with `data.error`. Inbox `item.add` rejects a bad `cycle` or `tracker_ref`.

