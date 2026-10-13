# software-factory: merged design (final)

Date: 2026-10-12. Status: approved design; build not started.

User decisions 2026-10-12 (round 4): tracker sync ships in M5; review profile default `lean`;
permissions via the broker hook only (no settings allow rules); G4 merge by the user on GitHub
(`/approve` may merge after a second confirmation). Sources: 00-decisions.md, A-runtime.md, B-agents.md,
C-setup-sync.md, D-control-center.md, Critic 1 (consistency), Critic 2 (feasibility).
A's runtime is the spine. Where this file and an architect doc differ, this file wins.

## 1. One-paragraph summary

`software-factory` is a generic Claude Code plugin. `/setup` scans a repo, interviews the user and writes
`.factory/` (constitution, org, config, role overlays). `/start` turns one dedicated Claude Code session
into the dispatcher. A loop "ticks": a Node CLI reads `.factory/`, syncs the tracker, applies inbox
requests, picks ready work and writes briefs. The session then launches background role agents
(14 roles plus a CTO judgment agent). Each agent works from a brief, writes a handoff file, and ends with
one line. Hooks validate handoffs, record tokens, broker permissions and block unsafe actions. The CLI
re-runs checks itself, so "done" is proven, not claimed. Work stops at 4 human gates (PRD, spec, mockups,
merge) plus budget and destructive gates. A local web control center shows the kanban, a live org chart
with message pulses, token use, and lets the user approve, add goals and pause.

## 2. Design rules (non-negotiable)

1. The disk is the brain. Any fresh session resumes from `.factory/` alone.
2. Only the CLI writes state JSON. Agents, skills, the dashboard and sync go through it or the inbox.
3. One level of agents. Role agents never get the `Agent` tool. Chain of command is data.
4. Fresh agent per task, with a written brief. No agent reads another agent's transcript.
5. The checker is never the author. Bench roles get the artifact and criteria, never the author's reasoning.
6. Proof is produced by the CLI, not typed by agents. The CLI re-runs checks at the branch head SHA.
7. Human intent is required for gates, merges and destructive actions. Agents cannot forge it.
8. Hooks and guards act only on factory agents and the lease-holding session. Normal sessions are untouched.
9. Keep the dispatcher context tiny: tick body <= 40 lines, CLI output <= 12 lines, agent final message = 1 line.

## 3. Architecture

Components:
- Dispatcher session (main Claude Code session after `/start`). Runs `tick`. Calls `Agent`, the sync MCP
  tool and the wakeup. Holds the lease.
- `factory` CLI: `node <plugin>/scripts/factory.mjs`. Node 20+, built-ins only. All deterministic logic.
- Role agents (background subagents). Builders run in git worktrees.
- `cto` agent (Opus). Judgment only: intake and tiering, epics and pods, escalations, replans.
- Hooks (`hooks/hooks.json`, `command: "node"` + `args`). Guard, broker, validate, record.
- `factory-sync` MCP server (stdio, bundled, no deps). Holds tracker secrets. Two-way sync.
- Control center (local Node server, 127.0.0.1, token). Reads `.factory/`, writes signed inbox requests.
- Check runner: detached Node process the CLI starts to re-run build/lint/test at a SHA.

## 4. Pipeline (goal to merged code)

```
/new-goal or dashboard or tracker intake
  -> goal (draft/planning)            CTO agent: tier S/M/L, pod roster
  -> PRD task (Product Manager)       Critic lane prd (L tier only)
  -> G1 approve PRD (human)
  -> Spec task (Staff Eng + Data)     Critic lane spec, Security if risk-flagged
  -> G2 approve spec (human)          small tier: G1+G2 on one screen, two records
  -> Mockups (UI/UX) if needs_ui      Critic lane design
  -> G3 approve mockups (human)       backend tasks do not wait for G3
  -> Breakdown (Staff drafts, PM sequences) -> epics + tasks, file ownership map, budget forecast
  -> per task: build in worktree -> CLI checks at SHA -> Code Review (+ Security if flagged)
       -> (UI tasks: QA) -> CLI merge into epic branch (agent only on conflict) -> integrated
  -> per epic: QA on integrated branch -> verified -> Tech Writer docs -> PR (gh) -> G4 (human merges)
  -> PR merged -> epic done -> goal done when all epics done
```

