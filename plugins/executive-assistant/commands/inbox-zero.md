---
name: inbox-zero
description: Quick workflow to achieve Gmail inbox zero by processing, labeling, and archiving all emails. Focused exclusively on clearing inbox.
---

# Inbox Zero Command

This command runs a focused workflow to achieve Gmail inbox zero. Unlike the full `/daily-prep` workflow, this command focuses solely on processing your Gmail inbox.

## Usage

### Basic Usage
```
/inbox-zero
```

Runs the complete inbox zero workflow:
1. Opens Gmail
2. Scans all unread emails
3. Categorizes by priority (Urgent, Important, FYI)
4. Applies appropriate Gmail labels
5. Archives non-urgent emails
6. Stars urgent emails and keeps them in inbox
7. Reports inbox zero status

**Duration**: 2-3 minutes for typical inbox (50-100 emails)

### With Options
```
/inbox-zero [options]
```

## Available Options

### Scan Mode
- `--all` - Process all inbox emails (not just unread)
  - Example: `/inbox-zero --all`
  - Use when: You have read emails still sitting in inbox

- `--unread-only` - Process only unread emails (default)
  - Example: `/inbox-zero --unread-only`

### Processing Options
- `--skip-newsletters` - Skip TLDR newsletter processing
  - Example: `/inbox-zero --skip-newsletters`
  - Use when: No newsletters or already processed

- `--skip-cleanup` - Skip email cleanup phase
  - Example: `/inbox-zero --skip-cleanup`
  - Use when: You want to handle cleanup manually

- `--quick` - Skip newsletters and cleanup, just categorize and organize
  - Example: `/inbox-zero --quick`
  - Use when: Need fastest processing

### Label Options
- `--skip-labeling` - Categorize but don't apply Gmail labels
  - Example: `/inbox-zero --skip-labeling`
  - Use when: Testing or want manual labeling

- `--labels-only` - Only apply labels, don't archive
  - Example: `/inbox-zero --labels-only`
  - Use when: Want to review before archiving

### Behavior
- `--dry-run` - Show what would happen without making changes
  - Example: `/inbox-zero --dry-run`
  - Use when: Testing or previewing actions

- `--auto-approve` - Skip confirmation prompts (use carefully!)
  - Example: `/inbox-zero --auto-approve`
  - Warning: Will process without asking

## Common Usage Examples

### Standard Inbox Zero
```
/inbox-zero
```
Full workflow: Process unread, categorize, label, archive. Achieve inbox zero.

### Quick Morning Clear
```
/inbox-zero --quick
```
Fast processing: Skip newsletters and cleanup, just organize inbox.

### Process Everything in Inbox
```
/inbox-zero --all
```
Process all inbox emails, not just unread. Good for catching up.

### Preview Before Processing
```
/inbox-zero --dry-run
```
See what would happen without making any changes.

### Label Without Archiving
```
/inbox-zero --labels-only
```
Apply labels but keep emails in inbox for manual review before archiving.

### Skip Newsletters
```
/inbox-zero --skip-newsletters
```
Full workflow but skip TLDR article extraction.

## What Happens When You Run It

### Step 1: Introduction (5 seconds)
- Welcome message
- Explains what will happen
- Shows expected duration

### Step 2: Gmail Scan (30-60 seconds)
- Opens Gmail in browser
- Scans inbox for unread (or all) emails
- Extracts: Sender, Subject, Preview, Timestamp
- Reports: "Found 47 emails to process"

### Step 3: Newsletter Processing (Optional, 15-30 seconds)
- Unless `--skip-newsletters` specified
- Detects TLDR newsletters
- Extracts articles
- Presents top 3 recommendations
- Records your decisions to memory

### Step 4: Email Cleanup (Optional, 30-45 seconds)
- Unless `--skip-cleanup` specified
- Categorizes bulk emails (Azure, GitHub, Marketing, etc.)
- Proposes batch actions (archive, delete, unsubscribe)
- Executes after approval
- Summarizes results

