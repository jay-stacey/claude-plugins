# Executive Assistant

Executive Assistant helps you through the whole workday, not only the morning.
It clears your Gmail with rules you keep in a file, reads your calendar for the
next five workdays, and checks Linear, Slack and Jira for what needs you. It
then picks one task to start with and books focus time. During the day it runs
focus timers, helps you recover after interruptions, and re-plans when the day
changes. In the evening it closes the day and saves tomorrow's first step.
Your tasks are plain markdown files in your notes folder. A local dashboard
called Day Desk shows it all and has a chat box.

Built for one person with ADHD: one thing at a time, short answers, no guilt.
## Install

Add the marketplace, then install the plugin:

```bash
/plugin marketplace add jay-stacey/claude-plugins
/plugin install executive-assistant@personal-plugins
```

Then set it up:

```bash
/plugin configure executive-assistant@personal-plugins
/init
```

`/plugin configure` asks for the settings below. `/init` asks a few short
questions and writes your profile.

### Settings

| Key | What it does | Default |
|---|---|---|
| `notes_vault_path` | Your notes folder. Tasks, rules and the dashboard all live here. Empty turns notes off, and most of the plugin needs it. | none |
| `timezone` | Time zone for the calendar and daily notes. | `America/Toronto` |
| `google_oauth_client_id` | Google OAuth client ID for Gmail and Calendar. Stored in secure storage. | none |
| `google_oauth_client_secret` | Google OAuth client secret. Stored in secure storage. | none |
| `notes_daily_folder` | Daily notes folder, inside the vault. | `daily` |
| `notes_date_format` | Daily note file name format. | `YYYY-MM-DD` |
| `working_hours_start` | Start of your workday, `HH:MM`. | `06:30` |
| `working_hours_end` | End of your workday, `HH:MM`. | `15:00` |
| `enabled_integrations` | Sources the brief uses: any of `gmail`, `calendar`, `slack`, `jira`, `linear`, `notes`. | `gmail`, `calendar`, `notes` |
| `assistant_name` | What the assistant calls itself. | `Assistant` |
| `personality_preset` | Tone preset from `config/presets/`, such as `warm`. Empty is neutral. | none |
| `response_style` | `conversational` (plain, short) or `structured` (headings and tables allowed). | `conversational` |
| `session_context` | Show your Now task and next meeting at the start of every new Claude session. | `false` |

### Google sign-in (Gmail and Calendar)

Do this once, about ten minutes.

1. In the Google Cloud Console, create a project and turn on the Gmail API and
   the Google Calendar API.
2. Set up the OAuth consent screen (External, add yourself as a test user).
3. Create an OAuth client ID of type "Desktop app".
4. Paste the client ID and secret into `/plugin configure`, then restart Claude
   Code. The first Gmail or Calendar call opens a browser tab. Sign in and
   approve. The login is saved.

