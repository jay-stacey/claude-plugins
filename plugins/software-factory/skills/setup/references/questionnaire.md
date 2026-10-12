# Setup questionnaire

Question wording, options, branching and the config each answer writes. Six AskUserQuestion calls
at most. A typical existing repo answers 12 questions. Sample values come from `scan.json`; replace
them with the real proposals and their sources.

Option rules: recommended option first with "(Recommended)"; on a re-run the saved value first with
"(current)", and the fresh scan value as "(detected now)" when it differs. "Other" is automatic.

## Call 1: Confirm the scan (section `scan` + `commands`)

Before the call, show at most 12 lines: stack per package, remote and default branch, CI file,
the commands with their sources (install, build, test, lint, typecheck, run, e2e, migrate_up,
migrate_down, screenshot; skip nulls), the number of rules found in docs, ADR count, UI and data
signals.

1. [Scan] "Is this summary right? Commands come from CI first, then package scripts, then framework
   defaults."
   - Looks right (Recommended)
   - Fix some items (then ask, one plain line each, only about the items the user names)
   - Wrong; ask me item by item
2. [Extra cmds] "Agents may run only the commands above (plus extra arguments). Are there other safe
   commands they should be allowed to run, for example a code generator or a seed script?"
   - None (Recommended)
   - Yes, I will list them (the user types them in "Other"; one per line or comma-separated)
   Reject any extra command that contains `&&`, `||`, `;`, `|`, `>`, backticks or `$(`; say why.
3. [Verify] Conditional: ask only when build or test came from framework defaults (no CI or script
   evidence). "Run build and test once now to confirm they work? It runs repo code and takes a few
   minutes."
   - Run them once now (Recommended)
   - Skip
   If run: use the Bash tool from `<repo>`; show pass or fail per command, and on a failure ask one
   plain question for the right command.

Config: `project`, `stack[]` (path, language, frameworks, package_manager), `commands.*`
(including `migrate_up`, `migrate_down`, `screenshot`; null when unknown), `commands.extra[]`
(default `[]`), `delivery` (mode `github` when the remote is GitHub and gh is logged in, else
`local`; `base_branch` = default branch; `remote` = remote name), `worktree.include_files`
(only if the user says yes below).

Env follow-up: when `proposed.worktree_include` is set, add this to call 1 as a 4th question:
[Env file] "Tests here may need your local `.env`. Copy it into agent worktrees?" Options: "No
(Recommended)", "Yes, copy .env". The file is never read by setup either way.

### New-project path (replaces call 1)

1. [Stack] TypeScript/Node, .NET, Python, Go
2. [App type] Web app, API service, CLI or library, Monorepo
3. [Remote] "Use an existing remote URL" (user types it), "Local only (Recommended)",
   "Create a GitHub repo with gh" (say it runs `gh repo create` and ask once more before running it).
Commands come from the stack (Node: `npm ci`, `npm run build`, `npm test`, `npm run lint`; .NET:
`dotnet restore`, `dotnet build`, `dotnet test`; Python: `uv sync`, `pytest -q`, `ruff check .`;
Go: `go mod download`, `go build ./...`, `go test ./...`, `go vet ./...`). Show them and ask
[Commands] "Use these commands?" Use them (Recommended) / Edit some. Add a seed goal "Bootstrap
repo: scaffold, CI and test harness" in call 2 as the recommended option.

## Call 2: Mission and goals (sections `mission`, `goals`)

4. [Mission] "One sentence for what this product does and for whom."
   - The README candidate, quoted, with its source (Recommended)
   - Skip for now
   (The user types their own in "Other".)
5. [Seed goals] "Start with goals now? Each goal still goes through PRD approval (G1)."
   - With roadmap candidates: multiSelect of up to 3 candidates (each with its source) plus
     "None; I will add goals later". The user can type more in "Other".
   - Without candidates: "None; I will use /software-factory:new-goal later (Recommended)" and
     "I will type 1 to 3 goals" (one per line in "Other").
   For each chosen goal, draft the outcome and 2-4 success criteria yourself; priority P2.

## Call 3: Constitution (section `constitution`)

6. [Testing] "Every code task must..."
   - Add or update tests and pass the full suite (Recommended)
   - Pass the existing suite; tests encouraged
   - Tests for logic only, not UI
7. [Security] multiSelect, all recommended:
   - No secrets or personal data in code, logs, fixtures, tickets or commits
   - New dependencies need approval at the spec gate (G2)
   - Security review on any change to auth, payments, permissions or secrets
   - Block a merge on high or critical dependency audit findings
8. [Forbidden] multiSelect, all recommended:
   - Force-push or rewrite shared history
   - Change CI/CD, infrastructure or deploy config without G2
   - Run migrations or scripts against non-local databases
   - Change public API contracts without an approved spec
