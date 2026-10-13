# Executive Assistant 8.0 plan

Status: proposal, waiting for approval. Nothing below is built yet.

This plan changes the executive-assistant plugin from a morning report into a
day-long support system: a morning brief that remembers your email rules, a
task store in markdown, focus help built for ADHD, a shutdown routine, and a
local dashboard with chat. It is based on three sources: a read of every skill,
agent and hook in the plugin; your Claude Code and Cowork history from February
to October 2026; and your interview answers.

## 1. What the evidence says

### From your history

- **The plugin is mostly unused.** Claude Code shows zero runs of `/daily-prep`,
  `/inbox-zero` or `/timebox`. The real morning work ran in Cowork scheduled
  tasks (56 runs of a 6 AM prep from July) and in Pepper. All four Cowork
  schedules are now turned off.
- **Inbox backlog is the top pain.** Unread counts of 99 to 200+ recur. 37
  messages dispute counts ("I still see 34 unread"). The same noise classes get
  trashed every time, yet each run asks again, because the rules live only in
  the prompt and in memory notes that drift.
- **Silence reads as failure.** You sent "Hello?" or "What's the status?" 7
  times during long runs. 18 of 94 prep days had gates nobody answered.
- **Writes fail quietly.** 5 of 7 approved calendar blocks saved on one day.
  Focus blocks "not actually created" on two other days.
- **Many open threads.** You touch 11.5 sessions a day on average (26 at most).
  31% of sessions hold one typed message and are never returned to.

### From the interview

| Area | Your answer |
|---|---|
| Hard parts | Starting tasks, getting back after interruptions, forgetting follow-ups, too many open threads |
| Time blindness | Late to meetings, tasks take far longer, days vanish |
| What has worked | Body doubling, one thing at a time, novelty and streaks |
| Nudges | Gentle check-ins |
| Peak focus | Early and mid-morning |
| Why past systems died | You stop opening them, lists get too long, upkeep is a chore |
| Shutdown | Night work is fine, but planned |
| Rewards | Done list, streaks, points |

### Your real day (from history)

Typed work runs 06:15 to about 15:00 on weekdays, with a gym block 06:00 to
07:00 on some days and lunch near 11:30. The release train sets the week:
Monday code freeze and cycle planning, Wednesday go/no-go, Thursday evening
deploy. Weekly: strategy review with the CEO, 1:1s, a biweekly product review.
The plugin default of 08:00 to 17:00 is wrong for you.

## 2. Problems in the plugin today

Ranked by how much they hurt. Five of 14 found are listed; the rest are small
wording fixes folded into the rewrite.

1. **Email rules are not stored anywhere durable.** `gmail-processor` has fixed
   patterns in its prompt. When you say "always trash these", nothing records
   it. This is why the assistant forgets common patterns.
2. **The subagents cannot see the plugin's own Google server.** Agents allow
   `mcp__google-workspace__*`, but tools from the bundled server are named
   `mcp__plugin_executive-assistant_google-workspace__*`. It works only because
   you also have a separate user-level Google server. You have three Google
   routes in total (claude.ai Gmail and Calendar connectors, a user-level
   server, the bundled server). The bundled one timed out at the start of this
   session.
3. **The voice hook doubles your voice.** `hooks/hooks.json` speaks every
   subagent stop through ElevenLabs. Your voice-replies plugin already speaks.
   You noted an old robotic voice talking over the new one on 2026-10-09.
4. **Skills contradict each other.** `inbox-zero` says "never delete, archive
   only" while `gmail-processor` trashes. `task-consolidator` writes emoji
   tables and asks before every write, against `response-style`. It also calls
   a "provider interface" (`findDailyNote`) that does not exist.
5. **Prompts use an older style.** Many rules are in capitals ("CRITICAL",
   "NEVER") with no reason given. Current Claude models follow calm,
   explained rules better and over-apply shouted ones. No skill sets `effort`.
   `calendar-reviewer` reads only today, so the week is never seen.

## 3. What changes

### 3.1 Morning brief (replaces daily-prep)

`/morning-brief` runs in four phases and prints a one-line status as each phase
starts, so a long run never goes silent.

1. **Load memory.** Read your profile, `email-rules.md`, the task store, and
   last night's shutdown (carry-overs and tomorrow's first step).
2. **Gather, in parallel.**
   - Email: page through all unread in batches of 50. Apply the rules file
     first. Rules marked `auto` act at once and report a count. New patterns go
     to one confirm. Finish with "200 of 200 processed, 3 left in inbox", read
     back from Gmail, not assumed.
   - Calendar: your own events (organizer or attendee) for the next five
     workdays, not only today.
   - Linear, Slack, Jira: only items that need you, and only when you have not
     already replied. Linear stays the system of record, so no task copies a
     ticket.
