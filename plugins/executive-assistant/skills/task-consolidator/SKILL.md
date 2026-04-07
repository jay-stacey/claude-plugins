---
name: task-consolidator
description: Consolidate tasks from email, Slack, Jira, Linear, and calendar into daily notes. Supports multiple notes providers (Obsidian, Notion, Logseq, Roam, markdown). Includes reading list, schedule, and email summaries. Merge and deduplicate action items.
allowed-tools: Read, Write, Edit, Glob
model: opus
---

# Task Consolidator

You integrate processed data from Gmail, Slack, Jira, Linear, and Calendar into the user's daily note, creating a unified task list and schedule for the day.

## Notes Provider Integration

This skill uses the **Notes Provider Interface** to support multiple note-taking tools. The provider is configured in `config/default.json` or `.config.local.json`:

```json
{
  "notes": {
    "enabled": true,
    "provider": "obsidian",  // or "notion", "logseq", "roam", "markdown"
    ...
  }
}
```

**Supported Providers:**
| Provider | Skill Location | Method |
|----------|----------------|--------|
| Obsidian | `notes-providers/obsidian/SKILL.md` | Local filesystem |
| Notion | `notes-providers/notion/SKILL.md` | Notion API via MCP |
| Logseq | `notes-providers/logseq/SKILL.md` | Local filesystem |
| Roam Research | `notes-providers/roam/SKILL.md` | Roam API |
| Plain Markdown | `notes-providers/markdown/SKILL.md` | Local filesystem |

**Provider Interface Operations:**
- `findDailyNote(date)` - Locate today's note
- `createDailyNote(date, template)` - Create from template
- `readNote(path)` - Read note content
- `updateNote(path, content)` - Update note content
- `appendToSection(path, section, content)` - Append to specific section

See `notes-providers/interface.md` for full interface specification.

---

## Process

### 1. Determine Notes Provider
- Read configuration to identify active provider
- If `notes.enabled: false`, skip consolidation and inform user
- Load provider-specific settings from config
- Use provider interface operations for all note interactions

### 2. Locate Today's Daily Note
- Call `findDailyNote(today)` via the configured provider
- Provider handles path construction based on its format:
  - **Obsidian**: `{vaultPath}/{dailyNotesPath}/YYYY-MM-DD.md`
  - **Notion**: Query database for page with Date = today
  - **Logseq**: `{graphPath}/{journalsPath}/YYYY_MM_DD.md`
  - **Roam**: Search for page titled "January 15th, 2026"
  - **Markdown**: `{basePath}/{dailyNotesFolder}/YYYY-MM-DD.md`

### 3. Create Daily Note if Doesn't Exist
- Call `createDailyNote(today, template)` via provider
- Provider handles:
  - Reading template from configured location
  - Variable substitution ({{date}}, {{time}}, etc.)
  - Creating file/page in correct location
- Inform user: "Created today's daily note"

### 3. Parse Existing Daily Note
Read current content and identify these sections by markdown headers:

**Core Task Sections:**
- `## 🔴 URGENT (Do First)` - Urgent tasks
- `## 🟡 IMPORTANT (Scheduled Time)` - Important tasks
- `## 📥 INBOX - Capture Throughout Day` - Inbox items
- `## 📊 WORK LOG` - Work progress notes
- `## 🤝 MEETINGS & COMMUNICATIONS` - Meetings section

**New Sections (added by this workflow):**
- `## 📅 TODAY'S SCHEDULE` - Calendar meetings and free blocks
- `## 📚 READING LIST` - Curated articles from newsletters
- `## 📊 EMAIL SUMMARIES` - Azure alerts, GitHub, etc.
- `## ⏰ Time Blocks` - Scheduled focus time

Preserve ALL existing content. Note current task count in each section.

### 4. Receive Input Data

Accept data from five sources:

**Gmail Processor** provides:
- Categorized emails (Urgent, Important, FYI, Junk)
- Reading list articles (from TLDR newsletters)
- Email summaries (Azure alerts, GitHub notifications)
- Email cleanup results

**Slack Reviewer** provides:
- Prioritized messages (High, Medium, FYI)
- Key decisions made
- Action items with context

**Jira Reviewer** provides:
- Categorized tickets (Critical, High, In Progress, Blocked)
- Mentions and comments requiring attention
- Status updates needed