Budget gate can open at any dispatch. Destructive gate opens on remove-goal --discard, destructive
migrations, and tracker cancels.

## 5. Engine (the loop)

- `/start`: `factory doctor --quick`, take lease, set `running`, then start the loop by invoking the
  built-in `loop` skill with `/software-factory:tick` (self-paced). Tells the user: keep this session
  open and dedicated.
- Each loop iteration runs `tick` and calls `ScheduleWakeup` exactly once (or stops the loop).
  Ticks triggered by agent completion notifications never call `ScheduleWakeup`.
- Accelerator (if the spike proves it): a plugin monitor (`monitors/monitors.json`,
  `when: on-skill-invoke:start`) runs `factory watch`, which prints one short line when an inbox file
  lands or a run completes, so the session wakes without waiting for the timer.
- Cadence: 270 s with runs active; 900 s then 1800 s then 3600 s when waiting on the human;
  1800 s when paused; stop when idle. Dashboard requests shorten the next wake to 120 s.
- Fallback if the loop proves unreliable: Desktop scheduled task, one fresh session per tick.

Tick steps (all CLI except the 3 model steps):
1. `factory tick begin --session ${CLAUDE_SESSION_ID}`: lease, debounce, recovery (transcript mtime +
   live background list; never orphan own-session runs on time alone; mark "suspect" one tick),
   collect completed runs, reconcile usage (incl. running agents), budget check, rotate events at 20 MB.
2. MODEL: call `factory-sync` `sync_tick` (only if a tracker is configured and due). Sync writes only
   `sync/*` and inbox requests. It refuses unless the caller holds the lease.
3. `factory tick plan`: apply inbox (verify signatures), dependencies, choose work, reserve, render
   briefs. Prints one JSON dispatch line per run.
4. MODEL: call `Agent` (background) per dispatch line. Hook binds `agent_id` to the run.
5. `factory tick end`: write counters, notifications, print <= 12 lines + `SCHEDULE n|NONE`.
6. MODEL: `ScheduleWakeup(n)` if this is a loop iteration.

Escalations (failed after retries, reviewer stalemate after 3 rounds, replan needs) go to the `cto` agent
as a normal run. The dispatcher never reasons about them inline.

Choosing work: priority P0..P3, then stage (integrate > review > rework > gate-producing > new build),
then dependents, then age. Skip when: goal not active; slot class full (total 5, builders 3, reviewers 2,
planners 2, qa 1); files_owned intersect a running run (real glob intersection on the file list, plus
`files_shared` hotspots); budget would exceed limit; global rate-limit backoff active.

Usage-limit and overload errors make the run `deferred`, never count as an attempt, and set a global
backoff until the limit resets.

## 6. Roles (agent library)

Role id = agent file name = overlay name. Agents dispatched as `software-factory:<id>`.

| id | model / effort (lean default) | tools | isolation | feeds |
|---|---|---|---|---|
| cto | opus / high | Read, Glob, Grep, Bash | none | intake, escalations |
| product-manager | opus / medium | Read, Glob, Grep, Write, Edit, WebSearch, WebFetch | none | G1 |
| project-manager | sonnet / low | Read, Glob, Grep, Write, Edit | none | breakdown, forecast |
| staff-engineer | opus / high | Read, Glob, Grep, Write, Edit, Bash, WebSearch, WebFetch | none | G2 |
| ui-ux-designer | sonnet / medium | Read, Glob, Grep, Write, Edit | none | G3 |
| data-engineer | sonnet / medium | Read, Glob, Grep, Write, Edit, Bash | worktree | G2 data, build |
| backend-engineer | sonnet / medium | Read, Glob, Grep, Write, Edit, Bash | worktree | build |
| frontend-engineer | sonnet / medium | Read, Glob, Grep, Write, Edit, Bash | worktree | build |
| devops-release | sonnet / low | Read, Glob, Grep, Write, Edit, Bash | worktree | CI tasks, merge conflicts |
| qa-engineer | sonnet / medium | inherit; disallowedTools Edit, NotebookEdit, Agent | worktree (detached) | verified |
| code-reviewer | sonnet / medium per task; opus at epic | Read, Glob, Grep, Bash, Write | worktree (detached) | G4 |
| security-reviewer | sonnet / high | Read, Glob, Grep, Bash, Write, WebSearch, WebFetch | worktree (detached) | G2 risk, G4 |
| critic | opus / high | Read, Glob, Grep, Write | none | G1-G3 |
| tech-writer | sonnet / low | Read, Glob, Grep, Write, Edit, Bash | worktree | G4 |
| setup-interviewer | sonnet | Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion | none | /setup |

