---
name: new-goal
description: Adds a goal to the software factory through a short interview - outcome, success criteria, constraints, priority and token budget - then creates it so the CTO can size it and the Product Manager can write the PRD. Use when the user runs /software-factory:new-goal or asks to add, create or queue a goal, feature or project for the factory.
argument-hint: "[what you want built, in one sentence]"
allowed-tools: Bash(node:*), AskUserQuestion, Read
---

# New goal

Run in this session. Do not fork and do not spawn agents. Ask at most 5 questions in at most 2
AskUserQuestion calls. The user's request: `$ARGUMENTS`.

## 1. Get the request

If `$ARGUMENTS` is empty, ask in one line: "What should the factory build or change?" and wait.
Never put secrets or customer personal data in a goal. If the request holds any, leave them out and say so.

## 2. Draft, then confirm

From the request, draft: a title (<= 80 chars, sentence case, no trailing period), an outcome
(<= 600 chars, what is true for users when done), 3-5 success criteria (each testable, one line), 0-3
constraints, and a priority (P0 urgent .. P3 someday; default P2).

Read budget tiers: `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" config get budget.tier_defaults`
(fall back to S 5M, M 15M, L 40M tokens).

AskUserQuestion call 1 (4 questions):
1. [Outcome] Show the drafted outcome. Options: "Use this (Recommended)", "Shorter: <one-line version>".
   "Other" lets the user type their own.
2. [Criteria] multiSelect, the drafted criteria as options (max 4; all recommended). "Other" adds one.
3. [Priority] "P2 Normal (Recommended)", "P1 High", "P0 Urgent", "P3 Low". Move "(Recommended)" if the
   request clearly says urgent.
4. [Budget] "Let the CTO size it (Recommended)", "S - 5M tokens (small fix)", "M - 15M tokens (feature)",
   "L - 40M tokens (large feature)". Use the numbers from config.

AskUserQuestion call 2 (only if you drafted constraints or the request hints at limits):
5. [Limits] multiSelect, the drafted constraints plus "No extra constraints". "Other" adds one.

## 3. Create

Run, with each value in single quotes (write a single quote inside a value as `'\''`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" goal new --title '<title>' --outcome '<outcome>' --criteria '<c1>' --criteria '<c2>' --priority P2 [--budget <tokens>] [--constraint '<k1>']
```

Leave out `--budget` when the user let the CTO size it. Pass the budget in tokens (for example 15000000).
On exit code 1, show the validation lines, fix the values, and run it once more.

## 4. Report

Show the new goal id and title. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status`.
- If the status does not show the factory as running, say: "Run /software-factory:start".
- Otherwise say: "The CTO sizes it on the next tick. You approve the PRD at gate G1 with
  /software-factory:approve."
