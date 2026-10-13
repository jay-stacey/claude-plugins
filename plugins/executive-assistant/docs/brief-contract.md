# Morning brief data contract

The morning brief runs three helper agents in parallel and merges what they
return. Each helper writes its spoken summary first (following the
`response-style` skill), then one fenced `json` block with the report below.
The parent reads only the JSON block for merging; the text is what a person
would say.

All times are local, `HH:MM`. All dates are `YYYY-MM-DD`. Gmail links are
`https://mail.google.com/mail/u/0/#all/<threadId>`. A field with nothing in it
is an empty list, never left out.

## EmailReport (email-assistant)

```json
{
  "unread_before": 200,
  "processed": 200,
  "unread_after": 3,
  "inbox_after": 3,
  "auto": {
    "trash": 142, "archive": 39, "label": 3, "support": 2,
    "by_rule": [{"rule": "Tech newsletters", "action": "trash", "count": 61}]
  },
  "needs_you": [
    {"from": "Sender name", "subject": "...", "summary": "one sentence",
     "ask": "reply | review | pay | decide | read", "due": "2026-10-14",
     "url": "https://mail.google.com/mail/u/0/#all/<threadId>", "thread_id": "..."}
  ],
  "pending_confirm": [
    {"group_id": "c1", "rule": "Cold sales", "action": "trash", "count": 4,
     "samples": ["subject one", "subject two"], "message_ids": ["..."]}
  ],
  "rule_suggestions": [
    {"line": "- trash | auto | Vendor webinars | from:vendor.example subject:webinar",
     "why": "6 this week, all trashed after a yes"}
  ],
  "filter_offers": [{"rule": "Tech newsletters", "query": "...", "runs": 7, "matched": 412}],
  "commitments": [
    {"text": "Send QA the UAT link", "said": "short quote of the sent line",
     "when": "2026-10-12", "due": "2026-10-13", "url": "..."}
  ],
  "placeholders": ["<ceo-address>"],
  "errors": []
}
```

- `needs_you` leaves out threads where the user already sent the last message.
- `pending_confirm` groups wait for one yes. `message_ids` lets the parent act
  on the yes without searching again.
- `unread_after` and `inbox_after` are read back from Gmail after acting.

## CalendarReport (calendar-assistant, review)

```json
{
  "range": {"start": "2026-10-13", "end": "2026-10-19"},
  "days": [
    {"date": "2026-10-13", "weekday": "Tue", "meeting_hours": 2.0, "focus_hours": 3.3,
     "events": [
       {"id": "...", "start": "10:00", "end": "10:30", "title": "Support queue review",
        "kind": "meet | focus | personal | allday", "response": "accepted | tentative | needsAction",
        "attendees": 3, "ours": false, "link": "https://..."}
     ],
     "free_blocks": [{"start": "11:00", "end": "11:30", "minutes": 30, "window": "deep | collab | admin"}]}
  ],
  "flags": [
    {"date": "2026-10-14", "kind": "heavy_day | prep_needed | back_to_back | double_booked | train_collision | no_lunch | unanswered_invite",
     "text": "one sentence", "event_id": "..."}
  ],
  "prep_tasks": [
    {"title": "Prep three points for the strategy review", "due": "2026-10-13",
     "estimate": "20m", "first_step": "Open last week's notes and copy the open items.",
     "source": "calendar:<event_id>"}
  ],
  "week_summary": "Two or three plain sentences about the next five workdays."
}
```

- Only events the user owns or attends are listed (organizer is the user, or
  the user is an attendee who has not declined). Team calendars are skipped.
- `ours` is true for events the assistant created. Those carry the
  `[Focus]` title prefix and the marker `ea:focus` on the first line of the
  description. Only `ours` events may ever be moved or deleted by the
  assistant.

## Timebox (calendar-assistant, plan and book)

Input from the parent:

```json
{
  "date": "2026-10-13",
  "speed": 1.6,
  "tasks": [{"id": "t-0102", "title": "...", "estimate_min": 20, "priority": "high",
             "due": "2026-10-13", "kind": "deep | shallow | admin"}],
  "free_blocks": [{"start": "11:00", "end": "11:30", "minutes": 30, "window": "deep"}],
  "mode": "propose | book | shift"
}
```

Output:

```json
{
  "blocks": [
    {"start": "07:00", "end": "09:00", "title": "[Focus] Deep work: CSV export review, release notes",
     "task_ids": ["t-0101", "t-0103"], "status": "proposed | created | moved | failed",
     "event_id": "...", "reason": "only for failed"}
  ],
  "unplaced": [{"id": "t-0108", "why": "needs 90m, largest free block is 45m"}],
  "verified": true
}
```

- Blocks group tasks by kind of work, not one block per task.
- Each task takes `estimate_min * speed`, rounded up to 5 minutes.
- `book` creates events, then lists the day again and marks each block
  `created` or `failed`. `verified` is true only after that read-back.
- `shift` moves only `ours` events, and only later in the same day.

## Brief file (written by the parent)

`{vault}/.assistant/brief/<date>.json`, saved with `tasks.py brief-save`. The
dashboard reads it.

```json
{
  "date": "2026-10-13",
  "generated_at": "2026-10-13T06:04",
  "mode": "normal | catch-up | prepare",
  "email": { "EmailReport": "as above" },
  "calendar": { "CalendarReport": "as above" },
  "elsewhere": [{"source": "linear | slack | jira | github", "title": "...", "url": "...", "why": "..."}],
  "followups": [{"text": "...", "why": "...", "url": "..."}],
  "plan": {"now": "t-0101", "today": ["t-0102"], "blocks": []},
  "pending": [{"kind": "email_confirm | blocks | rule | filter | placeholder", "summary": "...", "ref": "c1"}],
  "first_step": "From last night's shutdown, if any.",
  "week_summary": "..."
}
```

`pending` lists every decision still waiting for the user, so an unattended
6 AM run can leave its gates for later.
