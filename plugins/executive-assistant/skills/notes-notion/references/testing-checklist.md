# Testing Checklist — notes-notion

Developer-facing verification steps for this skill. Not needed at runtime.

- [ ] Connects to Notion API via MCP
- [ ] Queries database for daily note
- [ ] Creates new page with properties
- [ ] Reads page content as blocks
- [ ] Converts blocks to markdown
- [ ] Appends blocks to sections
- [ ] Handles rate limiting
- [ ] Handles authentication errors
- [ ] Creates from template if configured
