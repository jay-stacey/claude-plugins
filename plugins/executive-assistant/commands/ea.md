---
name: ea
description: Invoke your executive assistant for daily workflow preparation
agent: assistant
---

# EA Command (Executive Assistant)

Invoke your executive assistant to help with daily workflow preparation and organization.

## Usage

### Basic Usage
```
/ea
```

Starts an interactive session with your assistant. It will greet you based on your configured preferences and ask what you'd like to tackle today.

### With Options
```
/ea [options]
```

## Available Options

### Workflow Selection

- **Full daily prep** (default)
  ```
  /ea
  ```
  Complete workflow based on your enabled features: Calendar, Gmail, Slack, Jira, Linear, notes update.

- **Quick catch-up**
  ```
  /ea --quick
  ```
  Just the highlights - urgent items only, minimal interaction.

### Source Selection

- `--skip-calendar` - Skip Google Calendar review
- `--skip-email` - Skip Gmail processing
- `--skip-slack` - Skip Slack review
- `--skip-jira` - Skip Jira analysis
- `--skip-linear` - Skip Linear review
- `--only-calendar` - Quick schedule check only
- `--only-email` - Focus just on email/inbox zero
- `--only-slack` - Review Slack only
- `--only-jira` - Review Jira only
- `--only-linear` - Review Linear only

### Feature Toggles

- `--skip-newsletters` - Skip TLDR newsletter processing
- `--skip-cleanup` - Skip email cleanup actions
- `--skip-day-planning` - Skip timeboxing suggestions

### Behavior

- `--dry-run` - Preview without writing to notes
- `--auto` - Skip confirmations (use carefully!)

## Examples

### Standard Morning Routine
```
/ea
```
Full interactive workflow with your assistant.

### Quick Morning Check
```
/ea --quick
```
Fast overview of urgent items only.

### Email Focus
```
/ea --only-email
```
Just process Gmail and achieve inbox zero.

### Calendar Review
```
/ea --only-calendar
```
Quick look at today's schedule and free time.

### Project Management Focus
```
/ea --only-jira --only-linear
```
Review all assigned tickets across Jira and Linear.

### Catch Up After Weekend
```
/ea
```
Then tell the assistant you've been away - it will adjust accordingly.

### Preview Mode
```
/ea --dry-run
```
See what would be added without actually updating your notes.

## What to Expect

### 1. Greeting
The assistant greets you based on time of day and your configured personality preferences.

### 2. Check-In
It asks what you'd like to focus on today and offers choices based on your enabled features.

### 3. Processing
For each enabled section (Calendar, Email, Slack, Jira, Linear):
- Summary of what was found
- Any items needing your decision
- Celebration of wins (if enabled in config)

### 4. Consolidation
Preview of what will be added to your notes, with confirmation request.

### 5. Wrap-Up
Final summary and next steps for your day.

## Configuration

The assistant behavior is controlled by your configuration:

**Personality settings** (`config/default.json` or `user-profile.md`):
```json
{
  "personality": {
    "name": "Assistant",
    "style": "professional",
    "useEmojis": true,
    "celebrateWins": true
  }
}
```

**Feature toggles**:
```json
{
  "features": {
    "gmail": { "enabled": true },
    "googleCalendar": { "enabled": true },
    "slack": { "enabled": false },
    "jira": { "enabled": true },
    "linear": { "enabled": false },
    "notes": {
      "enabled": true,
      "provider": "obsidian"
    }
  }
}
```

## Personalization

Run `/init` to set up your personalized profile. The initialization questionnaire will configure:
- Your name and preferences
- Which integrations to use
- Personality and communication style
- Working hours and productivity preferences

## Troubleshooting

### Command not responding as expected
- Check that the plugin is properly installed
- Verify Google Workspace MCP server is connected (`/mcp`)
- Verify MCP servers are configured for Slack, Atlassian, Linear
- Run `/init` to ensure your profile is set up

### Can't connect to Gmail or Calendar
- Check MCP server status: `/mcp`
- Verify Google Workspace MCP server is connected
- Check OAuth credentials are configured (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`)
- Re-authenticate if needed

### Can't connect to other services
- Check that the relevant MCP servers are configured (Slack, Atlassian, Linear)
- Re-authenticate if needed
- Features can be individually disabled in config

### Missing features
- Check `features` section in config to ensure desired features are enabled
- Run `/init` to update your configuration

## Version History

**v5.0.0** - Google Workspace MCP Migration
- Migrated Gmail and Calendar from GWS CLI to Google Workspace MCP server
- Removed GWS CLI dependency (`npm i -g @googleworkspace/cli` no longer required)
- Added `.mcp.json` for MCP server configuration
- Co-Work compatible (no Bash tool dependency for Gmail/Calendar)
- Breaking change: GWS CLI no longer used; requires Google Workspace MCP server

**v4.0.0** - GWS CLI Migration
- Migrated Gmail and Calendar from MCP tools to GWS CLI (`gws` command)
- Removed daily-workflow plugin (consolidated into executive-assistant)
- Requires GWS CLI installation (`npm i -g @googleworkspace/cli`)
- Added `gws` configuration section
- Breaking change: no longer requires Gmail/Calendar MCP servers

**v3.0.0** - Executive Assistant Update
- Renamed from daily-workflow to executive-assistant
- Configurable personality system
- Multiple notes providers (Obsidian, Notion, Logseq, Roam, Markdown)
- Linear integration
- Initialization questionnaire (`/init`)
- Enhanced calendar management (color codes, breaks, whitelist/blacklist)
- Email whitelist/blacklist configuration

**v2.0.0** - Claudia Update
- Introduced Claudia personality
- Migrated Gmail from browser to native MCP
- Migrated Calendar from browser to native MCP
- Added interactive conversation mode
- Sub-agent architecture

**v1.0.0** - Initial release (as daily-prep)
- Browser-based Gmail and Calendar
- Slack and Jira via MCP
- Task consolidation to Obsidian

## Tips

- **First thing in the morning**: Run `/ea` before checking email/Slack manually
- **Overwhelmed?**: Tell the assistant - it will help you focus on just the urgent stuff
- **Short on time?**: Use `--quick` for essentials only
- **Trust the process**: Let it categorize, you can always adjust
- **Customize**: Run `/init` to personalize your experience