Org chart: User > CTO > Product line (PM > UI/UX), Delivery line (Project Manager), Engineering line
(Staff > Data, Backend, Frontend, DevOps, Tech Writer), Assurance bench (Critic, Code Review, Security,
QA; report only to the CTO). Pods: per-goal roster in the goal record; the dashboard draws them.

Every agent file: 120-200 lines. Sections: frontmatter, identity, start-up reads (brief, constitution,
overlay), inputs, method, outputs, definition of done, never, when stuck, final message.
Precedence: role Never rules + factory-protocol > constitution > brief > overlay > playbooks.

Review profile (config `reviews.profile`):
- lean (default): code review per task (Sonnet) + one Opus epic review; QA per epic on the integrated
  branch, per task only for UI tasks; Critic on spec/design/tasks, on PRD only for L tier.
- thorough: Opus code review per task; QA per task; Critic on every artifact.

## 7. Skills

User-facing (10): setup, start, pause (`--now`, `--stop`, `G-xxx`), new-goal (main session, no fork),
remove-goal, approve, status, sync, control-center, tick (model-invoked; manual single tick).

Preloaded, not user-invocable (v1): factory-protocol, evidence-rules, critique-method, review-checklist,
artifact-templates (PRD, spec, design, tasks, QA, review; S/M/L in references/), cto-playbook.
v1.1: backend-, frontend-, data-, devops-, docs-playbook (stack references). Overlays carry the repo stack
in v1. Each preloaded SKILL.md <= 150 lines; one-line descriptions.

## 8. `.factory/` layout

Committed (allow-list in `.factory/.gitignore`): `config.json`, `config.schema.json`, `constitution.md`,
`org.md`, `roles/`, `docs/`, `setup/answers.json`, `sync/map.json`.
Ignored: everything else.

```
.factory/
  config.json  config.schema.json  constitution.md  org.md
  roles/<role>.md                       overlays (setup writes; "Local notes" never rewritten)
  docs/G-001-<slug>/prd.md spec.md design/ critique/ reviews/ qa/ questions/ release-notes.md
  goals/G-001.json  epics/E-0001.json  tasks/T-0001.json  gates/GATE-0001.json
  runs/R-000001/{run.json, brief.md, handoff.md, result.json, checkpoint.md, evidence/}
  state/{factory.json, index.json, counters.json, usage.jsonl, ledger.jsonl, budget.json}
  inbox/*.json  inbox/processed/  inbox/rejected/
  events/events.jsonl  events/archive/
  sync/{map.json, state.json, outbox.jsonl, log-YYYY-MM.jsonl, preview.md}
  setup/{answers.json, scan.json}
  run/{lease.json, mutex/, human-intent.json, machine.json, cto-checkpoint.md, control-center.json}
  worktrees/E-0001/                     CLI-managed integration worktrees
```

`.factory/` is found with `git rev-parse --git-common-dir`, so every worktree resolves the main one.
In workspace mode (v0.2) it sits in a plain folder of repos and is found by walking up to `.factory/config.json`.
PR branches must never touch `.factory/`. The factory never commits in the main checkout.

## 9. Canonical contracts

All records: `schema, id, rev, created_at, updated_at`. snake_case. IDs G-001, E-0001, T-0001, R-000001, GATE-0001.

