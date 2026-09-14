# Testing Checklist — calendar-reviewer

Developer-facing verification steps for this skill. Not needed at runtime.

### Calendar MCP Tools
- [ ] `list_calendars` returns calendars
- [ ] `get_events` returns today's events with time range
- [ ] Handles authentication errors gracefully
- [ ] Handles empty calendar gracefully

### Event Extraction
- [ ] Extracts start/end times correctly
- [ ] Calculates duration correctly
- [ ] Extracts title, location, attendees
- [ ] Identifies all-day events
- [ ] Detects back-to-back meetings
- [ ] Detects overlapping events (conflicts)

### Free Time Calculation
- [ ] Reads working hours from config
- [ ] Calculates gaps between meetings
- [ ] Respects minimum block duration
- [ ] Applies energy patterns correctly
- [ ] Calculates totals accurately

### Safety
- [ ] Never modifies events
- [ ] Never deletes events
- [ ] Never accepts/declines invites
- [ ] Handles errors gracefully
