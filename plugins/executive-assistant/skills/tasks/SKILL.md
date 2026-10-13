---
name: tasks
description: Add, list, change, finish, park and resume the user's tasks, which are markdown files in the notes folder. Use when the user asks to add or capture a task, asks what is on their list or what to do next, marks something done, moves a task to another day, or parks a task before switching. Other skills use it for every task read and write.
when_to_use: Trigger phrases include "add a task", "remind me to", "put X on my list", "what's next", "what's on today", "I finished X", "move X to Friday", "park this", "where was I", "pick up where I left off".
argument-hint: "[add <text> | list | done <id> | park <id> | resume <id>]"
allowed-tools: Bash, Read
---

# Tasks

Each task is one markdown file in `{vault}/tasks/`, with YAML frontmatter at
the top and free notes below. The script `scripts/tasks.py` owns every read and
write. Always go through it, never edit task files with Edit or Write: the
script enforces the list limits, keeps the format the dashboard reads, and logs
points. A hand edit by the user is fine; the script reads it.

```bash
T="python ${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py"
$T init                 # first use: creates tasks/ and assistant/ files
```

The vault comes from `CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH`. If the script
says no notes folder is set, tell the user to run
`/plugin configure executive-assistant@personal-plugins`, and stop.

## Lists and limits

| List | Meaning |
|---|---|
| `now` | The one task the user is doing. At most one. |
| `today` | Planned for today. Now plus Today hold at most five. |
| `week` | This week. New tasks with no day land here. |
| `later` | Someday. The dashboard keeps it folded. |
| `done`, `dropped` | Finished or let go. Files stay on disk. |

The limits exist because a long Today list turns into a guilt pile for this
user. When the script refuses (exit code 4), say so plainly and offer the two
moves that fix it: swap a task out of Today, or put the new one in This week.
Do not raise the limit.

## Commands

All output is JSON. Exit codes: 0 ok, 2 bad input, 3 the file changed since it
was read, 4 a limit was hit, 5 not found.

```bash
$T add --parse "call the bank fri 15m !high #admin"     # quick-add text
$T add --title "Draft release notes" --due 2026-10-15 --estimate 45m \
       --priority high --first-step "Open the release in Linear" --source "<url>"
$T list                         # open tasks; --list now,today; --all; --tag x
$T show t-0142                  # one task with its notes and sha
$T update t-0142 --due 2026-10-16 --estimate 1h          # "" clears a field
$T move t-0142 now              # old Now drops to Today
$T done t-0142 --actual 50m     # logs points; suggests the next Now task
$T park t-0142 --next "Rerun the purge test"             # at most three parked
$T resume t-0142
$T parse "text"                 # preview how quick-add text is read
$T stats                        # points today and this week, streak, speed
```

Quick-add words: a day (`today`, `tomorrow`, `fri`, `2026-10-20`), a length
(`15m`, `1h30m`), a priority (`!high`, `!med`, `!low`) and tags (`#admin`).
Everything else is the title.

## How to write a good task

- **Title**: what done looks like, in the user's own words. "Send the CEO the
  error-spike summary", not "Error spike".
- **First step**: something the user can do in five minutes, cold. "Open last
  week's strategy note and copy the open items." A task without a small first
  step is the hardest kind for this user to start. Add one whenever you create
  or plan a task.
- **Estimate**: always set one. `stats` returns `speed`, the user's usual ratio
  of real time to planned time. When you plan, multiply by it and say so: "you
  planned 30m, that is about 50m at your usual speed".
- **Source**: link back to the email, Linear issue or meeting it came from.

Linear stays the system of record for engineering work. Do not create a task
that copies a Linear issue. Link the issue from a task only when there is extra
personal work around it, such as "prep my comments on NEO-412".

## Answering the user

Follow the `response-style` skill. After a change, say what happened in one
sentence: "Added *Call the bank* to This week, due Friday, 15 minutes." When the
user asks what to do next, name the Now task and its first step, then the time
until their next meeting if you know it. Never read the whole list aloud unless
they ask for it.