**Linear Reviewer** provides (if enabled):
- Assigned issues by priority (Urgent, High, Medium, Low)
- Mentions and comments requiring attention
- Cycle/sprint progress summary
- Blocked issues needing attention

**Calendar Reviewer** provides:
- Today's meetings (time, title, location, attendees)
- Free time blocks (time, duration, energy pattern)
- Scheduled focus blocks (if day planning was done)

### 5. Consolidate and Deduplicate Tasks

**Deduplication Rules:**
- **Same Jira/Linear issue in multiple sources**: Keep Jira/Linear entry only (most authoritative)
  - Example: DMS-2372 mentioned in Slack → Use Jira ticket, note Slack discussion
  - Example: NEO-123 mentioned in Slack → Use Linear issue, note Slack discussion
- **Same email thread**: If categorized differently, keep highest priority
- **Same person across sources**: Cross-reference but keep separate if different topics
- **Calendar events vs tasks**: Don't duplicate - reference meetings, schedule tasks around them

**Placement Rules:**

| Source Data | Target Section | Condition |
|-------------|----------------|-----------|
| Emails | **🔴 URGENT** | "today" deadline, marked urgent |
| Emails | **🟡 IMPORTANT** | "this week" deadline, requires response |
| Emails | **📥 INBOX** | FYI items, no action needed |
| Slack High Priority | **🔴 URGENT** | Direct mentions, questions |
| Slack Medium Priority | **🟡 IMPORTANT** | Discussions, code reviews |
| Slack FYI | **📥 INBOX** | Announcements, general info |
| Jira Critical/Highest | **🔴 URGENT** | Critical priority OR due today |
| Jira High/Medium | **🟡 IMPORTANT** | Normal priority tickets |
| Jira In Progress | **📊 WORK LOG** | Status updates needed |
| Jira Blocked | **🔴 URGENT** | Blockers need immediate attention |
| Linear Urgent | **🔴 URGENT** | Priority 1 (Urgent) |
| Linear High | **🟡 IMPORTANT** | Priority 2 (High) |
| Linear Medium/Low | **📥 INBOX** | Priority 3-4 (Medium/Low) |
| Linear Blocked | **🔴 URGENT** | Issues with blockers |
| Calendar Meetings | **📅 TODAY'S SCHEDULE** | All meetings |
| Calendar Free Blocks | **📅 TODAY'S SCHEDULE** | Available time |
| Focus Blocks | **⏰ Time Blocks** | Scheduled task time |
| TLDR Articles | **📚 READING LIST** | Accepted articles |
| Azure/GitHub/Jira Summaries | **📊 EMAIL SUMMARIES** | Processed notifications |

### 6. Format Content for Each Section

#### 📅 TODAY'S SCHEDULE Section

```markdown
## 📅 TODAY'S SCHEDULE

### Meetings
| Time | Meeting | Location | Prep Needed |
|------|---------|----------|-------------|
| 9:00 AM - 9:30 AM | Daily Standup | [Zoom](link) | None |
| 11:00 AM - 12:00 PM | Sprint Planning | Conf Room A | Review backlog |
| 2:00 PM - 3:00 PM | 1:1 with Manager | [Teams](link) | Prepare updates |

### Free Time Blocks
| Time | Duration | Energy | Planned Activity |
|------|----------|--------|------------------|
| 8:00 AM - 9:00 AM | 1 hr | 🔋 Deep Work | DMS-2372 Lead Notifications |
| 9:30 AM - 11:00 AM | 1.5 hr | 🔋 Deep Work | Available |
| 1:00 PM - 2:00 PM | 1 hr | 📋 Focus | Code reviews |
| 3:00 PM - 5:00 PM | 2 hr | 📋 Focus | Available |

**Summary:** {{meeting_count}} meetings ({{meeting_hours}} hrs) | {{free_hours}} hrs available
```

#### 📚 READING LIST Section

```markdown
## 📚 READING LIST

**Today's Curated Articles (from TLDR Newsletters):**

- [ ] [Article Title](url) - Brief summary - *TLDR AI, 5 min*
- [ ] [Article Title](url) - Brief summary - *TLDR DevOps, 3 min*
- [ ] [Article Title](url) - Brief summary - *TLDR Web Dev, 7 min*

> **Tip:** Mark articles complete when read. This improves future suggestions.
```

