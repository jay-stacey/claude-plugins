# Chief of Staff: contracts

This file is the build spec. Every part is built against it. If a part needs a change here, say so in your report; do not change another part's files.

Plugin root: `plugins/chief-of-staff/` in the `personal-plugins` repo. Approved design: `docs/mockup.html`. Plan: `docs/plan.md`.

## 1. Who owns which files

| Owner | Files | Notes |
|---|---|---|
| Console session | `console/**` | Static HTML, CSS, JS. No build step. No inline script (CSP `script-src 'self'`). |
| Core session | `server/app.py`, `server/cos/**` (Python package: sessions, transcripts, security, events), `server/tests/**`, `hooks/**`, `agents/**`, `skills/**`, `tests/**` (mod engine tests), `.claude-plugin/plugin.json`, `types/**`, `README.md` (plugin), and the small skip change in `plugins/voice-replies/**` | Owns the HTTP API below. |
| Voice session | `server/voice/**`, `server/setup.ps1`, `server/requirements-voice.txt` | Separate process in its own venv. Talks to the app server over HTTP only. |
| Lead (main session) | `docs/**`, repo-root `.claude-plugin/marketplace.json`, repo-root `README.md`, `.github/**` | Integration, versions, PR. |

Never edit a file another owner holds. Never commit. The lead commits.

## 2. Runtime folders and processes

- Runtime home: `%USERPROFILE%\.claude\chief-of-staff\` (call it `HOME`).
  - `HOME\run\server.json`: `{ "api": 1, "port": 47870, "pid": 1234, "token": "...", "url": "http://127.0.0.1:47870/#<token>", "chiefSessionId": "local_..." | null, "startedAt": 1792160000000 }`. Written by the app server at start, rewritten when the chief changes. Deleted on clean stop.
  - `HOME\venv\` voice venv, `HOME\models\` model files, `HOME\logs\` logs (rotate at 5 MB, keep 2).
  - `HOME\run\voice-state.json`: `{ "listen": "wake" | "ptt" | "off", "speak": bool }`, the console's own toggles. Written on every `/api/voice/control` change of `listen` or `speak` and read at start, so they survive a restart and win over the `listen` and `speak_replies` settings.
  - `HOME\run\notices.json`: `{ "staleDay": "2026-10-17" | null, "youAt": { "local_...": epoch_s } }`, so a restart repeats neither the daily stale notice nor a "waiting on Jay" notice from the last 10 minutes.
- **App server** `server/app.py`: Python 3.10+ standard library only (no venv). `python app.py start|stop|status|restart [--port N]`. Binds `127.0.0.1` only. Default port 47870; if busy, tries the next 9 ports. Start runs itself detached, waits up to 5 s on `/api/health`, writes `server.json`. Copy the Day Desk lifecycle (`plugins/executive-assistant/dashboard/server.py` `cmd_start`, `cmd_stop`, pid check by command line). Exits after 12 hours with no console client and no mod poll.
- **Voice daemon** `server/voice/voiced.py`: runs in `HOME\venv`. The app server starts it at start if `HOME\venv` exists and voice is enabled, and stops it on stop. It reads `server.json` for port and token. If the venv is missing, the app server runs without voice and reports `voice.state = "not-installed"`.
- **Chief mod** `hooks/register.tsx`: loads in every session; does work only in the Chief's session (section 6).

## 3. Security (all endpoints)

- Per-run token: `secrets.token_urlsafe(24)`. Header `X-COS-Token`, checked with `secrets.compare_digest`. SSE and the first page load use `?k=<token>` or the `#<token>` hash (the console reads `location.hash`, then sends the header).
- Host must be `127.0.0.1:<port>` or `localhost:<port>`. Origin must be absent or the same origin. No CORS headers.
- No token needed only for `GET /`, static files under `/static/`, and `GET /api/health`.
- JSON bodies up to 64 KB. Over that: 413.
- The server never writes any file of the Claude desktop app or of `~/.claude/projects`. It only reads them.

## 4. Data shapes

### Session

