# Notes Provider Interface

This document defines the common interface that all notes providers must implement to integrate with the Executive Assistant.

## Overview

Notes providers allow the assistant to write daily summaries, tasks, and schedules to the user's preferred note-taking application. Each provider implements the same interface but handles the specifics of its platform.

## Supported Providers

| Provider | Status | Method |
|----------|--------|--------|
| Obsidian | Full Support | Local filesystem |
| Notion | Full Support | API (requires MCP) |
| Logseq | Full Support | Local filesystem |
| Roam Research | Full Support | API (requires token) |
| Plain Markdown | Full Support | Local filesystem |

---

## Required Operations

All providers MUST implement these operations:

### 1. `findDailyNote(date)`

**Purpose:** Locate today's note file/page

**Input:**
- `date` - Date object or string (YYYY-MM-DD format)

**Output:**
```json
{
  "exists": true,
  "path": "/path/to/daily/2026-01-15.md",
  "content": "...",
  "frontmatter": {...}
}
```

**Behavior:**
- Check if daily note exists for given date
- Return path/identifier if found
- Return exists: false if not found

### 2. `createDailyNote(date, template)`

**Purpose:** Create a new daily note from template

**Input:**
- `date` - Date for the note
- `template` - Optional template content

**Output:**
```json
{
  "success": true,
  "path": "/path/to/daily/2026-01-15.md",
  "created": true
}
```

**Behavior:**
- Read template from configured path
- Replace date variables ({{date}}, {{date:YYYY-MM-DD}}, etc.)
- Create new note at appropriate location
- Return path to created note

### 3. `readNote(path)`

**Purpose:** Read content of a specific note

**Input:**
- `path` - Path or identifier of the note

**Output:**
```json
{
  "content": "...",
  "frontmatter": {...},
  "sections": [
    { "name": "URGENT", "content": "...", "startLine": 10, "endLine": 25 }
  ]
}
```

**Behavior:**
- Read full note content
- Parse frontmatter (YAML)
- Identify markdown sections by headers
- Return structured data

### 4. `updateNote(path, content)`

**Purpose:** Update entire note content

**Input:**
- `path` - Path or identifier
- `content` - Full new content

**Output:**
```json
{
  "success": true,
  "path": "/path/to/note.md"
}
```

**Behavior:**
- Replace entire note content
- Preserve file metadata if applicable
- Use Edit tool for local files (not Write)

### 5. `appendToSection(path, section, content)`

**Purpose:** Append content to a specific section

**Input:**
- `path` - Path or identifier
- `section` - Section header name (e.g., "URGENT")
- `content` - Content to append

**Output:**
```json
{
  "success": true,
  "section": "URGENT",
  "linesAdded": 5
}
```

**Behavior:**
- Find section by header
- Append content after header, before next section
- Preserve existing content in section
- Handle section not found gracefully

---

## Optional Operations

Providers MAY implement these operations:

### 6. `searchNotes(query)`

**Purpose:** Search across notes

**Input:**
- `query` - Search string

**Output:**
```json
{
  "results": [
    { "path": "...", "title": "...", "snippet": "..." }
  ]
}
```

### 7. `linkNotes(source, target)`

**Purpose:** Create internal link between notes

**Input:**
- `source` - Source note path
- `target` - Target note path

**Output:**
```json
{
  "success": true,
  "linkFormat": "[[2026-01-15]]"
}
```

### 8. `getRecentNotes(count)`

**Purpose:** Get list of recently modified notes

**Input:**
- `count` - Number of notes to return

**Output:**
```json
{
  "notes": [
    { "path": "...", "title": "...", "modified": "..." }
  ]
}
```

---

## Standardized Note Structure

Regardless of provider, daily notes should follow this structure:

```markdown
---
date: YYYY-MM-DD
created: timestamp
updated: timestamp
---

# Daily Note - YYYY-MM-DD

## Today's Focus
- [ ] Top priority 1
- [ ] Top priority 2
- [ ] Top priority 3

## INBOX
[Captured items throughout day]

## SCHEDULE
[Meetings and time blocks]

## URGENT
[Items needing immediate attention]

## IMPORTANT
[Items for this week]

## WORK LOG
[Progress updates and notes]

## AUTOMATED REVIEW
[Added by assistant]
```

---

## Configuration

Each provider has its own configuration section:

```json
{
  "notes": {
    "enabled": true,
    "provider": "obsidian",

    "obsidian": {
      "vaultPath": "/path/to/vault",
      "dailyNotesPath": "Daily Notes",
      "templatePath": "Templates/Daily Note.md"
    },

    "notion": {
      "databaseId": "xxx-xxx-xxx",
      "dailyNotesDatabase": "Daily Notes",
      "templateId": "template-page-id"
    },

    "logseq": {
      "graphPath": "/path/to/graph",
      "journalsPath": "journals",
      "dateFormat": "YYYY_MM_DD"
    },

    "roam": {
      "graphName": "my-graph",
      "apiToken": "${ROAM_API_TOKEN}"
    },

    "markdown": {
      "basePath": "/path/to/notes",
      "dailyNotesFolder": "daily",
      "dateFormat": "YYYY-MM-DD"
    }
  }
}
```

---

## Error Handling

All providers must handle these error cases:

1. **Note not found** - Return exists: false, don't throw
2. **Permission denied** - Report error, suggest fix
3. **API failure** - Retry once, then report
4. **Invalid path** - Validate before operations
5. **Template not found** - Use default template

---

## Provider Selection

The task-consolidator skill reads the provider from config:

```javascript
const provider = config.notes.provider;

switch (provider) {
  case 'obsidian':
    return new ObsidianProvider(config.notes.obsidian);
  case 'notion':
    return new NotionProvider(config.notes.notion);
  case 'logseq':
    return new LogseqProvider(config.notes.logseq);
  case 'roam':
    return new RoamProvider(config.notes.roam);
  case 'markdown':
    return new MarkdownProvider(config.notes.markdown);
  default:
    return new MarkdownProvider(config.notes.markdown);
}
```

---

## Implementation Notes

- **Local providers** (Obsidian, Logseq, Markdown) use Read/Edit/Write tools
- **API providers** (Notion, Roam) use their respective MCP servers
- All providers should handle concurrent access gracefully
- Backup before destructive operations
- Preserve user's manual entries
