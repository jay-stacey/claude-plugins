---
name: initializer
description: Interactive setup questionnaire that personalizes the executive assistant - name, role, hours, timezone, integrations, notes folder, style, and an optional focus profile - and writes the user's profile. Used by the initializer agent behind /init.
user-invocable: false
allowed-tools: Read, Write, Edit, AskUserQuestion
---

# Initializer

Walk the user through a short questionnaire, then write their profile and tell
them how to apply the settings. Setup is long enough that people avoid
re-running it, so keep each question quick and let existing answers stand as
defaults.

## Phases

1. **Welcome:** what setup covers and how long it takes.
2. **Basic information:** name, nickname, role, industry.
3. **Work style:** hours, timezone, communication style, accessibility.
4. **Tools:** email, calendar, messaging, project management, notes folder.
5. **Preferences:** summary style, emoji, morning depth, celebrations,
   assistant name and personality.
6. **Personalization (optional):** VIP contacts, recurring commitments,
   terminology.
7. **Focus profile (optional, opt-in):** see below.
8. **Generate:** write the files and show the config command.
9. **Complete:** short summary and next steps.

Question wording, options, and branching for phases 2-6 are in
`references/questionnaire.md`. Read it before Phase 2, then go in order.

Ask with `AskUserQuestion`, 2-4 clear options per question, and let "Other"
take free text. On a re-run, show the current answer as the first option.

## Phase 1: Welcome

> Let's set up your assistant. It takes about three minutes. I'll ask about
> you, your hours, which tools to connect, where your notes live, and how you
> like me to talk. You can skip anything optional.

## Phase 7: Focus profile

Ask first, as its own yes/no: "Want to set up a focus profile? Five quick
questions about how your day goes, so I can time nudges and plans better."
Only continue on a yes. Skipping it changes nothing else.

1. **Hardest parts of the day** (multi-select): starting tasks, getting back
   after interruptions, remembering follow-ups, too many open threads, other.
2. **Peak focus window:** early morning, mid-morning, afternoon, evening, or a
   custom range in HH:MM-HH:MM.
3. **Nudge level:** gentle, firm, or none.
4. **Shutdown style:** firm stop, flexible, or planned night work.
5. **Rewards** (multi-select): done list, streaks, points, or none.

Write the answers to `{vault}/assistant/profile.md`, where `{vault}` is the
notes vault path from Phase 4 (or `CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH`), under
this heading:

```markdown
## Focus profile

- Hard parts: starting tasks, getting back after interruptions
- Peak focus: 06:30-11:30
- Nudges: gentle
- Shutdown style: planned night work
- Rewards: done list, streaks
```

If the file exists, use Edit on the `## Focus profile` section: change the
lines these questions cover and keep any other lines (such as "Time
blindness" or "What helps") and every other section, because the user and
other skills edit this file too. If it does not exist, create it from
`${CLAUDE_PLUGIN_ROOT}/templates/profile.md` when that template exists, then
fill in the section; otherwise create it with a `# Assistant profile` title and
this section. If there is no notes vault, add the section to the end of
`user-profile.md` instead and say so in one line.

## Phase 8: Generate

### user-profile.md

Write `user-profile.md` in the plugin root. It holds free-text context that
has no `userConfig` key.

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

### Plugin config

Settings with a `userConfig` key are applied through plugin config, not a
file, because that is what every skill reads at run time and it survives
reinstalls. Show the collected values and the command:

```
/plugin configure executive-assistant@personal-plugins
```

Map answers onto `notes_vault_path`, `notes_daily_folder`, `notes_date_format`,
`timezone`, `working_hours_start`, `working_hours_end`, `enabled_integrations`,
`assistant_name`, `personality_preset`, `response_style`, and the two
sensitive Google OAuth credentials. Collect the credentials only through
`/plugin configure`, and never echo them back or write them to a file.

### .config.local.json

Write this only for the finer tuning that has no `userConfig` key:

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

## Phase 9: Complete

Follow the `response-style` skill. Lead with what the user still has to do,
then one short list of what was saved. Leave out steps that do not apply.

```markdown
You're set up. Three things left for you:

Run `/plugin configure executive-assistant@personal-plugins` and paste in the
values above. That turns on Gmail, Calendar, and notes.

Add your Google OAuth client ID and secret in the same dialog. The bundled
Google server signs you in the first time you use it. Run `/mcp` to check it.

Slack needs its own MCP server. Add it, then check it with `/mcp`.

Saved:
- user-profile.md with your role, VIPs, and preferences
- focus profile in {vault}/assistant/profile.md

When you're ready, run `/morning-brief --dry-run` to preview a morning, then
`/morning-brief` for the real thing.
```

Name only the Slack, Atlassian, or Linear servers the user enabled.

## Errors

- **Name skipped:** it is the one required answer, so ask again once, gently.
- **No integration enabled:** warn that the assistant will have little to do,
  then allow it.
- **No notes folder:** fine; notes are optional.
- **Invalid input:** check timezones against IANA names and VIP emails for a
  valid shape, and re-ask with an example.
- **File write fails:** say which file, show its content so the user can save
  it by hand, and keep every answer collected so far. Losing a half-finished
  setup is the outcome to avoid.
- **User stops partway:** write what you have and list the sections still
  unset.