### Step 5: Email Categorization (30 seconds)
- Categorizes remaining emails:
  - 🔴 Urgent: Response needed today
  - 🟡 Important: Response needed this week
  - 📋 FYI: Read-only, no action
  - 🗑️ Junk: Suggested for deletion
- Shows category breakdown
- Asks for confirmation

### Step 6: Label Application (30-45 seconds)
- Unless `--skip-labeling` specified
- Creates Gmail labels if they don't exist:
  - Action/Urgent
  - Action/This Week
  - FYI/Read Later
  - Monitoring/Azure
  - Development/GitHub
  - Work/Jira
- Applies labels to categorized emails
- Reports: "Applied 47 labels across 6 categories"

### Step 7: Archive Processing (15-30 seconds)
- Unless `--labels-only` specified
- Archives non-urgent emails:
  - 🟡 Important → Archived with "Action/This Week" label
  - 📋 FYI → Archived with "FYI/Read Later" label
  - 📊 Monitoring → Archived with appropriate labels
- Keeps urgent emails in inbox (starred)
- Reports: "Archived 43 emails"

### Step 8: Inbox Zero Report (10 seconds)
- Verifies inbox state
- Reports results:
  - Total processed
  - Urgent items remaining in inbox
  - Archived count
  - Labels applied
  - Inbox zero status
- Provides label access links

**Total Duration**: 2-4 minutes depending on inbox size and options

## Expected Output

After running `/inbox-zero`, you'll see:

```
🎯 INBOX ZERO WORKFLOW

Let me help you achieve inbox zero by processing and organizing your Gmail inbox.

This will take about 2-3 minutes. Let's get started!

---

📧 SCANNING GMAIL INBOX...

✅ Found 47 unread emails to process

---

📰 PROCESSING NEWSLETTERS...

Found 2 TLDR newsletters (5 articles)
Recommended for you: 3 articles

[Shows recommendations]

---

🧹 EMAIL CLEANUP...

Proposing batch actions:
- 📊 Azure Alerts: 8 emails → Archive (with summary)
- 💻 GitHub: 5 emails → Archive (with summary)
- 🗑️ Marketing: 3 emails → Delete

Execute cleanup? (yes/no): yes

✅ Cleanup complete: 8 archived, 5 archived, 3 deleted

---

📋 CATEGORIZING EMAILS...

- 🔴 Urgent: 6 emails
- 🟡 Important: 15 emails
- 📋 FYI: 13 emails

---

🏷️ APPLYING LABELS...

Creating labels...
- ✅ Action/Urgent (exists)
- ✅ Action/This Week (exists)
- ✅ FYI/Read Later (created)

Applying labels to 47 emails... Done!

---

📥 ARCHIVING PROCESSED EMAILS...

- 🟡 Important: 15 emails → Archived with "Action/This Week"
- 📋 FYI: 13 emails → Archived with "FYI/Read Later"
- 📊 Monitoring: 13 emails → Archived with labels

---

✅ INBOX ZERO ACHIEVED!

**Results:**
- 📬 Total processed: 47 emails
- 🔴 Urgent (in inbox): 6 emails (starred)
- 📥 Archived: 41 emails
- 🏷️ Labels applied: 47
- ⭐ Starred: 6

**Current Inbox:**
- 📭 Inbox contains: 6 urgent emails (all starred)
- 🎯 Focus on these 6 starred items today

**Quick Access:**
- 🔴 View urgent: [Action/Urgent Label](link)
- 🟡 View this week: [Action/This Week Label](link)
- 📋 View FYI: [FYI/Read Later Label](link)

**Inbox Zero Status:** ✅ ACHIEVED

Ready to tackle your day!
```

## Next Steps After Running

