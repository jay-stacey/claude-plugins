---
name: markdown-provider
description: Plain markdown file integration for simple note management. Uses local filesystem operations.
allowed-tools: Read, Write, Edit, Glob
model: opus
---

# Markdown Provider

Implements the Notes Provider interface for plain markdown files. The simplest provider option, requiring no external tools or APIs.

## Configuration

```json
{
  "notes": {
    "provider": "markdown",
    "markdown": {
      "basePath": "/path/to/notes",
      "dailyNotesFolder": "daily",
      "dateFormat": "YYYY-MM-DD",
      "templatePath": "templates/daily.md"
    }
  }
}
```

---

## Directory Structure

```
notes/
├── daily/
│   ├── 2026-01-15.md
│   ├── 2026-01-16.md
│   └── ...
├── templates/
│   └── daily.md
└── ...
```

---

## Operations

### findDailyNote(date)

```
1. Build path: {basePath}/{dailyNotesFolder}/{dateFormat}.md
2. Example: /notes/daily/2026-01-15.md
3. Use Glob or Read to check existence
4. If exists: Read content
5. Return { exists, path, content, frontmatter }
```

### createDailyNote(date, template)

```
1. Check if note exists
2. If exists: return existing path
3. Read template if configured
4. If no template: use default
5. Replace date variables
6. Write file using Write tool
7. Return { success, path, created: true }
```

### readNote(path)

```
1. Read file content
2. Parse YAML frontmatter (if present)
3. Split by ## headers into sections
4. Return { content, frontmatter, sections }
```

### updateNote(path, content)

```
1. Verify file exists
2. Use Edit tool to update (preserves metadata)
3. Return { success, path }
```

### appendToSection(path, section, content)

```
1. Read current content
2. Find ## {section} header
3. Find next ## header or EOF
4. Insert content after section header
5. Use Edit tool
6. Return { success, section, linesAdded }
```

---

## File Format

### Standard Markdown

```markdown
---
date: 2026-01-15
created: 2026-01-15T08:00:00
updated: 2026-01-15T10:30:00
---

# Daily Note - 2026-01-15

## Today's Focus

- [ ] Priority 1
- [ ] Priority 2
- [ ] Priority 3

## INBOX

[Items captured throughout the day]

## URGENT

- [ ] **Email from John** - Budget approval needed
  - Deadline: Today 5 PM
  - Action: Review and approve

## IMPORTANT

- [ ] Code review PR #123
- [ ] Update documentation

## WORK LOG

### Morning
- Started work on feature X

### Afternoon
- Completed feature X
- Submitted PR for review

## AUTOMATED REVIEW (10:30 AM)

**Sources processed:** Gmail ✓ | Slack ✓ | Jira ✓

- Added 3 urgent tasks
- Added 5 important tasks
```

---

## Date Formats

Supported date formats for file naming:

| Format | Example |
|--------|---------|
| YYYY-MM-DD | 2026-01-15 |
| YYYY_MM_DD | 2026_01_15 |
| DD-MM-YYYY | 15-01-2026 |
| MM-DD-YYYY | 01-15-2026 |
| YYYYMMDD | 20260115 |

Configure via `dateFormat` in config.

---

## Default Template

If no template configured:

```markdown
---
date: {{date}}
---

# Daily Note - {{date:MMMM D, YYYY}}

## Today's Focus

- [ ]

## INBOX

## URGENT

## IMPORTANT

## WORK LOG

## AUTOMATED REVIEW
```

---

## Variable Substitution

Supported template variables:

| Variable | Output |
|----------|--------|
| `{{date}}` | 2026-01-15 |
| `{{date:YYYY-MM-DD}}` | 2026-01-15 |
| `{{date:MMMM D, YYYY}}` | January 15, 2026 |
| `{{date:dddd}}` | Wednesday |
| `{{time}}` | 10:30 |
| `{{time:HH:mm}}` | 10:30 |
| `{{datetime}}` | 2026-01-15 10:30 |

---

## Section Finding

Find sections using regex:

```javascript
// Find ## URGENT section
const regex = /^## (🔴 )?URGENT.*$/mi;
const match = content.match(regex);

// Find section boundaries
const sectionStart = content.indexOf(match[0]);
const nextSection = content.indexOf('\n## ', sectionStart + 1);
const sectionEnd = nextSection > -1 ? nextSection : content.length;
```

---

## Links

Plain markdown links (not wiki-links):

```markdown
See [yesterday's note](2026-01-14.md) for context.
Related to [Project Alpha](../projects/alpha.md).
```

Or use relative paths:

```markdown
[Previous Day](./2026-01-14.md)
[Next Day](./2026-01-16.md)
```

---

## Error Handling

### Directory Not Found
```
Error: Base path does not exist
Action: Create directory or verify path
Fallback: Use current directory
```

### Permission Denied
```
Error: Cannot write to directory
Action: Check file permissions
Suggest: Use different path or fix permissions
```

### Template Not Found
```
Error: Template file not found
Action: Use default template
Note: Template is optional
```

---

## Advantages

**Simplicity:**
- No external tools required
- Works anywhere with filesystem access
- Easy to version control (Git)
- Portable across systems

**Compatibility:**
- Works with any markdown editor
- Can be viewed in VS Code, GitHub, etc.
- Easy to backup and sync

**Flexibility:**
- No lock-in to specific tools
- Easy to migrate to other providers later
- Custom folder structure supported

---

## Testing Checklist

- [ ] Locates daily note by date
- [ ] Creates with date format from config
- [ ] Reads and parses frontmatter
- [ ] Identifies sections by headers
- [ ] Appends content to sections
- [ ] Uses Edit tool for existing files
- [ ] Creates directories if needed
- [ ] Handles missing template gracefully
- [ ] Supports different date formats
- [ ] Works with relative paths
