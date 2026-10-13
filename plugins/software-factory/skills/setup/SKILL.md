---
name: setup
description: Sets up software-factory for this repo, or for a folder that holds several git repos (workspace mode) - scans the codebase, interviews the user (mission, rules, roles, gates, budget, tracker, teams) in about 12-16 short questions, and writes .factory/ (config, constitution, org chart, role overlays). Use when the user asks to set up, configure, reconfigure or re-scan the factory, or when .factory/config.json is missing.
argument-hint: "[--reset] [--section <name>] [--new] [--no-scan]"
context: fork
agent: setup-interviewer
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, mcp__plugin_software-factory_factory-sync__tracker_discover
model: sonnet
---

# Setup

Set up the software factory for the repo in the current working directory, or for the folder that holds
several repos (workspace mode, Phase 0). Arguments: `$ARGUMENTS`.

Commands (run exactly as written; `<repo>` is the absolute repo root from Phase 0. In workspace mode
`<repo>` is the workspace folder, the folder that holds `.factory/`, and each repo is `<repo>/<repo path>`):
- CLI (written `CLI` in the reference files): `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" <cmd>`
- Scanner: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" <args>`

References (read when the phase says so):
- Questions: `${CLAUDE_PLUGIN_ROOT}/skills/setup/references/questionnaire.md`
- Scan rules: `${CLAUDE_PLUGIN_ROOT}/skills/setup/references/scan.md`
- Templates: `${CLAUDE_PLUGIN_ROOT}/skills/setup/references/templates/constitution.md`, `org.md`, `role-overlay.md`

## Arguments

| Argument | Effect |
|---|---|
| (none) | Full setup. On a re-run, saved answers are the defaults. |
| `--reset` | Back up, then ignore saved answers (Phase 0 step 6). |
| `--section <name>` | Re-run one section and regenerate only the files that depend on it. |
| `--new` | Treat the repo as new (no scan proposals). In workspace mode it applies to every repo. |
| `--no-scan` | Reuse `.factory/setup/scan.json` (workspace mode: every `scan-<name>.json`) if present; do not re-scan. |

Section names and what they regenerate: `scan` (config commands + stack, overlays, constitution
coding standards), `commands` (config, overlays), `mission` (org.md), `goals` (inbox requests only),
`constitution` (constitution.md), `team` and `gates` (config, org.md, overlays), `budget` (config),
`tracker` (config), `teams` (config `teams`, `tracker.goal_mapping`, `streams`, `cycles`; org.md;
constitution), `roles` (overlays only), `pointer` (CLAUDE.md line). Unknown name: list these and stop.

## Phase 0: Preflight (no questions unless noted)

1. `git rev-parse --show-toplevel` gives `<repo>`. Inside a git repo: classic mode, go to step 2.
   Not a git repo: this may be a workspace, a plain folder that holds several git repos. Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" --workspace "<cwd>"` (`<cwd>` is the
   absolute current folder; it prints JSON and writes nothing).
   - `repos` is empty: say "This folder is not a git repo and holds none." Ask (one question)
     "Run `git init` here?" Yes: run it and use classic mode. No: stop.
   - `repos` has entries: show them (name, path, stack hint if known, default branch) and ask (one
     question) "Workspace mode with these <N> repos (Recommended) / Pick one repo instead / Stop".
     - Workspace mode: `<repo>` is `<cwd>`. Keep the `repos` list; it feeds Phase 1. Step 4 runs
       `init --workspace`.
     - Pick one repo instead: tell the user to start Claude Code in that repo (or `cd` there if the
       session can) and run `/software-factory:setup` again. Stop.
     - Stop: stop.
   - Never run `git init` in a folder that holds repos.
2. `node --version` must be 20 or later. If not, say so and stop.
3. `gh auth status` (record only: logged in or not). Never print token text.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" init` (workspace mode: `init --workspace`, run in `<cwd>`).
   It is idempotent and creates `.factory/` with default config.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get` (current config) and Read `<repo>/.factory/setup/answers.json` if it exists.
   Answers present = re-run mode. If some sections are unfinished, the first question is
   "Resume at <section> (<n> sections left) / Review everything / Start over".
6. `--reset`: copy `config.json`, `constitution.md`, `org.md`, `roles/` and `setup/answers.json` from
   `<repo>/.factory/` into `<repo>/.factory/setup/backup-<yyyymmdd-hhmmss>/` (Bash `cp -r`), then treat
   the run as fresh. Never touch goals, tasks, gates, inbox or sync.
7. Path checks: if `<repo>` is longer than 180 characters, warn: "Worktrees may fail on this long
   path. Run `git config core.longpaths true` or move the repo to a shorter path." If `<repo>`
   contains `OneDrive`, warn: "OneDrive sync can lock files while agents work. Move the repo outside
   OneDrive." Show warnings once, in plain words, and go on.
   Workspace mode: the factory puts worktrees at `<repo>/.factory/worktrees/R-000000`. Warn when that
   path plus 120 characters is longer than 240 ("Worktrees may fail on this long path. Move the
   workspace folder to a shorter path."). Same OneDrive warning.
8. The repo is new when `--new` is given, or the scan says `kind: new`. In workspace mode each repo
   has its own `kind`.

## Phase 1: Scan (no questions)

Read `references/scan.md` first.
Workspace mode: do steps W1-W3 instead of steps 1-4.
- W1. Unless `--no-scan` (with existing scan files), run once:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" --workspace "<repo>" --scan-all --out-dir "<repo>/.factory/setup"`.
  It scans every repo and writes `.factory/setup/scan-<name>.json`. Read each scan file. A repo with
  `scan_error` gets no proposals; say so and go on.
