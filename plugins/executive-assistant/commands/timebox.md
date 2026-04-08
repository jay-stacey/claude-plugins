---
name: timebox
description: Intelligent calendar timeboxing - analyze schedule, timebox daily todos, schedule recurring strategic sessions, detect bottlenecks, and optimize calendar for maximum productivity.
---

# Timebox Command

This command uses advanced calendar analysis to optimize your schedule by intelligently timeboxing todos, ensuring strategic work gets scheduled, and identifying scheduling problems before they impact productivity.

## Usage

### Basic Usage
```
/timebox
```

Complete calendar optimization workflow:
1. Analyzes today's calendar and free time
2. Extracts todos from Obsidian daily note
3. Intelligently matches todos to optimal time slots
4. Checks for missing recurring strategic blocks (Security, DevSecOps, etc.)
5. Detects scheduling bottlenecks (overcommitment, meeting fatigue)
6. Provides actionable recommendations
7. Creates approved focus blocks and strategic sessions

**Duration**: 2-4 minutes

### With Options
```
/timebox [options]
```

## Available Options

### Scope
- `--today-only` - Only timebox today's todos (skip strategic blocks)
  - Example: `/timebox --today-only`
  - Use when: Quick daily timeboxing without long-term planning

- `--strategic-only` - Only schedule recurring strategic blocks (skip daily todos)
  - Example: `/timebox --strategic-only`
  - Use when: Monthly/quarterly planning session

- `--analyze-only` - Show bottleneck analysis without scheduling
  - Example: `/timebox --analyze-only`
  - Use when: Want to review schedule health without changes

### Time Period
- `--this-week` - Analyze and timebox for entire week
  - Example: `/timebox --this-week`
  - Use when: Weekly planning session (Sunday/Monday)

- `--this-month` - Analyze month and schedule all strategic blocks
  - Example: `/timebox --this-month`
  - Use when: Monthly planning (beginning of month)

- `--next-month` - Plan ahead for next month
  - Example: `/timebox --next-month`
  - Use when: Proactive planning (end of current month)

### Behavior
- `--auto-approve-focus` - Automatically create focus blocks without confirmation
  - Example: `/timebox --auto-approve-focus`
  - Warning: Creates events immediately

- `--auto-approve-strategic` - Automatically schedule strategic blocks
  - Example: `/timebox --auto-approve-strategic`
  - Warning: Creates recurring events

- `--dry-run` - Show analysis and plan without creating events
  - Example: `/timebox --dry-run`
  - Use when: Reviewing recommendations first

- `--force-schedule` - Override bottleneck warnings and schedule anyway
  - Example: `/timebox --force-schedule`
  - Use when: You know your schedule is tight but need to fit everything

### Filters
- `--min-block=N` - Only use free blocks of at least N minutes
  - Example: `/timebox --min-block=60` (only 60+ min blocks)
  - Use when: Want to avoid fragmenting schedule

- `--max-utilization=N` - Set maximum schedule utilization (0-100)
  - Example: `/timebox --max-utilization=70` (max 70% scheduled)
  - Use when: Want lighter schedule

- `--priority=urgent` - Only schedule urgent todos
  - Example: `/timebox --priority=urgent`
  - Use when: Overcommitted, focus on critical items only

## Common Usage Examples

### Standard Daily Timeboxing
```
/timebox
```
Full analysis + daily todos + strategic blocks + recommendations

### Quick Morning Timebox
```
/timebox --today-only
```
Just schedule today's todos without long-term planning

### Weekly Planning Session
```
/timebox --this-week
```
Analyze week, schedule todos for upcoming days, ensure strategic blocks

### Monthly Strategic Planning
```
/timebox --this-month --strategic-only
```
Schedule Security Audits, DevSecOps, Process Improvement for the month

### Schedule Health Check
```
/timebox --analyze-only
```
Review bottlenecks and get recommendations without making changes

### Preview Timeboxing
```
/timebox --dry-run
```
See full plan without creating any calendar events

### Conservative Scheduling
```
/timebox --max-utilization=65 --min-block=45
```
Lighter schedule with only substantial focus blocks

### Emergency Overload Mode
```
/timebox --priority=urgent --force-schedule
```
Tight schedule but must fit urgent items

## What Happens When You Run It

### Step 1: Calendar Analysis (30 seconds)
- Queries Google Calendar via MCP tools
- Extracts today's meetings
- Calculates free time blocks
- Identifies energy patterns (morning deep work, etc.)
- Reports schedule overview