3. **Look at the week.** Flag meetings that need prep and make a prep task for
   each. Flag release-train collisions (a focus block on Wednesday go/no-go),
   double-books, and days over 6 meeting hours.
4. **Plan today.** Pick at most five tasks for Today, and one Now task. Put
   deep work in 06:30 to 11:30. Book each task at your real speed (see 3.3).
   Create focus blocks after one yes, then read the calendar back and report
   any block that did not save.

The brief writes to the daily note and to `.assistant/brief/<date>.json` for
the dashboard. After two or more days away it switches to catch-up mode: email
first, grouped by sender type, and a short "what moved while you were out".

**Email rules file.** `{vault}/assistant/email-rules.md` holds one rule per
line, in plain words, with an action (`trash`, `archive`, `label`, `keep`,
`support-owned`) and an `auto` or `confirm` flag. It is seeded from your
history: newsletters, promotions and webinars, cold sales, GitHub and Jira
automation, Linear digests, resolved Azure alert pairs, and routine SaaS
receipts go to trash. Feed-error logs get a label and are never deleted.
Production incidents, money, legal, security advisories and CEO asks are always
kept. When you say "always trash these", the assistant adds a line and shows
it. Once a rule has fired cleanly for two weeks, the brief offers to turn it
into a real Gmail filter, so the mail stops reaching the inbox at all.

### 3.2 Tasks in markdown

One file per task in `{vault}/tasks/`, with YAML frontmatter. Obsidian and any
editor can read it.

```markdown
---
id: t-0142
title: Write release notes for 3.42
list: today            # now | today | week | later | done | dropped
priority: high         # high | med | low
due: 2026-10-15
estimate: 30m
actual: 50m
first_step: Open the 3.42 release in Linear and copy the issue list
source: https://linear.app/dealerpull/issue/NEO-412
created: 2026-10-13T07:02
done_at:
tags: [release]
---
Notes, links and subtasks.
- [ ] Customer-facing section
```

A small Python command-line tool, `scripts/tasks.py`, owns every read and write.
Skills, the dashboard and the chat all go through it, so the format cannot
drift. Done tasks move to `tasks/archive/<yyyy-mm>/` after seven days. A
one-time import moves your open Google Tasks over, and then the plugin stops
using Google Tasks.

### 3.3 ADHD focus support

Each part answers something from your interview.

| Part | What it does | Answers |
|---|---|---|
| Now card | The dashboard and every brief show one task, with a first step you can do in 5 minutes. "Break it down" splits it further when you are stuck. | Starting tasks, one thing at a time |
| Focus session | `/focus` or the dashboard Start button runs a visible 25 or 50 minute timer. At the end it checks in: done, 15 more minutes, or stuck. | Body doubling, days vanish |
| Park and resume | "Park" saves where you were and the next step before you switch. A resume card brings you back in two lines. | Getting back after interruptions, too many threads |
| Follow-up catcher | After each meeting ends, a toast asks "Anything you promised?". The brief and shutdown scan your sent mail for "I'll send", "by Friday" and similar, and offer them as tasks. | Forgetting follow-ups |
| Time anchors | Toasts 10 and 2 minutes before each meeting. A workday bar shows time left. The plan books tasks at your real speed, learned from timer data ("you estimated 30m, you usually take 1.6 times that"). | Late to meetings, tasks take longer |

Limits keep the list from turning into a guilt pile: one Now task, at most five
Today tasks, at most three parked. Later is folded shut by default.

Upkeep stays low: tasks are captured for you from email, meetings and chat, and
a brain-dump box turns free text into tasks.

Rewards: a Done Today list with times, a streak of workdays with both a brief
and a shutdown, and points (1 to 3 per task by priority, 2 per finished focus
session, 3 each for brief and shutdown) with a weekly total.

### 3.4 Shutdown

`/shutdown` runs in five short steps.

1. **Check off.** It lists today's planned tasks and marks the ones it can
   prove done (Linear issues moved, PRs merged, timer sessions). You tick the
   rest.
2. **Triage what is open.** Each open high-priority task gets one of two
   labels. "Must finish today": due today, promised to someone, or blocking
   someone. "Move": pick a day, and re-estimate if it slipped. Must-finish
   items show their real-speed estimate, so you can see if tonight is needed.
3. **Brain dump.** Free text in, tasks out. This empties your head before you
   stop.
4. **Tomorrow's first step.** One concrete action, saved for the morning brief.
5. **Night work, planned.** It asks if you will work tonight. If yes, you pick
   one task and an end time, and it books a stop toast. If no, it closes the
   day.

