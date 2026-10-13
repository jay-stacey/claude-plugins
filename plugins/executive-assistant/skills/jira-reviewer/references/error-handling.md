# Error Handling - jira-reviewer

In every case, keep the rest of the review going and say in one line what was
skipped. A partial Jira review is more useful than none.

### Jira connection fails
1. Check authentication with `atlassianUserInfo`.
2. Check the `cloudId` is the Dealerpull instance.
3. Ask the user to re-authenticate: `claude mcp test atlassian`.
4. If it still fails, offer to skip Jira for this run.

### No tickets found
Say "No active tickets are assigned to you." Then offer one or two ways to
look wider: tickets closed in the last 7 days, a different project filter, or
specific statuses. Recommend one.

### JQL query fails
Try the simpler query:
```
assignee = currentUser() AND resolution = Unresolved
```
If that also fails, tell the user, include the error text for troubleshooting,
and skip Jira.

### Rate limiting
Jira's limits can be tight. Tell the user, wait 1-2 minutes, then retry in
smaller batches.

### Mention query fails
Mention JQL is fragile with special characters in the `accountId`.
1. Note in the report: "Couldn't check mentions this time, so only assigned
   tickets are shown."
2. Carry on with the assigned-ticket report.
3. Retry once without the project filter:
   ```
   comment ~ "[~accountid:{accountId}]" AND assignee != currentUser()
   ```

Common causes: a malformed `accountId` (it should be alphanumeric), no access
to some projects, or a rate limit already hit by the assigned query.