Coding standards are not asked: use the rules found in the docs plus the linter configs, each with
its source. Say so in one line before the call ("I found 14 coding rules in CLAUDE.md and 2 linter
configs; they go into the constitution with their sources").

## Call 4: Team and gates (sections `team`, `gates`)

9. [Team] "Which roles are active? These 10 are always on: CTO, Product Manager, Project Manager,
   Staff Engineer, DevOps/Release, QA, Code Reviewer, Security Reviewer, Critic, Tech Writer."
   - The scan proposal, naming the added builders and why (Recommended)
   - All 14 roles
   - Custom (follow-up multiSelect of the 4 optional roles: Backend, Frontend, Data, UI/UX)
   At least one builder (Backend, Frontend or Data) must stay on.
10. [Gates] multiSelect, all checked by default:
    - G1 PRD approval
    - G2 Spec approval
    - G3 UI mockup approval (recommended only when UI/UX is active; say "no UI detected" otherwise)
    - G4 Pull request review before merge
    Unchecking G4 shows: "Without G4 you will not be asked before a factory PR is ready. You still
    merge on GitHub." Unchecking G1 or G2 shows: "The factory will plan and build without your review."
11. [Approvers] Conditional: only when CODEOWNERS lists more than one owner.
    - Only me (Recommended)
    - Me and the code owners: <first 3 owners>

Config: `roles.active[]`, `gates.G1..G4.enabled`, `gates.G1.approvers` (`["owner"]` or
`["owner", ...owners]`).

## Call 5: Budget, parallel work, tracker (sections `budget`, `tracker`)

12. [Budget] "Token budget per goal size? The CTO sizes each goal S, M or L."
    - Standard: S 5M, M 15M, L 40M (Recommended)
    - Lean: S 2M, M 6M, L 15M
    - Generous: S 10M, M 30M, L 80M
13. [Parallel] "How many builder agents may work at once?"
    - 3 (Recommended)
    - 1 (lowest cost, slowest)
    - 5 (needs the machine cap `max_parallel_agents` of 7 or more)
14. [Tracker] "Which tracker should the factory mirror goals and tasks into?"
    - The scan recommendation first, with its evidence, for example "Linear (Recommended): NEO-123
      style keys in 41 commits" or "GitHub Issues (Recommended): #refs found and gh logged in"
    - None, local only (Recommended when the scan found nothing)
    - The other two of Linear / GitHub Issues / Jira (keep 4 options total)

Config: `budget.tier_defaults {S, M, L}` in tokens; `concurrency.builders` = answer and
`concurrency.total` = builders + 2; `tracker.provider` = `none | linear | github | jira`.

## Call 6: Tracker details and pointer (conditional; sections `tracker`, `pointer`)

Skip the call when the tracker is None and there is no CLAUDE.md or AGENTS.md.

15. [Scope] Only when a tracker was picked.
    - Linear: team key options ranked by scan hits (for example "NEO (Recommended): 41 commits").
    - Jira: project key options ranked by scan hits.
    - GitHub: "This repo: <owner>/<repo> (Recommended)".
16. [Sync mode] Only when a tracker was picked.
    - Two-way (Recommended)
    - Push only: a mirror for people to watch
    - Intake only: pull new issues labelled `factory-intake`, push nothing
    - Dry run: plan and log, write nothing
17. [Pointer] Only when CLAUDE.md or AGENTS.md exists.
    "Add one line to <file> so other Claude sessions know the factory runs here?"
    - Add the line (Recommended)
    - Skip

Tracker status, decided after the call. Call `mcp__plugin_software-factory_factory-sync__tracker_discover`
with `{projectDir, tracker, scopeHint}` (scopeHint: Linear `{team_key}`, Jira `{project_key}`, GitHub
`{owner, repo}`). Its first line decides:
- `READY ...`: `tracker.status = "ready"`. Show its status-map line. Summary line: "The first sync is
  preview only: run /software-factory:sync --preview."
- `PENDING_CREDENTIALS missing: <keys>`: `tracker.status = "pending_credentials"`. Summary lines: "Add
  <keys> with `/plugin configure software-factory@personal-plugins`, run `/reload-plugins`, then
  `/software-factory:setup --section tracker`."
- `SCOPE_NOT_FOUND`: ask question 15 again with the `available:` keys as options.
- `SYNC disabled` or `ERROR`: `tracker.status = "pending_credentials"`; show the line.
- The tool does not exist in this session: `tracker.status = "pending_credentials"`. Summary line: "Run
  /reload-plugins so the factory-sync server starts, then /software-factory:setup --section tracker."
Keys per tracker: Linear `linear_api_key`; GitHub none if gh is logged in, else `github_token`;
Jira `jira_site`, `jira_email`, `jira_api_token`.

Config: `tracker = {provider, status, mode: two_way | push_only | intake_only | dry_run,
scope: {team_key} | {project_key} | {owner, repo}, goal_mapping: parent_issue (Linear, GitHub) |
epic (Jira), labels: {managed: "software-factory", role_prefix: "role:", intake: "factory-intake"}}`.
Not asked (defaults): `push_kinds` (prd, spec, mockup, code, docs), `create_in: "mapped"`,
`trusted_editors: []` (tracker comments become task feedback only for these user ids),
`max_writes_per_tick: 20`, `max_ops_before_confirm: 50`. The status map lives in `.factory/sync/state.json`;
`tracker.status_map {key: stateId}` overrides it.

## Not asked (defaults, said once in the summary)

- Review depth `reviews.profile = "lean"` (change with `CLI config set reviews.profile '"thorough"'`).
- Notifications: `notifications.desktop = true`; the per-machine switch is the
  `desktop_notifications` plugin option.
- Permissions: no settings allow rules are written; the broker approves factory-agent commands.

## Config mapping (the only keys setup writes)

`project`, `stack`, `commands` (all keys, `extra` as an array), `roles.active`, `gates.G1-G4`
(`enabled`, `G1.approvers`), `budget.tier_defaults`, `concurrency.builders`, `concurrency.total`,
`delivery`, `tracker`, `worktree.include_files`. Leave every other key alone; `config merge` keeps it.
Commands values must be strings or null. Sources go in the answers files and overlays, never in config.
