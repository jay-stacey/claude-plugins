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
| [executive-assistant](plugins/executive-assistant) | 7.3.0 | Daily workflow automation across Gmail, Google Calendar, Slack, Jira, Linear, and your notes app. Triage email to inbox zero, timebox the calendar, and consolidate action items into a daily note. |
| [voice-replies](plugins/voice-replies) | 1.1.0 | Reads Claude's replies aloud. Haiku rewrites each reply for speech, and Kokoro speaks it on your GPU, with a compact voice and speed panel above the prompt. |
| [session-manager](plugins/session-manager) | 1.1.0 | Reviews your open Claude sessions. Type `/manager` to see which are stale, which wait on you, and which are done but not archived, with one next step each. Can bulk archive long-idle sessions and report leftover worktrees. |
| [session-brief](plugins/session-brief) | 1.0.0 | Shows a brief above the prompt: how the session started, where it left off, next steps, and what you should know. Renames the session to say what the work is. |

### executive-assistant

Skills: `/daily-prep` (full prep), `/inbox-zero`, `/timebox`, `/init` (setup).

Notes: plain markdown files in a folder you configure, with frontmatter tags
and a file-based search index (no database) for tag, text, and backlink recall.

Requires the [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp)
server for Gmail and Calendar; Slack, Atlassian, and Linear MCP servers are
optional and enabled per feature in config.

### voice-replies

Command: `/voice` (on, off, stop, voice, speed, voices, test).

Needs a one-time Kokoro setup on Windows before install (about 3 GB):
`powershell -ExecutionPolicy Bypass -File plugins\voice-replies\server\setup.ps1`.
Without it, replies use the built-in Windows voice. See the
[plugin README](plugins/voice-replies/README.md).

### session-brief

Command: `/brief` (refresh, show, hide, rename, autorename on|off).

After each turn, Haiku writes a short brief from the session's opening and its
latest messages. The brief is saved per session, so a reopened session shows it
at once. See the [plugin README](plugins/session-brief/README.md).

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
claude plugin test ./plugins/voice-replies
claude plugin test ./plugins/session-brief
python scripts/check-skills.py
```

## License

MIT