Goal: `title<=80, slug, outcome<=600, success_criteria[1-7], constraints[], priority P0..P3,
status{draft|planning|awaiting_g1|active|paused|budget_blocked|done|cancelled}, status_reason, tier S|M|L,
pod{product, tech_lead, members[]}, needs_ui, docs{prd,spec,design}, gates{G1,G2,G3}, gate_policy,
budget{limit_tokens, warn_pct=80, stop_pct=100}, created_by{kind, via}, epics[]`.

Epic: `goal_id, title, slug, summary, depends_on[], status{draft|building|integrating|qa|verified|pr_open|
changes_requested|done|cancelled}, branch factory/E-0001-<slug>, base_branch, pr{number,url,state,head_sha,
review_decision,merged_at}, gates{G4}`.

Task: `goal_id, epic_id|null, kind{prd|spec|mockup|breakdown|code|test|docs|release|research|pr_feedback},
title<=80, description<=1200, role, size S|M|L, priority, acceptance_criteria[{id:"AC-1", text}],
ac_version, files_owned[], files_shared[], files_read[], depends_on[], gate_deps[], gate|null, risk_flags[],
reviews_required[[role]], reviews{role:{verdict, run_id, round, at}}, status, status_reason, attempts,
max_attempts=3, rework_count, max_rework=3, estimate_tokens, model_override, branch, base_ref,
current_run_id, runs[], blocked{reason, question_id, needs, since}|null,
resume_from{branch, commit, checkpoint_path}|null, feedback[{source, ref, path, at}], answers[]`.

Task status: `draft, backlog, ready, in_progress, checking, in_review, changes_requested, verified,
integrated, awaiting_approval, done` + side `blocked, paused, deferred, failed, cancelled`.
Key rules: `checking` = CLI re-runs checks at head SHA; only QA sets `verified`; `integrated` = merged into
epic branch; `done` only when the epic PR merges (code) or the gate is approved (artifacts).

Run: `task_id, goal_id, epic_id, kind{author|review|qa|integrate|escalation|rebase}, role, subagent_type,
model, status{dispatching|running|suspect|completed|invalid_handoff|failed|deferred|orphaned|stopped},
session_id, agent_id, tool_use_id, dispatched_at, started_at, ended_at, isolation, worktree_path, branch,
head_sha, brief_path, handoff_path, stop_blocks, estimate_tokens, exit{reason, message}`.

Dispatch prompt (exactly 3 lines):
```
FACTORY_RUN=R-000123 task=T-0042 goal=G-003 role=backend-engineer attempt=2
Read and follow your brief: <abs>/.factory/runs/R-000123/brief.md
Finish by writing your handoff file, then reply with one line: HANDOFF <path> <status>
```
Agent `description` starts with `[T-0042]`.

Brief (CLI-rendered, front matter): `run_id, task_id, goal_id, epic_id, role, kind, tier, round,
factory_home (abs), cli (abs path to factory.mjs), constitution, overlay, goal_outcome,
acceptance_criteria, files_owned, files_shared, files_read, setup (exact command), base_ref, branch,
evidence_required, commands{build,test,lint,run}, diff_cmd (reviewers), artifacts{prd,spec,design},
output_paths[], feedback[], answers[], resume_from, handoff_path, token_hint`. Body: task description and
the overlay inlined (<=150 lines).

Handoff (`runs/<id>/handoff.md`, `factory/handoff@1`, body <= 10 lines): `run_id, task_id, goal_id,
from_role, to_role=cto, status{handed_off|blocked|partial|failed}, verdict{pass|fail|escalate}|null,
acceptance_criteria[{id, met, evidence[ev_id]}], evidence[ev_id], files_touched[], branch, base_ref,
commits[], findings[{id, severity{blocker|major|minor|nit}, file, line, text, fix}], report_path,
open_questions[{id, to_role, blocking, question, assumed}], follow_ups[{title, kind, reason}],
destructive{what}|null, resume_note, tokens_used (hook fills)`.