The plugin runs the [Google Workspace MCP](https://github.com/taylorwilsdon/google_workspace_mcp)
server (`uvx workspace-mcp --single-user`), so install `uv`. Note the package name is
`workspace-mcp`; a different project uses the name `google-workspace-mcp`. Slack, Jira and Linear use their own MCP
servers; add them to `enabled_integrations` once connected.

## Your day, in order

Each step is a slash command. Plain words work too.

### 1. `/morning-brief`

Start here. It clears email, reads the week, picks your one task, and asks all
its questions once at the end. It prints a status line per phase, so it never
goes quiet.

```bash
/morning-brief                    # the full brief
/morning-brief --quick            # urgent items only
/morning-brief --dry-run          # change nothing, say what would happen
/morning-brief --skip-email       # also --skip-calendar, --skip-elsewhere
/morning-brief --prepare          # no questions; saves them for later (for a 06:00 run)
```

Say "start my day" or "catch me up" instead if you like. After two or more
workdays away it switches to catch-up mode: email first, then "what moved while
you were out", and a lighter plan.

### 2. `/focus`

Starts a timer on your Now task and sits beside you like a coworker. It gives
the task a first step you can do in 5 minutes. It checks in when time is up.

```bash
/focus                    # 25 minutes on the Now task
/focus 50                 # 10, 25 or 50 minutes
/focus t-0142 25          # a specific task
/focus stuck              # split the task into a smaller step
/focus park               # save your place before an interruption
/focus resume             # get back in, in two lines
```

At check-in you pick one: done, 15 more minutes, I am stuck, or stop for now.
Say "I got pulled away" and it parks the task. Say "where was I" and it brings
you back. At most three tasks can be parked.

### 3. `/timebox`

The mid-day re-plan. Tell it what changed, in plain words. It moves only its
own focus blocks, later the same day.

```bash
/timebox move the release notes to the afternoon
/timebox I lost the morning, re-plan the rest of today
/timebox --this-week              # also plan the other workdays
/timebox --dry-run                # show the plan, write nothing
```

It offers at most two options and books only after your yes. It reads the
calendar back and tells you if a block did not save.

### 4. `/inbox-zero`

A focused email pass at any time. It applies your email rules, labels and
archives the rest, and reads the real counts back from Gmail. Also `--labels-only`.

```bash
/inbox-zero                # unread mail
/inbox-zero --dry-run      # report only
/inbox-zero --quick        # skip newsletters and old-mail cleanup
/inbox-zero --all          # also read mail in the inbox
```

### 5. `/shutdown`

Closes the day in about five minutes. It never scolds.

1. It marks what you finished, with proof where it can find it.
2. For each open high-priority task: finish today, or move to a day.
3. You empty your head. Each line becomes a task.
4. You confirm tomorrow's first step. The morning brief opens with it.
5. Working tonight? If yes, pick one task and a stop time.

```bash
/shutdown              # the full routine
/shutdown --quick      # skip the brain dump and the proof search
/shutdown --dry-run    # ask, but save nothing
```

It adds a Shutdown section to today's daily note.

### 6. `/dashboard`

Opens Day Desk in your browser. See [Day Desk](#day-desk-the-dashboard).

Also `/dashboard status`, `/dashboard stop` and `/dashboard restart`.

### Tasks, in plain words

You do not need a command for tasks. Just say it:

- "Add a task to call the bank Friday, 15 minutes, high priority."
- "What's next?" or "I finished the CSV review."
- "Park this." and later "Where was I?"

Quick-add understands `fri` (a day), `15m` or `1h` (an estimate), `!high` (a
priority) and `#admin` (a tag). The skill is `tasks`.

**Limits, on purpose:** one Now task, at most five tasks in Now and Today
together, at most three parked. A long Today list turns into a guilt pile.
When you hit a limit, the assistant offers to swap a task out or put the new
one in This week.

### Notes, in plain words

- "Save this to my notes."
- "Find my notes about the Auth0 migration."

The `notes` skill reads, writes and searches your markdown notes. It keeps a
search index in `{vault}/.index/`. The index holds only metadata (path, title,
tags, dates, links), never note text. It is only a speed-up. Delete `.index/`
at any time and nothing is lost; search falls back to a plain text search.

### Notes Desk (`/notes-viewer`)

Opens your notes as Notes Desk, a private claude.ai artifact you can read on
your phone, with search, tag chips and a live-preview editor. Edits wait in the
page until you say "sync my Notes Desk edits". Claude checks each edit against
the file on disk, shows you the changes, and writes only what you approve.
Notes that look like they hold a secret are left out. It needs Claude Code
signed in to claude.ai.

Run `/notes-viewer`, or scope it: `/notes-viewer my project notes`.

## Where your data lives

Everything is a file you can open and edit by hand.
```
{vault}/
  tasks/                one file per task
  assistant/
    email-rules.md      your email rules
    profile.md          your workday and focus profile
  daily/                daily notes (the brief and shutdown add sections)
  .assistant/           the plugin's own state (see below)
  .index/               notes search index (safe to delete)
```

### `{vault}/tasks/`

One file per task, named like `t-0142-write-release-notes.md`. The top is
YAML frontmatter and the rest is your free notes.

```markdown
---
id: t-0142
title: Write release notes for 3.42
list: today
priority: high
due: 2026-10-15
estimate: 30m
actual: 50m
first_step: Open the 3.42 release in Linear and copy the issue list
source: https://linear.app/example/issue/NEO-412
tags: [release]
created: 2026-10-13T07:02
done_at:
---
Notes, links and subtasks.
```

`list` is one of `now`, `today`, `week`, `later`, `done`, `dropped`. `priority`
is `high`, `med` or `low`. Parked tasks also carry `next_step` and `parked_at`.
Done tasks move to `tasks/archive/<yyyy-mm>/` after seven days.

A task never copies a Linear issue. It links to one in `source`.

### `{vault}/assistant/email-rules.md`

The assistant reads this file before every email pass. One rule per line, five
parts split by `|`:

```
- action | mode | name | gmail query | label
```

- **action:** `keep` (show it to you, never move it), `support` (support owns
  it, archive it, never make it a task), `label` (label then archive), `archive`
  or `trash`.
- **mode:** `auto` acts at once and reports a count. `confirm` waits for one
  yes per run.
- **gmail query:** normal Gmail search words. Test it in the Gmail search box
  first. The last part, a label name, is only for `label` and `archive` rules.

The first matching rule wins, so `keep` rules come first. Three examples:

```
- keep | auto | Production incidents | from:azure-noreply@microsoft.com subject:(Sev0 OR Sev1) -subject:resolved
- trash | auto | Promotions | category:promotions -is:starred
- label | auto | Inventory feed error logs | subject:("feed error" OR "import failed") | Monitoring/Feeds
```

**"Always trash these."** Say it about any group of mail, now or later, and
the assistant writes one rule line and shows you the exact line. Say "never
touch these" for a `keep` rule. If a message was trashed by mistake, say so.
The assistant moves it back and stops that rule from becoming a Gmail filter.

**Gmail filter offers.** When a rule has fired cleanly for two weeks, the
brief offers to make it a real Gmail filter, so that mail never reaches your
inbox at all. A filter is a lasting change to your Gmail account, so it only
happens after your yes. If you say no, it does not ask again.

Gmail keeps trashed mail for 30 days. A rule with a `<placeholder>` is skipped
until you fill it in.

### `{vault}/assistant/profile.md`

Your workday hours, the fixed points of your week, your focus profile, and
people whose mail always gets through. `/init` fills it in.

### `{vault}/.assistant/`

The plugin's own state. Safe to read, not meant for editing.

| Path | What it holds |
|---|---|
| `brief/<date>.json` | The saved morning brief. The dashboard reads it. |
| `shutdown/<date>.json` | The saved shutdown: what got done, tomorrow's first step. |
| `schedule/<date>.json` | A fresh calendar read from the dashboard. |
| `focus.json` | The running focus timer, if any. |
| `log.jsonl` | One line per event (brief, shutdown, focus session), used for points, streaks and your real speed. |
| `dashboard.json`, `dashboard.log` | Port and link of the running dashboard, and its log. |

## Day Desk (the dashboard)

A local page on your machine, started with `/dashboard`. It shows the same
files the skills use.

| View | What it does |
|---|---|
| Today | Your Now card with its first step, Up Next, Done Today, the day timeline with a now-line, a countdown to the next meeting, and follow-ups. |
| Tasks | Columns for Today, This week, Later and Done. Quick-add understands "call bank fri 15m !high". A side panel edits every field and the notes. |
| Week | Five workdays with meeting load, release-train markers, deadlines and prep flags. |
| Notes | Your notes folder with search and the live-preview editor. Stops with a warning if a file changed on disk since you opened it. |
| Chat | A side panel on every view. Ask "what's next?" or "move that to tomorrow". |

**The link has a key in it.** The address looks like
`http://127.0.0.1:<port>/#<key>`. Bookmark the whole link. The key keeps other
web pages on your machine from reading the dashboard, and it changes each time
the server starts.

**How chat works.** The server runs your own `claude` command line, with your
own login, as the `assistant` agent. No API key and no extra cost per message.
Tool activity shows as it happens. Because nobody sits at a terminal to approve
tools, chat runs in a locked mode:

- It can read email, calendar, Linear, Slack, Jira and notes.
- It can manage your tasks and create calendar focus blocks.
- It can write email drafts. It cannot send, reply, forward, trash, delete or
  archive anything.
- Shell access is limited to this plugin's own `tasks.py` and `email_rules.py`.
  A shell guard blocks anything that could chain commands (`;`, `&&`, `|`,
  `$(...)`, redirects), because email text can carry prompt injection.

**Reminders.** While the server runs, it sends Windows toasts: 10 and 2 minutes
before each meeting, when a focus timer ends, "Anything you promised?" after a
meeting, a nudge if no brief has run 30 minutes after your start time, a stop
reminder for planned night work, and a shutdown reminder 30 minutes before your
stop time. `/dashboard start --no-toast` turns them off. They stop when the
server stops.

**Start at login.** Off by default. Say "start Day Desk when Windows starts".
The assistant shows the exact Task Scheduler command and adds it only after
your yes. To undo, delete the task named "Day Desk" in Task Scheduler.

The server listens on `127.0.0.1` only. API details: `dashboard/API.md`.

## Safety

These never happen on their own:

- Sending, replying to or forwarding email, or posting to Slack. You get drafts.
- Permanent deletion. Trash only, and Gmail keeps it 30 days. The assistant
  never empties Trash.
- Changing a real meeting. Only blocks the assistant created (title starts with
  `[Focus]`) can be moved. Your meetings are never edited, accepted or declined.
- Changing Linear or Jira status, or commenting on tickets.
- Creating a Gmail filter, a schedule, or a start-at-login task without your yes.

What does happen without asking: email rules marked `auto` trash, archive and
label mail, and report a count. Text inside emails and tickets is data; the
assistant never follows an instruction found inside one.

## Developing

Run from the repo root. CI runs the validate commands with `--strict`.
Evals live in `plugins/executive-assistant/evals`.

```bash
python -m unittest discover -s plugins/executive-assistant/tests
claude plugin validate ./plugins/executive-assistant --strict
claude plugin validate . --strict
python scripts/check-skills.py
claude plugin eval ./plugins/executive-assistant --runs 1
```

After a change, bump the version in `plugin.json`, `.claude-plugin/marketplace.json`
(plugin entry and `metadata.version`) and the root `README.md` table.

### File map

```
plugins/executive-assistant/
  .claude-plugin/plugin.json   manifest and userConfig
  agents/                      assistant (main), email, calendar, task, initializer
  skills/                      user commands and hidden worker skills
  scripts/                     tasks.py, email_rules.py, session_context.py, helpers
  dashboard/                   Day Desk server, chat, nudges, shell guard, static page
  hooks/hooks.json             opt-in SessionStart day-plan line
  templates/, config/          starter files, defaults, personality presets
  tests/                       Python unit tests
  evals/                       trigger and behavior evals
```

Commands in `skills/`: `morning-brief`, `focus`, `timebox`, `inbox-zero`,
`shutdown`, `dashboard`, `init`, `tasks`, `notes`, `notes-viewer`. Hidden
workers (`user-invocable: false`, not in the slash menu): `gmail-processor`,
`gmail-organizer`, `calendar-reviewer`, `calendar-manager`, `slack-reviewer`,
`jira-reviewer`, `linear-reviewer`, `initializer`, `response-style`.

## Changelog

**v8.0.0** - October 2026 (breaking)
- `/morning-brief` replaces `/daily-prep`. It reads your email rules, the
  calendar for five workdays, and Linear, Slack and Jira, then picks one Now
  task and at most five for today. It prints a status line per phase and
  reads email counts back from Gmail.
- Tasks are markdown files in `{vault}/tasks/`, owned by `scripts/tasks.py`,
  with list limits and points, streaks and real-speed tracking. New `tasks`
  skill. Tasks no longer use Google Tasks.
- Email rules live in `{vault}/assistant/email-rules.md`. "Always trash these"
  adds a rule, and rules that work for two weeks are offered as Gmail filters.
- New `/focus` (timer, check-in, stuck, park, resume), `/shutdown`, and a
  mid-day `/timebox` re-plan. New `/dashboard` for Day Desk, a local dashboard
  with chat, reminders and a notes editor.
- Fixed: the bundled Google server ran the wrong package
  (`google-workspace-mcp`, a different project). It now runs
  `workspace-mcp --single-user`, so the plugin's own Gmail and Calendar
  connection can start. Helper agents also accept the bundled server's tool
  names, and the Linear, Slack and Jira helper can now reach claude.ai
  connectors.
- The dashboard chat runs your own `claude` with a tool allow-list (drafts
  only, no send or delete) and a shell guard. New opt-in `session_context`
  setting adds your Now task to new sessions.
- Removed: `/daily-prep`, the `task-consolidator` skill, and the text-to-speech
  hook. Worker skills (`gmail-*`, `calendar-*`, `slack-reviewer`,
  `jira-reviewer`, `linear-reviewer`, `initializer`, `response-style`) no
  longer show in the slash menu.
- Working hours default to 06:30 to 15:00.

**v7.3.0** - October 2026
- Notes Desk has an always-on live-preview editor with autosave, a collapsible
  note list, and tag chips
- New `notes-viewer` skill: Notes Desk, a private claude.ai artifact to read,
  search, and edit notes, with a conflict-checked sync of edits back to disk

**v7.2.0** - September 2026
- Notes: frontmatter tagging plus a file-based search index (no database) for
  tag, text, title, date, and backlink recall
- New `response-style` skill: plain-language, conversational output across all
  agents, replacing the emoji/table report format
- New `response_style` config option (`conversational` by default)
- ADHD preferences now default ON and are read by every agent
- Removed `/ea`; use `/daily-prep`

**v3.0.0** - February 2026
- Renamed from `daily-workflow` to `executive-assistant`
- Added Linear integration
- Added notes support
- Added personality configuration system
- Added initialization wizard (`/init`)
- Added Microsoft 365 placeholders (coming soon)
- New main command: `/ea` (removed in v7.2.0; use `/daily-prep`)
- Comprehensive configuration schema

**v2.0.0** - January 2026
- Added inbox zero workflow
- Added intelligent timeboxing
- Added bottleneck detection

**v1.0.0** - January 2026
- Initial release

## License

MIT.