```json
{
  "id": "local_ced01055-...",          // desktop session id; background jobs use "bg_<cliSessionId>"
  "cliId": "bf92d35d-...",             // CLI session id (transcript file name), may be null
  "title": "DP1-676",
  "kind": "interactive" | "background",
  "state": "you" | "active" | "wait" | "stale",
  "stateReason": "Waiting for a permission prompt",   // short, plain, shown in hover cards
  "live": true,                        // has a running process (listed by `claude agents --json`)
  "liveStatus": "busy" | "idle" | "waiting" | null,
  "waitingFor": "permission prompt" | null,
  "parentId": "local_..." | null,      // from spawnedFrom.sessionId
  "childIds": ["local_..."],
  "cwd": "C:\\Dealerpull\\worktrees\\...",
  "repo": "dp-web-ui" | null,          // last folder of originCwd
  "branch": "DP/dp1-676-ab438c" | null,
  "prNumber": 1216 | null,
  "prState": "OPEN" | "MERGED" | "CLOSED" | null,
  "createdAt": 1791478559622,
  "lastActivityAt": 1792159469445,
  "model": "claude-sonnet-5-5" | null,
  "effort": "high" | null,
  "permissionMode": "auto" | null,
  "summary": "IF-49 now reads the vendor's RIN ...",  // turnWrapUp.description, else lastTurnReport, else postTurnSummary.status_detail; max 400 chars
  "needsAction": "Jay's decision: ..." | null,        // postTurnSummary.needs_action
  "appStatus": "blocked" | "completed" | "review_ready" | null, // postTurnSummary.status_category, as written by the app
  "isChief": false,
  "link": "claude://claude.ai/epitaxy/local_..."
}
```

### Sources and state rules

Read, every 2 s for live status and every 10 s for files:

1. `claude agents --json` (timeout 20 s; on failure keep the last result and mark `liveStale: true` in the snapshot). Rows: `kind`, `sessionId` (= `cliId`), `name`, `status` (interactive: `busy`/`idle`/`waiting`, plus `waitingFor`) or `state` (background: `working`/`blocked`/`done`/`failed`/`stopped`).
2. Desktop session files: `%APPDATA%\Claude\claude-code-sessions\*\*\local_*.json`. Skip `isArchived: true`. These files are not a documented format: treat every field as optional, never crash on a bad file, and re-read a file only when its mtime changes. Join to rows by `cliSessionId`.
3. Transcripts: `%USERPROFILE%\.claude\projects\*\<cliId>.jsonl` (find by glob, cache the path).

First match wins:

| # | State | Rule |
|---|---|---|
| 1 | `you` | live and `status == "waiting"` (a prompt on screen) |
| 2 | `active` | live and has unfinished background work started less than 2 hours ago (stateReason "Running background work"), whatever `appStatus` says |
| 3 | `you` | background job `state` in `blocked`, `failed` |
| 4 | `active` | live and `status == "busy"`; or background `state == "working"` |
| 5 | `stale` | not live, and `prState` in `MERGED`, `CLOSED` or `lastActivityAt` older than `stale_hours` (default 24); this beats an old `appStatus` or `needsAction` |
| 6 | `you` | `appStatus` in `blocked`, `review_ready`, or `needsAction` is set |
| 7 | `active` | the transcript grew in the last 30 s |
| 8 | `stale` | live and `lastActivityAt` older than `stale_hours` |
| 9 | `wait` | everything else (idle, finished, waiting on a helper, CI or a background task) |

Unfinished background work (rule 2) comes from the live session's transcript: a `Bash` or `Agent` `tool_use` with `run_in_background: true`, whose `tool_result` was not an error, and that no later record closes. A record closes it when it is a `<task-notification>` naming its `<tool-use-id>` or its task id (`toolUseResult.backgroundTaskId` or `agentId`), in a user row or a queued `queue-operation` row; a sub-agent hand-back (`origin.kind == "peer"`, `handback: true`, `from` = the agent id); or a `KillShell`/`TaskStop` call on its task id. The scan reads at most the last 16 MB of the transcript, then only appended lines.

`stateReason` examples: "Waiting for a permission prompt", "Running background work", "Needs your decision: <needsAction>", "Working now", "PR 1216 merged", "No activity for 3 days", "Idle, finished its last turn".

The Chief's own session has `isChief: true` and is drawn as the core, not as a node.

### Which sessions the console shows

