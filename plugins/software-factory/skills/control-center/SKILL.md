---
name: control-center
description: Starts, stops, opens or checks the local software-factory control center - a web page on 127.0.0.1 with the kanban board, live org chart, token use, approvals and goals. Use when the user runs /software-factory:control-center or asks to open the factory dashboard or board.
argument-hint: "[start | stop | status | open | restart]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# Control center

1. Take the action from `$ARGUMENTS`: one of `start`, `stop`, `status`, `open`, `restart`.
   Empty means `start`. Anything else: say the valid actions and stop.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" dashboard <action>`.
3. Exit code 4: say "The factory is not set up here. Run /software-factory:setup." and stop.
4. Relay the output as it is, at most 8 lines. Show the URL exactly as printed; it carries a private
   token, so do not shorten it, and do not paste it anywhere else.
5. After `start` or `open`, add: "The page runs only on this computer. It writes requests the factory
   applies on its next tick."
