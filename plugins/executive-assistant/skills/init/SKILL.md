---
name: init
description: Set up and personalize the executive assistant through an interactive questionnaire - working hours, timezone, which integrations to enable, notes folder, and assistant personality. Use when the user asks to set up, configure, personalize, or reconfigure the assistant, or when they run the assistant for the first time and no profile exists.
argument-hint: "[--reset]"
context: fork
agent: initializer
allowed-tools: Read, Write, Edit, AskUserQuestion
model: sonnet
---

# Init

Walks the user through setup and writes their profile. The `initializer` skill
carries the question wording and branching — this is the entry point.

## Usage

```
/init            # run setup, keeping any existing answers as defaults
/init --reset    # start over, ignoring the existing profile
```

## What it configures

| Area | Settings |
|---|---|
| Basic | Name, role, timezone |
| Work style | Working hours, communication style, accessibility preferences |
| Integrations | Which of Gmail, Calendar, Slack, Jira, Linear to enable |
| Notes | Markdown notes folder path and daily-note subfolder |
| Personality | Assistant name, tone, emoji and celebration preferences |

## What it writes

Settings that have a `userConfig` key — notes folder, timezone, working hours,
enabled integrations, assistant name, personality preset — are **not** written
to a file. Collect the answers, then tell the user the exact command to apply
them:

```
/plugin configure executive-assistant@personal-plugins
```

That is the source of truth, it survives reinstalls, and it is what every skill
reads at run time. Offer the equivalent one-liner when they would rather not
click through the dialog:

```
claude plugin install executive-assistant@personal-plugins --config notes_vault_path=... --config timezone=...
```

Only two things are still written as files:

- `user-profile.md` in the plugin root — free-text context (role, priorities,
  VIP contacts) that has no `userConfig` key. Gitignored.
- `.config.local.json` — legacy overrides. Write it only for the detailed
  Gmail/Calendar tuning that has no `userConfig` key.

Secrets never go in either file. `google_oauth_client_id` and
`google_oauth_client_secret` are `sensitive` options kept in secure storage, so
collect them through `/plugin configure` and never echo them back.

## Behavior

Existing answers become the defaults on a re-run, so the user can press through
the parts that have not changed. That matters because setup is long enough that
people avoid re-running it, and a stale profile is worse than a slightly
outdated one.

If the user abandons partway, write what was collected so far rather than
discarding it, and tell them which sections are still unset.
