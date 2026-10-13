# claude-plugins

A personal Claude Code plugin marketplace.

## Install

```bash
/plugin marketplace add jay-stacey/claude-plugins
```

Then install a plugin from the list below:

```bash
/plugin install executive-assistant@personal-plugins
```

Then set it up. Configuration lives in plugin config, so it survives reinstalls:

```bash
/plugin configure executive-assistant@personal-plugins
```

Or run `/init` for a guided walkthrough.

## Plugins

| Plugin | Version | What it does |
|---|---|---|
| [executive-assistant](plugins/executive-assistant) | 8.0.0 | A morning brief that remembers your email rules and plans the week, focus sessions with check-ins, an end-of-day shutdown, markdown tasks, and Day Desk, a local dashboard with chat. Built for an ADHD workday. |
| [voice-replies](plugins/voice-replies) | 1.2.0 | Reads Claude's replies aloud. Haiku rewrites each reply for speech, and Kokoro speaks it on your GPU (or CPU), with a compact voice and speed panel above the prompt. |
| [session-manager](plugins/session-manager) | 1.1.0 | Reviews your open Claude sessions. Type `/manager` to see which are stale, which wait on you, and which are done but not archived, with one next step each. Can bulk archive long-idle sessions and report leftover worktrees. |
| [software-factory](plugins/software-factory) | 0.3.1 | An AI software factory. A CTO agent turns your goals into work for 14 role agents that plan, design, build, review and test code, in one repo or across a folder of repos. Teams map to Linear teams and sub-teams, bugs and tech debt run in team streams, cycles sync with Linear, and the CTO baselines work in flight and sends regular reports with improvement proposals. You approve at four gates and merge the pull requests. Includes a local control center with a kanban, a live org chart and token budgets. |
| [session-brief](plugins/session-brief) | 1.0.0 | Shows a brief above the prompt: how the session started, where it left off, next steps, and what you should know. Renames the session to say what the work is. |

### executive-assistant

Your workday, start to finish: `/morning-brief` (email rules, five-day calendar,
one task to start with), `/focus` (timer, stuck, park, resume), `/timebox`
(mid-day re-plan), `/inbox-zero`, `/shutdown` (close the day), `/dashboard`
(Day Desk, a local dashboard with chat), and `/init` (setup). Tasks and email
rules are plain markdown files in your notes folder.

Requires the [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp)
server for Gmail and Calendar; Slack, Atlassian, and Linear MCP servers are
optional and enabled per feature in config. Full guide:
[plugins/executive-assistant](plugins/executive-assistant/README.md).

### voice-replies

Command: `/voice` (on, off, stop, voice, speed, voices, test, install).

After installing the plugin, type `/voice install` once (Windows). It checks
your GPU, installs Kokoro on the GPU or on the CPU, and tests it.
Until then, replies use the built-in Windows voice. See the
[plugin README](plugins/voice-replies/README.md).

### session-brief

Command: `/brief` (refresh, show, hide, rename, autorename on|off).

After each turn, Haiku writes a short brief from the session's opening and its
latest messages. The brief is saved per session, so a reopened session shows it
at once. See the [plugin README](plugins/session-brief/README.md).

### software-factory

Commands: `/setup`, `/start`, `/pause`, `/new-goal`, `/new-item`, `/remove-goal`,
`/approve`, `/status`, `/report`, `/sync`, `/control-center`, `/tick`.

Run `/setup` once per repo, then `/start` in a dedicated session. See the
[plugin README](plugins/software-factory/README.md).

## Repository layout

```
.claude-plugin/marketplace.json   # marketplace manifest
plugins/<name>/                   # one directory per plugin
scripts/check-skills.py           # structural checks beyond the manifest validator
.github/workflows/validate.yml    # CI
```

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the plugin layout, the rules that
silently break components, and how to add a second plugin.

```bash
claude plugin validate .
claude plugin validate ./plugins/executive-assistant
claude plugin validate ./plugins/voice-replies
claude plugin validate ./plugins/session-manager
claude plugin validate ./plugins/session-brief
claude plugin validate ./plugins/software-factory
claude plugin test ./plugins/voice-replies
claude plugin test ./plugins/session-brief
node --test "plugins/software-factory/test/**/*.test.mjs" "plugins/software-factory/control-center/test/**/*.test.mjs"
python scripts/check-skills.py
```

## License

MIT
