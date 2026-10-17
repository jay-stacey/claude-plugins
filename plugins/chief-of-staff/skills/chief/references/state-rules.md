# Session states

The server reads three sources, read only. It never writes them.

1. `claude agents --json`, every 5 seconds while a console or the Chief is connected and every 20 seconds otherwise: which sessions have a running process, and whether each is `busy`, `idle` or `waiting` (with `waitingFor`, such as "permission prompt"). Background jobs report `working`, `blocked`, `done`, `failed` or `stopped`.
2. The desktop app's session files (`%APPDATA%\Claude\claude-code-sessions`), every 10 seconds: title, parent session, last activity, pull request, and the app's own note on the last turn (`postTurnSummary`: `status_category` and `needs_action`). Archived sessions are left out.
3. The CLI transcripts (`%USERPROFILE%\.claude\projects\*\<id>.jsonl`): growth means a session is working, and a message from another session shows as a link between the two.

The first rule that matches wins.

1. `you`: live and waiting (a permission prompt or a question).
2. `active`: live and still running background work it started less than 2 hours ago (a background Bash command or agent with no completion record yet). The stateReason is "Running background work".
3. `you`: a background job blocked or failed.
4. `active`: live and busy, or a background job working.
5. `stale`, for a session that is not running: its pull request merged or closed, or no activity for `stale_hours` (24 by default). This beats the app's old note on its last turn.
6. `you`: the app marked it blocked, ready for review, or needing Jay's action.
7. `active`: its transcript grew in the last 30 seconds.
8. `stale`: a running session with no activity for `stale_hours`.
9. `wait`: everything else, such as idle, finished its last turn, or waiting on a helper, CI or a background task.

`stateReason` says why in a few words, for example "Waiting for a permission prompt", "Needs your decision: ...", "PR 1216 merged" or "No activity for 3 days".

The console shows sessions that are live, active in the last `recent_days` (3 by default), or a parent or child of one of those. `cos_sessions` lists the same set; `{ "all": true }` lists every open session.

## Proactive notices

The server sends a notice when a session moves into `you`, when one goes from `active` to `wait` (it finished), and once a day after nine in the morning with the stale list. Notices within 20 seconds are batched into one prompt, at most one prompt every 2 minutes, only while the Chief is idle, never in quiet hours (22:00 to 07:00 by default), never about the Chief's own session. The prompt starts with "[Notice, not from Jay]". Pass it on in one or two spoken sentences; do not act on it.
