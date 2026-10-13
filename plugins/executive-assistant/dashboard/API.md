# Day Desk API

Day Desk is the local dashboard. `dashboard/server.py` (Python standard
library only) serves the page and this JSON API on `127.0.0.1` only.

## Files

| File | Owner | Job |
|---|---|---|
| `server.py` | core | HTTP server, auth, tasks, notes, state, schedule, shutdown, static files, start/stop |
| `chat.py` | chat | Runs `claude -p` for the chat panel and for schedule refresh; streams events |
| `nudges.py` | nudges | Decides which reminders are due; sends Windows toasts |
| `static/index.html`, `static/app.css`, `static/app.js` | page | The page. No build step, no framework. |

`/static/editor.bundle.js` is served from
`skills/notes-viewer/assets/editor.bundle.js` (global `NotesEditor`, see
`createEditor({parent, doc, readOnly, live, onChange, onOpenLink, onOpenWiki,
resolveWiki})` returning `{getDoc, setDoc, setLive, setReadOnly, run, focus,
destroy}`).

## Security

- Listens on `127.0.0.1` only.
- The page URL is `http://127.0.0.1:<port>/#<token>`. The page reads the token
  from `location.hash` and sends it on every API call as header
  `X-Day-Desk-Token`. A missing or wrong token gets `403`.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, else
  `403`. This blocks DNS rebinding.
- A request with an `Origin` header must come from the same origin, else
  `403`. No CORS headers are ever sent.
- Static files need no token; they hold no user data.
- Note paths: relative, `.md` only, no `..`, no hidden folder, inside the
  vault, never under `tasks/` or `.assistant/`. Bad paths get `400`.

## Errors

Every error is `{"error": "plain sentence"}` with a status code. Task tool
exit codes map as: 2 → `400`, 3 → `409` (body also has `sha`), 4 → `422`
(a list limit), 5 → `404`.

## Endpoints

All bodies are JSON. Times are local `HH:MM`, dates `YYYY-MM-DD`.

### State

`GET /api/state` → the page polls this every 20 seconds.

```json
{
  "now": "2026-10-13T09:48",
  "context": "tasks.py context output",
  "focus": {"running": true, "session": {"task": "t-0101", "title": "...", "started_at": "...", "minutes": 25, "ends_at": "2026-10-13T10:13", "remaining_min": 25, "over": false}},
  "profile": {"start": "06:30", "stop": "15:00", "deep": ["06:30", "11:30"], "admin_after": "13:30", "shutdown_reminder_min": 30},
  "schedule": "same as GET /api/schedule",
  "brief": {"date": "...", "generated_at": "...", "mode": "...", "email": {}, "elsewhere": [], "followups": [], "pending": [], "week_summary": "..."},
  "nudges": [{"id": "meeting_10:evt123", "kind": "meeting_10", "title": "Heads-up", "text": "Support queue review starts in 10 minutes.", "at": "09:50"}],
  "chat": {"busy": false, "session_id": "..."}
}
```

`brief` is today's brief or `null`. `context.stats` holds points, streak and
speed.

### Tasks

| Method and path | Body | Result |
|---|---|---|
| `GET /api/tasks?lists=now,today,week,later,done` | | `tasks.py list` output. `done` holds the last 7 days only. |
| `POST /api/tasks` | `{"parse": "call bank fri 15m !high"}` or fields: `title, list, priority, due, estimate, first_step, next_step, source, tags[], notes` | `{"task": {...}, "note": "..."}` |
| `GET /api/tasks/<id>` | | `{"task": {... "body": "..."}}` |
| `PATCH /api/tasks/<id>` | any fields above, `body`, `if_sha` | `{"task": {...}}`, or `409` with `sha` |
| `POST /api/tasks/<id>/move` | `{"list": "now"}` | `{"task", "demoted"}`, or `422` |
| `POST /api/tasks/<id>/done` | `{"actual": "50m"}` optional | `{"task", "points", "suggest_now"}` |
| `POST /api/tasks/<id>/drop` | | `{"task"}` |
| `POST /api/tasks/<id>/park` | `{"next": "rerun the test"}` | `{"task"}`, or `422` |
| `POST /api/tasks/<id>/resume` | | `{"task", "demoted"}` |
| `GET /api/parse?text=...` | | quick-add preview |

