---
name: inbox-zero
description: Clear the Gmail inbox to zero - sweep unread mail, apply the user's email rules, categorize by priority, label, archive, and trash what the rules allow. Use when the user asks for inbox zero, email cleanup, or a focused inbox pass.
argument-hint: "[--dry-run] [--quick] [--all] [--labels-only]"
allowed-tools: Agent, AskUserQuestion, Bash, Read, mcp__google-workspace__*, mcp__plugin_executive-assistant_google-workspace__*
---

# /inbox-zero

Focused Gmail cleanup. This skill runs in the main conversation so it can ask
the user for one yes and wait for it. The `email-assistant` agent does the
work with its `gmail-processor` and `gmail-organizer` skills, which carry the
full procedure. This file sets the flags, the order, and the rules above them.

## Steps

1. Print "Checking email...". Ask `email-assistant` to run gmail-processor
   with the flags below. It acts on `auto` rules and returns its EmailReport
   (shape in `${CLAUDE_PLUGIN_ROOT}/docs/brief-contract.md`).
2. If `pending_confirm` has groups, ask once with AskUserQuestion: one
   question per group (at most four), each with the count and two sample
   subjects. Recommend the rule's action first.
3. On a yes, run `batch_modify_gmail_message_labels` on that group's
   `message_ids` (look up label ids with `list_gmail_labels` first). Then
   count `in:inbox` again.
4. If the report has `rule_suggestions`, offer them in the same question set,
   and add an accepted one with
   `python ${CLAUDE_PLUGIN_ROOT}/scripts/email_rules.py add --line "..."`.

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