#### 📊 EMAIL SUMMARIES Section

```markdown
## 📊 EMAIL SUMMARIES

### Azure Alerts ({{date}})
- Critical: {{count}} | Error: {{count}} | Warning: {{count}} | Info: {{count}}
- Key issues: {{brief_description}}
- [View in Azure Portal](link)

### GitHub Activity
- PR Reviews Requested: {{count}}
- Issues Assigned: {{count}}
- Actions Failed: {{count}}
- Mentions: {{count}}
- Repos: {{repo_list}}

### Jira Notifications Processed
- Field changes auto-archived: {{count}}
- Questions/mentions kept: {{count}}
```

#### ⏰ Time Blocks Section (if day planning done)

```markdown
## ⏰ Time Blocks

| Time | Activity | Source | Priority |
|------|----------|--------|----------|
| 8:00 AM - 9:30 AM | [Focus] DMS-2372 Lead Notifications | 🎯 Jira | 🔴 Urgent |
| 9:30 AM - 10:00 AM | [Focus] Respond to PM email | 📧 Email | 🔴 Urgent |
| 1:00 PM - 1:45 PM | [Focus] Code review PR #456 | 💬 Slack | 🟡 Important |
| 3:00 PM - 4:30 PM | [Focus] DMS-2350 Admin Dashboard | 🎯 Jira | 🟡 Important |

**Legend:** 📅 Meeting | 🎯 Jira | 📧 Email | 💬 Slack
```

#### Standard Task Format

```markdown
- [ ] **[Source]** - Brief description - [Link]
  - [Additional context]
  - [Action needed]
```

Examples:
```markdown
- [ ] **Email from John** - Q: Budget approval needed - [Gmail](link)
  - Deadline: Today 5 PM
  - Action: Review document and approve

- [ ] **#engineering** - @you: Review PR #123 - [Slack](link)
  - From: Alex - 2 hours ago
  - Action: Code review

- [ ] **[DMS-2372](jira-link)** Lead Notifications - Status: In Progress
  - 2 new comments from PM
  - Action: Respond to questions

- [ ] **[NEO-45](linear-link)** Login Component - Status: In Progress
  - Mentioned by @designer
  - Action: Review design feedback
```

### 7. Update Daily Note

Use the notes provider interface to update:
- Call `appendToSection(path, section, content)` for each section
- Provider handles format-specific operations internally

**For filesystem providers (Obsidian, Logseq, Markdown):**
- Use `Edit` tool (NOT `Write`) to modify existing note

**For new sections (Schedule, Reading List, Email Summaries):**
- Check if section exists
- If not, insert section in proper order:
  1. After INBOX, before URGENT: `## 📅 TODAY'S SCHEDULE`
  2. After SCHEDULE, before URGENT: `## 📚 READING LIST`
  3. After READING LIST, before URGENT: `## 📊 EMAIL SUMMARIES`
- If exists, update content within section

**For existing sections (URGENT, IMPORTANT, etc.):**
- Find each section by markdown header
- Insert new tasks after section header, before existing tasks
- Maintain formatting: Preserve indentation, checkboxes, links
- Preserve everything else: Don't modify user's manual entries

**Add timestamp section at end:**
```markdown
---

## 🤖 AUTOMATED REVIEW ({{time}})

**Sources processed:** Calendar ✓ | Gmail ✓ | Slack ✓ | Jira ✓ | Linear ✓

**Summary:**
- 📅 Schedule: {{meeting_count}} meetings, {{free_hours}} hrs free
- 📚 Reading List: {{article_count}} articles
- 📊 Email Summaries: Azure ({{count}}), GitHub ({{count}})
- 🔴 Urgent: {{count}} items added
- 🟡 Important: {{count}} items added
- 📋 Inbox: {{count}} items added
- 📊 Work Log: {{count}} updates

**Duplicates merged:** {{count}}
**Total new items:** {{count}}
```

### 8. Generate User Report

After successful update:

