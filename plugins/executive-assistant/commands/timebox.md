---
name: timebox
description: Optimize the calendar - timebox today's todos into free slots, schedule recurring strategic blocks, and flag scheduling bottlenecks. Use when the user asks to timebox, plan their day, or fix an overloaded calendar.
argument-hint: "[--dry-run] [--today-only] [--strategic-only] [--analyze-only] [--this-week]"
context: fork
agent: calendar-assistant
allowed-tools: mcp__google-workspace__*, Read, Write, Edit
model: opus
---

# /timebox

Calendar optimization. Runs the `calendar-reviewer` then `calendar-manager` skills — those carry the analysis and scheduling procedure.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Show the plan, create nothing |
| `--analyze-only` | Bottleneck report only, no scheduling |
| `--today-only` | Timebox today's todos, skip strategic blocks |
| `--strategic-only` | Schedule recurring strategic blocks only |
| `--this-week` / `--this-month` | Widen the planning window |
| `--auto-approve-focus` | Create focus blocks without confirming |

Arguments arrive as `$ARGUMENTS`. Parse the flags above; ignore anything unrecognized and say so.

## Rules

- Never create a calendar event without explicit approval, unless an `--auto-approve-*` flag is set.
- `--dry-run` overrides every auto-approve flag.
- Never move or delete an existing event. Only add.
- Respect protected time and working hours from config.

## Output

Schedule analysis, bottlenecks found, the proposed blocks, and what was actually created.
