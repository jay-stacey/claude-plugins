# Testing Checklist — linear-reviewer

Developer-facing verification steps for this skill. Not needed at runtime.

- [ ] Successfully connects to Linear MCP
- [ ] Retrieves assigned issues
- [ ] Reads issue details including comments
- [ ] Categorizes by priority correctly
- [ ] Identifies new comments and activity
- [ ] Detects blocked issues
- [ ] Generates well-formatted report
- [ ] Provides working Linear issue links
- [ ] Handles no results gracefully
- [ ] Respects user adjustments
- [ ] Takes no automatic actions on issues

### Mention Detection Tests
- [ ] Constructs valid query for mentions
- [ ] Excludes already-assigned issues
- [ ] Correctly parses mention comments
- [ ] Categorizes mentions as Action Required vs FYI
- [ ] Handles empty results gracefully
- [ ] Handles query failure gracefully
- [ ] Report shows assignee and mentioner info