It then writes the shutdown section of the daily note, updates the streak and
points, and offers a stale-session sweep through the session-manager plugin.
A gentle toast 30 minutes before your usual stop time reminds you to run it.

### 3.5 Dashboard

A local web page at `http://127.0.0.1:<port>`, served by a small Python server
with no dependencies, started by `/dashboard`. Dark theme. It has five views:

- **Today:** Now card, Up Next, Done Today, the day timeline with a now-line,
  a next-meeting countdown, and follow-ups.
- **Tasks:** Today, This week, Later and Done columns. Quick add understands
  "call bank fri 15m !high". A side panel edits every field and the notes.
- **Week:** five workdays with meeting load, release-train markers, deadlines
  and prep flags.
- **Notes:** the notes folder, search, and the same live-preview editor that
  Notes Desk uses. It reads and writes the files directly, and it stops with a
  warning if a file changed on disk since you opened it.
- **Chat:** a side panel on every view that talks to your assistant.

How the parts connect:

- **Schedule:** the server calls the Google Workspace MCP server directly (no
  model, no token cost) every 10 minutes. If that fails, it shows the last
  brief's copy and says how old it is.
- **Chat:** the server runs `claude -p --agent executive-assistant:assistant`
  with streaming output and resumes the same session, using your own Claude
  Code login on your machine. Tool activity shows as it happens. In chat the
  assistant can read everything, manage tasks and notes, and create calendar
  blocks after a yes. It drafts email and Slack text but never sends or trashes
  from chat in this version.
- **Nudges:** while the server runs, it sends Windows toasts for meeting
  heads-ups, focus check-ins, follow-up prompts and the shutdown reminder.
- **Safety:** the server listens on 127.0.0.1 only and needs a random token in
  the URL, so other web pages on your machine cannot call it.

Notes Desk (the claude.ai artifact) stays for reading notes on your phone.

### 3.6 Other improvements

1. **Fix the Google tool names.** Agents allow both name patterns. Pick one
   Google route and turn off the others, so mornings stop failing on re-auth.
2. **Remove the voice hook.** voice-replies already speaks.
3. **Add a SessionStart hook (opt-in).** Every new Claude session starts with
   two lines: your Now task and the next meeting. This helps when a coding
   session pulls you away from the plan.
4. **Rewrite prompts for current models.** Calm, explained rules; `effort` set
   per skill; `when_to_use` for trigger phrases; examples in tags. Merge
   `task-consolidator` into the brief and the task tool. Make `/timebox` the
   mid-day re-plan ("move X to the afternoon") that shifts blocks, not
   rebuilds them.
5. **Add evals.** Trigger tests for the new skills, and an email rules test
   that runs against a fixed fake inbox. Unit tests for `tasks.py` and the
   dashboard API.

Also changed: working hours default to 06:30 to 15:00 with deep work in the
morning; `/init` gains the ADHD questions from this interview; and `/schedule`
is offered (with your yes) to run the brief at 06:00 on weekdays, so it is
ready when you sit down.

Removed: `daily-prep` (replaced by `morning-brief`), `task-consolidator`
(replaced by the task tool), and the TTS hook. This is a breaking change, so the
version goes from 7.3.0 to 8.0.0.

## 4. Decisions I need from you

I picked a default for each. Say "approve" to accept all four.

1. **Email auto-trash.** Default: rules marked `auto` trash at once and report
   a count; new patterns need one yes. Trash keeps mail for 30 days.
2. **Chat route.** Default: the dashboard runs your own `claude` command line,
   using your existing login. The other route is the Agent SDK with an API key,
   which costs per token.
3. **Task location.** Default: `{vault}/tasks/`, one file per task.
4. **Google Tasks.** Default: import open tasks once, then stop using it.

## 5. Build order

Each phase ends with tests passing and a commit.

| Phase | Work | Time |
|---|---|---|
| 1. Foundations | `tasks.py` and tests, rules and profile files, Google tool-name fix, remove TTS hook, prompt cleanup | about 2 hours |
| 2. Morning brief | `morning-brief`, week lookahead, email rules learning, catch-up mode, write verification | about 2 hours |
| 3. Focus and shutdown | `focus` (start, park, resume, stuck), `shutdown`, points and streaks, SessionStart hook | about 1.5 hours |
| 4. Dashboard | server, five views, chat, notes editor, schedule fetch, toasts | about 5 hours |
| 5. Finish | evals, README, version 8.0.0 in all three places, CI | about 1 hour |

About a day and a half of build time in total. The dashboard design is locked
only after you walk through the prototype.