- W2. For each repo read only its top docs: `README.md`, and `CLAUDE.md` or `AGENTS.md`. Skip every
  other doc. Take mission, conventions (tagged with the repo name), testing, security and forbidden
  areas, all with `<repo name>/<file>:<line>` sources. Write notes to `<repo>/.factory/setup/scan-notes.md`
  with one `### <repo name>` block per repo under each heading.
- W3. Save: write `{"scan_rev": {<name>: <scan_rev>, ...}, "kind": {<name>: <kind>, ...}, "repos": <the repos list>}`
  to `.factory/setup/pending/answers-scan.json` and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" setup save scan <that file>`.
Classic mode:
1. Unless `--no-scan` (with an existing scan.json): run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" --root "<repo>" --out "<repo>/.factory/setup/scan.json"`. Then Read the scan.json.
2. Read the repo docs that scan.json lists, as `scan.md` says (you read them yourself; no sub-agent).
   Extract mission, conventions with `file:line` sources, testing, security and forbidden areas,
   glossary, and roadmap candidates.
3. Write those notes to `<repo>/.factory/setup/scan-notes.md` (machine-local; reused by `--section`).
4. Save: write `{"scan_rev": ..., "kind": ..., "proposed": <scan.proposed>}` to
   `.factory/setup/pending/answers-scan.json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" setup save scan <that file>`.

## Phases 2-8: Interview

Read `references/questionnaire.md`, then ask its calls in order, skipping what it marks conditional.
Workspace mode: use the "Workspace branch" of call 1 in place of the single-repo call 1.
Call 7 (Teams) runs when the tracker is Linear or in workspace mode. With Linear, call
`tracker_discover` with `scopeHint.list_teams` before call 6 and with `scopeHint.team_keys` after
call 7, as the questionnaire says. At most 7 AskUserQuestion calls, 8 in workspace mode.
After each call: write that section's answers to `.factory/setup/pending/answers-<section>.json`
(include `"completed": true` and every source you showed) and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" setup save <section> <file>`.

## Phase 9: Generate

1. Config. Build one patch with only the keys setup owns (questionnaire "Config mapping"; workspace
   mode: "Workspace config mapping"). From call 7 it adds `teams` (unless the user chose one team),
   `tracker.goal_mapping`, `streams` and `cycles`. Write it to
   `.factory/setup/pending/config.json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config merge <file>`, then `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config validate`.
   On a validation error, fix the patch once and merge again.
2. Seed goals. For each goal the user chose: `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" inbox add --type goal.add --payload '<json>'` with
   `{title, outcome, success_criteria[], priority, constraints[], notes: "seeded by /setup"}`.
   The goal is created on the first tick.
3. Markdown. For `constitution.md`, `org.md`, and `roles/<role>.md` for every active role (files under
   `<repo>/.factory/`):
   - Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" --check <file>`.
   - `MISSING` or `UNCHANGED`: Write the new file from its template, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/scan-repo.mjs" --stamp <file>`.
   - `EDITED` or `NO_HASH`: Write the new version to `<name>.proposed.md`, show
     `git diff --no-index -U1 <file> <name>.proposed.md` (first 40 lines), and ask "Keep mine
     (Recommended) / Take new / Keep both". Take new: copy the old "Local notes" section into the
     proposed text, Write it over the file, stamp it, delete the `.proposed.md`. Keep mine: delete the
     `.proposed.md`. Keep both: leave both and say so. Ask once for all overlays together if more
     than one is edited.
   - Roles that are no longer active: leave their overlay file; say it is unused.
   - Workspace mode: the constitution and every overlay get the "Repos" table from their template
     (one row per repo the factory may change). Classic mode: leave the Repos section out unless
     config has `teams`; then the constitution's Repos section names the teams only.
   - `org.md` gets the "Teams" table when config has `teams` (team, parent, tracker key, repos, roles).
4. Pointer. If the user said yes and `CLAUDE.md` or `AGENTS.md` exists at `<repo>` (not asked in
   workspace mode, where `<repo>` is not a repo), append with Edit:
   `This repo runs software-factory. Agents follow .factory/constitution.md; do not hand-edit .factory/ state while the loop runs.`
   Skip if the line is already there.
5. Doctor. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" doctor`. Show its warnings (path length, OneDrive, gh auth, git) in plain words.
6. Summary, at most 15 lines:
   - What was written (paths relative to `<repo>`) and what was kept.
   - Active roles, gates on, budget sizes, builders at once.
   - "The factory's permission broker approves factory-agent commands, so no allow rules were added to
     your settings. Agents can run your build, test, lint and other listed commands (with extra
     arguments), but not arbitrary shell commands."
   - Tracker line from the questionnaire (sync ships later, or credentials needed).
   - Teams: one line per team (id, tracker key, repos), plus streams and cycles as chosen.
   - "The CTO collects a baseline of open pull requests and in-flight work every hour, and writes a
     report every day. Read it with /software-factory:report; approve its proposals with
     /software-factory:approve."
   - Classic mode: "Commit `.factory/` so your team shares the setup." (Only the allow-listed files are tracked.)
   - Workspace mode: "`.factory/` is not inside any repo, so nothing is committed. To share it with your
     team, make `.factory` its own git repo (`git init` inside `.factory`)." Say it; never run it.
     Also list the repos the factory may change and the default repo.
7. Last line, exactly one of:
   - No goals yet: `Next: run /software-factory:new-goal to add the first goal.`
   - Otherwise: `Next: run /software-factory:start in a session you keep open for the factory.`