```
📅 Today's Schedule:
- 4 meetings (3.5 hrs)
- 6.5 hrs free time
- 3 quality focus blocks identified
```

### Step 2: Bottleneck Detection (15 seconds)
- Calculates schedule utilization
- Detects back-to-back meetings
- Checks for sufficient deep work time
- Identifies schedule fragmentation
- Reports issues with severity

```
🚨 Bottlenecks Detected: 2

1. ⚠️ Back-to-Back Meetings (3 hrs)
   9:00 AM - 12:00 PM: No breaks
   Impact: Meeting fatigue, reduced focus

2. 🔴 Insufficient Deep Work (1 hr)
   Available: 1 hr | Needed: 2+ hrs
   Impact: Complex tasks won't fit
```

### Step 3: Daily Timeboxing (30 seconds)
- Reads todos from Obsidian daily note
- Extracts from "Today's Focus", "URGENT", "IMPORTANT" sections
- Estimates durations for each todo
- Matches todos to optimal free blocks
- Respects priorities and energy patterns
- Presents timeboxing plan

```
⏰ Daily Timeboxing Plan:

| Time | Task | Priority | Fit |
|------|------|----------|-----|
| 8:00-9:30 AM | DMS-2166 API | 🔴 Urgent | ✅ Perfect (morning) |
| 1:00-1:45 PM | PR review | 🟡 Important | ✅ Good |
| 3:00-4:30 PM | Dashboard | 🟡 Important | ✅ Perfect |

Create these 3 focus blocks? (yes/no)
```

### Step 4: Strategic Blocks Check (20 seconds)
- Loads recurring block templates from config
- Checks for missing blocks this month
- Checks for missing blocks next month
- Finds optimal slots for each
- Presents recommended schedule

```
📅 Recurring Strategic Blocks:

Missing This Month:
- Security Audit (120 min) - Due Jan 15
- Process Improvement (90 min) - Due Feb 1

Recommended Slots:
- Security: Wed Jan 15, 9-11 AM ⭐
- Process: Mon Feb 3, 2-3:30 PM ⭐

Schedule these blocks? (yes/no)
```

### Step 5: Recommendations (15 seconds)
- Analyzes detected bottlenecks
- Generates specific actionable recommendations
- Prioritizes by impact
- Shows before/after comparison

```
💡 Recommendations:

High Priority:
1. 🔴 Decline 2 PM Design Sync (reduces overcommitment)
2. 🔴 Schedule Security Audit (overdue)

Medium Priority:
3. 🟡 Add buffer after standup (prevents fatigue)
4. 🟡 Block Friday PM for Prof Dev (recurring)

Expected Impact:
- Schedule: 85% → 70% ✅
- Deep work: 1 hr → 2.5 hrs ✅
- Strategic blocks: 0/3 → 3/3 ✅
```

### Step 6: Event Creation (30-60 seconds)
- After user approval, creates calendar events via MCP tools
- For each focus block:
  - Creates event with `manage_event` (action: create, summary: "[Focus] Task Name", start, end)
  - Or uses `manage_focus_time` for native focus block support
  - Adds description with priority and source link
  - Sets as "Busy" to protect time
- For each strategic block:
  - Creates with recurrence pattern via `manage_event` with recurrence parameter
  - Uses template color and description
- Reports success/failures

```
✅ Focus Blocks Created: 3
✅ Strategic Blocks Created: 2

View calendar: [Google Calendar](link)
```

### Step 7: Summary (10 seconds)
- Reports all actions taken
- Shows updated schedule metrics
- Lists next steps
- Provides calendar link

```
✅ Timeboxing Complete!

Actions Taken:
- Created 3 focus blocks for today
- Scheduled 2 strategic sessions
- Identified 4 optimization opportunities

Next Steps:
1. Review focus blocks in calendar
2. Decline overcommitment meeting
3. Add standup buffer starting tomorrow

Your calendar is optimized! 🎯
```

**Total Duration**: 2-4 minutes

## Expected Output

