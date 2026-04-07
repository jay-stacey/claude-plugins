---
name: init
description: Initialize and personalize your executive assistant with an interactive questionnaire
skills: initializer
---

# Init Command

Run this command to personalize your executive assistant with an interactive setup questionnaire.

## Usage

```
/init
```

## What Happens

The initialization process walks you through a questionnaire to configure:

### 1. Basic Information
- Your name and preferred nickname
- Job title/role
- Industry you work in

### 2. Work Style
- Working hours (8-5, 9-6, custom)
- Timezone
- Communication style preference (professional, friendly, casual, formal)
- Accessibility needs (ADHD-friendly, dyslexia-friendly, low-distraction)

### 3. Productivity Tools
- Email provider (Gmail, Outlook)
- Calendar (Google Calendar, Outlook)
- Messaging (Slack, Teams, Discord)
- Project management (Jira, Linear, Asana, Trello)
- Note-taking (Obsidian, Notion, Logseq, Roam, Markdown)

### 4. Preferences
- Summary style (bullets, paragraphs, tables, mixed)
- Emoji usage (heavy, light, none)
- Morning routine depth (quick, standard, detailed)
- Win celebrations (yes, sometimes, no)

### 5. Personalization (Optional)
- VIP contacts to prioritize
- Recurring commitments to track
- Industry-specific terminology

## Output

After completing the questionnaire, the command creates:

1. **`user-profile.md`** - Your personalized profile in markdown format
2. **`.config.local.json`** - Local configuration overrides

## Duration

The setup takes approximately 2-3 minutes.

## Re-Running Init

You can re-run `/init` at any time to update your preferences. Your previous settings will be shown as defaults.

## Examples

### First-Time Setup
```
/init
```
Complete questionnaire from scratch.

### Update Preferences
```
/init
```
Re-run to modify existing settings.

## After Initialization

Once setup is complete:

1. **Configure MCP Servers** - Set up required servers for your chosen integrations
2. **Configure Notes Provider** - Set up your chosen notes app (vault path, etc.)
3. **Test with Dry Run** - Run `/ea --dry-run` to preview the workflow
4. **Start Using** - Run `/ea` to begin your first session

## Troubleshooting

### Can't Save Profile
- Check file permissions in the plugin directory
- Try running from the plugin root directory

### Missing Integration Options
- Some integrations show "Coming Soon" - these are planned for future releases
- Currently supported: Gmail, Google Calendar, Slack, Jira, Linear

### Want to Start Over
- Delete `user-profile.md` and `.config.local.json`
- Re-run `/init`

## Tips

- **Be honest about preferences** - The setup tailors the experience to you
- **Start simple** - Enable only the integrations you actively use
- **ADHD-friendly mode** - If you find yourself overwhelmed, enable this option
- **Update regularly** - Re-run `/init` when your work situation changes

---

Ready to personalize your assistant?

```
/init
```
