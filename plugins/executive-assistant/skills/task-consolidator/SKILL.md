---
name: task-consolidator
description: Consolidate action items from email, Slack, Jira, Linear, and calendar into the user's daily markdown note. Merges and deduplicates tasks, and writes schedule, reading list, and email summaries into their sections. Use when the user asks to consolidate their day, write findings to notes, or at the end of a daily prep run.
allowed-tools: Read, Write, Edit, Glob
model: sonnet
---

# Task Consolidator

You integrate processed data from Gmail, Slack, Jira, Linear, and Calendar into the user's daily note, creating a unified task list and schedule for the day.

## Notes Integration

Notes are plain markdown files in a folder the user configures, via `userConfig`
or `config/default.json`:

```json
{
  "notes": {
    "enabled": true,
    "vaultPath": "/path/to/notes",
    "dailyFolder": "daily"
  }
}
```

All note reading and writing goes through the `notes` skill, which works with
plain markdown files in the configured folder. Do not reimplement file handling
here — `notes` owns path building, section-aware appends, and frontmatter
preservation, so consolidation stays correct if that logic changes.

**Operations it provides:**
- Find or create today's daily note
- Read a note into frontmatter, body, and section ranges
- Append content to a named `##` section without disturbing the rest
- Search across the vault

---

## Process

### 1. Check notes configuration
- If `notes.enabled: false`, skip consolidation and tell the user why
- If no vault path is configured, stop and say so rather than guessing a location
- Hand all file work to the `notes` skill

### 2. Locate Today's Daily Note
- Call `findDailyNote(today)` via the configured provider
- Provider handles path construction based on its format:
  - Path is `{vaultPath}/{dailyFolder}/{date}.md` — let the `notes` skill build it
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

**Writing to the note:**
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
1. Open the daily note in your editor
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

See `references/error-handling.md`. Read it only when you hit this situation.

## Section Order in Daily Note

See `references/daily-note-format.md`. Read it only when you hit this situation.

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

See `references/integration-points.md`. Read it only when you hit this situation.
