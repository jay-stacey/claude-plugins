---
name: logseq-provider
description: Logseq graph integration for journal pages and task management. Uses local filesystem operations.
allowed-tools: Read, Write, Edit, Glob
model: opus
---

# Logseq Provider

Implements the Notes Provider interface for Logseq graphs using local filesystem operations.

## Configuration

```json
{
  "notes": {
    "provider": "logseq",
    "logseq": {
      "graphPath": "/path/to/logseq/graph",
      "journalsPath": "journals",
      "dateFormat": "YYYY_MM_DD"
    }
  }
}
```

---

## Logseq Structure

Logseq uses a specific directory structure:

```
graph/
├── journals/
│   ├── 2026_01_15.md
│   ├── 2026_01_16.md
│   └── ...
├── pages/
│   ├── project-alpha.md
│   └── ...
├── logseq/
│   └── config.edn
└── ...
```

---

## Operations

### findDailyNote(date)

```
1. Build path: {graphPath}/{journalsPath}/{dateFormat}.md
2. Date format examples:
   - YYYY_MM_DD → 2026_01_15.md
   - YYYY-MM-DD → 2026-01-15.md
   - MMM_Do,_YYYY → Jan_15th,_2026.md
3. Use Glob to check if file exists
4. If exists: Read file content
5. Return { exists, path, content }
```

### createDailyNote(date, template)

```
1. Check if journal page exists
2. If exists: return existing path
3. Build content with Logseq outline format
4. Write new file
5. Return { success, path, created: true }
```

### readNote(path)

```
1. Read file content
2. Parse Logseq outline format (indented bullets)
3. Identify blocks by indentation level
4. Find sections by specific markers
5. Return { content, blocks, sections }
```

### updateNote(path, content)

```
1. Verify file exists
2. Use Edit tool to replace content
3. Maintain Logseq outline format
4. Return { success, path }
```

### appendToSection(path, section, content)

```
1. Read current content
2. Find section marker (e.g., "## URGENT" or "URGENT::")
3. Insert content as child blocks
4. Maintain indentation
5. Return { success, section, blocksAdded }
```

---

## Logseq Format

### Outline Structure

Logseq uses indented bullet points:

```markdown
- Today's Focus
  - [ ] Priority 1
  - [ ] Priority 2
  - [ ] Priority 3
- URGENT
  - [ ] **Email from John** - Budget approval
    - Deadline: Today 5 PM
    - Action: Review and approve
- IMPORTANT
  - [ ] Code review PR #123
```

### Block Properties

Logseq supports block properties:

```markdown
- Task title
  priority:: high
  deadline:: 2026-01-15
  tags:: work, urgent
```

### Page Properties

At the start of the file:

```markdown
date:: 2026-01-15
type:: journal
status:: in-progress
```

### Links

```markdown
- See [[2026-01-14]] for yesterday
- Related to [[Project Alpha]]
- Assigned to [[John Smith]]
```

### Tags

```markdown
- Task with #urgent tag
- Also supports [[tag]] format
```

---

## Section Markers

Logseq doesn't have traditional markdown headers in journals. Use these patterns:

**Option 1: Top-level bullets**
```markdown
- Today's Focus
- URGENT
- IMPORTANT
```

**Option 2: Markdown headers (if configured)**
```markdown
## Today's Focus
## URGENT
## IMPORTANT
```

**Option 3: Custom markers**
```markdown
- URGENT::
  - Task 1
  - Task 2
```

---

## Default Journal Template

```markdown
- Today's Focus
  - [ ]
- ---
- INBOX
  -
- ---
- URGENT
  -
- ---
- IMPORTANT
  -
- ---
- WORK LOG
  -
- ---
- AUTOMATED REVIEW
  -
```

---

## Date Format

Common Logseq date formats:

| Format | Example |
|--------|---------|
| YYYY_MM_DD | 2026_01_15 |
| YYYY-MM-DD | 2026-01-15 |
| MMM_Do,_YYYY | Jan_15th,_2026 |
| dd-MM-yyyy | 15-01-2026 |

Check `logseq/config.edn` for the graph's date format:

```edn
:journal/page-title-format "YYYY_MM_DD"
:journal/file-name-format "YYYY_MM_DD"
```

---

## Error Handling

### Graph Not Found
```
Error: Graph path does not exist
Action: Ask user to verify graphPath in config
Suggest: Check Logseq graph location
```

### Format Mismatch
```
Error: Date format doesn't match graph config
Action: Read format from logseq/config.edn
Fallback: Try common formats
```

### File Locked
```
Error: File is locked (Logseq has it open)
Action: Logseq auto-reloads, should be safe
Note: Logseq handles concurrent access well
```

---

## Testing Checklist

- [ ] Locates journal page correctly
- [ ] Creates new journal with proper format
- [ ] Parses outline structure
- [ ] Identifies sections by markers
- [ ] Appends as child blocks with indentation
- [ ] Maintains Logseq outline format
- [ ] Creates proper page links [[]]
- [ ] Handles different date formats
- [ ] Reads config.edn for settings