`GET /api/sessions` returns all open sessions. Each carries `"inView": true` when it is live, or active in the last `recent_days` (default 3), or is a parent or child of an in-view session. The graph draws only in-view sessions. The roster lists in-view sessions and one collapsed row "N older sessions" that expands to the rest, sorted by last activity.

### Turn (transcript entry)

```json
{ "uuid": "...", "role": "user" | "assistant" | "tool", "at": 1792159164513,
  "text": "plain text, max 4000 chars, cut with ' …'",
  "toolName": "Bash" | null, "toolSummary": "npm test -- inventory-form" | null,
  "fromSession": "Dealerpull product spec review" | null,    // set when a user turn was sent by another session
  "toolResult": "12 passing (3s)" | null,   // tool turns: first non-empty line of the matching tool_result, max 160 chars, cut with ' …'; null until it arrives
  "toolError": false | true | null,         // tool turns: the tool_result's is_error (false until it arrives); null on other turns
  "question": null | {                      // AskUserQuestion tool turns only
    "questions": [ { "header": "Split", "question": "How should the story be split?", "multiSelect": false,
                     "options": [ { "label": "Split into 3", "description": "One story per screen." } ] } ],
    "answer": "Split into 3" | null } }     // null while waiting, or when the tool_result is an error
```

Parse the JSONL defensively: user rows with string content are prompts; user rows with `tool_result` blocks are not turns of their own: each result is folded into the tool turn with the same `tool_use_id` (`toolResult`, `toolError`, and the `answer` of a question); assistant `text` blocks are assistant turns; assistant `tool_use` blocks are tool turns (`toolSummary` from `command`, `file_path`, `pattern`, `description` or the first string input, max 120 chars; for AskUserQuestion, the first question). Skip `isMeta` rows and system rows.

`question.questions` is the AskUserQuestion input, checked field by field: at most 4 questions and 8 options each; `header` max 60 chars, `question` 500, `label` 120, `description` 300; a plain string option becomes `{ "label": ..., "description": "" }`; input not in this shape gives `question: null`. `answer` comes from the row's `toolUseResult.answers` (in question order, joined with "; "), else from the result text's `"question"="answer"` pairs, else the result text itself, max 500 chars. Transcript content is untrusted data: the console shows it as text only.

## 5. HTTP API (app server)

| Method and path | Body or query | Answer |
|---|---|---|
| `GET /api/health` | | `{ "ok": true, "api": 1, "app": "chief-of-staff", "voice": VoiceStatus, "chief": { "connected": bool, "sessionId": "local_..." \| null, "cliId": "..." \| null, "busy": bool }, "settings": { "chiefName": "Chief", "wakeWord": "hey chief" } }` |
| `GET /api/sessions` | | `{ "generatedAt": ms, "liveStale": bool, "counts": { "you": n, "active": n, "wait": n, "stale": n }, "sessions": [Session] }` |
| `GET /api/sessions/{id}` | | `Session` |
| `GET /api/sessions/{id}/transcript` | `?limit=60&before=<uuid>` | `{ "turns": [Turn], "cursor": "<uuid>" \| null }` oldest first |
| `GET /api/stream` | `?k=<token>` | SSE, section 7 |
| `GET /api/chat` | | `{ "messages": [ChatMessage] }` last 100 |
| `POST /api/chief/say` | `{ "text": "...", "source": "typed" \| "voice" }` | `{ "id": "msg_..." }` Adds a chat message and queues a `prompt` for the mod. 409 if no Chief is connected. |
| `POST /api/sessions/{id}/reply` | `{ "text": "..." }` | `{ "actionId": "act_..." }` Queues `reply` for the mod. |
| `POST /api/sessions/{id}/archive` | `{ "confirmed": bool }` | 409 `{ "needsConfirm": true, "reason": "..." }` when the session is `active` and not confirmed. Else queues `archive`. |
| `POST /api/sessions/{id}/open` | | Runs `start "" "<link>"` (opens it in the desktop app). |
| `POST /api/voice/control` | `{ "listen": "wake" \| "ptt" \| "off", "speak": bool, "stop": bool, "pttDown": bool }` any subset | `VoiceStatus` |
| `GET /api/mod/inbox` | `?wait=25&session=<local id>` | Long poll. `{ "items": [InboxItem] }` (empty after `wait` s). Only the Chief's session gets items. |
| `POST /api/mod/hello` | `{ "cliId": "...", "isChief": bool }` | `{ "ok": true, "sessionId": "local_..." \| null, "settings": Settings }` The mod calls this when it becomes the Chief. `$.session.id()` in a mod returns the CLI session id, not the desktop `local_` id, so the server finds the desktop id by matching `cliSessionId` in the desktop session files. |
| `POST /api/mod/reply` | `{ "text": "...", "turnId": "..." }` | Adds a Chief chat message, sends it to the voice daemon if `speak` is on. |
| `POST /api/mod/result` | `{ "actionId": "...", "ok": bool, "detail": "..." }` | Pushes an `action` SSE event. |
| `POST /api/mod/busy` | `{ "busy": bool }` | The Chief's turn started or ended (drives the orb "Thinking"). |
| `GET /api/voice/jobs` | `?wait=25` | Long poll for the voice daemon. `{ "jobs": [ { "id": "spk_...", "text": "...", "kind": "speak" \| "stop" \| "control" \| "ack" \| "quit" } ] }`. `control` carries any of `listen`, `speak`, `pttDown`; the server also sends one `control` job with all of `wakeWord`, `wakeAck` (`"chime"` \| `"word"` \| `"off"`), `fillers` (bool) and `chiefName`, first in the daemon's first poll and again whenever one of them changes. `ack` (no text) asks for a short spoken filler such as "On it" at once: the server queues it when a voice `final` arrives, and for a typed `POST /api/chief/say` while `speak` is on, unless `fillers` is off or the voice is not installed. `quit` makes the daemon release the mic and GPU and exit; the server sends it on stop and waits 3 s before it ends the process, because on Windows `terminate()` runs no shutdown handler. |
| `POST /api/voice/event` | VoiceEvent | The voice daemon reports. |

