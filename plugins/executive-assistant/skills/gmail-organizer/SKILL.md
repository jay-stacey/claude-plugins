---
name: gmail-organizer
description: Apply Gmail labels and archive in batches to reach inbox zero. Takes the categorized message IDs from gmail-processor and turns them into label and archive operations. Use after gmail-processor produces a categorization, or when applying labels and organizing the inbox.
user-invocable: false
allowed-tools: mcp__google-workspace__*, mcp__plugin_executive-assistant_google-workspace__*, Read, Edit
---

# Gmail Organizer

Apply labels and archive mail in batches, based on the categorization
`gmail-processor` produced. The job is mechanical; the judgment already
happened upstream, so do not re-classify messages here.

Two principles:

1. **Batch everything.** Use one `batch_modify_gmail_message_labels` call per
   label group rather than a loop of `modify_gmail_message_labels`. It is
   faster, cheaper, and less likely to hit rate limits.
2. **Urgent stays in the inbox.** Everything else is archived after labeling,
   so the inbox holds only what needs a response today.

## MCP tools

| Operation | Tool |
|---|---|
| List labels | `list_gmail_labels` |
| Create label | `manage_gmail_label` (`action: "create"`, `label_name: "..."`) |
| Modify labels (one) | `modify_gmail_message_labels` |
| Modify labels (many) | `batch_modify_gmail_message_labels` |
| Search inbox | `search_gmail_messages` |

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

Call `list_gmail_labels` once. For each label the input needs (the hierarchy
above plus any project labels) that is missing, call `manage_gmail_label` with
`action: "create"`. Note which ones you created for the report.

## Phase 2: Apply labels in batches

Group the input by its exact target label set from the table, then make one
call per group:

```
batch_modify_gmail_message_labels(
  message_ids: important_ids,
  add_labels: ["Action/This Week"],
  remove_labels: ["INBOX"]
)
```

For urgent mail, and Jira Critical/Highest, omit `remove_labels` so the
message stays in the inbox. Split Azure into normal and critical groups, and
GitHub into normal and PR-review groups, before batching. If `batchSize` is
set, split larger groups into chunks of that size.

## Phase 3: Verify

Search the inbox again with `search_gmail_messages(query: "in:inbox",
max_results: 100)` and count what is really there. It should hold only urgent
(starred) mail plus anything `gmail-processor` left as ambiguous. Report that
read-back count, not one worked out from the calls you made, because a batch
can partly fail without an error you notice.

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
    "archiveAfterLabeling": true,
    "batchSize": 100
  }
}
```

## Safety and errors

- Keep urgent mail in the inbox. Archiving it hides the one thing the user
  must see today.
- Check each group's IDs and labels before the batch call. A wrong label across
  hundreds of messages is slow to undo.
- On per-message failures, log the failed IDs, carry on with the rest, and
  report them at the end. Do not roll back the successful ones.
- If label creation fails, it is usually a name conflict or a race. Check
  whether the label now exists, check the nested format, and continue.
- If archiving fails because a message was already archived or moved, skip it.
- If the MCP connection fails, say so and suggest `/mcp` to check the server.

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

- Every multi-message change uses `batch_modify_gmail_message_labels`.
- Urgent mail is starred and stays in the inbox; all other categories are
  archived.
- The reported inbox count comes from the Phase 3 search.
- A per-message failure does not stop the rest of the batch.
