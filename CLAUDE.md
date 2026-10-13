# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** This file guides work *on the plugin source*. A plugin's own runtime
> voice is not set here. For executive-assistant it comes from
> `config/presets/`, the user's generated profile, and the `response-style`
> skill. Keep persona out of this file.

## What this repo is

A Claude Code plugin marketplace named `personal-plugins`. The catalog is
`.claude-plugin/marketplace.json`. Each plugin lives in `plugins/<name>/`.

| Plugin | Kind | Main entry |
|---|---|---|
| `executive-assistant` | Markdown skills + agents + MCP | `/daily-prep`, `/inbox-zero`, `/timebox`, `/init` |
| `session-manager` | Markdown skill + agent | `/manager` |
| `voice-replies` | TypeScript hooks mod + Python TTS server | `/voice` |
| `session-brief` | TypeScript hooks mod | `/brief` |
| `software-factory` | Markdown skills + agents + Node CLI, hooks and local web server | `/setup`, `/start`, `/new-goal`, `/control-center` |

Two plugin kinds exist, and they are built differently:

- **Markdown plugins** (executive-assistant, session-manager) are only
  `SKILL.md` and agent `.md` files. No build step.
- **Hooks mods** (voice-replies, session-brief) use `hooks/hooks.json` with
  `{ "modules": ["./register.tsx"] }`. The `.tsx` imports from `claude-code`
  (atoms, `EngineInterface`, `Register`). `plugin.json` sets `"types"`. The
  engine writes `.claude-plugin/types/` at load time. That folder is
  gitignored, and `tsconfig.json` extends it. Load the `plugin-authoring`
  skill before you change a mod.

## Commands

CI (`.github/workflows/validate.yml`) runs all of these on every push and PR:

```bash
claude plugin validate . --strict
claude plugin validate ./plugins/<name> --strict
python scripts/check-skills.py
```

CI also does a real install smoke test (`claude plugin marketplace add`, then
`claude plugin install <name>@personal-plugins`), because `validate` only
checks manifest shape.

The hooks mods have engine tests. Run one plugin's tests:

```bash
claude plugin test ./plugins/voice-replies
claude plugin test ./plugins/session-brief
```

Tests import `expect`, `mock`, `test` from `claude-code/testing` and drive the
mod through a fake engine.

software-factory has plain Node tests (Node 20 or later, no dependencies):

```bash
node --test "plugins/software-factory/test/**/*.test.mjs" "plugins/software-factory/control-center/test/**/*.test.mjs"
```

Notes Desk editor (`plugins/executive-assistant/skills/notes-viewer/editor/`):
after you change `src/`, rebuild. The build overwrites the committed
`assets/editor.bundle.js`.

```bash
npm --prefix plugins/executive-assistant/skills/notes-viewer/editor run build
```

## Rules that silently break components

`scripts/check-skills.py` and `CONTRIBUTING.md` enforce these:

- Skills are at `skills/<name>/SKILL.md`, exactly one level deep. Deeper
  nesting is never discovered.
- A skill's `name:` must equal its directory name. Frontmatter starts on line 1.
- Keep `SKILL.md` under 500 lines. Move detail to `references/`.
- Only `plugin.json` goes in `.claude-plugin/`. Components stay at the plugin root.
- `author` is required, because CI runs `--strict`.
- `context: fork` is a skill field. Agents ignore it.
- Secrets go in `plugin.json` `userConfig` with `"sensitive": true`. Reference
  them as `${user_config.<key>}` (see executive-assistant `.mcp.json`).
- Commands and skills are the same mechanism. A skill at
  `skills/<name>/SKILL.md` creates `/<name>`. Keep entry-point skills thin and
  route with `context: fork` + `agent: <agent-name>`.

Before you edit any `plugin.json`, check the official docs:
https://code.claude.com/docs/en/plugins-reference. This repo uses `name`,
`version`, `description`, `author`, `license`, `keywords`, `homepage`,
`repository`, `displayName`, `userConfig`, and `types`. Component path fields
(`skills`, `agents`, `hooks`, `mcpServers`) are omitted on purpose. Default
locations are used.

## Versioning and release

After you implement a change, bump the plugin version before you commit.
The version lives in three places, and they must match:

1. `plugins/<name>/.claude-plugin/plugin.json`
2. The plugin's entry in `.claude-plugin/marketplace.json` (also bump
   `metadata.version` there)
3. The plugins table in `README.md`

To add a new plugin, follow `CONTRIBUTING.md`. Register it in
`marketplace.json`, or `check-skills.py` fails.

Commit titles follow `<plugin> <version>: <what changed>` or
`Add <plugin>: <what it does>`.

## executive-assistant architecture

- `agents/assistant.md` orchestrates. It delegates to `email-assistant`,
  `calendar-assistant`, and `task-assistant` (Slack, Jira, Linear).
  `initializer.md` runs setup.
- Skills split into entry points (`daily-prep`, `inbox-zero`, `timebox`,
  `init`) and workers (`gmail-*`, `calendar-*`, `slack-reviewer`,
  `jira-reviewer`, `linear-reviewer`, `task-consolidator`, `notes`,
  `notes-viewer`).
- All user-facing output goes through the `response-style` skill. That skill
  says output may be read aloud, so no tables or emoji headers.
- Settings come from `plugin.json` `userConfig` (`/plugin configure`).
  `config/default.json` + `config/schema.json` hold the full option set.
  `config/examples/` holds role configs. `config/presets/` holds personalities.
- Gmail and Calendar use the bundled Google Workspace MCP server (`.mcp.json`,
  run with `uvx`). Slack, Atlassian, and Linear MCP servers are optional.
- Tasks are markdown files in `{vault}/tasks/`. `scripts/tasks.py` owns every
  read and write of them; skills and the dashboard call it and never edit task
  files directly. Its tests: `python -m unittest discover -s plugins/executive-assistant/tests`.
- Email rules and the user profile live in `{vault}/assistant/` (templates in
  `templates/`). Speech comes from the voice-replies plugin; this plugin has no
  TTS hook.

Safety rules for this plugin:

- External services are read-only by default.
- Never auto-delete or send email, messages, or tickets.
- Never change Jira or Linear status without explicit user action.
- Preview note changes and get approval before writing. Use `Edit`, not
  `Write`, on existing note files.
- Continue the workflow when one source fails.

## software-factory architecture

Read `plugins/software-factory/docs/contracts.md` before you change it. That
file is the build spec. `docs/design.md` explains the reasons.

- One Node CLI, `scripts/factory.mjs`, owns all state under the target repo's
  `.factory/`. Skills, agents, hooks and the dashboard change state only
  through it or through signed inbox files.
- `/start` turns a session into the dispatcher. `/loop` runs the `tick`
  skill, and each tick launches background role agents from CLI-written briefs.
- Role agents never get the `Agent` tool. Each one writes `handoff.json` and
  ends with one line. The CLI re-runs checks itself before review.
- `hooks/hooks.json` holds the permission broker, which allows known-safe
  commands for factory agents only, plus run binding and usage recording.
- `control-center/` is a local web server with no build step. It writes only
  signed inbox requests.
- Keep the stored paths short. Deep Windows paths break git worktrees.
- Workspace mode: `.factory/` can sit in a plain folder of several repos.
  Resolve a record's repo with `scripts/lib/repos.mjs`. Never use
  `repoRoot(home)` for git, commands or delivery. The CLI makes every agent
  worktree. Agent files must not set `isolation: worktree`.