Evidence index (`runs/<id>/evidence/index.jsonl`, written only by `factory evidence run` and the check
runner): `{id, label, command, exit_code, log_path, head_sha, source{agent|cli}, at}`. Gate-relevant
proof is `source: cli`.

Gate: `type{G1|G2|G3|G4|budget|destructive|tracker}, subject{kind, id}, goal_id,
status{pending|approved|rejected|changes_requested|superseded}, opened_at, opened_by, artifact{paths[],
pr_url, summary<=600, diffstat}, request{add_tokens_suggested, action, impact[]},
decision{by, via{cli|dashboard|tracker|github}, at, notes, add_tokens}|null, auto`.

Inbox request (`inbox/<ts>-<id8>-<type>.json`, tmp then rename): `schema, id, created_at,
source{dashboard|cli|tracker|setup}, actor{kind, name}, type, payload, dedupe_key, needs_confirmation,
auto_apply, sig (HMAC for human-authority types)`. Types: `gate.decide, goal.add, goal.activate,
goal.remove, goal.pause, goal.resume, factory.pause{mode}, factory.resume, factory.stop, budget.override,
task.note, task.answer, task.retry, task.cancel, task.pause, sync.now, tracker.intake, tracker.field_update,
tracker.status_change, tracker.scope_change, tracker.comment, tracker.missing, tracker.conflict,
tracker.config_drift, sync.first_sync, sync.bulk_confirm, sync.redaction_blocked`.
`needs_confirmation` requests become `tracker` gates, so /approve and the dashboard handle them.
Result on move: `result{status{applied|rejected|superseded|gated}, reason, tick, gate_id}`.

Event (`events/events.jsonl`, one line <= 4 KB, lock-free append): `v, id(ulid), ts, type,
source{cli|hook|server|sync|reconcile}, session_id, actor{kind, role, run_id, agent_id}, goal_id, epic_id,
task_id, run_id, msg<=140, data{}`. Types: tick.started/finished, lock.acquired/stolen/released,
factory.status, inbox.processed{request_id, outcome}, goal.status, epic.status, task.created,
task.status{from,to}, run.dispatched/started/ended/lost/deferred, msg.{dispatch|handoff|question|answer|
review_request|review_result|rework|escalation|approval_request|approval_result}{from, to, ref_path},
evidence.rejected, gate.opened/decided, budget.warned/blocked/overridden, pr.opened/updated/merged,
sync.completed/conflict/failing.

Usage snapshot (`state/usage.jsonl`, latest per agent_id wins): `ts, source, scope{agent|session},
agent_id, session_id, agent_type, run_id, task_id, goal_id, role, status{running|finished|lost},
requests, tool_calls, by_model{model:{input, output, cache_read, cache_creation, requests}}, hours{}`.
Ledger (`state/ledger.jsonl`): only `reserve | release | override` lines.
Spend per run: running = max(estimate, live snapshot); finished/lost = snapshot.
Billed-equivalent tokens = input + output + 1.25 x cache_creation + 0.1 x cache_read (weights in config).

Config (`config.json`), owners: C owns `project, stack, commands, packages, roles, tracker,
notifications, worktree`; A owns `gates{G1..G4:{enabled, approvers}}, budget{tier_defaults{S,M,L},
warn_pct, stop_pct, weights, estimates{prd, spec, mockup, code_S, code_M, review, qa}, hard_kill},
concurrency{total, builders, reviewers, planners, per_role, max_goals_building}, checks{pre_review[],
post_merge[]}, delivery{mode, base_branch, remote}, reviews{profile}, recovery, cadence, sync{min_interval_s,
full_every_ticks}`; D owns `control_center{port, open_browser, show_cost}`.
Defaults: budget tiers S 5M, M 15M, L 40M. Estimates prd 300k, spec 500k, mockup 300k, code S 250k,
code M 600k, review 150k, qa 300k. Code tasks above M are rejected ("split it").

## 10. Hooks (final)

All `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<event>.mjs"]}`.
Each exits in < 50 ms unless `CLAUDE_PROJECT_DIR/.factory` exists AND (agent_type starts with
`software-factory:` OR session holds the lease). Libraries lazy-imported.