### Focus

| Method and path | Body | Result |
|---|---|---|
| `POST /api/focus/start` | `{"id": "t-0101", "minutes": 25}` | `{"session", "demoted"}`, or `422` when one runs |
| `POST /api/focus/end` | `{"result": "done|more|stuck|stopped", "minutes": 20, "more": 15}` | `tasks.py focus-end` output |

### Schedule

`GET /api/schedule` →

```json
{
  "source": "refresh | brief | none",
  "as_of": "2026-10-13T06:04",
  "refreshing": false,
  "date": "2026-10-13",
  "events": [{"id": "...", "start": "10:00", "end": "10:30", "title": "...", "kind": "meet|focus|personal|allday", "attendees": 3, "ours": false, "link": "..."}],
  "days": "CalendarReport days for up to 5 workdays",
  "flags": [],
  "week_summary": "..."
}
```

Today's events come from the newest of `.assistant/schedule/<date>.json`
(written by a refresh) and today's brief. `days` comes from the brief.

`POST /api/schedule/refresh` → `{"started": true}`. Runs in the background
through `chat.py` (a headless Claude call that asks the calendar-assistant for
today and saves it with `tasks.py schedule-save`). `GET /api/state` shows
`schedule.refreshing` until it ends.

### Notes

| Method and path | Body | Result |
|---|---|---|
| `GET /api/notes?q=&limit=200` | | `{"notes": [{"path", "title", "updated", "tags": [], "size"}]}`, newest first. Daily notes and all folders except `tasks/` and hidden ones. |
| `GET /api/notes/file?path=projects/a.md` | | `{"path", "content", "sha"}` |
| `PUT /api/notes/file` | `{"path", "content", "base_sha"}`; `base_sha: null` creates a new note and fails with `409` if it exists | `{"path", "sha"}`, or `409` with the disk `sha` when the file changed since `base_sha` |

### Shutdown

`POST /api/shutdown` with the shutdown JSON from the shutdown skill
(`done`, `moved`, `finish_today`, `brain_dump`, `first_step`, `first_task`,
`tonight`). The server marks `done` ids done, applies `moved`, saves with
`tasks.py shutdown-save`, runs `archive --days 7`, and appends a `## Shutdown`
section to today's daily note. → `{"saved": "...", "points": 3, "stats": {...}}`

### Chat

`POST /api/chat` with `{"message": "...", "new": false}` → a streamed body of
newline-delimited JSON (`application/x-ndjson`), one event per line:

```json
{"type": "start", "session_id": "..."}
{"type": "tool", "name": "mcp__...__get_events", "label": "Reading your calendar"}
{"type": "text", "delta": "Your Now task is "}
{"type": "done", "session_id": "...", "is_error": false}
{"type": "error", "text": "plain sentence"}
```

Only one chat runs at a time; a second request gets `409`.
`GET /api/chat/history` → `{"session_id", "messages": [{"role": "user|assistant", "text", "at"}]}` (last 50).
`POST /api/chat/reset` → starts a new conversation next time.

### Nudges

`POST /api/nudges/<id>/dismiss` → `{}`. Nudges also go out as Windows toasts
unless the server runs with `--no-toast`.

## Start and stop

```bash
python dashboard/server.py start [--port 0] [--no-toast] [--no-open] [--dev]
python dashboard/server.py status
python dashboard/server.py stop
python dashboard/server.py serve ...      # foreground, used by start and by tests
```

`start` runs `serve` as a detached process and writes
`{vault}/.assistant/dashboard.json` (`port`, `pid`, `url`, `started_at`; the
token lives only in the URL there). `--dev` makes chat load this plugin folder
with `--plugin-dir`, for testing a branch that is not installed.
