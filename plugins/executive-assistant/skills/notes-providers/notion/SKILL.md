---
name: notion-provider
description: Notion integration for daily notes and task management. Uses Notion API via MCP server.
allowed-tools: mcp__notion__*, Read, Write, Edit
model: opus
---

# Notion Provider

Implements the Notes Provider interface for Notion using the Notion API.

## Configuration

```json
{
  "notes": {
    "provider": "notion",
    "notion": {
      "databaseId": "abc123-def456-...",
      "dailyNotesDatabase": "Daily Notes",
      "templateId": "template-page-id"
    }
  }
}
```

---

## Prerequisites

1. **Notion MCP Server** - Must be configured and authenticated
2. **Integration Access** - Notion integration must have access to:
   - Daily Notes database
   - Template page (if using)
3. **Database Schema** - Daily Notes database should have:
   - `Date` property (type: date)
   - `Title` property (type: title)
   - `Status` property (optional)

---

## Operations

### findDailyNote(date)

```
1. Query database for page with Date = {date}
2. Use Notion MCP to search:
   - database_id: {databaseId}
   - filter: { property: "Date", date: { equals: "YYYY-MM-DD" } }
3. If found: get page content
4. Return { exists, pageId, content, properties }
```

### createDailyNote(date, template)

```
1. Check if daily note exists (findDailyNote)
2. If exists: return existing page
3. If template configured:
   - Duplicate template page
   - Update Date property
4. Else create new page:
   - Parent: Daily Notes database
   - Properties: { Date: date, Title: "YYYY-MM-DD" }
   - Content: default sections
5. Return { success, pageId, created: true }
```

### readNote(pageId)

```
1. Get page properties via Notion MCP
2. Get page content (blocks)
3. Convert blocks to markdown-like structure
4. Identify sections by heading blocks
5. Return { content, properties, sections }
```

### updateNote(pageId, content)

```
1. Parse content into Notion blocks
2. Delete existing content blocks
3. Append new blocks
4. Update properties if needed
5. Return { success, pageId }
```

### appendToSection(pageId, section, content)

```
1. Get page blocks
2. Find heading block matching section
3. Find next heading or end
4. Insert new blocks after section heading
5. Return { success, section, blocksAdded }
```

---

## Notion Block Types

Map markdown to Notion blocks:

| Markdown | Notion Block |
|----------|--------------|
| `# Heading` | heading_1 |
| `## Heading` | heading_2 |
| `### Heading` | heading_3 |
| `- [ ] Task` | to_do (unchecked) |
| `- [x] Task` | to_do (checked) |
| `- Item` | bulleted_list_item |
| `1. Item` | numbered_list_item |
| `> Quote` | quote |
| `---` | divider |
| `` `code` `` | code |
| `**bold**` | bold annotation |
| `*italic*` | italic annotation |
| `[link](url)` | link annotation |

---

## Database Properties

### Required Properties

```json
{
  "Date": {
    "type": "date",
    "date": { "start": "2026-01-15" }
  },
  "Title": {
    "type": "title",
    "title": [{ "text": { "content": "2026-01-15" } }]
  }
}
```

### Optional Properties

```json
{
  "Status": {
    "type": "select",
    "select": { "name": "In Progress" }
  },
  "Tags": {
    "type": "multi_select",
    "multi_select": [{ "name": "daily" }, { "name": "automated" }]
  },
  "Urgent Count": {
    "type": "number",
    "number": 3
  }
}
```

---

## Default Page Template

If no template configured, create with:

```
# {{date}}

## Today's Focus
- [ ]

---

## INBOX

---

## URGENT

---

## IMPORTANT

---

## WORK LOG

---

## AUTOMATED REVIEW
```

---

## Error Handling

### API Authentication Failed
```
Error: Notion API returned 401
Action: Check Notion MCP server authentication
Suggest: Re-authenticate or verify integration token
```

### Database Not Found
```
Error: Database {databaseId} not found
Action: Verify database ID in config
Suggest: Ensure integration has access to database
```

### Rate Limited
```
Error: Notion API rate limit exceeded
Action: Wait and retry (exponential backoff)
Max retries: 3
```

### Page Not Found
```
Error: Page {pageId} not found
Action: Page may have been deleted
Fallback: Create new daily note
```

---

## Notion MCP Tools

Use these MCP tools for Notion operations:

| Operation | Tool |
|-----------|------|
| Query database | `mcp__notion__query_database` |
| Get page | `mcp__notion__get_page` |
| Create page | `mcp__notion__create_page` |
| Update page | `mcp__notion__update_page` |
| Get blocks | `mcp__notion__get_block_children` |
| Append blocks | `mcp__notion__append_block_children` |
| Delete block | `mcp__notion__delete_block` |

---

## Testing Checklist

- [ ] Connects to Notion API via MCP
- [ ] Queries database for daily note
- [ ] Creates new page with properties
- [ ] Reads page content as blocks
- [ ] Converts blocks to markdown
- [ ] Appends blocks to sections
- [ ] Handles rate limiting
- [ ] Handles authentication errors
- [ ] Creates from template if configured
