---
name: claudia
description: (Deprecated) Alias for /ea - your executive assistant
agent: assistant
---

# Claudia Command (Deprecated)

**Note:** This command has been replaced by `/ea` in version 3.0.0.

The `/claudia` command now invokes the generic Executive Assistant. All functionality has been preserved and enhanced.

## What's New in v3.0.0

- **Configurable personality** - Set your assistant's name, style, and behavior
- **Multiple notes providers** - Obsidian, Notion, Logseq, Roam, or plain Markdown
- **Linear integration** - Support for Linear project management
- **Initialization questionnaire** - Run `/init` to personalize your experience
- **Enhanced calendar** - Color codes, break settings, whitelist/blacklist
- **Email filtering** - Whitelist/blacklist for email cleanup

## Migration

Simply use `/ea` instead of `/claudia`. The workflow is the same, just more configurable!

```
/ea              # Full interactive workflow
/ea --quick      # Fast essentials only
/ea --only-email # Focus on Gmail
```

## Want the Claudia Personality Back?

Add this to your `config/default.json`:

```json
{
  "personality": {
    "preset": "claudia"
  }
}
```

Or run `/init` and choose the "friendly/warm" personality style.

## Backward Compatibility

All existing options are still supported:
- `--skip-calendar`, `--skip-email`, `--skip-slack`, `--skip-jira`
- `--only-calendar`, `--only-email`, `--only-slack`, `--only-jira`
- `--skip-newsletters`, `--skip-cleanup`, `--skip-day-planning`
- `--dry-run`, `--auto`

---

**Recommendation:** Update to use `/ea` - it's the same great workflow with more flexibility!