Errors are `{ "error": "plain sentence" }` with 400, 401, 403, 404, 409, 413 or 500.

### Other shapes

```json
ChatMessage  { "id": "msg_...", "role": "chief" | "me", "source": "typed" | "voice" | "notice" | null, "text": "...", "at": ms,
               "confirm": { "question": "...", "yes": "Archive anyway", "no": "Leave it running" } | null }
InboxItem    { "id": "...", "type": "prompt", "text": "..." }
           | { "id": "act_...", "type": "archive", "sessionId": "local_...", "title": "...", "reason": "..." }
           | { "id": "act_...", "type": "reply", "sessionId": "local_...", "title": "...", "text": "..." }
VoiceStatus  { "state": "not-installed" | "starting" | "off" | "listening" | "hearing" | "thinking" | "speaking" | "error",
               "listen": "wake" | "ptt" | "off", "speak": bool, "device": "cuda" | "cpu" | null,
               "stt": "faster-whisper large-v3-turbo" | null, "tts": "chatterbox" | "kokoro" | null,
               "wakeWord": "hey chief" | null, "micError": "plain sentence" | null, "detail": "plain sentence" | null }
             // "error" means nothing can be spoken. A mic that will not open sets micError only: the state
             // stays "listening" or "off", and the server still queues speak jobs.
VoiceEvent   { "type": "status", "status": VoiceStatus }
           | { "type": "wake" }                      // wake word heard
           | { "type": "partial", "text": "..." }   // optional live transcript
           | { "type": "final", "text": "..." }     // finished utterance -> server does POST /api/chief/say with source "voice"
           | { "type": "level", "rms": 0.0-1.0 }    // at most 10 per second, for the orb
           | { "type": "spoken", "id": "spk_...", "ok": bool }
           | { "type": "barge" }                     // Jay talked over the Chief: the server drops queued speak and ack jobs
           | { "type": "nearMiss", "score": 0.31 }   // a wake word that almost matched: written to the server log only
Settings     { "staleHours": 24, "recentDays": 3, "speakReplies": true, "listen": "wake", "voice": "auto", "wakeWord": "hey chief", "notify": true, "quietHours": "22:00-07:00" | "",
               "chiefName": "Chief", "wakeAck": "chime" | "word" | "off", "fillers": true }
             // chiefName and wakeWord keep letters, digits, spaces, apostrophes and hyphens, max 30 chars; wakeWord is lower case
```

