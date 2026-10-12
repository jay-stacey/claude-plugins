---
name: remove-goal
description: Removes (cancels) one software-factory goal after showing its impact and getting confirmation, stops its running agents, and optionally discards its branches and worktrees. Use when the user runs /software-factory:remove-goal or asks to remove, cancel or drop a factory goal.
argument-hint: "G-001 [--discard]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, TaskStop
---

# Remove goal

Arguments: `$ARGUMENTS`. Run every command exactly as written. This action is hard to undo, so every
confirmation is a full sentence and nothing runs before the user says yes.

1. Find the goal id (`G-` plus digits) in the arguments. If there is none, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" goal list` and ask with AskUserQuestion which goal
   to remove (up to 4 goals as options).
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" goal impact <G>`. Show its lines (at most 12):
   tasks, running agents, branches, open PRs, gates and tokens spent.
3. Ask with AskUserQuestion (header "Remove"):
   "Removing <G> (<title>) cancels its <n> open tasks and stops its <m> running agents. Its branches,
   worktrees and documents are kept unless you also choose to discard them. Do you want to remove this goal?"
   Options: "Remove the goal" / "Keep it".
   On "Keep it": say nothing changed and stop.
4. If `--discard` was given, ask a second time (header "Discard"):
   "Discarding also deletes the goal's task branches and worktrees. Commits that were never merged are
   lost and cannot be recovered. Do you want to discard them as well?"
   Options: "Remove and keep branches (Recommended)" / "Remove and discard branches".
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" goal remove <G> --confirm <G>`, adding
   `--discard` only if the user chose "Remove and discard branches".
6. The output lists any running runs of this goal, each with a run id and an agent id. Call `TaskStop`
   with each agent id (load the tool first if it is deferred). If TaskStop says the task already ended,
   go on.
7. Report in at most 5 lines: the goal is cancelled, how many agents stopped, and what was kept or
   discarded. If the CLI says a destructive gate opened, say: "Approve the discard with
   /software-factory:approve."

If the CLI exits with code 1 and mentions human intent, say: "Type the command yourself so the factory
knows a person asked for it: /software-factory:remove-goal <G>."
Never remove a goal the user did not name or pick.