1. **Review Inbox** - Check the 6 urgent starred emails
2. **Respond to Urgent** - Handle time-sensitive items first
3. **Plan This Week** - Review "Action/This Week" label for scheduling
4. **Read FYI Later** - Access "FYI/Read Later" when you have time

## Troubleshooting

### Gmail Doesn't Load
**Problem**: GWS CLI can't access Gmail

**Solutions**:
- Check GWS CLI auth: `gws auth login -s gmail`
- Verify installation: `gws --version`
- Test directly: `gws gmail +triage --max 1`
- Try: `/inbox-zero --skip-gmail` (manual fallback)

### Too Many Emails
**Problem**: 100+ unread emails taking too long

**Solutions**:
- Use: `/inbox-zero --quick` for faster processing
- Process in batches: Process 100, run again for next 100
- Use: `/inbox-zero --skip-newsletters --skip-cleanup`
- Consider time-based: Process last 24 hours first

### Labels Not Creating
**Problem**: Gmail labels not being created

**Solutions**:
- Check GWS CLI auth has Gmail scope: `gws auth login -s gmail`
- Test directly: `gws gmail users labels list`
- Manually create labels then re-run
- Use: `/inbox-zero --skip-labeling` as fallback

### Archiving Too Aggressive
**Problem**: Archived something you wanted to keep in inbox

**Solutions**:
- Search for email in Gmail (it's in All Mail)
- Click "Move to Inbox" button
- Next time use: `/inbox-zero --labels-only`
- Review urgent categorization rules in config

### Command Not Found
**Problem**: `/inbox-zero` command not recognized

**Solutions**:
- Verify executive-assistant plugin is installed
- Restart Claude Code to reload plugins
- Try running from plugin directory

## Configuration

Inbox zero behavior is controlled by `.config.json`:

```json
{
  "inboxZero": {
    "enabled": true,
    "scanMode": "unread",
    "processNewsletters": true,
    "runCleanup": true,
    "applyLabels": true,
    "archiveProcessed": true,
    "keepUrgentInInbox": true,
    "starUrgentEmails": true,
    "batchSize": 50,
    "requireApproval": true
  }
}
```

## Integration with /ea

The `/ea` command includes inbox zero as part of the full daily prep workflow. If you want to run inbox-zero separately during the day, use this command.

**When to use /inbox-zero vs /ea:**
- **Use /inbox-zero**: Mid-day inbox cleanup, quick inbox clear, focused email processing
- **Use /ea**: Morning routine, full workflow (email + Slack + Jira + calendar + planning)

## Tips for Success

### Daily Habit
- Run every morning after `/daily-prep`
- Run mid-day if inbox builds up
- Consistent processing prevents backlog

### Speed Optimization
- Use `--quick` for fastest processing
- Process smaller batches more frequently
- Skip options you don't need

### Trust the System
- Let the categorization work for you
- Don't obsess over perfect labeling
- Access archived emails via label views
- Focus on urgent starred items only

### ADHD-Friendly
- Quick wins: See inbox empty immediately
- Clear focus: Only starred items need attention
- Reduced overwhelm: Everything else organized and hidden
- Consistent routine: Same process every time

## Safety Notes

**What inbox-zero NEVER does:**
- Permanently delete emails (only moves to Trash)
- Modify email content
- Send responses
- Share emails
- Change account settings

**What inbox-zero ALWAYS does:**
- Ask for approval before batch actions
- Provide undo guidance
- Log all actions for audit
- Keep urgent items in inbox
- Preserve all email content

**Recovery:**
- Archived emails: Search and "Move to Inbox"
- Deleted emails: Gmail Trash (30-day recovery)
- Labels: Can be removed or modified anytime
- Stars: Can be toggled on/off

## Version History

**v1.0.0** - Initial Release
- Gmail scan and categorization
- Label creation and application
- Inbox zero workflow
- Integration with daily-prep
- ADHD-friendly design

---

**Ready to achieve inbox zero?**

```
/inbox-zero
```

Let's clear that inbox! 🚀
