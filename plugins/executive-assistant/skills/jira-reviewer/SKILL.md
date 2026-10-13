---
name: jira-reviewer
description: Review Jira tickets assigned to the user and tickets where they were @mentioned, check new comments and updates, and prioritize by urgency and deadline. Use when checking Jira or during the daily workflow.
user-invocable: false
allowed-tools: mcp__atlassian__*, Read, Write, Edit
---

# Jira Reviewer

Help the user see which Jira tickets need them today, which are stalled or
blocked, and where someone is waiting on their answer.

## Read-only

Do not change status, add comments, change assignees or watchers, or edit any
field. The user's teammates see every Jira change under the user's name, and a
wrong transition can trigger workflows and notifications. If the user asks for
an update, show exactly what you would change and wait for a clear yes. Link
every ticket so the user can act in one click.

## Process

### 1. Authenticate

- Call `atlassianUserInfo` and keep the `accountId`. The mention query needs it.
- Call `getAccessibleAtlassianResources` for the `cloudId` (expected instance
  `dealerpulldms.atlassian.net`). Use that `cloudId` for every later call.
- If auth fails, ask the user to re-authenticate with `claude mcp test atlassian`.

### 2. Assigned tickets

`searchJiraIssuesUsingJql`:

```
assignee = currentUser()
AND status != Done
AND status != Closed
ORDER BY priority DESC, updated DESC
```

Fields: `summary`, `description`, `status`, `priority`, `created`, `updated`,
`comment`, `duedate`.

### 3. Mentioned tickets (when `mentions.enabled`)

`searchJiraIssuesUsingJql`, with `maxResults` from `mentions.maxResults`
(default 25):

```
comment ~ "[~accountid:{accountId}]"
AND assignee != currentUser()
AND status NOT IN (Done, Closed)
AND project IN ({configured_projects})
ORDER BY updated DESC
```

Replace `{accountId}` with the value from step 1 and `{configured_projects}`
with the configured projects (for example `DMS, CS, DT`). Fields: `summary`,
`description`, `status`, `priority`, `assignee`, `created`, `updated`,
`comment`.

If nothing comes back, leave the section out. If the query fails, note it in
one line and carry on with assigned tickets; see `references/error-handling.md`
for the simpler fallback query.

### 4. New activity

For each assigned ticket, call `getJiraIssue` and look for comments in the last
24 hours, status or assignee changes (including newly assigned to the user),
new attachments, and changes to the description or acceptance criteria.

For each mentioned ticket, call `getJiraIssue`, find the comments that contain
`[~accountid:{accountId}]`, and keep the text, author, and time.

**Action required** if any of these hold:
- The comment asks a question ("?").
- It uses words like "please", "can you", "need you to", "review", "check",
  "look at".
- It is from the last 24 hours.
- The ticket is In Progress or Blocked, so it may be waiting on the user.

**FYI only** otherwise, for example "FYI", "heads up", "update:", an older
mention, or a ticket in To Do or Backlog.

Recency: last 24 hours is recent (call it out), last 7 days is this week, and
older mentions rank lower, cut off at `maxAgeDays`.

### 5. Prioritize

Each list below is a set of signals; one strong signal is enough to place a
ticket.

**Critical/Urgent**
- Jira priority Critical or High.
- Status In Progress or Blocked.
- New comments in the last 24 hours, especially from a PM or stakeholder.
- Due within 2 days, or overdue.
- Flagged as urgent in Slack or email, production issues, customer-facing bugs.

**High Priority**
- Priority High or Medium, still To Do.
- Assigned in the last 3 days, or 2+ recent comments.
- Sprint commitments, or blocking a teammate.

**In Progress, needs a status update**
- In Progress with no update in 2-3 days, or waiting on review or testing.

**Blocked**
- Status Blocked or Impediment, waiting on an outside dependency. Note what
  it waits for and how long.

**Mentioned (not the user's ticket)**
- Split into Action required and FYI only. Show the assignee, so the user
  knows who to coordinate with.

### 6. Action items

For each ticket, name the next step: answer a question in comments, update a
stalled status, chase a blocker, or request review on a linked PR.

```
- [ ] **[DMS-XXXX](https://dealerpulldms.atlassian.net/browse/DMS-XXXX)** [Summary] - Status: [Status]
  - [What needs attention]
  - [Deadline, if any]
  - Action: [Specific action]
```

## Report

Follow the `response-style` skill. Lead with what needs the user, at most five,
one sentence each with its link. Then the rest as short bullets. Leave out
empty sections.

```markdown
Three Jira tickets need you today.

[DMS-2372](https://dealerpulldms.atlassian.net/browse/DMS-2372) Lead notifications -
the PM left two questions on edge cases, and it is due tomorrow.

[DMS-2401](https://dealerpulldms.atlassian.net/browse/DMS-2401) Login timeout -
Critical, assigned today, and QA is blocked until it starts.

Colin asked you on [DMS-2456](https://dealerpulldms.atlassian.net/browse/DMS-2456)
(Alex's ticket) to check the token refresh section of the API docs.

Needs a nudge:
- [ ] [DMS-2301](link) migration script - no update in 3 days; log progress
- [ ] [DMS-2299](link) blocked 5 days on a vendor API key; follow up

Quiet:
- 2 high-priority tickets in To Do, on plan
- 1 FYI mention on DMS-2401 from Mike
```

If the user is reading this directly (not through a parent agent), close with
one offer, such as "I can add these to today's note."

## Errors

See `references/error-handling.md` when a call fails, no tickets come back, or
you are rate limited.

## Advanced options

See `references/advanced-features.md` when the config sets custom JQL, project
or sprint filters, priority thresholds, or cross-referencing.

## Implementation notes

- Fields vary by project; check what is available before relying on one.
- Summarize long comment histories rather than quoting them.
- Ticket URL: `https://[instance].atlassian.net/browse/[KEY]`.
- Pagination: 50 per query by default, 100 at most.