| Event | Matcher | Sync | Job |
|---|---|---|---|
| SessionStart | startup/resume/compact/clear | sync | Re-inject <= 15 lines of dispatcher state; write `run/machine.json` (non-secret userConfig) |
| UserPromptSubmit | all | sync | Record human intent for /approve, /remove-goal, /pause (15 min) |
| PreToolUse | Agent | sync | Dispatch guard: factory running, goal active, no pending pause, run is `dispatching`, header present |
| PostToolUse | Agent | async | Bind `agent_id` + `tool_use_id` to the run |
| PreToolUse | Bash, Edit, Write, MultiEdit, NotebookEdit, Read | sync | Permission broker + write guard (section 11) |
| SubagentStop | software-factory:.* | sync, 60 s | Validate handoff (exit 2, cap 2), write usage snapshot, emit run.ended + msg.handoff |
| PreCompact | all | sync | Write `run/cto-checkpoint.md`, flush index |
| SessionEnd | all | sync | Release lease if held |
| Stop | main thread | async | Session usage snapshot (dispatcher overhead) |

## 11. Safety

- Permission broker (PreToolUse, factory agents only). Allow: the factory CLI with known subcommands;
  exact `config.commands.*` strings; read-only git; `git add/commit/switch/merge/rebase` inside the run's
  own worktree on `factory/*` branches; Edit/Write inside the run worktree AND within `files_owned`
  (reviewers: only their report paths). Deny with a reason: everything else, including `node -e`,
  network tools for web-capable roles, writes to `.factory/` state, reads of the HMAC key.
  Result: no prompts stall background agents, and file ownership is enforced, not just requested.
- Human intent: `/approve`, `/remove-goal`, `/pause` write an intent token via UserPromptSubmit. Dashboard
  requests are HMAC-signed by the server; the key lives in `${CLAUDE_PLUGIN_DATA}`. The CLI rejects
  unsigned human-authority requests.
- Merges: agents never merge to the base branch. `gh pr merge` and `gh api` merge calls are denied for
  agents. Recommend GitHub branch protection as the real G4 enforcement.
- No `.env` copied into worktrees by default. No broad allow rules in settings. /setup may write narrow
  rules to `.claude/settings.local.json` only, with consent.
- Tracker text is data: only `trusted_editors` content reaches briefs, quoted with provenance.
- Redaction on all outgoing tracker text (emails, phones, Luhn numbers, VINs, secret prefixes).
- Never delete in a tracker. First sync is preview-only. Bulk guard at 50 ops or 5 cancels.
- Checkpoint commits run hooks normally; on hook failure, save a patch instead of `--no-verify`.
- Plugin hooks scoped to factory activity; /setup enables the plugin per project with consent.

## 12. Delivery

- Epic branch `factory/E-0001-<slug>` from `origin/<base>`. Task branch `factory/T-0042-<slug>`.
- `factory worktree prepare --run R` (first brief command): removes any stale worktree holding the branch,
  switches to the task branch from the epic branch (or `resume_from`), performs `merge_first` merges,
  takes a per-task branch lock. Reviewers and QA get a detached checkout of the head SHA.
- After a handoff: CLI check runner re-runs `checks.pre_review` at head SHA (tokens: 0).
- Integration: the CLI merges task branches into the epic branch serially and runs `checks.post_merge`.
  A `devops-release` agent runs only on conflict or failing post-merge checks. Lockfiles regenerate.
- PR: `factory pr create --epic E` pushes and runs `gh pr create` with a generated body (goal, AC table,
  evidence table, review verdicts, waived majors, risks, rollback). Body uses `Refs` links, never `Closes`.
- G4: the user merges on GitHub. `/approve` can merge only after a second explicit confirmation.
  `factory pr poll` detects merge, changes requested (creates `pr_feedback` task), conflicts, close.
- No remote: `delivery.mode: local`; G4 shows `git log` + diffstat; the user merges locally.
- Worktrees pruned when the task reaches `done`.

## 13. Pause, resume, stop

