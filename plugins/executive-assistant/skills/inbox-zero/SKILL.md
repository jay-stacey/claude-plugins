---
name: inbox-zero
description: Clear the Gmail inbox to zero - sweep unread mail, apply the user's email rules, categorize by priority, label, archive, and trash what the rules allow. Use when the user asks for inbox zero, email cleanup, or a focused inbox pass.
argument-hint: "[--dry-run] [--quick] [--all] [--labels-only]"
context: fork
agent: email-assistant
allowed-tools: mcp__google-workspace__*, mcp__plugin_executive-assistant_google-workspace__*, Read, Write, Edit
model: sonnet
---

# /inbox-zero

Focused Gmail cleanup. Run the `gmail-processor` skill, then `gmail-organizer`.
Those two carry the full procedure, so this file only sets the flags and the
rules that sit above them.

## Flags

Arguments arrive as `$ARGUMENTS`. Parse these, and if anything else appears,
ignore it and say so in one line.

| Flag | Effect |
|---|---|
| `--dry-run` | Report the plan, change nothing |
| `--quick` | Skip newsletters and old-mail cleanup |
| `--all` | Include read mail sitting in the inbox, not just unread |
| `--labels-only` | Apply labels but do not archive or trash |
| `--skip-newsletters` | Leave newsletters untouched |
| `--auto-approve` | Skip the batch confirmation prompt |

## Rules

The user's email rules live in `{vault}/assistant/email-rules.md`, where
`{vault}` is `CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH`. `gmail-processor` reads
that file and does the matching. Do not re-implement rule matching here; pass
the results through.

- **Rules marked `auto`** act without asking. Report what they did as a count.
- **Everything else** (rules marked `confirm`, and mail no rule covers) goes
  into one batch plan, and the user gives one yes for the whole batch.
  `--auto-approve` skips that prompt.
- **`--dry-run` overrides everything**, including `auto` rules and
  `--auto-approve`. It reports what would happen and changes nothing.
- **Trash is allowed** where a rule or the approved plan says so, because
  Gmail keeps trashed mail for 30 days and the user can get it back.
  Permanent deletion is never allowed, because it cannot be undone. Do not
  empty Trash or call any permanent-delete tool.

If the rules file does not exist, `gmail-processor` falls back to its built-in
buckets and every destructive action goes through the batch plan.

## Output

Follow the `response-style` skill. Lead with what still needs the user, then a
short list of what was handled: labeled, archived, trashed (by rule and by
approval). End with the inbox count read back from Gmail after the run, not
worked out from what was moved.
