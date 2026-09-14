# Testing Checklist — jira-reviewer

Developer-facing verification steps for this skill. Not needed at runtime.

- [ ] Successfully authenticates with Atlassian MCP
- [ ] Retrieves assigned tickets via JQL
- [ ] Reads ticket details including comments
- [ ] Categorizes by priority correctly
- [ ] Identifies new comments and activity
- [ ] Detects blocked tickets
- [ ] Generates well-formatted report
- [ ] Provides working Jira ticket links
- [ ] Handles no results gracefully
- [ ] Respects user adjustments
- [ ] Takes no automatic actions on tickets

### Mention Detection Tests
- [ ] Successfully extracts accountId from atlassianUserInfo
- [ ] Constructs valid JQL for mention search
- [ ] Excludes already-assigned tickets from mention results
- [ ] Correctly parses mention comments to find context
- [ ] Categorizes mentions as Action Required vs FYI
- [ ] Handles empty mention results gracefully
- [ ] Handles mention query failure gracefully (continues with assigned)
- [ ] Respects config toggles (enabled, includeResolved, maxAgeDays, maxResults)
- [ ] Report shows assignee name for mentioned tickets
- [ ] Report shows mentioner name and comment excerpt
- [ ] Summary stats include mention count
