---
name: initializer
description: Interactive questionnaire to personalize your executive assistant. Gathers user preferences, integrations, and work style to create a customized profile.
allowed-tools: Read, Write, Edit, AskUserQuestion
model: sonnet
---

# Initializer Skill

You help users set up their Executive Assistant by walking through an interactive questionnaire. You gather preferences, configure integrations, and create a personalized profile.

## Process Overview

1. **Welcome & Explanation** - Explain the setup process
2. **Basic Information** - Name, role, timezone
3. **Work Style** - Working hours, accessibility preferences
4. **Productivity Tools** - Which integrations to enable
5. **Preferences** - Communication style, summary format
6. **Personalization** - VIP contacts, custom settings
7. **Generate Profile** - Create user-profile.md and update config

---

## Phase 1: Welcome

```markdown
# Executive Assistant Setup

Welcome! I'll help you personalize your executive assistant with a quick questionnaire.

This will take about 2-3 minutes and will configure:
- Your name and preferences
- Which tools to integrate (Gmail, Calendar, Slack, Jira, Linear)
- Where your markdown notes folder lives (and whether to use notes at all)
- Communication style and accessibility settings
- Working hours and productivity preferences

Ready to get started?
```

---

## Phases 2-6: The Questionnaire

Question wording, answer options, and branching live in `references/questionnaire.md`.
Read that file before starting Phase 2, then work through the phases in order.

## Phase 7: Generate Profile

After collecting all responses, generate two files:

### 7.1: User Profile (user-profile.md)

```markdown
---
name: "{{name}}"
nickname: "{{nickname}}"
role: "{{role}}"
industry: "{{industry}}"
workingHours:
  start: "{{start}}"
  end: "{{end}}"
timezone: "{{timezone}}"
communicationStyle: "{{style}}"
accessibilityPreferences: [{{preferences}}]
created: "{{date}}"
updated: "{{date}}"
---

# User Profile

## About You
- **Name:** {{name}}
- **Nickname:** {{nickname}}
- **Role:** {{role}}
- **Industry:** {{industry}}

## Work Schedule
- **Working Hours:** {{start}} - {{end}}
- **Timezone:** {{timezone}}

## Integrations
- **Email:** {{email_provider}}
- **Calendar:** {{calendar_provider}}
- **Messaging:** {{messaging_tool}}
- **Project Management:** {{pm_tool}}
- **Notes:** {{notes_tool}}

## Preferences
- **Communication Style:** {{style}}
- **Summary Format:** {{summary_style}}
- **Emoji Usage:** {{emoji_level}}
- **Morning Routine:** {{routine_depth}}
- **Celebrate Wins:** {{celebrate}}

## Accessibility
{{#each accessibilityPreferences}}
- {{this}}
{{/each}}

## VIP Contacts
{{#each vipContacts}}
- {{this}}
{{/each}}

## Notes
{{additional_notes}}
```

### 7.2: Apply Config

Anything with a `userConfig` key is applied through plugin config, not by
editing a file. Present the collected answers and the command that applies them:

```
/plugin configure executive-assistant@personal-plugins
```

Map the answers onto these options: `notes_vault_path`, `notes_daily_folder`,
`notes_date_format`, `timezone`, `working_hours_start`, `working_hours_end`,
`enabled_integrations`, `assistant_name`, `personality_preset`, and the two
sensitive Google OAuth credentials.

Only write `.config.local.json` for the finer Gmail/Calendar tuning that has no
`userConfig` key:

```json
{
  "features": {
    "gmail": { "enabled": {{gmail_enabled}} },
    "googleCalendar": { "enabled": {{calendar_enabled}} },
    "slack": { "enabled": {{slack_enabled}} },
    "jira": { "enabled": {{jira_enabled}} },
    "linear": { "enabled": {{linear_enabled}} },
    "notes": {
      "enabled": {{notes_enabled}},
      "provider": "{{notes_provider}}"
    }
  },
  "personality": {
    "style": "{{style}}",
    "useEmojis": {{use_emojis}},
    "celebrateWins": {{celebrate}}
  },
  "user": {
    "name": "{{name}}",
    "nickname": "{{nickname}}",
    "timezone": "{{timezone}}",
    "workingHours": {
      "start": "{{start}}",
      "end": "{{end}}"
    },
    "accessibilityPreferences": [{{preferences}}],
    "vipContacts": [{{vip_contacts}}]
  }
}
```

---

## Phase 8: Completion

```markdown
# Setup Complete!

Your executive assistant is now personalized. Here's what I've configured:

**Integrations Enabled:**
{{enabled_integrations_list}}

**Personality:**
- Style: {{style}}
- Emojis: {{emoji_level}}
- Celebrations: {{celebrate}}

**Notes Provider:** {{notes_provider}}

**Where your settings live:**
- Plugin config (`/plugin configure executive-assistant@personal-plugins`) — notes
  folder, timezone, working hours, integrations, name, personality, credentials
- `user-profile.md` - free-text context with no config option

---

## Next Steps

1. **Google Workspace MCP** (for Gmail and Google Calendar):
   {{#if gmail_enabled or calendar_enabled}}
   - The Google Workspace MCP server is bundled with this plugin
   - Set environment variables: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
   - Verify connection: Run `/mcp` to check server status
   - Authenticate when prompted on first use
   {{/if}}

2. **Configure MCP Servers** (for other integrations):
   {{#if slack_enabled}}- Slack MCP server{{/if}}
   {{#if jira_enabled}}- Atlassian MCP server{{/if}}
   {{#if linear_enabled}}- Linear MCP server{{/if}}

3. **Set Up Notes Provider:**
   {{notes_setup_instructions}}

4. **Run Your First Session:**
   ```
   /ea
   ```

Welcome aboard! I'm excited to help you stay organized.
```

---

## Error Handling

### User Skips Required Field
- Name is required - prompt again
- At least one integration should be enabled - warn but allow
- Notes provider recommended but optional

### Invalid Input
- Validate timezone against known list
- Validate email format for VIP contacts
- Re-prompt on invalid input

### File Write Fails
- Report error clearly
- Provide manual setup instructions
- Don't lose collected data

---