```
🎯 CALENDAR TIMEBOXING WORKFLOW

Analyzing your schedule and optimizing for productivity...

---

📅 CALENDAR ANALYSIS

Today's Schedule:
- 📊 4 meetings (3.5 hrs)
- 🟢 6.5 hrs free time
- 🔋 2 hrs morning deep work
- 📋 4.5 hrs afternoon focus

---

🚨 BOTTLENECKS DETECTED: 2

1. ⚠️ Back-to-Back Meetings (3 hours)
   Time: 9:00 AM - 12:00 PM
   Impact: Meeting fatigue, no breaks
   Recommendation: Add 15-min buffer after 11 AM

2. 🔴 Insufficient Deep Work (1 hour available)
   Needed: 2+ hours for complex tasks
   Impact: DMS-2166 (90 min) won't fit
   Recommendation: Protect 8-10 AM slot

---

⏰ DAILY TIMEBOXING PLAN

Todos from Obsidian: 5
Scheduled: 3 (4.5 hrs, 69% utilization)

| Time | Task | Priority | Energy Fit |
|------|------|----------|------------|
| 8:00-9:30 AM | DMS-2166 User Corrections API | 🔴 Urgent | ✅ Perfect |
| 1:00-1:45 PM | Code review PR #721 | 🟡 Important | ✅ Good |
| 3:00-4:30 PM | DMS-2350 Admin Dashboard | 🟡 Important | ✅ Perfect |

Not scheduled (insufficient time):
- DMS-2399 Mobile Integration (180 min)
  → Suggestion: Schedule for tomorrow

Create these 3 focus blocks? (yes/no): yes

✅ Created [Focus] DMS-2166 User Corrections API (8:00-9:30 AM)
✅ Created [Focus] Code review PR #721 (1:00-1:45 PM)
✅ Created [Focus] DMS-2350 Admin Dashboard (3:00-4:30 PM)

---

📅 RECURRING STRATEGIC BLOCKS

Missing This Month: 2
Missing Next Month: 1

1. Security Audit (120 min) - Due Jan 15
   Recommended: Wed Jan 15, 9-11 AM ⭐

2. Process Improvement (90 min) - Due Feb 1
   Recommended: Mon Feb 3, 2-3:30 PM ⭐

3. Professional Development (60 min) - Fridays
   Recommended: Every Fri, 3-4 PM (recurring) ⭐

Schedule these strategic blocks? (yes/no): yes

✅ Created [Strategic] Security Audit (Jan 15, 9-11 AM, monthly recurrence)
✅ Created [Strategic] Process Improvement (Feb 3, 2-3:30 PM)
✅ Created [Strategic] Professional Development (Fridays 3-4 PM, weekly recurrence)

---

💡 OPTIMIZATION RECOMMENDATIONS

High Priority:
1. 🔴 Schedule Security Audit ASAP - ✅ DONE
2. 🔴 Decline 2 PM Design Sync - Reduces schedule from 85% → 75%

Medium Priority:
3. 🟡 Add 15-min buffer after standup - Prevents meeting fatigue
4. 🟡 Block Fri 3-4 PM for Prof Dev - ✅ DONE

Low Priority:
5. 🟢 Implement "No Meeting Fridays" policy
6. 🟢 Async standup experiment

---

📊 BEFORE vs AFTER

Before Timeboxing:
- Schedule: 60% (meetings only)
- Deep work: 1 hr/day
- Strategic blocks: 0/3 scheduled

After Timeboxing:
- Schedule: 75% ✅ (meetings + focus blocks)
- Deep work: 2.5 hrs/day ✅
- Strategic blocks: 3/3 ✅

---

✅ TIMEBOXING COMPLETE!

Created Events:
- 3 focus blocks for today's todos
- 3 strategic session blocks
- Total: 6 calendar events created

Next Steps:
1. View your optimized calendar: [Google Calendar](link)
2. Review focus blocks before each session
3. Decline 2 PM Design Sync to reduce overcommitment
4. Add buffer after tomorrow's standup

Your calendar is optimized for productivity! 🎯
```

## Integration with /daily-prep

The `/daily-prep` command now includes intelligent timeboxing:
- Calendar analysis happens early in workflow
- Timeboxing occurs after todos are collected from all sources
- Results included in Obsidian daily note

**When to use /timebox separately:**
- Mid-day schedule adjustment
- Weekly/monthly planning sessions
- Focus only on calendar optimization
- After adding new todos to daily note

## Troubleshooting

### Calendar Doesn't Load
**Problem**: Google Workspace MCP can't access Google Calendar

**Solutions**:
- Check MCP server status: `/mcp`
- Verify Google Workspace MCP server is connected
- Check OAuth credentials are configured
- Try: `/timebox --analyze-only` (text-based analysis)