- `/pause` (drain): stop new dispatch at once (guard also reads pending pause requests), let runs finish.
- `/pause --now`: TaskStop runs, checkpoint (commit or patch), tasks `paused`, `resume_from` set.
- `/pause --stop`: confirm, `--now`, release lease, end loop. Only `/start` restarts.
- `/pause G-001`: pause one goal.
- `/start` is idempotent and resumes.

## 14. /setup

Fork to `setup-interviewer` (sonnet). Phases: preflight (git, node, gh) -> scan (`scan-repo.mjs`:
remotes, manifests, CI steps, commands, lint config, CLAUDE.md/AGENTS.md/README/CONTRIBUTING/SECURITY,
ADRs, CODEOWNERS, PR template, UI/migration/IaC/E2E signals; never reads secrets) -> confirm scan ->
mission + seed goals -> constitution -> team + gates -> budget + concurrency -> tracker -> notifications +
permissions -> generate. About 10-12 questions on an existing repo. Writes through `factory config merge`
and `factory setup save`. Re-run: answers become defaults; `--section <name>`; `--reset` backs up;
user-edited files shown as diff, "Keep mine" recommended. Secrets only via `/plugin configure`.
New-project path asks stack, app type, remote, and seeds "Bootstrap repo" goal.

## 15. Tracker sync (two-way)

- `factory-sync` stdio MCP server; secrets from `userConfig` (sensitive) via MCP env.
- Adapters: none, linear (GraphQL), github (gh api; Projects v2 status optional), jira (REST v3).
- Tools: `sync_tick`, `sync_preview`, `sync_apply_preview`, `tracker_discover`, `sync_status`.
- Mapping: goal = parent issue (Linear/GitHub) or epic (Jira); task = issue (filtered by kind); status map
  captured in setup; `role:<id>` label; assignee stays human; handoff = 8-line comment; PR link attached.
- Ownership: title/description/AC shared and gated; status factory-owned while in progress; priority,
  due date, assignee, human labels human-owned (auto-apply); human comments become requests.
  Human cancel/done/rework moves become `tracker` gates. Gate approval from the tracker is off.
- Echo suppression by hash of the returned normalized value; dedupe keys; `sf-id: T-0042` footer for
  crash recovery; outbox with backoff; rate-limit aware; audit log stores field names only.
- Cadence: delta pull each tick (min 60 s), push outbox, full reconcile every 30 ticks, `/sync --full`.

## 16. Control center

- `node <plugin>/control-center/server/cli.mjs start|stop|status|open|restart --project <dir>`.
- 127.0.0.1 only, random token per start, Host/Origin checks, no CORS, strict CSP, no-referrer,
  sandboxed iframes for mockups, path-checked artifact reader, 16 KB body cap.
- Data: polls `state/index.json`, gates, budget and the events offset every 1-2 s; pushes via SSE.
- Writes only signed inbox requests (plus its own run file and log).
- UI (no build, vendored Preact + htm, SVG): Board (kanban + epic strip), Team (org chart with animated
  message pulses, pods mode in v1.1), Tokens (totals, per goal vs budget with 80/100 markers, per role,
  per model, hourly), Approvals (G1-G4, budget, destructive, tracker; artifact viewer), Goals (add, pause,
  remove with typed confirmation), Activity feed. Dark/light, WCAG AA, reduced motion.

## 17. Milestones

- M0 Spike (throwaway `sf-spike` plugin): proves loop re-entry, broker, SubagentStop exit 2 on background
  agents, worktree state after commit-only agents, monitor wake, idle tick cost, AskUserQuestion in fork,
  laptop sleep. Kill criteria pick the engine.
- M1 Core runtime: CLI, schemas, lifecycle, tick, hooks, broker, checks runner, delivery, budget, pause.
- M2 Agent library: 15 agent files, 6 preloaded skills, 10 user skills.
- M3 /setup: scanner, interviewer, templates, overlays.
- M4 Control center: server, 6 views, telemetry reconcile.
- M5 Tracker sync: factory-sync MCP, Linear + GitHub adapters, preview, ownership, redaction.
- M6 Validation: repo CI rules, node tests, plugin validators, end-to-end run on a sample repo.
- Later: Jira adapter, stack playbooks, custom roles, mod telemetry, Agent Teams, multi-goal portfolio.

