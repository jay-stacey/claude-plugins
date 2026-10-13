---
name: dashboard
description: Open Day Desk, the user's local dashboard for their Now task, focus timer, tasks, schedule, week, notes and a chat with their assistant, and start or stop the small local server behind it. Use when the user asks to open, show, start, restart or stop the dashboard, Day Desk, their task board or their day view.
when_to_use: Trigger phrases include "open the dashboard", "open Day Desk", "show my board", "show my day", "start the dashboard", "stop the dashboard", "restart Day Desk", "is the dashboard running".
argument-hint: "[start | stop | status | restart] [--dev] [--no-toast]"
allowed-tools: Bash, Read
---

# Dashboard (Day Desk)

Day Desk is a page on this machine, served by `dashboard/server.py` on
`127.0.0.1` only. It shows the same tasks, brief and notes the skills use,
because it reads the same files through the same tools. Its chat talks to the
`assistant` agent by running the user's own `claude` command line. While it
runs it also sends gentle Windows reminders: meeting heads-ups, the end of a
focus timer, "anything you promised?" after meetings, and the shutdown nudge.

```bash
D="python ${CLAUDE_PLUGIN_ROOT}/dashboard/server.py"
```

The notes folder comes from `CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH`. If the
script says no notes folder is set, tell the user to run
`/plugin configure executive-assistant@personal-plugins`, and stop.

## Commands

Read `$ARGUMENTS`. The default is `start`.

| Command | Run | Then |
|---|---|---|
| `start` | `$D start` (add `--dev` or `--no-toast` when given) | It starts the server in the background, opens the browser, and prints `url`. If it was already running it says `already_running` and opens it again. |
| `status` | `$D status` | Say whether it runs and since when. |
| `stop` | `$D stop` | Say it stopped. Reminders stop with it. |
| `restart` | `$D stop`, then `$D start` | Use after updating the plugin. |

Before the first start, run `python ${CLAUDE_PLUGIN_ROOT}/scripts/tasks.py init`
so the task and rules files exist.

`--dev` makes the chat load this plugin folder with `--plugin-dir`. Use it
only when the user is testing a plugin branch that is not installed.

## Tell the user

One or two lines, then the link on its own line:

> Day Desk is running. It opened in your browser.
>
> http://127.0.0.1:52811/#...

The link holds a key that keeps other web pages on this machine from reading
the dashboard, so tell the user to bookmark the link itself, not just the
address. The key changes each time the server starts.

If start fails, give the error line and point to
`{vault}/.assistant/dashboard.log`.

## Start at login (only on request)

Starting Day Desk when Windows starts is a lasting change, so set it up only
after a clear yes, and say exactly what it adds. On yes, create a Task
Scheduler task for the current user that runs `$D start --no-open` at log-on,
with the vault path in the command. Show the command before running it. To
undo, the user deletes the task named "Day Desk" in Task Scheduler.

## Safety

- The server listens on 127.0.0.1 only and refuses requests without its key,
  from another host name, or from another site.
- The dashboard chat may read email, calendar, Linear and notes, manage the
  user's tasks and create calendar focus blocks. It cannot send, trash or
  delete anything; it drafts instead. That limit is set by the tool allow-list
  in `dashboard/chat.py`.
- Never print the key into a file other than `{vault}/.assistant/dashboard.json`.
