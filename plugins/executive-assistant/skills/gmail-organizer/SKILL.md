---
name: gmail-organizer
description: Apply Gmail labels and archive in batches to reach inbox zero. Takes the categorized message IDs from gmail-processor and turns them into label and archive operations. Use after gmail-processor produces a categorization, or when applying labels and organizing the inbox.
user-invocable: false
allowed-tools: Read, Edit, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__search_threads, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__get_message, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__get_thread, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__list_labels, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__create_label, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__label_thread, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__unlabel_thread, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__label_message, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__unlabel_message, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__update_message_labels, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__trash_thread, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__trash_message, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__untrash_thread, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__untrash_message, mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__create_draft, mcp__claude_ai_Gmail__search_threads, mcp__claude_ai_Gmail__get_message, mcp__claude_ai_Gmail__get_thread, mcp__claude_ai_Gmail__list_labels, mcp__claude_ai_Gmail__create_label, mcp__claude_ai_Gmail__label_thread, mcp__claude_ai_Gmail__unlabel_thread, mcp__claude_ai_Gmail__label_message, mcp__claude_ai_Gmail__unlabel_message, mcp__claude_ai_Gmail__update_message_labels, mcp__claude_ai_Gmail__trash_thread, mcp__claude_ai_Gmail__trash_message, mcp__claude_ai_Gmail__untrash_thread, mcp__claude_ai_Gmail__untrash_message, mcp__claude_ai_Gmail__create_draft
---

# Gmail Organizer

Apply labels and archive mail in batches, based on the categorization
`gmail-processor` produced. The job is mechanical; the judgment already
happened upstream, so do not re-classify messages here.

Two principles:

1. **Group, then work thread by thread.** The native Gmail connector has no
   batch call, so group the input by target label set first, check each
   group once, then make one `label_thread` call per thread (all of the
   group's labels in one call) and one `unlabel_thread` call to archive.
   Print a status line every 25 threads.
2. **Urgent stays in the inbox.** Everything else is archived after labeling,
   so the inbox holds only what needs a response today.

## MCP tools

Native Gmail connector; full names in `${CLAUDE_PLUGIN_ROOT}/docs/google-tools.md`.

| Operation | Tool |
|---|---|
| List labels | `list_labels` |
| Create label | `create_label` (`displayName: "Action/Urgent"`) |
| Add labels to a thread | `label_thread` (`threadId`, `labelIds`) |
| Archive a thread | `unlabel_thread` with `INBOX` |
| Search inbox | `search_threads` |

## Labels

Nested with `/`, created on first use:

```
Action/Urgent            Monitoring/Azure         Work/Jira
Action/This Week         Monitoring/Critical      Work/High Priority
FYI/Read Later           Monitoring/Warning       Work/Medium Priority
FYI/Newsletters          Development/GitHub       Work/Low Priority
FYI/Reports              Development/Code Review
```

| Category | Add labels | Star | Remove `INBOX` |
|---|---|---|---|
| Urgent | `STARRED`, `Action/Urgent`, plus project labels | Yes | No |
| Important | `Action/This Week` | No | Yes |
| FYI | `FYI/Read Later` | No | Yes |
| Newsletter | `FYI/Newsletters` | No | Yes |
| Azure | `Monitoring/Azure`, plus `Monitoring/Critical` if severe | No | Yes |
| GitHub | `Development/GitHub`, plus `Development/Code Review` if a PR review | No | Yes |
| Jira Critical/Highest | `Work/Jira`, `Work/High Priority`, `Action/Urgent`, `STARRED` | Yes | No |
| Jira High | `Work/Jira`, `Work/High Priority` | No | Yes |
| Jira Medium | `Work/Jira`, `Work/Medium Priority` | No | Yes |
| Jira Low | `Work/Jira`, `Work/Low Priority` | No | Yes |
| Jira with @mention | `Work/Jira`, `Action/This Week` | No | Yes |

## Phase 1: Make sure labels exist

Call `list_labels` once. For each label the input needs (the hierarchy above
plus any project labels) that is missing, call `create_label`. Keep the name
to id map; the label calls take ids. Note which labels you created for the
report.

## Phase 2: Apply labels thread by thread

Group the input by its exact target label set from the table. Then, for each
thread in a group:

```
label_thread(threadId: id, labelIds: ["<id of Action/This Week>"])
unlabel_thread(threadId: id, labelIds: ["INBOX"])
```

For urgent mail, and Jira Critical/Highest, skip `unlabel_thread` so the
thread stays in the inbox. Split Azure into normal and critical groups, and
GitHub into normal and PR-review groups, first.

## Phase 3: Verify

Search the inbox again with `search_threads(query: "in:inbox", pageSize: 50)`,
paging to the end, and count what is really there. It should hold only urgent
(starred) mail plus anything `gmail-processor` left as ambiguous. Report that
read-back count, not one worked out from the calls you made, because a call
can fail without an error you notice.

## Output

Return the JSON in the contract below to the parent. If you also write a line
for the user, follow `response-style`: lead with what is still in the inbox
and why, then one short bullet list of what was labeled and archived. Mention
newly created labels only if there are any.

## Configuration

```json
{
  "gmailOrganizer": {
    "enabled": true,
    "autoCreateLabels": true,
    "urgentKeepInInbox": true,
    "starUrgentEmails": true,
    "archiveAfterLabeling": true
  }
}
```

## Safety and errors

- Keep urgent mail in the inbox. Archiving it hides the one thing the user
  must see today.
- Check each group's IDs and labels before the first call. A wrong label
  across hundreds of threads is slow to undo.
- On per-message failures, log the failed IDs, carry on with the rest, and
  report them at the end. Do not roll back the successful ones.
- If label creation fails, it is usually a name conflict or a race. Check
  whether the label now exists, check the nested format, and continue.
- If archiving fails because a message was already archived or moved, skip it.
- If the Gmail connector is missing or fails, say so and suggest connecting
  Gmail under Settings, Connectors in Claude.

Undo, if the user asks: remove a label by searching `label:{name}`; unarchive
from All Mail with "Move to Inbox"; delete a label in Gmail Settings, Labels
(messages keep their other labels).

## Contract

Input from `gmail-processor`:

```json
{
  "urgent": [{"messageId": "...", "from": "...", "subject": "..."}],
  "important": [...],
  "fyi": [...],
  "newsletters": [...],
  "azureAlerts": [...],
  "githubNotifications": [...],
  "jiraNotifications": [...]
}
```

Returns:

```json
{
  "processed": 42,
  "urgent": 3,
  "archived": 39,
  "labelsApplied": 42,
  "starred": 3,
  "inboxZero": true,
  "newLabelsCreated": ["Monitoring/Azure"]
}
```

`inboxZero` is true only when the Phase 3 read-back shows nothing beyond urgent
and ambiguous mail.

## Developer checks

- Each thread gets one `label_thread` call with all its labels, and at most
  one `unlabel_thread` call.
- Urgent mail is starred and stays in the inbox; all other categories are
  archived.
- The reported inbox count comes from the Phase 3 search.
- A per-message failure does not stop the rest of the batch.
