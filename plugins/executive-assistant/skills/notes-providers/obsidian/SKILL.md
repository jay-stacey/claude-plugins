---
name: obsidian-provider
description: Obsidian vault integration for daily notes, task consolidation, and knowledge management. Uses local filesystem operations.
allowed-tools: Read, Write, Edit, Glob
model: opus
---

# Obsidian Provider

Implements the Notes Provider interface for Obsidian vaults using local filesystem operations.

## Configuration

```json
{
  "notes": {
    "provider": "obsidian",
    "obsidian": {
      "vaultPath": "C:\\Users\\User\\Documents\\Obsidian\\MyVault",
      "dailyNotesPath": "Daily Notes",
      "templatePath": "Templates/Daily Note.md",
      "quickCapturesPath": "Inbox/Quick Captures.md"
    }
  }
}
```

---

## Operations

### findDailyNote(date)

```
1. Build path: {vaultPath}/{dailyNotesPath}/{YYYY-MM-DD}.md
2. Use Glob to check if file exists
3. If exists: Read file content
4. Return { exists, path, content, frontmatter }
```

**Path Examples:**
- `C:\Users\User\Documents\Obsidian\MyVault\Daily Notes\2026-01-15.md`
- `/home/user/obsidian/vault/10-DAILY/2026-01-15.md`

### createDailyNote(date, template)

```
1. Check if daily note exists (findDailyNote)
2. If exists: return existing path
3. Read template from {vaultPath}/{templatePath}
4. Replace variables:
   - {{date}} → 2026-01-15
   - {{date:YYYY-MM-DD}} → 2026-01-15
   - {{date:dddd, MMMM DD, YYYY}} → Wednesday, January 15, 2026
   - {{time}} → HH:MM
5. Write new file using Write tool
6. Return { success, path, created: true }
```

### readNote(path)

```
1. Use Read tool to get file content
2. Parse YAML frontmatter (between --- markers)
3. Split content into sections by ## headers
4. Return { content, frontmatter, sections }
```

### updateNote(path, content)

```
1. Verify file exists
2. Use Edit tool to replace content (NOT Write for existing files)
3. Preserve file metadata
4. Return { success, path }
```

### appendToSection(path, section, content)

```
1. Read current note content
2. Find section header (## {section})
3. Find end of section (next ## or end of file)
4. Insert content after header
5. Use Edit tool to update
6. Return { success, section, linesAdded }
```

---

## Section Handling

### Standard Obsidian Daily Note Sections

```markdown
## Today's Focus
## INBOX - Capture Throughout Day
## SCHEDULE
## READING LIST
## URGENT (Do First)
## IMPORTANT (Scheduled Time)
## ROUTINE (Filler Time)
## Time Blocks
## WORK LOG
## MEETINGS & COMMUNICATIONS
## NOTES & LEARNING
## REFLECTION (End of Day)
## LINKS
## AUTOMATED REVIEW
```

### Section Identification

Find sections by matching patterns:
- `## URGENT` or `## 🔴 URGENT`
- `## IMPORTANT` or `## 🟡 IMPORTANT`
- Case-insensitive matching

### Section Order

When inserting new sections, maintain this order:
1. Today's Focus
2. INBOX
3. SCHEDULE (new)
4. READING LIST (new)
5. EMAIL SUMMARIES (new)
6. URGENT
7. IMPORTANT
8. ROUTINE
9. Time Blocks
10. WORK LOG
11. MEETINGS
12. NOTES
13. REFLECTION
14. LINKS
15. AUTOMATED REVIEW (always last)

---

## Obsidian Features

### WikiLinks

Use `[[YYYY-MM-DD]]` format for daily note references:
```markdown
See [[2026-01-14]] for yesterday's notes.
```

### Tags

Add tags for discoverability:
```markdown
#daily #automated #2026-01
```

### Backlinks

Create links to project and people notes:
```markdown
Related to [[Project Alpha]] and [[John Smith]]
```

### Dataview Compatibility

Structure frontmatter for Dataview queries:
```yaml
---
date: 2026-01-15
type: daily
status: in-progress
tasks_added: 15
urgent_count: 3
---
```

---

## File Operations

### Reading Files
```
Tool: Read
Path: {vaultPath}/{relativePath}
```

### Creating Files
```
Tool: Write
Path: {vaultPath}/{relativePath}
Content: {content}
```

### Editing Files
```
Tool: Edit
Path: {vaultPath}/{relativePath}
old_string: {existing content}
new_string: {new content}
```

### Finding Files
```
Tool: Glob
Pattern: {vaultPath}/{dailyNotesPath}/*.md
```

---

## Error Handling

### Vault Not Found
```
Error: Vault path does not exist
Action: Ask user to verify vaultPath in config
Fallback: Save to current directory
```

### Template Not Found
```
Error: Template file not found at {templatePath}
Action: Use default minimal template
Default Template:
---
date: {{date}}
---

# {{date:dddd, MMMM DD, YYYY}}

## Today's Focus
- [ ]

## INBOX

## URGENT

## IMPORTANT

## WORK LOG
```

### File Locked
```
Error: File is locked (Obsidian has it open)
Action: Inform user to close file in Obsidian
Retry: After 2 seconds
Fallback: Save to Quick Captures
```

### Permission Denied
```
Error: Cannot write to vault
Action: Check file permissions
Suggest: Run as administrator or check OneDrive sync
```

---

## Quick Captures Backup

If daily note write fails, save to Quick Captures:

```markdown
## Quick Capture - {{timestamp}}

**From: Automated Review**

{{content}}

---
Move to today's daily note when resolved.
```

---

## Testing Checklist

- [ ] Locates daily note correctly
- [ ] Creates from template with variable substitution
- [ ] Reads and parses frontmatter
- [ ] Identifies sections correctly
- [ ] Appends to sections without overwriting
- [ ] Uses Edit tool for existing files
- [ ] Handles missing template gracefully
- [ ] Saves to Quick Captures on failure
- [ ] Creates WikiLinks correctly
- [ ] Supports emoji in section headers
