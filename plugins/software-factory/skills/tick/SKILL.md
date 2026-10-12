---
name: tick
description: Runs one software-factory dispatcher tick - collect finished runs, plan work, launch the role agents the CLI asks for, and schedule the next wakeup. Used by the /loop that /software-factory:start begins, and by hand for a single tick. Triggers on "run a factory tick", "tick the factory", "/software-factory:tick".
allowed-tools: Bash(node:*), Agent, ScheduleWakeup, mcp__plugin_software-factory_factory-sync__sync_tick
---

# Tick

You are the dispatcher. Run the steps below exactly. Never read briefs, tasks or code. Never reason about
task content. Never change a DISPATCH field. Keep your own text to one short line per step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" tick begin --session ${CLAUDE_SESSION_ID}`.
   - Exit code 3: another session holds the lease. Say so in one line and stop. Do not schedule.
   - Exit code 4: the factory is not set up. Say "Run /software-factory:setup" and stop.
   - Output has a line `SKIP <n>`: go straight to step 6 with `n` seconds. Skip steps 2 to 5.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" tick plan --session ${CLAUDE_SESSION_ID}`.
3. For each line that starts with `DISPATCH `, parse the JSON after it and call the `Agent` tool once with
   `subagent_type`, `model`, `description` and `prompt` copied verbatim, and `run_in_background: true`.
   Send all Agent calls in one message. If an Agent call is denied, do not retry it; the CLI recovers it.
4. If the plan output has the line `SYNC due` and the tool
   `mcp__plugin_software-factory_factory-sync__sync_tick` exists, call it once with
   `{"projectDir": "<absolute path of the current project>", "mode": "delta"}`. If the tool does not exist, skip this step silently.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" tick end --session ${CLAUDE_SESSION_ID} --loop`
   (drop `--loop` when this tick was run by hand). Relay its summary lines as they are.
6. Schedule:
   - This tick is a `/loop` iteration and the last line is `SCHEDULE <s>` (or step 1 gave `SKIP <n>`):
     call `ScheduleWakeup` once with that many seconds.
   - The last line is `NONE`: do not schedule. The loop ends. Say "Factory idle. Loop stopped."
   - This tick was started by a background-agent completion notice, not by the loop timer: do not call
     `ScheduleWakeup`. The pending wakeup still stands.
   - The tick was run by hand: do not schedule.

If a command fails with another exit code, show its last 3 lines, then still do step 6 with 900 seconds.

Standing rule after any tick: when a background factory agent's completion notice arrives in this
session (its last line starts with `HANDOFF`), do not read, judge or discuss it. Run this skill again
once. That run counts as started by a completion notice, so it does not call `ScheduleWakeup`.
