---
name: inbox-zero
description: Clear the Gmail inbox to zero - sweep unread mail, categorize by priority, apply labels, and archive. Use when the user asks for inbox zero, email cleanup, or a focused inbox pass.
argument-hint: "[--dry-run] [--quick] [--all] [--labels-only]"
context: fork
agent: email-assistant
allowed-tools: mcp__google-workspace__*, Read, Write, Edit
model: sonnet
---

# /inbox-zero

Focused Gmail cleanup. Runs the `gmail-processor` then `gmail-organizer` skills — those carry the full procedure, so don't restate it here.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Report the plan, change nothing |
| `--quick` | Skip newsletters and old-mail cleanup |
| `--all` | Include read mail sitting in the inbox, not just unread |
| `--labels-only` | Apply labels but do not archive |
| `--skip-newsletters` | Leave newsletters untouched |
| `--auto-approve` | Skip the batch confirmation prompt |

Arguments arrive as `$ARGUMENTS`. Parse the flags above; ignore anything unrecognized and say so.

## Rules

- Always show the batch plan and get approval before labeling or archiving, unless `--auto-approve` is set.
- `--dry-run` overrides `--auto-approve`.
- Never delete mail. Archive only.

## Output

Report counts per category, what was labeled, what was archived, and the final inbox count.
