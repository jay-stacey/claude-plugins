---
name: linear-reviewer
description: Review Linear issues assigned to the user and issues where they were @mentioned, check new comments and updates, and prioritize by urgency. Use when checking Linear or during the daily workflow.
user-invocable: false
allowed-tools: mcp__linear-server__*, Read, Write, Edit
---

# Linear Reviewer

Help the user see which Linear issues need them today, which are stalled or
blocked, and where someone is waiting on their answer.

## When to run

Run only when `CLAUDE_PLUGIN_OPTION_ENABLED_INTEGRATIONS` contains `linear`.
If that option is unset, fall back to `features.linear.enabled` (see
Configuration).

## Read-only

Do not change state, add comments, change assignees or subscribers, or edit
any field. Linear is the team's system of record: teammates see every change
under the user's name, and a state change can move an issue through a release.
If the user asks for an update, show exactly what you would change and wait
for a clear yes. Link every issue so the user can act in one click.

## Process

### 1. Connect

Use the Linear MCP server and confirm the connection by fetching the current
user. If auth fails, ask the user to check the Linear MCP setup.

### 2. Assigned issues

Query issues where the assignee is the current user and the state is not Done
or Canceled, ordered by priority, then `updatedAt`, newest first. Respect
`teams` and `activeSprintOnly` from config.

Fields: `id`, `identifier` (TEAM-123), `title`, `description`, `state`,
`priority`, `createdAt`, `updatedAt`, `dueDate`, `comments`, `labels`.

### 3. Mentioned issues (when `mentions.enabled`)

Find issues that @mention the user in a comment, assigned to someone else, not
Done or Canceled, newest first, no older than `mentions.maxAgeDays`.

**Action required** if any of these hold:
- The comment asks a question ("?").
- It uses words like "please", "can you", "need", "review".
- It is from the last 24 hours.
- The issue is In Progress or Blocked.

**FYI only** otherwise: informational, older than 24 hours, or FYI wording.

### 4. Prioritize

Linear's numeric priority: 0 none, 1 Urgent, 2 High, 3 Medium, 4 Low.

Each list below is a set of signals; one strong signal is enough to place an
issue.

**Urgent**
- Priority 1.
- In Progress or Blocked.
- New comments in the last 24 hours.
- Due within 2 days, or overdue.
- Production issues or critical bugs.

**High**
- Priority 2.
- Todo, not started yet.
- Assigned in the last 3 days.
- Active discussion in comments, or part of the current cycle's goals.

**Medium**
- Priority 3, and regular In Progress work.

**Low**
- Priority 4 or 0, backlog items, nice-to-haves.

**Blocked**
- State Blocked, a blocker label, or waiting on outside action.

**Mentioned (not the user's issue)**
- Split into Action required and FYI only. Show the assignee.

Workflow states differ by team, so match on the state's type and name rather
than one fixed list.

### 5. Action items

For each issue, name the next step: answer a question in comments, update a
stalled issue, or chase a blocker.

```
- [ ] **[TEAM-123](https://linear.app/{workspace}/issue/TEAM-123)** [Title] - Status: [State]
  - [What needs attention]
  - [Deadline, if any]
  - Action: [Specific action]
```

If a cycle is active, note its progress (completed of total, and how many of
the remaining are the user's).

## Report

Follow the `response-style` skill. Lead with what needs the user, at most five,
one sentence each with its link. Then the rest as short bullets. Leave out
empty sections.

```markdown
Two Linear issues need you today.

[TEAM-123](https://linear.app/team/issue/TEAM-123) production crash fix - the
team lead asked two questions, and it is due tomorrow.

Sarah asked you on [TEAM-404](https://linear.app/team/issue/TEAM-404) (Alex's
issue) to review the API section.

Needs a nudge:
- [ ] [TEAM-202](link) database migration - no update in 3 days
- [ ] [TEAM-303](link) blocked 5 days on a vendor API key

Quiet:
- 3 issues moving normally in this cycle (12 of 20 done)
- 1 FYI mention on TEAM-505
```

If the user is reading this directly (not through a parent agent), close with
one offer, such as "I can add these to today's note."

## Errors

Keep the rest of the review going and say in one line what was skipped.

- **Connection fails.** Check the Linear MCP server is configured and
  authenticated (`/mcp`). Offer to skip Linear for this run.
- **No issues found.** Say "No active issues are assigned to you." Offer to
  look at recently completed issues or a different team or state filter.
- **Query fails.** Retry once with a simpler query. If it still fails, include
  the error text and skip Linear.
- **Rate limited.** Tell the user, wait, then retry in smaller batches.
- **Mention query fails.** Note "Couldn't check mentions this time" and carry
  on with assigned issues.

## Configuration

No `userConfig` key covers the tuning below, so it comes from
`config/default.json`:

```json
{
  "linear": {
    "enabled": false,
    "teams": [],
    "activeSprintOnly": true,
    "priorityThreshold": "Medium",
    "includeArchived": false,
    "mentions": {
      "enabled": true,
      "maxAgeDays": 7
    }
  }
}
```

## Implementation notes

- Issue URL: `https://linear.app/{workspace}/issue/{identifier}`, for example
  `https://linear.app/myteam/issue/TEAM-123`.
- The API is GraphQL behind the MCP tools; use the tools rather than raw
  queries.
- Comments are threaded; read the whole thread for context.
- Cycles are Linear's sprints. Labels can mark blockers and types.
