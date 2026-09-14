---
name: daily-prep
description: Run the full daily workflow preparation across Calendar, Gmail, Slack, Jira, and Linear, then consolidate everything into the user's daily note. Use when the user asks to start their day, prep their day, run a morning review, catch up on everything, or asks what needs their attention today.
argument-hint: "[--quick] [--dry-run] [--only-email] [--skip-calendar]"
context: fork
agent: assistant
model: opus
---

# Daily Prep

Starts an interactive session with the executive assistant for daily prep across Calendar, Gmail, Slack, Jira, and Linear (whichever you have enabled in config).

## Usage

```
/daily-prep                  # full interactive prep
/daily-prep --quick          # urgent items only, minimal interaction
/daily-prep --only-email     # focus a single source
/daily-prep --dry-run        # preview without writing anything
```

`/ea` is a short alias for this skill.

## Options

**Source selection**
- `--skip-{calendar,email,slack,jira,linear}` — skip a section
- `--only-{calendar,email,slack,jira,linear}` — run just that section

**Behavior**
- `--quick` — minimal interaction, urgent items only
- `--skip-cleanup` — skip email cleanup actions
- `--skip-day-planning` — skip timeboxing suggestions
- `--dry-run` — preview without creating calendar events
- `--auto` — skip non-destructive confirmations

## What runs

The assistant orchestrates three sub-agents in parallel where possible:

| Sub-agent | Sources |
|-----------|---------|
| `email-assistant` | Gmail (triage + inbox zero) |
| `calendar-assistant` | Google Calendar (review + timeboxing) |
| `task-assistant` | Slack, Jira, Linear |

It returns a single consolidated summary at the end — urgent items first, then important, then a brief close.

## Configuration

Personality and feature toggles come from plugin config, set with
`/plugin configure executive-assistant@personal-plugins` and read from the
environment:

| Setting | Environment variable | Default |
|---|---|---|
| Which sources run | `CLAUDE_PLUGIN_OPTION_ENABLED_INTEGRATIONS` | `gmail, calendar, notes` |
| Assistant name | `CLAUDE_PLUGIN_OPTION_ASSISTANT_NAME` | `Assistant` |
| Tone preset | `CLAUDE_PLUGIN_OPTION_PERSONALITY_PRESET` | neutral professional |
| Working hours | `CLAUDE_PLUGIN_OPTION_WORKING_HOURS_START` / `_END` | `08:00` / `17:00` |
| Timezone | `CLAUDE_PLUGIN_OPTION_TIMEZONE` | `America/Toronto` |

An unset option is absent from the environment, not empty. `config/default.json`
supplies defaults for the finer Gmail/Calendar tuning that has no `userConfig`
key; a configured option always wins. Run `/init` for a guided walkthrough.

```json
{
  "personality": { "name": "Assistant", "style": "professional" },
  "features": {
    "gmail":          { "enabled": true },
    "googleCalendar": { "enabled": true },
    "slack":          { "enabled": false },
    "jira":           { "enabled": true },
    "linear":         { "enabled": false }
  }
}
```

## Troubleshooting

- **MCP connection issues** — run `/mcp` to check server status. For Gmail/Calendar, verify `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are set and the Google Workspace MCP is connected.
- **Missing features** — check the `features` section of your config; run `/init` to update.
- **Disabled source still showing up** — make sure the relevant `features.{source}.enabled` is `false`.
