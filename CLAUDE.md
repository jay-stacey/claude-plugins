# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** This file guides work *on the plugin source*. The assistant's own
> runtime personality is not set here — it comes from `config/presets/` and the
> user's generated profile. Keep persona out of this file.

## Repository Overview

This is a Claude Code personal plugins repository containing the `executive-assistant` plugin (v6.0), which orchestrates daily task preparation by integrating Gmail, Google Calendar, Slack, Jira, Linear, and multiple note-taking systems.

**Prerequisites:**
- [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp) server for Gmail and Calendar (bundled via `.mcp.json`; requires `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` environment variables)
- MCP servers for Slack, Atlassian, and Linear (as needed)

## Available Commands

| Command | Plugin | Purpose |
|---------|--------|---------|
| `/daily-prep` | executive-assistant | Main workflow - full daily preparation |
| `/ea` | executive-assistant | Short alias for /daily-prep |
| `/init` | executive-assistant | Setup and personalization |
| `/inbox-zero` | executive-assistant | Email cleanup (2-3 min) |
| `/timebox` | executive-assistant | Calendar optimization (2-4 min) |

## Architecture

### Plugin Structure

```
plugins/
└── executive-assistant/          # v6.0 (Primary)
    ├── .claude-plugin/plugin.json
    ├── .mcp.json                   # Google Workspace MCP server
    ├── config/
    │   ├── default.json          # Default configuration
    │   ├── schema.json           # JSON Schema validation
    │   ├── examples/             # Role-based configs
    │   └── presets/              # Personality presets
    ├── agents/
    │   ├── assistant.md          # Main orchestrator
    │   ├── initializer.md        # Setup wizard
    │   └── [domain]-assistant.md # Specialized agents
    ├── skills/                   # <name>/SKILL.md (+ optional references/)
    │   ├── daily-prep/           # Entry points: daily-prep, ea, init,
    │   ├── inbox-zero/           #   inbox-zero, timebox
    │   ├── notes/                # Markdown notes
    │   └── [service]-*/          # gmail, calendar, slack, jira, linear
    ├── hooks/hooks.json
    └── scripts/                  # Helper utilities
```

### Skills Framework

Skills are self-contained markdown files defining specialized sub-agents:

| Skill | Purpose | Tools |
|-------|---------|-------|
| `gmail-processor` | Email scanning, categorization | Google Workspace MCP |
| `gmail-organizer` | Label automation, inbox zero | Google Workspace MCP |
| `calendar-reviewer` | Schedule analysis | Google Workspace MCP |
| `calendar-manager` | Timeboxing, bottleneck detection | Google Workspace MCP |
| `slack-reviewer` | Message prioritization | Slack MCP |
| `jira-reviewer` | Ticket analysis | Atlassian MCP |
| `linear-reviewer` | Issue tracking | Linear MCP |
| `task-consolidator` | Notes integration | Read, Edit, Write |
| `initializer` | Setup wizard | Dialog tools |
| `notes` | Markdown notes: read, write, search, section-aware append | `Read`, `Write`, `Edit`, `Glob`, `Grep` |

### Integration Approach

| Service | Method | Tools Used |
|---------|--------|------------|
| Gmail | MCP native API | `mcp__google-workspace__*` (Gmail tools) |
| Google Calendar | MCP native API | `mcp__google-workspace__*` (Calendar tools) |
| Slack | Native API | `mcp__slack__*` |
| Jira | Native API | `mcp__atlassian__*` |
| Linear | Native API | `mcp__linear-server__*` |
| Markdown | Local filesystem | `Read`, `Edit`, `Write` |

## Key Design Principles

1. **Read-only by default**: All external service operations are read-only
2. **User confirmation required**: Note writes require explicit approval
3. **Graceful degradation**: Workflow continues if individual sources fail
4. **ADHD-friendly UX**: Visual hierarchy with emojis, summaries first, clear action items

## Configuration (v6.0)

### Structure
```
config/
├── default.json      # All configuration options with defaults
├── schema.json       # JSON Schema for validation
├── examples/         # Role-based configurations
│   ├── developer.json
│   ├── manager.json
│   └── minimal.json
└── presets/          # Personality presets
```

### Key Configuration Areas
- **MCP Server**: Google Workspace MCP config, timezone, Gmail/Calendar settings
- **Personality**: Name, greeting style, humor level, emoji usage
- **User Profile**: Name, role, timezone, VIP contacts
- **Features**: Toggle integrations (gmail, calendar, slack, jira, linear, notes)
- **Safety**: 10+ safety protocols for write operations
- **Providers**: Multi-provider notes configuration

## Creating New Skills

1. Create folder under `skills/<skill-name>/`
2. Add `SKILL.md` with:
   - Clear process steps
   - Safety protocols section
   - Output format specification
   - Error handling strategy
   - Testing checklist
3. Skills are auto-discovered - do NOT add to plugin.json

## Creating New Entry Points

Commands and skills are the same mechanism: a skill at `skills/<name>/SKILL.md`
creates `/<name>`. There is no separate `commands/` directory.

1. Add `skills/<name>/SKILL.md` with `name` matching the directory
2. Route to a sub-agent with `context: fork` + `agent: <agent-name>`
3. Keep the entry point thin — procedure belongs in the skill it delegates to

## Safety Protocols

- Never auto-delete emails, messages, or tickets
- Never send automated responses
- Never update Jira/Linear status without explicit user action
- Always preview changes before writing to notes
- Use `Edit` tool instead of `Write` for existing files

## Plugin Manifest Rules (CRITICAL)

**BEFORE modifying any plugin.json file, review the official documentation:**
- Plugin structure: https://code.claude.com/docs/en/plugins
- Full reference: https://code.claude.com/docs/en/plugins-reference

### Valid plugin.json Fields ONLY

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | Unique identifier and skill namespace |
| `description` | Yes | Shown in plugin manager |
| `version` | Yes | Semantic versioning (e.g., "1.0.0") |
| `author` | No | Object with `name` and optional `email` |
| `license` | No | License identifier (e.g., "MIT") |
| `keywords` | No | Array of tags for discoverability |
| `homepage` | No | URL to documentation |
| `repository` | No | URL to source code |

### Component Path Fields

`skills`, `agents`, `hooks`, and `mcpServers` are valid optional fields in
`plugin.json`, but this plugin omits them and relies on the default locations
(`skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`). Only set them to add a
non-standard path — note that `skills` *adds to* the default directory while
`agents` *replaces* it.

## Version History

| Version | Plugin | Status |
|---------|--------|--------|
| v5.0.0 | executive-assistant | Current - Google Workspace MCP for Gmail/Calendar, Co-Work compatible |
| v4.0.0 | executive-assistant | Previous - GWS CLI for Gmail/Calendar, consolidated from daily-workflow |
| v3.0.0 | executive-assistant | Previous - Linear, multi-provider notes, personality system |
| v2.0.0 | daily-workflow | Removed - Was deprecated, now consolidated into executive-assistant |

## Release/Commit Conventions

After implementing a plan, always bump the version number in plugin.json (or equivalent manifest) before committing.