Confirm buttons: when the Chief asks for a yes or no, it ends its reply with one line `[[confirm: <yes label> | <no label>]]`. The mod strips that line before it posts the reply and sends it as `confirm` beside the text. A button press in the console sends `POST /api/chief/say` with the label text (for example "Archive anyway.") as a typed message. The Chief also accepts a spoken yes.

## 6. Chief mod (hooks/register.tsx)

Phase 0 proved on this machine (cos-spike mod, 2026-10-16): `$.mcp.call('ccd_session_mgmt', 'list_sessions', {...})` works with no prompt; `$.http.fetch('http://127.0.0.1:<port>/...')` works; `$.prompt.submit` from a `$.clock.after` timer starts a new turn in an idle session; `$.session.id()` returns the CLI session id. The `ccd_session_mgmt` tool names and arguments are the ones the desktop app lists (`list_sessions`, `get_session`, `list_events`, `send_message`, `archive_session`).

- **Becoming the Chief.** The `/chief` skill marks the session. The mod hooks `prompt.submit`; when the text starts with `/chief` (or the skill `chief-of-staff:chief` runs), it stores `chief:session = <its session id>` in `$.store`, ensures the app server runs (`$.process.run` `python <root>/server/app.py start`), posts `/api/mod/hello`, and opens the console URL in the browser. Only one Chief: a new `/chief` in another session takes over (the server records `chiefSessionId`; the old mod sees it in `/api/health` and stops polling).
- **Persona.** In the Chief's session the mod adds one `prompt.compose` section (scope `session`) with the body of `agents/chief.md`, every `{name}` replaced by the `chief_name` setting (cleaned as in Settings, default "Chief"). The same file also works as `claude --agent chief-of-staff:chief`, where the name is Chief.
- **Inbox loop.** `$.clock.after` loop: long-poll `GET /api/mod/inbox?wait=25`. `prompt` -> `$.prompt.submit({ text })` (queues a turn; never folded into a running one). `archive` -> `$.mcp.call('ccd_session_mgmt', 'archive_session', { session_id, reason })`. `reply` -> `$.mcp.call('ccd_session_mgmt', 'send_message', { session_id, message })`. Report each with `/api/mod/result`. If `$.mcp.call` is refused, fall back to `$.prompt.submit` asking the Chief to do it with its own tools. Back off 2 s doubling to 30 s when the server is down.
- **Replies.** `turn.complete` with `agentId === undefined` and `reason === 'answer'` in the Chief's session: strip the confirm line, post `/api/mod/reply`. `turn.start` and `turn.complete` post `/api/mod/busy`.
- **Tool for the model.** Register a tool `cos_sessions` (no input, or `{ id }`) that returns `GET /api/sessions` compacted (id, title, state, stateReason, summary, needsAction, parentId, live, lastActivityAt), so the Chief answers "what needs me" without reading transcripts.
- **voice-replies.** voice-replies 1.7.0 skips speaking when `HOME\run\server.json` has `chiefSessionId` equal to its session's id. The Chief's speech comes only from the voice daemon.

## 7. SSE stream (`GET /api/stream?k=`)

Events (`event:` name, `data:` JSON). Snapshot on connect. 15 s heartbeat comment. `id:` counter with a 500-event ring for `Last-Event-ID`.

| Event | Data |
|---|---|
| `snapshot` | `{ "sessions": GET /api/sessions body, "chat": [ChatMessage], "voice": VoiceStatus, "chief": {...} }` |
| `sessions` | same as `GET /api/sessions`, sent when anything changed |
| `activity` | `{ "id": "local_...", "kind": "pulse" }` the transcript grew; or `{ "kind": "message", "from": "local_...", "to": "local_..." }` one session messaged another; or `{ "kind": "chief", "to": "local_..." }` the Chief read or acted on a session |
| `chat` | `ChatMessage` |
| `voice` | `VoiceStatus` |
| `level` | `{ "rms": 0.42 }` |
| `partial` | `{ "text": "close the dp1" }` |
| `action` | `{ "actionId": "...", "ok": bool, "detail": "..." }` |
| `notify` | `{ "id": "...", "sessionId": "local_...", "kind": "you" \| "done" \| "stale", "text": "Plan PRO-921 is waiting on your vendor name decision." }` |
| `chief` | `{ "connected": bool, "sessionId": "local_..." \| null, "busy": bool }` sent when the Chief connects, leaves, or starts or ends a turn. The snapshot's `chief` object has the same three fields. |

