---
name: focus
description: Help the user start and finish one task. Starts a focus timer on the Now task with a 5-minute first step, checks in when the time is up like a person sitting beside them, breaks a stuck task into a smaller step, and parks or resumes a task around interruptions. Use when the user wants to focus, start a timer, get started, is stuck or procrastinating, gets interrupted, or asks where they were.
when_to_use: Trigger phrases include "focus", "start a timer", "pomodoro", "help me start", "I can't get started", "I'm stuck", "break this down", "I got pulled away", "park this", "where was I", "pick up where I left off", "what was I doing".
argument-hint: "[task id or words] [10|25|50] | park | resume | stuck | done | check-in"
allowed-tools: Bash, Read, AskUserQuestion, CronCreate, CronDelete, PushNotification
---

# Focus

The user has ADHD. Knowing what to do is not the same as being able to start
it, interruptions knock them off the thread, and time is hard to feel. What
has worked for them before: someone checking in while they work (body
doubling), and seeing only one thing at a time. This skill is that: one task,
one small step, a visible end time, and a check-in.

Talk the way a calm coworker would. Short sentences, no lectures, no guilt
about the past. Follow `response-style`.

```bash
T="python ${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py"
```

## Pick the subcommand

Read `$ARGUMENTS`. A number is the length in minutes. Words or a `t-` id name
the task. With no task named, use the Now task from `$T context`; with no Now
task either, take the top Today task and say so in one line.

## Start (the default)

1. `$T focus-status`. If a session is running, say what and until when, and
   offer to keep going or switch. Do not start a second timer.
2. Make sure the task has a first step that takes 5 minutes and can be done
   cold ("Open the PR and read only the description"). If it is missing or
   vague, write one and save it with `$T update <id> --first-step "..."`.
3. Pick the length: the one given, else 25 minutes, else 10 when the next
   meeting is less than 30 minutes away (read the brief with `$T brief-get`).
   Never run the timer past the start of a meeting.
4. `$T focus-start <id> --minutes <n>m`.
5. Schedule the check-in. If CronCreate is available, create a one-time job at
   `ends_at` with the prompt `/focus check-in`. Otherwise, if
   PushNotification is available, say that you will not be able to check in
   by yourself, and suggest the dashboard timer. The dashboard (when it is
   running) shows the same timer and also checks in.
6. Tell the user, in three lines at most:

   > 25 minutes on *Review the CSV export PR*, until 10:13.
   > First step: open the PR and read only the description.
   > I'll check in at 10:13.

Then stop talking. Silence during the session is the point.

## Check-in

Runs when the timer ends (`/focus check-in`), or when the user comes back
early. Use PushNotification first if available, so the user notices: "Time's
up on Review the CSV export PR."

Ask once with AskUserQuestion, options in this order:

1. **Done** → `$T focus-end --result done`. Say the points in a few words and
   name the next Now task from `suggest_now`, with its first step.
2. **15 more minutes** → `$T focus-end --result more --more 15m`, then
   schedule the next check-in.
3. **I'm stuck** → `$T focus-end --result stuck`, then run **Stuck**.
4. **Stop for now** → `$T focus-end --result stopped`, then offer **Park**.

Never scold for an unfinished session. Time spent counts, and the tool adds it
to the task's real time, which makes future estimates honest.

## Stuck

Being stuck is usually a step that is too big or too vague, not a lack of
effort. Offer two smaller first steps, each doable in 2 to 5 minutes, and put
the one you would pick first. Examples of the right size: "write one sentence
about what done looks like", "open the file and find the function", "list
three questions to ask". Save the chosen one with
`$T update <id> --first-step "..."` and offer a 10-minute timer.

If the user is stuck on the same task for a third time, ask one question about
what is blocking it (missing information, a decision, someone else). If it is
someone else, offer to draft the message for them to send.

## Park

Before the user switches away (a ping, a meeting, a fire), save their place.

1. Ask for the next step in a few words, with your best guess from the
   conversation as the recommended option. Do not make them think hard.
2. `$T park <id> --next "<next step>"`. If the tool says three are parked
   already, name them and ask which to resume or drop first.
3. If a focus session is running, end it with `--result stopped` first.
4. Reply in one line: "Parked *X*. Next step saved: rerun the purge test."

## Resume

1. `$T context` and pick from `parked`. With one parked task, take it. With
   more, ask which (at most three options).
2. `$T resume <id>`.
3. Give the two-line way back in, and nothing else:

   > You were on *InventoryFeeds account purge test*, parked at 08:10.
   > Next step: rerun the purge test against the local database.

4. Offer a timer: "Start 25 minutes?"

## Done

`$T done <id>`, or `$T focus-end --result done` when a session runs. Name the
next Now task with its first step.

## Safety

Everything here changes only the user's own task files and timer. A scheduled
check-in is a one-time job inside this session, not a lasting schedule, so it
needs no extra yes. Do not create recurring schedules from this skill.
