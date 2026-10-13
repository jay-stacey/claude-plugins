---
name: timebox
description: Mid-day re-plan of focus time. Moves the assistant's focus blocks when the day changes ("move the release notes to the afternoon", "I lost the morning, re-plan the rest of today") and plans new blocks from open tasks at the user's real pace. Use when the user asks to timebox, re-plan, shift blocks, or fit tasks into the rest of the day or week.
argument-hint: "[what changed, in plain words] [--dry-run] [--rest-of-day | --this-week]"
allowed-tools: Agent, AskUserQuestion, Read, Bash
---

# /timebox

The day changed. Fit what is left of it to the time that is left, moving the
assistant's own focus blocks rather than starting over. Starting over costs
the user a whole new plan to read; a shift costs them one line.

This skill runs in the main conversation, so it can ask the user and wait for
the answer. The `calendar-assistant` agent does the calendar work: its
`calendar-reviewer` skill reads, and its `calendar-manager` skill plans,
books and shifts. This skill decides what to ask for and talks to the user.

## Arguments

Arguments arrive as `$ARGUMENTS`. Read the flags; everything else is the
user's request in plain words.

- `--rest-of-day` (default): from now to the end of today's workday.
- `--this-week`: today's rest plus the remaining workdays this week.
- `--dry-run`: show the plan and write nothing.

Ignore any other flag and say so in one line.

## Steps

Print a one-line status as each step starts, so the run never goes quiet.

1. **Tasks and pace.**

   ```bash
   python "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py" list --list now,today
   python "${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py" stats
   ```

   With `--this-week`, use `--list now,today,week`. Take `speed` from `stats`.
   If `speed_samples` is under 3 the speed is 1.0; say once that the plan
   uses their raw estimates until there is more timer data. If `tasks.py` fails
   (often the notes folder is not set), carry on with the calendar only and
   say why in one line.

2. **The calendar.** Ask `calendar-assistant` for a review with `days: 1` and
   `from_now: true` (or the rest of this week's workdays for `--this-week`).
   You need the free blocks, the `ours` events and the flags.

3. **Choose the mode.**
   - Today already has `ours` blocks, or the request names a block or a task
     in one: **shift**. Move those blocks later the same day.
   - No `ours` blocks today: **propose** new blocks from the tasks.
   - Both can apply: shift the existing blocks first, then propose new blocks
     only for tasks that are not in any block.
   Ask `calendar-assistant` in that mode, with the Timebox input: `date`, `speed`, `tasks` (each
   with `estimate_min`, `priority`, `due`, and `kind` from its tags or title),
   `free_blocks`, `mode`, and the user's words.

4. **Offer at most two options** with AskUserQuestion. Lead with the change,
   one line each. Put the one you would pick first, marked recommended, with
   the reason in a few words.

5. **On a yes.** Ask `calendar-assistant` to `book` or `shift` exactly the
   chosen blocks (pass the blocks JSON from step 3). It re-reads today first,
   and writes only if the slots are still free. If something changed since the
   proposal (a new meeting landed in a slot), say what changed and give the
   updated options instead of writing.

## Rules

- Move only `ours` events: `[Focus]` title and `ea:focus` on the first line of
  the description. The user's meetings stay where they are, because other
  people are counting on them.
- Shift later in the same day only. Earlier time has passed or is already
  promised.
- Keep the planning rules from `calendar-manager`: real time is estimate times
  speed, 10 minutes after meetings, lunch kept, at most 75% of free time
  booked, deep work as early as is still possible, admin after 13:30.
- Blocks that no longer fit today: offer to drop them. Their tasks stay on the
  Today list, and tomorrow's brief plans them.
- Report writes from the read-back, never from what was asked.

## Output

Follow `response-style`. Short, plain, no tables.

A proposal:

> You lost the morning, so I'd push both blocks to the afternoon.
>
> 1. Deep work moves to 12:30 to 13:40, admin to 14:00 to 14:45. The CSV
>    review fits; the release notes slip to tomorrow.
> 2. Keep only the deep block at 12:30 and drop admin today.
>
> I'd take 1. The admin tasks are due today.

After the yes:

> Moved both blocks. Deep work is 12:30 to 13:40, admin 14:00 to 14:45.

With `--dry-run`, stop after the proposal and say that nothing was written.