### Todos Not Found
**Problem**: Can't extract todos from Obsidian

**Solutions**:
- Verify daily note exists: `10-DAILY/YYYY-MM-DD.md`
- Check note has "URGENT" or "IMPORTANT" sections
- Manually specify priorities when prompted
- Use: `/timebox --today-only` and provide manual list

### Event Creation Fails
**Problem**: Calendar events not being created

**Solutions**:
- Check MCP server status: `/mcp`
- Verify Google Workspace MCP server is connected and authenticated
- Verify not in read-only calendar
- Create events manually using provided times
- Try: `/timebox --dry-run` for manual planning

### Bottleneck False Positives
**Problem**: Detected bottlenecks aren't real issues

**Solutions**:
- Review thresholds in `.config.json`
- Adjust `bottleneckThresholds` values
- Use: `--force-schedule` to override warnings
- Provide feedback for threshold tuning

### Overcommitment Warnings
**Problem**: System won't schedule due to overcommitment

**Solutions**:
- Use: `--force-schedule` to override
- Use: `--priority=urgent` to only schedule critical
- Use: `--max-utilization=85` to allow tighter packing
- Decline optional meetings first

### Strategic Blocks Wrong Dates
**Problem**: Recurring blocks scheduled on wrong days

**Solutions**:
- Check config `recurringBlocks` settings
- Verify `dayOfMonth` and `preferredDay` values
- Use: `--strategic-only` with `--dry-run` to preview
- Adjust dates manually then use templates

## Configuration

Timebox behavior controlled by `.config.json`:

```json
{
  "calendarManager": {
    "timeboxing": {
      "maxUtilization": 0.75,
      "bufferMinutes": 10,
      "preferredFocusTime": "morning"
    },
    "recurringBlocks": [
      {
        "name": "Security Audit",
        "frequency": "monthly",
        "dayOfMonth": 15,
        "duration": 120
      },
      {
        "name": "DevSecOps Review",
        "frequency": "quarterly",
        "duration": 180
      },
      {
        "name": "Process Improvement",
        "frequency": "monthly",
        "duration": 90
      },
      {
        "name": "Professional Development",
        "frequency": "weekly",
        "dayOfWeek": "Friday",
        "timeSlot": "3:00 PM",
        "duration": 60
      }
    ]
  }
}
```

## Tips for Success

### Daily Usage
- Run first thing in morning (after `/daily-prep`)
- Review bottleneck warnings carefully
- Trust the intelligent timebox recommendations
- Adjust priorities if schedule too tight

### Weekly Planning
- Run `/timebox --this-week` on Sunday evening or Monday morning
- Review all strategic blocks for the week
- Ensure professional development time is blocked
- Adjust recurring patterns as needed

### Monthly Planning
- Run `/timebox --this-month --strategic-only` at month start
- Schedule all Security Audits, DevSecOps, Process Improvement
- Review quarterly blocks (Q1, Q2, Q3, Q4)
- Plan ahead for next month

### Optimization
- Pay attention to bottleneck patterns
- Implement high-priority recommendations
- Protect morning deep work time
- Block recurring focus time before others book it

### ADHD-Friendly
- Use timeboxing to externalize planning
- Trust the system's priorities
- Focus only on current time block
- Review bottlenecks weekly to prevent overwhelm

## Advanced Usage

### Custom Recurring Blocks
Add your own recurring sessions to config:

```json
{
  "name": "Team Building",
  "frequency": "monthly",
  "dayOfMonth": 10,
  "duration": 60,
  "description": "Monthly team social activity",
  "color": "blue"
}
```

### Protected Time Windows
Define times that should never have meetings:

```json
{
  "protectedTime": {
    "morningDeepWork": {
      "enabled": true,
      "days": ["Monday", "Wednesday", "Friday"],
      "timeRange": "8:00-10:00 AM"
    }
  }
}
```

### Custom Bottleneck Thresholds
Adjust sensitivity:

```json
{
  "bottleneckThresholds": {
    "overcommitment": 0.90,
    "minDeepWorkHours": 3,
    "backToBackMeetings": 3
  }
}
```

## Version History

**v1.0.0** - Initial Release
- Intelligent daily timeboxing
- Recurring strategic block scheduling
- Bottleneck detection and analysis
- Actionable optimization recommendations
- Integration with daily-prep workflow

---

**Ready to optimize your calendar?**

```
/timebox
```

Let's make every minute count! ⏰
