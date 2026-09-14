# Testing Checklist — task-consolidator

Developer-facing verification steps for this skill. Not needed at runtime.

### Core Functions
- [ ] Successfully locates today's daily note via provider
- [ ] Creates daily note from template if missing
- [ ] Reads and parses daily note structure
- [ ] Deduplicates tasks across sources (including Linear)
- [ ] Places tasks in correct sections
- [ ] Uses provider interface for all operations
- [ ] Preserves all existing content

### Notes Provider Integration
- [ ] Reads provider from configuration
- [ ] Finds an existing daily note
- [ ] Creates a daily note when none exists
- [ ] Appends to a section without disturbing other sections
- [ ] Handles a note with no frontmatter
- [ ] Handles plain markdown provider correctly
- [ ] Graceful degradation if notes.enabled: false

### New Sections
- [ ] Creates 📅 TODAY'S SCHEDULE section correctly
- [ ] Populates meetings table with calendar data
- [ ] Populates free time blocks table
- [ ] Creates 📚 READING LIST section correctly
- [ ] Formats reading list with checkboxes and sources
- [ ] Creates 📊 EMAIL SUMMARIES section correctly
- [ ] Includes Azure alert counts by severity
- [ ] Includes GitHub activity summary
- [ ] Handles ⏰ Time Blocks from day planning

### Linear Integration
- [ ] Receives Linear issues from linear-reviewer
- [ ] Maps Linear priorities to sections correctly
- [ ] Deduplicates Linear issues mentioned in Slack
- [ ] Formats Linear issue links correctly

### Safety
- [ ] Never overwrites user's manual entries
- [ ] Handles missing template gracefully
- [ ] Handles file permission errors
- [ ] Creates backup on major changes
- [ ] Asks confirmation before writing
- [ ] Falls back to inbox location on failure
