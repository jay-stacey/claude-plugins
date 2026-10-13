---
name: shutdown
description: Close the user's workday. Checks off what got done (with proof where it can find it), makes the user choose for each open high-priority task between finishing it now and moving it to a day, empties their head into tasks, saves tomorrow's first step for the morning brief, and plans night work on purpose. Use when the user says they are wrapping up, signing off, done for the day, or asks to shut down or review the day.
when_to_use: Trigger phrases include "shutdown", "shut down", "wrap up", "end of day", "EOD", "I'm signing off", "done for the day", "close the day", "what did I get done today", "review my day".
argument-hint: "[--quick] [--dry-run]"
effort: high
allowed-tools: Bash, Read, Write, Edit, Glob, Agent, AskUserQuestion, CronCreate, PushNotification
---

# Shutdown

The user has ADHD. Days vanish, follow-ups get lost overnight, and open loops
keep the mind running after work. The shutdown answers three things in about
five minutes: what got done today, what must not be dropped, and what the
first step is tomorrow. Night work is fine for this user when it is chosen on
purpose; the shutdown makes it a choice instead of a slide.

Follow `response-style`. Print a one-line status as each step starts. Keep
every question short. Never scold for what did not get done.

```bash
T="python ${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py"
```

Flags: `--quick` skips step 3 (brain dump) and the evidence search.
`--dry-run` asks the questions but writes nothing, and says what it would
have saved.

## Step 1: What got done (status: "Looking at today...")

1. `$T context`, `$T list --all`, and `$T stats`. Today's planned tasks are
   Now plus Today, plus anything already done today (`done_at` is today).
2. Look for proof, unless `--quick`:
   - Focus sessions in the log are already counted.
   - Ask `task-assistant` (one call) for Linear issues assigned to the user
     that moved to done or into review today. Match them to tasks by the
     `source` link.
3. Tell the user which tasks you can already mark done and why ("PR merged",
   "NEO-412 moved to done"). Then ask with AskUserQuestion, multiSelect,
   "Which of these did you also finish?" listing the open planned tasks
   (split into two questions if there are more than four).
4. Mark each with `$T done <id>`.

## Step 2: What must not be dropped (status: "Checking what's still open...")

For each open task that is high priority, due today, promised to someone, or
blocking someone, ask with AskUserQuestion (one question per task, at most
four; mention the rest in one line and move them to the next workday):

- **Finish today** — show the real time: `estimate × speed`, rounded up to 5
  minutes. "About 50 minutes at your usual speed."
- **Move to <next workday>** (recommended when it is not due today)
- **Move to another day** — the user types the day.

Apply with `$T update <id> --due <date>` and `$T move <id> week|later`. A
push to a later day adds one to the task's `slipped` count. When `slipped`
reaches 2, ask in the same question set whether the estimate was wrong or the
task should be split, because a task that keeps moving is usually too big.

Tasks the user chose to finish today stay in Today. Step 5 decides when.

## Step 3: Empty your head (status: "Anything still in your head?")

Ask one question with AskUserQuestion: "Anything still rattling around?"
Options: "Nothing" (recommended), and the free-text "Other" box for a list.
Turn each line into a task with `$T add --parse "<line>"`. They land in This
week unless the line names a day. Say the count in one line.

## Step 4: Tomorrow's first step

Pick tomorrow's most likely Now task: due tomorrow, else the top high-priority
task, else what was Now today. Propose one concrete first step the user can
do in 5 minutes cold, and ask with AskUserQuestion: your proposal
(recommended), or type another. The morning brief opens with it.

## Step 5: Tonight (status: "Last question...")

Ask: "Working tonight?"

- **No, the day is done** (recommended unless something was marked Finish
  today).
- **Yes, one thing** — then ask which task (from the Finish-today ones first)
  and the stop time. Book a stop reminder: CronCreate one-time job at the
  stop time with the prompt "Stop time. Wrap up *<task>* and park it.", and
  say that it fires only if this session stays open; the dashboard also
  shows it when running.

## Step 6: Save (status: "Saving the day...")

Skip with `--dry-run`.

1. Write the shutdown JSON to a temp file in the session scratchpad (or
   `./temp/`) and run `$T shutdown-save <file>`, then delete the temp file:

   ```json
   {
     "date": "2026-10-13",
     "done": ["t-0101", "t-0102"],
     "moved": [{"id": "t-0103", "to": "2026-10-14"}],
     "finish_today": ["t-0104"],
     "brain_dump": 2,
     "first_step": "Open the 3.42 release notes draft and finish the customer section.",
     "first_task": "t-0103",
     "tonight": {"task": "t-0104", "until": "20:30"}
   }
   ```

   Use `"tonight": null` for no night work.
2. `$T archive --days 7` to fold away old finished tasks.
3. With the `notes` skill, add a `## Shutdown` section to today's daily note:
   a done list with times, what moved and where, tomorrow's first step.
4. If the session-manager plugin is installed, offer one line: "Want a sweep
   of stale Claude sessions? Run /manager." Only offer; do not run it.

## Close

Run `$T stats` again. Then two or three lines, and the next step:

> Day closed. 6 done, 17 points today. Streak: 7 days.
> Moved 2 tasks to Wednesday.
>
> Next: tomorrow starts with opening the 3.42 release notes draft.

With night work: "Tonight: *Draft release notes*, stop at 20:30." instead of
the last line.

## Safety

Everything here changes only the user's own task files, notes and in-session
reminders. It never changes Linear, Jira, Slack or email. The stop reminder is
a one-time job inside this session, not a lasting schedule.
