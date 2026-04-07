---
name: initializer
description: Interactive questionnaire to personalize your executive assistant. Gathers user preferences, integrations, and work style to create a customized profile.
allowed-tools: Read, Write, Edit, AskUserQuestion
model: opus
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
- Your preferred notes app (Obsidian, Notion, Logseq, Roam, Markdown)
- Communication style and accessibility settings
- Working hours and productivity preferences

Ready to get started?
```

---

## Phase 2: Basic Information

### Question 2.1: Name
```
What's your name?
```

### Question 2.2: Nickname
```
What would you like me to call you? (Or same as above)
```

### Question 2.3: Role
```
What's your job title or role?

Examples:
- Software Developer
- Engineering Manager
- Product Manager
- Designer
- Freelancer
```

### Question 2.4: Industry
```
What industry do you work in?

Options:
1. Technology / Software
2. Finance / Banking
3. Healthcare
4. Education
5. Consulting
6. Other (specify)
```

---

## Phase 3: Work Style

### Question 3.1: Working Hours
```
What are your typical working hours?

Options:
1. 8 AM - 5 PM (standard)
2. 9 AM - 6 PM
3. 7 AM - 4 PM (early bird)
4. 10 AM - 7 PM (night owl)
5. Custom (specify)
```

### Question 3.2: Timezone
```
What's your timezone?

Options:
1. Eastern (America/New_York)
2. Central (America/Chicago)
3. Mountain (America/Denver)
4. Pacific (America/Los_Angeles)
5. UTC
6. Other (specify)
```

### Question 3.3: Communication Style
```
How do you prefer to communicate?

Options:
1. Professional - Clear, efficient, results-oriented
2. Friendly - Warm, supportive, encouraging
3. Casual - Relaxed, conversational
4. Formal - Business-appropriate, structured
```

### Question 3.4: Accessibility Preferences
```
Any accessibility preferences? (Select all that apply)

Options:
1. ADHD-friendly - Summaries first, visual hierarchy, celebrate wins
2. Dyslexia-friendly - Simple formatting, clear fonts
3. Low-distraction - Minimal notifications, focused workflow
4. None / Standard
```

---

## Phase 4: Productivity Tools

### Question 4.1: Email Provider
```
Which email provider do you use?

Options:
1. Gmail (Recommended - full integration via GWS CLI)
2. Outlook / Microsoft 365 (Coming soon)
3. Other / None
```

### Question 4.2: Calendar
```
Which calendar do you use?

Options:
1. Google Calendar (Recommended - full integration via GWS CLI)
2. Outlook Calendar (Coming soon)
3. Other / None
```

### Question 4.3: Messaging Tool
```
Which messaging tool do you use at work?

Options:
1. Slack (Full integration)
2. Microsoft Teams (Coming soon)
3. Discord
4. Other / None
```

### Question 4.4: Project Management
```
Which project management tool do you use?

Options:
1. Jira (Full integration)
2. Linear (Full integration)
3. Asana (Coming soon)
4. Trello
5. Other / None
```

### Question 4.5: Note-Taking Tool
```
Which note-taking tool do you use?

Options:
1. Obsidian (Recommended - full integration)
2. Notion (Full integration)
3. Logseq (Full integration)
4. Roam Research (Full integration)
5. Plain Markdown files
6. Apple Notes / Other
```

---

## Phase 5: Preferences

### Question 5.1: Summary Style
```
How do you like to receive summaries?

Options:
1. Bullet points - Quick, scannable
2. Paragraphs - Detailed context
3. Tables - Organized data
4. Mixed - Bullets for tasks, paragraphs for context
```

### Question 5.2: Emoji Usage
```
Emoji preference?

Options:
1. Heavy - Lots of emojis for visual scanning
2. Light - Some emojis for priority indicators
3. None - Text only
```

### Question 5.3: Morning Routine
```
How detailed should your morning prep be?

Options:
1. Quick overview - Just urgent items (2-3 min)
2. Standard - Full workflow with confirmations (4-6 min)
3. Detailed analysis - Deep dive into everything (8-10 min)
```

### Question 5.4: Celebration Style
```
Should I celebrate your wins?

Options:
1. Yes! - Positive reinforcement helps
2. Sometimes - For big achievements
3. No - Just the facts
```

---

## Phase 6: Personalization (Optional)

### Question 6.1: VIP Contacts
```
Any VIP contacts I should always prioritize? (emails or names, comma-separated)

Examples: boss@company.com, john.smith@client.com

(Leave blank to skip)
```

### Question 6.2: Recurring Commitments
```
Any recurring commitments I should know about?

Examples:
- Team standup every morning at 9 AM
- 1:1 with manager every Tuesday
- Client call every Friday

(Leave blank to skip)
```

### Question 6.3: Industry Terminology
```
Any specific jargon or terminology I should use?

Examples:
- Use "sprint" instead of "iteration"
- Call tickets "issues" not "bugs"

(Leave blank to skip)
```

---

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

### 7.2: Update Config

Update `config/default.json` or create `.config.local.json` with user's choices:

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

**Files Created:**
- `user-profile.md` - Your personalized profile
- `.config.local.json` - Your local configuration

---

## Next Steps

1. **Set Up GWS CLI** (for Gmail and Google Calendar):
   {{#if gmail_enabled or calendar_enabled}}
   - Install: `npm install -g @googleworkspace/cli`
   - Authenticate: `gws auth login -s gmail,calendar`
   - Verify: `gws --version`
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

## Testing Checklist

- [ ] All questions display correctly
- [ ] Multi-select questions work
- [ ] Free-text input handles special characters
- [ ] Profile markdown generates correctly
- [ ] Config JSON is valid
- [ ] Error handling works for invalid input
- [ ] Setup can be re-run to update profile
