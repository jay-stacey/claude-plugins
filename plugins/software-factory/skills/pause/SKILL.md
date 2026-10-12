---
name: pause
description: Pauses the software factory - drain by default (no new work, running agents finish), --now to stop running agents and checkpoint their work, --stop to shut the factory down, or G-xxx to pause one goal. Use when the user runs /software-factory:pause or asks to pause, halt or stop the factory.
argument-hint: "[--now | --stop | G-001]"
disable-model-invocation: true
allowed-tools: Bash(node:*), TaskStop, AskUserQuestion
---

# Pause

Arguments: `$ARGUMENTS`. Run every command below exactly as written.

Pick the mode from the arguments:

## No argument: drain

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" pause --session ${CLAUDE_SESSION_ID}`.
2. Say: "No new work will start. Running agents finish their current task. Resume with
   /software-factory:start." Relay the CLI lines (at most 6).

## `G-xxx`: pause one goal

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" pause --goal <G-xxx> --session ${CLAUDE_SESSION_ID}`.
2. Say which goal is paused and that its running agents finish their current task. To resume it, the
   user runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" goal resume <G-xxx>` or uses the Goals
   view of `/software-factory:control-center`.

## `--now`: stop running agents

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" pause --now --session ${CLAUDE_SESSION_ID}`.
2. The output lists the runs to stop, one per line, each with a run id (`R-...`) and an agent id.
   For each run: call `TaskStop` with the agent id (load the tool first if it is deferred), then run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" run checkpoint <run id>`. If TaskStop says the task already ended, still checkpoint it.
3. Say how many agents stopped and that their work is saved (commit or patch) and resumes on
   `/software-factory:start`.

## `--stop`: shut the factory down

1. Ask with AskUserQuestion (header "Stop"):
   "Stopping the factory ends every running agent, saves their work as a checkpoint, and releases this
   session as the dispatcher. Only /software-factory:start restarts it. Do you want to stop the factory?"
   Options: "Stop the factory" / "Pause and drain instead" / "Cancel".
2. "Cancel": say nothing changed and stop. "Pause and drain instead": do the drain steps above.
3. "Stop the factory": run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" pause --now --stop --session ${CLAUDE_SESSION_ID}`, then do step 2
   of `--now` for every listed run.
4. Do not call `ScheduleWakeup`. The loop ends at its next wakeup, when the tick finds the factory
   stopped. Say: "The factory is stopped. Run /software-factory:start to restart."

If the CLI exits with code 1 and mentions human intent, say: "Type the command yourself so the factory
knows a person asked for it: /software-factory:pause <same arguments>."
