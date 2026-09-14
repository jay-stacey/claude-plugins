# Error Handling — jira-reviewer

### Jira Connection Fails
1. Check authentication: `atlassianUserInfo`
2. Verify cloudId is correct for Dealerpull instance
3. Ask user to re-authenticate: `claude mcp test atlassian`
4. If still failing, offer to skip Jira review and try again later

### No Tickets Found
- Report: "No active tickets currently assigned to you"
- Suggest:
  - Check recently closed tickets (last 7 days)
  - Verify Jira project filter is correct
  - Check if tickets are in "Done" status
- Ask if user wants to query specific projects or statuses

### JQL Query Fails
- Try simpler query: `assignee = currentUser() AND resolution = Unresolved`
- If still failing, inform user and skip Jira review
- Provide error details for troubleshooting

### Rate Limiting
- Jira API has rate limits (can be conservative)
- If rate limited, inform user
- Suggest: Wait 1-2 minutes before retrying
- Offer to process tickets in smaller batches

### Mention Query Fails
- JQL syntax for mentions can be tricky with special characters in accountId
- If mention query fails:
  1. Log warning: "Could not retrieve mentioned tickets: [error]"
  2. Continue with assigned tickets report (don't fail entire review)
  3. Note in report: "Mention detection encountered an error. Only assigned tickets shown."
- Common issues:
  - Invalid accountId format (should be alphanumeric)
  - Project restrictions (user may not have access to some projects)
  - API rate limiting (if already hit limits on assigned query)
- Fallback: Try simpler query without project filter if initial query fails:
  ```
  comment ~ "[~accountid:{accountId}]" AND assignee != currentUser()
  ```
