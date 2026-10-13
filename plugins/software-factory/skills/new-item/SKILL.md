---
name: new-item
description: Adds a bug, tech-debt item or chore to a team's work stream in the software factory - asks for the team, class, title and description when they are missing, creates the item through the CLI, and says what happens next. Use when the user runs /software-factory:new-item or asks to report a bug, log tech debt or add a chore for the factory.
argument-hint: "[bug|tech_debt|chore] [what is wrong, in one sentence]"
allowed-tools: Bash(node:*), AskUserQuestion
---

# New item

Run in this session. Do not fork and do not spawn agents. Ask at most 4 questions in one
AskUserQuestion call, plus one plain line when the request is empty. The request: `$ARGUMENTS`.
CLI: `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" <cmd>`.

## 1. Check streams and teams

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get streams`, then
`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get teams`.
- Exit code 4: say "The factory is not set up here. Run /software-factory:setup." and stop.
- `streams.enabled` is not true: say "Bug and tech-debt streams are off, so no agent would pick this
  up. Turn them on with /software-factory:setup --section teams." and stop.
- `teams` is null or `{}`: the team is `core`. Do not ask for it.
- `teams` has one team with repos: use it. Do not ask.

## 2. Get the item

If `$ARGUMENTS` is empty, ask in one line: "What is the bug, debt or chore?" and wait.
Never put secrets or customer personal data in an item. If the request holds any, leave them out
and say so.

Draft from the request: a title (<= 80 chars, sentence case, no trailing period), a description
(<= 1200 chars: what happens, what should happen, where, how to see it), and a class (`bug` when
something is broken, `tech_debt` when it works but costs time, `chore` for upkeep such as an upgrade).

AskUserQuestion, one call, only the questions you need:
1. [Team] Only with 2 or more teams that own repos. The teams whose repos match the request first
   (Recommended), up to 4 options; "Other" takes any team id.
2. [Class] "Bug", "Tech debt", "Chore", with your draft first and "(Recommended)".
3. [Priority] "P2 Normal (Recommended)", "P1 High", "P0 Urgent (starts now, skips the stream limit
   and the cycle)", "P3 Low". Move "(Recommended)" if the request clearly says urgent.
4. [Repo] Only when the chosen team owns 2 or more repos and the request does not say which. Up to 4
   of the team's repos; "Other" takes a name.
Show the drafted title and description in the question text so the user can fix them in "Other".

## 3. Create

Run, with each value in single quotes (write a single quote inside a value as `'\''`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" item new --team <team> --class <bug|tech_debt|chore> --title '<title>' --description '<description>' --priority <P0-P3> [--repo <name>]
```

On exit code 1, show the validation lines, fix the values, and run it once more.

## 4. Report

Show the new item id, team, class and priority. Then say what happens next, in these words or
close to them:
- "The Staff Engineer triages it: finds the cause, writes a note at
  `.factory/docs/streams/<team>/items/<id>.md`, then plans a fix of 1 to 3 tasks or asks you a question."
- "The fix ships as its own pull request. You approve it at gate G4 with /software-factory:approve."
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get cycles`. When `cycles.enabled` is true and the
  priority is not P0, add: "Cycles are on, so it starts once the CTO commits it to a cycle. P0 starts at once."
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status`. If it does not show the factory as running, add: "Run /software-factory:start".
