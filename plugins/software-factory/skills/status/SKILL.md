---
name: status
description: Shows a short software-factory status - factory state, goals, running agents, gates waiting for the user, and budget use. Use when the user runs /software-factory:status or asks how the factory, a goal or the agents are doing, or what is waiting on them.
argument-hint: "[G-001]"
allowed-tools: Bash(node:*)
---

# Status

1. If `$ARGUMENTS` holds a goal id (`G-` plus digits), run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status --goal <G>`.
   Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status`.
2. Exit code 4: say "The factory is not set up here. Run /software-factory:setup." and stop.
3. Relay the output as it is, at most 20 lines. Do not add analysis, tables or other commands.
4. Add one closing line only when it applies:
   - Gates are pending: "Decide them with /software-factory:approve."
   - The factory is stopped or paused: "Run /software-factory:start to resume."