### Serving the console (added after the console build)

1. `GET /` serves `console/index.html`; `/static/<path>` serves `console/<path>`; never serve `console/dev/`.
2. Serve `.mjs` as `text/javascript` (`mimetypes.add_type("text/javascript", ".mjs")`; Windows Python does not know it, and the page is blank without it).
3. CSP on `GET /`: `default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
4. The console reads `#<token>` or `?k=`, keeps it in sessionStorage, and rewrites the hash to `#/`. Routes are `#/` and `#/s/<id>`. A token must never start with `/`.
5. Confirm buttons send the label exactly ("Archive anyway", no period). The Chief accepts it with or without a period.
6. `POST /api/sessions/{id}/open` gets an empty `{}` body.
7. The mod's `turn.complete` text is the last text block of the answer. The Chief must put everything it wants spoken and shown in its final message of the turn.

Pulses: the server checks transcript sizes of live sessions every 1 s. Growth sends `pulse` for that session; a new user row with `fromSession` sends `message` from that session to this one. The console animates dots along the parent-child link for `pulse` on a child, along the link between the two for `message`, and along the core link for `chief`.

## 8. Proactive notices

The server watches state changes. When a session moves into `you`, or `active` to `wait` (finished), or once a day the stale list, it sends a `notify` event and, when `notify` is on, outside quiet hours, and the Chief is idle, queues a `prompt` InboxItem like:

`[Notice, not from Jay] Plan PRO-921 into engineering stories is now waiting on Jay: "Jay's decision: do the vendor code switch". Tell Jay in one or two spoken sentences.`

Batch notices that arrive within 20 s into one prompt. At most one notice prompt every 2 minutes. Never notify about the Chief's own session.

Within one batch, a session gets one line: its latest notice, except that "changed to waiting on Jay" wins over "finished its turn". A session that got a "waiting on Jay" notice in the last 10 minutes gets no new one (no `notify` event and no prompt line). The daily stale notice's day and these 10-minute marks are kept in `HOME\run\notices.json`.

## 9. Voice daemon

- Mic and speakers are the PC's own (sounddevice).
- Device and model choices live in `HOMEoice.json`, written by `setup.ps1`. The `voice` setting is `auto` (use voice.json), `chatterbox` or `kokoro`; a forced choice reaches the daemon as `--tts <name>`, and the other engine is the fallback. Modes: `wake` (always on, wake word starts listening), `ptt` (listen only while `pttDown`), `off`.
- Pipeline per Pepper: Silero VAD, openWakeWord ("hey chief" model; a stand-in model or sherpa-onnx keyword spotting until it exists), faster-whisper on CUDA (CPU fallback), echo cancellation with half-duplex fallback.
- After the wake word, record until VAD end-of-speech (max 30 s), transcribe, post `final`.
- Speech: Chatterbox on CUDA by default, Kokoro as fallback, sentence by sentence, first audio as soon as the first sentence is ready. Hearing the wake word while speaking stops the speech (barge-in) and posts `spoken` with `ok: false`.
- Strip markdown before speaking (the Chief should not write any). Never read code blocks or URLs aloud; say "I've put the link on screen".
- Post `status` on every state change and `level` at most 10 times a second.

## 10. Console

Build `docs/mockup.html` for real: same layout, tokens and type. Control center graph (in-view sessions; the Chief as the core; parent-child links; animated dots from `activity` events; hover card with title, state, stateReason, summary; click opens the page view). Roster with state filters and the "N older sessions" row. Chief panel (orb tied to `VoiceStatus` and `level`, toggles for wake word, speak replies and push-to-talk with a hold-to-talk button, chat with confirm buttons, typed input). Page view (`#/s/<id>`: transcript with paging, reply box that posts `/reply`, Open in app, Ask Chief about it (sends "Tell me about <title>."), Archive with the confirm flow). Toast for `notify` events. Reconnect SSE with backoff 2 s doubling to 30 s and show "Reconnecting" in the header. Respect `prefers-reduced-motion`. Works at 1280 to 2560 wide and degrades to one column under 720.
