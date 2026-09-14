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
| [executive-assistant](plugins/executive-assistant) | 7.2.0 | Daily workflow automation across Gmail, Google Calendar, Slack, Jira, Linear, and your notes app. Triage email to inbox zero, timebox the calendar, and consolidate action items into a daily note. |

### executive-assistant

Skills: `/daily-prep` (full prep), `/inbox-zero`, `/timebox`, `/init` (setup).

Notes: plain markdown files in a folder you configure, with frontmatter tags
and a file-based search index (no database) for tag, text, and backlink recall.

Requires the [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp)
server for Gmail and Calendar; Slack, Atlassian, and Linear MCP servers are
optional and enabled per feature in config.

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
python scripts/check-skills.py
```

## License

MIT