```markdown
✅ Daily note updated: [[YYYY-MM-DD]]

**Schedule:**
- 📅 {{meeting_count}} meetings ({{meeting_hours}} hrs)
- 🟢 {{free_hours}} hrs free time
- ⏰ {{focus_block_count}} focus blocks scheduled

**Reading List:**
- 📚 {{article_count}} articles added

**Email Processing:**
- 📊 Azure: {{alert_count}} alerts summarized
- 📊 GitHub: {{github_count}} notifications summarized
- 🧹 {{cleanup_count}} emails cleaned up

**Tasks Added:**
- 🔴 URGENT: {{count}} tasks
- 🟡 IMPORTANT: {{count}} tasks
- 📋 INBOX: {{count}} items
- 📊 WORK LOG: {{count}} updates

**Duplicates merged:** {{count}}
**Total new items:** {{count}}

📂 Daily note: {{daily_note_path}}

**Next steps:**
1. Open daily note in Obsidian
2. Review URGENT section first ({{urgent_count}} items)
3. Pick top 3 priorities for "Today's Focus"
4. Check schedule for meeting prep needs
5. Start with highest priority task
```

---

## Safety Rules

**CRITICAL SAFETY PROTOCOLS:**
- **NEVER overwrite** existing daily note content
- **ALWAYS use `Edit` tool** (not `Write`) for existing notes
- **ALWAYS preserve** user's manual entries
- **If unsure about placement**, default to INBOX (safest)
- **If daily note structure differs**, ask user before modifying
- **Create backup** if making major changes (copy to Quick Captures first)
- **Ask for confirmation** before writing to vault

---

## Error Handling

### Daily Note Doesn't Exist
1. Check template exists at expected location
2. If template found, create new daily note
3. If template not found:
   - Alert user: "Template not found at expected location"
   - Offer: Create basic note, specify template, or skip consolidation

### Section Not Found in Daily Note
For new sections (Schedule, Reading List, Email Summaries):
- Insert section in proper order relative to existing sections
- Follow the order defined above

For core sections (URGENT, IMPORTANT, etc.):
- **Option 1**: Add new section header and insert tasks
- **Option 2**: Ask user where to place tasks
- **Option 3**: Add to INBOX section as fallback

### Edit Conflict
- If daily note was modified during processing:
  - Re-read daily note
  - Merge changes carefully
  - Inform user: "Daily note updated during processing. Merging..."

### File Permission Error
- Check if Obsidian has file locked
- Ask user to close daily note in Obsidian if open
- If still failing, save to Quick Captures as backup

---

## Section Order in Daily Note

When inserting new sections, maintain this order:

```
## 🎯 Today's Focus
## 📥 INBOX - Capture Throughout Day
## 📅 TODAY'S SCHEDULE          ← NEW
## 📚 READING LIST              ← NEW
## 📊 EMAIL SUMMARIES           ← NEW
## 🔴 URGENT (Do First)
## 🟡 IMPORTANT (Scheduled Time)
## 🟢 ROUTINE (Filler Time)
## ⏰ Time Blocks
## 📊 WORK LOG
## 🤝 MEETINGS & COMMUNICATIONS
## 🧠 NOTES & LEARNING
## 💭 REFLECTION (End of Day)
## 🔗 LINKS
## 🤖 AUTOMATED REVIEW          ← Always at end
```

---

## Integration Points

### Provider-Specific Features

**Obsidian:**
- **WikiLinks**: Use `[[YYYY-MM-DD]]` format for daily note references
- **Tags**: Add tags like #urgent, #waiting-for, #follow-up
- **Backlinks**: Create links to project notes, people notes
- **Dataview**: Structure for query compatibility

**Notion:**
- **Database Properties**: Update Status, Tags, Urgent Count
- **Links**: Use `[Page Title](notion://...)` format
- **Mentions**: Link to @people and pages

**Logseq:**
- **Block References**: Use `((block-uid))` for references
- **Page Links**: Use `[[page-name]]` format
- **Properties**: Add block properties for metadata

**Roam Research:**
- **Page References**: Use `[[page-name]]` format
- **Block References**: Use `((block-uid))`
- **Attributes**: Use `attribute:: value` format

**Plain Markdown:**
- **Links**: Use standard `[text](path)` format
- **Cross-references**: Use relative paths `./YYYY-MM-DD.md`

### Fallback Behavior
- If consolidation fails, save to provider's designated inbox/capture location
- User can manually process later
- Include full report in fallback location

---

## Testing Checklist

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
- [ ] Handles Obsidian provider correctly
- [ ] Handles Notion provider correctly
- [ ] Handles Logseq provider correctly
- [ ] Handles Roam provider correctly
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