## 18. Top risks

1. Loop reliability on `ScheduleWakeup` (spike M0).
2. Dispatcher overhead tokens (dedicated session, tiny tick, monitor wake).
3. Transcript format is undocumented (versioned parser, doctor check).
4. Worktree auto-cleanup semantics (CLI-managed fallback).
5. Tracker normalization false conflicts (fixture tests per adapter).

## 19. Workspace mode (v0.2)

Why: real systems often span several repos that sit side by side, for example a .NET API and two
Angular apps. A goal such as "website hosting" needs backend and frontend work in different repos, and
the factory must plan, build, test and ship that work as one goal.

Decisions (spec: contracts.md section 20):
- The factory home can live in a plain folder that holds the repos. Config lists each repo with its own
  stack, commands, checks and delivery settings. One-repo setups keep the old shape.
- An epic belongs to one repo, so one epic ships as one pull request in one repo. A goal can own epics in
  several repos, and epics can depend on epics in other repos.
- The CLI makes every agent worktree itself. Claude Code's built-in worktree isolation only works for the
  session's own repo, so it cannot serve a workspace. The permission broker is now the only wall that
  keeps an agent inside its worktree. It already checked every write and command; tests cover the new
  layout. One code path serves both modes.
- Cross-repo QA: when a goal's epics span repos, each epic is tested and reviewed on its own, then waits.
  When all are ready, one QA run checks out every epic branch side by side, runs the apps together and
  tests the goal's success criteria end to end. Only then are the pull requests opened.

## 20. Teams, streams, baseline, cycles and reports (v0.3)

Why: testing 0.2.0 on a real system showed three gaps. The CTO and the teams did not look at work
already in flight (open pull requests, branches, in-progress tracker issues), so plans collided with
it. The factory only built goals, so bugs and tech debt waited forever. Linear sync handled one team
and no projects, so a goal that spans a product team and several engineering sub-teams did not sync.

Decisions (spec: contracts.md section 21):
- Teams are config: a team owns repos (and, for planner work, roles), may have a parent team, and maps
  to one tracker team or sub-team. Every task and epic resolves to a team. A goal lists its teams and a
  lead team. Setup proposes the map from the Linear team tree and the repo names.
- A goal that spans teams becomes one Linear project across those teams (`goal_mapping: project`). Each
  issue is created in the team that does the work. Records that came from the tracker carry a
  `tracker_ref`, so the sync links them instead of creating duplicates.
- Bugs and tech debt run in one standing "stream" goal per team. Each item gets a cheap triage run by
  the staff engineer, which writes a note and creates a small epic with 1-3 code tasks. The normal
  build, review, QA and PR path follows, without the goal gates or docs. Streams use at most a share of
  the builder slots (30% by default) while goal work waits, and their budget rolls each cycle.
- The CTO's standing work (assessments, cycle plans, reports) lives in one "ops" goal with a daily
  budget, so every task and run still belongs to a goal and the existing budget, brief and dispatch
  code paths serve it unchanged.
- Baseline first: the CLI collects a deterministic snapshot of each repo (open pull requests with their
  files, branches ahead of base, recent commits), the factory (work by team, blocked work, waiting
  gates) and the tracker (in-progress issues per team). Every agent reads its team's baseline, and code
  runs see the open pull requests that touch their files. The CTO assesses it at start and daily.
- Cycles come from Linear (or a local calendar). At a cycle start the CTO commits work for each team;
  at its end the CTO writes a cycle review. Cycles order work; they only gate stream items.
- The CTO uses idle ticks: when nothing else runs, or once a day, it writes a report on progress, work
  in flight, cost and quality, reviews the process, and proposes up to five improvements. Each proposal
  is a gate. Approving a config proposal applies an allow-listed config change; an overlay note is added
  to a role's local notes; advice is recorded. The user decides; the CTO never changes its own rules.

