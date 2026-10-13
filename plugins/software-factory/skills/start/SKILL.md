---
name: start
description: Starts or resumes the software factory and makes this session the dispatcher - checks the setup, takes the lease, and begins the self-paced tick loop. Use when the user runs /software-factory:start or asks to start, resume or restart the factory loop.
argument-hint: "[--takeover]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Skill
---

# Start

Turn this session into the factory dispatcher. `/start` is safe to run again; it resumes.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" doctor --quick`.
   - Exit code 4: say "The factory is not set up here. Run /software-factory:setup first." and stop.
   - Any other non-zero exit: show the failing lines and the fix they name, then stop.
   - Exit 0 with warnings (for example path length or a OneDrive folder): show them, then go on.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" start --session ${CLAUDE_SESSION_ID} $ARGUMENTS`.
   - Exit code 3: another session holds the lease. Show the CLI lines. Tell the user to close that
     session, or run `/software-factory:start --takeover` here if that session is gone. Stop.
   - Otherwise show its output (at most 6 lines). `start` also collects a fresh baseline (open pull
     requests, branches, blocked work, tracker work in flight) and asks the CTO to assess it.
3. Invoke the `loop` skill with the Skill tool, argument `/software-factory:tick`. Give no interval;
   the loop is self-paced and each tick schedules the next one.
4. Tell the user, in these words or close to them:
   - "This session is now the factory dispatcher. Keep it open and use it only for the factory."
   - "Open the control center with /software-factory:control-center to watch the board and approve gates."
   - "Use /software-factory:pause to pause, and /software-factory:status for a quick look."
   - "The CTO first checks the work already in flight, then writes a report every day. Read it with
     /software-factory:report; it may propose improvements you approve with /software-factory:approve."
   - "Add a bug, tech-debt item or chore with /software-factory:new-item."

5. Standing rule for the rest of this session: when a background factory agent's completion notice
   arrives (its last line starts with `HANDOFF`), do not read, judge or discuss its output. Invoke
   `/software-factory:tick` once instead. That tick is not a loop iteration, so it does not call
   `ScheduleWakeup`.

Do not start the loop twice. If this session already runs the factory loop, skip step 3 and say so.
