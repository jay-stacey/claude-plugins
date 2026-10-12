# Scan rules

How to use `scan.json` and the repo docs. The scanner collects facts; you add judgement from the docs.

## What the scanner does (`scripts/setup/scan-repo.mjs`)

- Walks at most 5,000 paths and reads at most 64 KB per file. Skips `node_modules`, `bin`, `obj`,
  `dist`, `build`, `.git`, `vendor`, `.venv`, `target`, `.factory`, `.claude` and similar folders.
- Never opens secret-like files: `.env*` (except `*.example`, `*.sample`, `*.template`), `*.pem`,
  `*.key`, `*.pfx`, `secrets.*`, `appsettings*.json`, `id_*`, `.npmrc`, `.pypirc`, `.netrc`,
  `*.tfvars`, `*.tfstate`. It only counts them (`secret_like_files_skipped`).
- Reads git: remotes (credentials stripped), default branch, last 500 commit messages and branch
  names for tracker keys, tracked source file count.
- Output: `.factory/setup/scan.json` (`schema: factory/scan@1`), machine-local and regenerated.

## Fields you use

| Field | Use |
|---|---|
| `kind` | `new` (no commits or under 10 tracked source files) switches to the new-project path |
| `stack[]` | `{path, language, frameworks[], package_manager, evidence}` per manifest |
| `monorepo` | `{tool, evidence, packages[]}`; mention packages in overlays |
| `ci[]` | CI files and their `run:` steps with line numbers |
| `proposed.commands.<k>` | `{value, source, tier}`; tier is `ci`, `scripts` or `default` |
| `proposed.roles` | `active[]`, `required[]`, `reasons{role: why}` |
| `proposed.gates.G3` | on only when UI was found |
| `proposed.tracker` | `recommend` (`keyed`, `github`, `none`), `team_key`, `evidence` |
| `proposed.delivery` | `github` or `local` |
| `proposed.worktree_include` | set only when `.env.example` exists and `.env` is gitignored; ask |
| `proposed.approver_candidates` | CODEOWNERS owners |
| `proposed.constitution_sources` | agent docs, CONTRIBUTING, SECURITY, linter configs |
| `docs` | `agent[]` (CLAUDE.md, AGENTS.md, copilot, cursor rules), `human{readme, contributing, security, roadmap, changelog}`, `adrs[]` |
| `codeowners` | `{path, owners[], rules[{pattern, owners}]}` for "files you own" in overlays |
| `signals` | `ui`, `backend`, `migrations`, `iac`, `e2e` with evidence paths |

Command precedence (already applied by the scanner): CI steps, then package scripts and Makefile
targets, then framework defaults. A `default`-tier build or test command triggers the optional
"run once now" question. Always show the `source` next to a proposal.

Tracker keys: `keyed` means Linear or Jira style keys (`NEO-123`); the scan cannot tell which.
Recommend Linear unless the docs or remotes mention Atlassian or Jira.

## Reading the docs yourself

Read, in this order, at most 8 files and 64 KB each: root `CLAUDE.md` / `AGENTS.md`, then nested
agent docs (closest to `stack[].path` first), `CONTRIBUTING.md`, `SECURITY.md`, `README.md`,
`ROADMAP.md`, `.github/pull_request_template.md`, and the ADR titles already in scan.json (do not
open ADR bodies unless a title names a rule you need). Never open a path the scanner marks as secret.

Extract into `.factory/setup/scan-notes.md`:

```
## Mission candidate        one sentence, from README; cite README.md:<line>
## Architecture             at most 8 lines
## Conventions              - <rule> (CLAUDE.md:42)        one line each, max 25
## Testing rules            - <rule> (<file>:<line>)
## Security rules           - <rule> (<file>:<line>)
## Forbidden or sensitive   - <path or action> (<file>:<line>)  e.g. generated clients, migrations
## Glossary                 - <term>: <meaning>            max 15
## Roadmap candidates       - <title> (<file>:<line>)      max 5
## PR checklist             - <item> (.github/pull_request_template.md:<line>)
```

Rules:
- Quote rules in short paraphrase with a `file:line` source. Never invent a rule.
- Keep role-specific rules tagged: `[frontend]`, `[backend]`, `[data]`, `[qa]`, `[security]`,
  `[devops]`, `[docs]`, or `[all]`. Overlays use these tags.
- Leave out anything that is personal data, a secret, a URL with a token, or a customer name.
- Org-wide house rules (writing style, tracker rules) go in `org.md` operating guidelines, not
  in the constitution.

## Where each fact lands

| Fact | File |
|---|---|
| Stack, commands, roles, gates, tracker, delivery | `config.json` via `config merge` |
| Mission, product context, glossary, guidelines, reporting chain | `org.md` |
| Testing, security, forbidden, coding standards with sources, done, escalation | `constitution.md` |
| Per-role stack, commands, conventions, owned and do-not-touch paths | `roles/<role>.md` |
| Raw answers and sources | `setup/answers.json` via `setup save` |
