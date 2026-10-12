# software-factory

An AI software factory for Claude Code. A CTO agent turns your goals into work
for 14 role agents. The agents plan, design, build, review and test code in git
worktrees. You approve at four gates and merge the pull requests.

## What you get

- **15 agents:** CTO, Product Manager, Project Manager, Staff Engineer, UI/UX
  Designer, Data Engineer, Backend Engineer, Frontend Engineer, DevOps /
  Release, Tech Writer, Critic, Code Review, Security Reviewer, QA Engineer,
  and a Setup Interviewer.
- **10 commands:** `/setup`, `/start`, `/pause`, `/new-goal`, `/remove-goal`,
  `/approve`, `/status`, `/sync`, `/control-center`, `/tick`.
- **Gates:**
  - Four human gates: G1 PRD, G2 architecture spec, G3 UI mockups, G4 merge.
  - A budget gate, which opens when a goal reaches its token budget.
  - A destructive-action gate, which opens before any work is discarded.
- **Proof, not claims.** The factory re-runs your build, lint and tests itself
  before any review. Only QA can mark work verified.
- **A local control center** at `http://127.0.0.1:47610`. It has:
  - a kanban board;
  - a live org chart that shows messages moving between agents;
  - token use per goal, role and model;
  - approvals, goal management and an activity feed.

## Requirements

- Claude Code 2.1.296 or newer (the version it was tested on).
- Node.js 20 or newer on your PATH. Nothing to install with npm.
- git. For pull requests: the GitHub CLI (`gh`), logged in.
- A trusted folder. Run `claude` once in the repo and accept the trust prompt.
- On Windows, keep repos at short paths. Deep paths break git worktrees.
  `git config --global core.longpaths true` helps.

## Install

```bash
/plugin marketplace add jay-stacey/claude-plugins
/plugin install software-factory@personal-plugins
```

## Quick start

1. Open Claude Code in your repo and run `/software-factory:setup`.

   Setup does three things:
   - It scans the repo: stack, commands, CI, CLAUDE.md, ADRs (short architecture decision records) and CODEOWNERS.
   - It asks about 10 questions.
   - It writes the `.factory/` folder.
2. Add a goal: `/software-factory:new-goal Add CSV export to the reports page`.
3. Open a new session for the factory. Run `/software-factory:start` there.
   That session is now the dispatcher. Keep it open, and use it only for the factory.
4. Watch it work: `/software-factory:control-center`.
5. Approve gates in the control center or with `/software-factory:approve`.
6. Merge the pull request on GitHub. The factory sees the merge and closes the work.

## How it works

```
goal -> CTO intake -> PRD -> G1 -> spec (+ Critic) -> G2 -> mockups -> G3
     -> breakdown into epics and tasks -> build in worktrees
     -> factory re-runs checks -> Code Review (+ Security) -> merge into epic branch
     -> QA on the epic -> epic review -> docs -> pull request -> G4 (you merge) -> done
```

- **The tick.** The dispatcher session runs a short loop step every few minutes.
  - A Node CLI reads `.factory/`.
  - It applies your approvals, picks ready work and writes a brief for each task.
  - The session launches the agents in the background.
  - When nothing is running, the loop sleeps longer.
- **Handoffs.** Each agent writes a handoff file and ends with one line. The
  CLI checks the handoff and re-runs the tests at that exact commit.
- **Permissions.** A hook (the permission broker) allows known-safe commands for
  factory agents and denies everything else with a reason. Agents do not stall
  on prompts. Your normal sessions are not affected.
- **Budgets.** Each goal has a token budget. The defaults are 5M for small, 15M
  for medium and 40M for large goals. You get a warning at 80%. At 100%, new
  work stops until you approve more.

## Commands

| Command | What it does |
|---|---|
| `/setup` | Scans and interviews. Re-run a part with `--section <name>`. Start over with `--reset`. |
| `/start` | Makes this session the dispatcher and starts the loop. Also resumes after a pause. |
| `/pause` | Default: no new work starts, and running agents finish. Flags below. |
| `/new-goal` | Adds a goal. The CTO sizes it and the Product Manager writes the PRD. |
| `/remove-goal` | Shows the impact, asks you to confirm, stops the goal's work. `--discard` also deletes its branches. |
| `/approve` | Approve, request changes on, or reject an open gate. |
| `/status` | A short text status. |
| `/sync` | Tracker sync: preview, health, full reconcile. |
| `/control-center` | `start`, `stop`, `status`, `open` or `restart` the local dashboard. |
| `/tick` | One loop step. The loop calls this itself. |

`/pause` flags:
- `--now` stops running agents and saves a checkpoint.
- `--stop` also ends the loop.
- `G-001` pauses one goal.

## What lives in `.factory/`

| Path | What it is | Committed |
|---|---|---|
| `config.json` | Team settings | yes |
| `constitution.md` | Your non-negotiable rules | yes |
| `org.md` | Mission and reporting lines | yes |
| `roles/<role>.md` | Per-repo notes for each role. Plugin updates never touch them. | yes |
| `docs/` | PRDs, specs, mockups, reviews, QA reports | your choice |
| everything else | Working state: goals, tasks, runs, events, usage | no (gitignored) |

The factory never commits in your checkout. Pull request branches never
touch `.factory/`.

## Safety

- Agents never push, merge to your base branch, or call `gh`. The CLI pushes
  and opens pull requests itself.
- Gates, merges and deletes need your intent. The dashboard signs your
  requests. Agents cannot forge an approval.
- No secrets are copied into worktrees by default. Agents cannot read `.env`,
  key files or the plugin's data folder.
- The dashboard binds to `127.0.0.1` only and needs a fresh token each start.

## Settings

Run `/plugin configure software-factory@personal-plugins` to change these settings:
- tracker keys (stored as secrets);
- a machine cap on parallel agents;
- desktop notifications;
- the sync kill switch.

Repo settings live in `.factory/config.json`. To trade quality for cost, set
`models.all` (for example `"haiku"`) or `models.by_role` (for example
`{"code-reviewer": "opus"}`). Change them with
`/software-factory:setup --section <name>`.

## Developing

- Read `docs/contracts.md` first. It is the build spec.
- Run the tests:

  ```bash
  node --test "plugins/software-factory/test/**/*.test.mjs" "plugins/software-factory/control-center/test/**/*.test.mjs"
  ```

- To see the dashboard with sample data, run:

  ```bash
  node plugins/software-factory/control-center/server/cli.mjs start --demo
  ```
