# Advanced Features — jira-reviewer

### Custom JQL Queries
User can configure:
- **Project filter**: Only tickets from specific projects (e.g., DMS)
- **Sprint focus**: Only tickets in active sprint
- **Status filter**: Include specific statuses beyond open tickets
- **Custom JQL**: Advanced users can provide their own query

### Priority Thresholds
- **Critical threshold**: Define what makes a ticket critical (deadline, comments, etc.)
- **Attention threshold**: How many days without update triggers "needs status" flag
- **Blocker tracking**: Automatically flag tickets blocked for X days

### Comment Analysis
- **Keyword detection**: Flag comments containing "urgent", "blocker", "question"
- **Stakeholder tracking**: Prioritize comments from PM, clients, or management
- **Question detection**: Identify comments ending with "?" that need response

### Integration Points
- **Cross-reference Slack**: Match Jira tickets mentioned in Slack messages
- **Email correlation**: Connect Jira tickets referenced in emails
- **PR linking**: Identify tickets with associated pull requests
- **Sprint planning**: Show tickets in current and upcoming sprints
