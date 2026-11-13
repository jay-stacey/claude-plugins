# Chief of Staff plugin: build plan

Status: draft for approval, 2026-10-16. Mockup: `docs/mockup.html`.

## What it is

A new plugin, `chief-of-staff`, in the `personal-plugins` marketplace. It adds:

- **The Chief**, a conversational agent that runs in one Claude desktop session. It watches every other session, tells you which ones need you, and acts on them when you ask.
- **The console**, a local web page (127.0.0.1) with the session graph, a session roster, the Chief's chat, and a full-page view of any session.
- **Ears and voice**, a local speech server. The browser streams the microphone to it. It listens for "Hey Chief", turns speech into text, and speaks the Chief's replies. It runs on the GPU and falls back to the CPU.

## How the parts talk

```
 Browser console  ──HTTP/SSE──►  cos server (Python, 127.0.0.1)  ◄──reads──  desktop session files (read-only)
                                   │  PC mic -> VAD + wake word + STT          ~/.claude/projects/*.jsonl (read-only)
                                   │  TTS -> PC speakers                       claude agents --json
                                   │  inbox of prompts and actions
                                   ▼
                     Chief mod (TypeScript hooks mod, runs inside the Chief's desktop session)
                       - pulls prompts from the inbox  -> $.prompt.submit (a normal user turn)
                       - sees each Chief reply         -> posts it to the server (chat + speech)
                       - runs actions                  -> $.mcp.call("ccd_session_mgmt", ...)
```

Why this shape:

1. **Reading is direct and read-only.** Live status comes from `claude agents --json`, a documented CLI command. Checked on this machine: it lists every desktop session with `status` (`busy`, `idle`, `waiting`, plus `waitingFor` such as "permission prompt") and its CLI session id. The server runs it every 2 seconds. The desktop app also writes one JSON file per session, which fills in the rest. It holds the title, parent session (`spawnedFrom`), last activity, PR state, and the app's own status note (`postTurnSummary.status_category`, `needs_action`). The server reads these files and the transcript files. It never writes them.
2. **Every change goes through the desktop app.** Archive, send a reply, and open a session use the app's own session tools. Only a desktop session has those tools, so the Chief lives in one. A headless `claude -p` process does not get them.
3. **The Chief talks like a person.** Its own reply is what gets spoken. There is no second rewrite pass, unlike voice-replies. The agent prompt makes it write short, spoken sentences.

## Session states

| State | Rule (first match wins) |
|---|---|
| Waiting on you | `claude agents` says `waiting`, the app marks it blocked or needing action, or its last turn ended with a question to you |
| Active | `claude agents` says `busy`, or its transcript grew in the last 30 seconds |
| Waiting | Idle, but waiting on a helper session, a background task, or CI |
| Stale | No activity for 24 hours (configurable), or its PR is merged or closed |

The Chief speaks up when a session enters "Waiting on you", when one finishes, and once a day for stale ones. Quiet hours and a per-session mute are settings.

## Voice stack (local hardware)

Most of this already works in Pepper (`F:\Personal\Pepper\voice\src\pepper_voice\`), on this machine, with CUDA. The plugin copies and adapts those modules instead of starting from zero:

| Job | Default (proven in Pepper) | Fallback or upgrade |
|---|---|---|
| Speech detection | Silero VAD, `vad.py` | none needed |
| Wake word "Hey Chief" | openWakeWord, `wake.py`, with a new "hey chief" model trained by the same pipeline that made `hey_pepper.onnx` (`F:\atlas-training`) | sherpa-onnx keyword spotter (no training) until the model exists; push-to-talk always works |
| Speech to text | faster-whisper, `stt.py`, CUDA, CPU fallback | NVIDIA Parakeet TDT 0.6B v3 (more accurate, faster) as a later upgrade |
| Text to speech | `tts/manager.py` chain: Chatterbox, then Kokoro, then Piper | Kokoro alone when GPU memory is short |
| Echo control | `duplex.py`, WebRTC echo cancellation, half-duplex fallback | headphones |

The microphone and speakers are the PC's own, like Pepper. The voice server listens even when the console tab is closed, and the console only shows what it hears and says. While the Chief speaks, the server needs the wake word before it treats sound as an interruption. Saying "Hey Chief" while it talks stops the speech.

Known problems carried over from Pepper: Chatterbox needs CUDA torch 2.6, and the Kokoro and Chatterbox packages conflict in one install. Phase 0 settles one working install.

voice-replies must not also read the Chief's replies. It has no switch for that today, so the build adds a small "skip this session" setting to voice-replies (one version bump).

voice-replies' own TTS server is not reused. It has no token or Host check, and it can only play on the PC, not stream to a page. The Chief's voice server gets the Day Desk security pattern.

## Safety rules

- Archive is the strongest action. The Chief never deletes a session.
- Before it archives an active session, the Chief says it is active and asks. The console shows Archive and Leave buttons on that question. A spoken "yes" works too.
- A reply from the full-page view goes into the target session as your message, labelled as sent from the Chief's session. The Chief shows you the text before it sends anything you dictated.
- The server binds to 127.0.0.1 only, uses a per-run token, and checks Host and Origin (the Day Desk pattern).
- No customer data leaves the machine. Speech never goes to a cloud service.

## Plugin layout

```
plugins/chief-of-staff/
  .claude-plugin/plugin.json      name, version, author, types, userConfig
  agents/chief.md                 the Chief: voice, rules, tools
  skills/chief/SKILL.md           /chief: start the server, open the console, make this session the Chief
  skills/chief/references/        state rules, action rules, speech style
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              the Chief mod
  server/                         Python: app.py, sessions.py, voice/ (vad, wake, stt, tts), setup.ps1
  console/                        static HTML, CSS, JS (no build step), from the approved mockup
  tests/                          engine tests for the mod, Python unit tests for the server
  docs/plan.md, docs/mockup.html
```

## Build order

Phase 0 is a spike. It proves the four risky assumptions before anything else is built (about 1 hour):

1. A mod can call `ccd_session_mgmt` tools with `$.mcp.call`. If not, the Chief agent calls them in its own turn.
2. A mod can inject a prompt with `$.prompt.submit` from a background poll.
3. `claude agents --json` plus the desktop session files give the right state for 3 live sessions. The desktop files are not a documented format, so the reader treats every field as optional.
4. One Python install runs Pepper's voice modules with Chatterbox and Kokoro on CUDA.

Reused patterns, so less is new:

- Server security, start, stop and status: Day Desk (`executive-assistant/dashboard/server.py`).
- Live updates with SSE and moving dots along graph links: software-factory control center (`server/sse.mjs`, `views/team.mjs`).
- A Claude session kept open across turns, if needed later: Pepper (`core/src/agent.ts`).

Then three sessions work in parallel, each in its own folder so they never touch the same files:

| Session | Owns | Done when |
|---|---|---|
| Console | `console/` | The mockup is live on real data: graph, roster, hover cards, page view, reply box, chat |
| Server and mod | `server/app.py`, `server/sessions.py`, `hooks/`, `agents/`, `skills/` | `/chief` starts everything, states match the app, archive with confirmation works |
| Voice | `server/voice/`, `server/setup.ps1` | "Hey Chief, what needs me?" is heard, answered and spoken on the GPU, and works with the GPU off |

Last, one integration pass: `claude plugin validate --strict`, `scripts/check-skills.py`, the plugin's tests, a manual run through every item in the request, version entries in `marketplace.json` and `README.md`, then the PR.

## Estimates

- Phase 0 spike: about 1 hour.
- Parallel build: about 4 to 6 hours of agent time.
- Integration and local test: about 2 hours, plus about 20 minutes of your time to try the voice loop.

## Update 2026-10-18: terminal support (0.3.0)

This section records what changed in 0.3.0. The text above is the original plan from 2026-10-16 and is left as it was.

### What no longer holds

Item 2 of "Why this shape" said that every change goes through the desktop app, so the Chief had to live in a desktop session. That is no longer true. The Chief can now run in a terminal Claude Code session as well. A terminal session does not have the desktop app's session tools, so 0.2.2 in a terminal reported a false success for an archive, could not see desktop sessions from a Windows Store install, and blocked every action on terminal and background sessions.

### cos_act and the router

Every change to another session now goes through one Chief-only mod tool, `cos_act` (`mcp__chief-of-staff__cos_act`), with the actions `archive`, `stop`, `reply`, `open` and `start`. One guarded router in the mod runs every action, whether it comes from the Chief or from a console button. The router picks the route that works on this host:

- the desktop app's session tools, in a desktop Chief;
- the engine's cross-session send (`$.session.send`), for replies the desktop tools cannot make;
- `claude stop <bgId>` and `claude --bg ... -- <task>`, run by the mod itself with fixed arguments, for background sessions.

`cos_act` answers with an outcome: `done`, `refused`, `failed`, `needsConfirm`, `opened`, `handedOff` or `unsupported`. The server adds `expired` when no result comes back in time. Only `done` means the action happened. `opened` means the session is open in the Claude app and Jay finishes the action there. The persona never calls that an archive. In the desktop app, the Chief still starts sessions with `mcp__ccd_session__start_session`, because `cos_act start` refuses there.

The server gives each session a `kind` (`desktop`, `cli` or `bg`) and an `actions` map that says, per action, `yes`, `app` (only by opening it in the app) or `no`, with a plain note for every value that is not `yes`. The console shows only the buttons that work, and the Chief offers only what the map allows. The binding field and outcome shapes are in `docs/contracts.md`.

### What each session kind gets

| Session | Reply | Archive | Stop | Open in app |
|---|---|---|---|---|
| Desktop, Chief in the desktop app | yes (desktop tool) | yes (desktop tool) | no | yes |
| Desktop, Chief in a terminal | yes when the session can be reached, else open it in the app | opens it in the app, where Jay archives it | no | yes |
| Terminal (interactive) | yes | no: close it in its own window | no | no |
| Background | yes | no: use Stop | yes, `claude stop` | no |

### Why no claude rm, no process kill and no file edit

- **No `claude rm`.** It removes the background session's row and may remove its worktree, which is the closest command to a delete. `claude stop` keeps the conversation, and `claude --bg --resume` brings it back.
- **No process kill.** The only way to end an interactive terminal session from outside is to kill its process, which loses the running turn. The Chief tells Jay to type /exit in that window instead.
- **No edit of the desktop app's files.** The app keeps its archive state in memory, overwrites an edited file, and skips its own teardown (stopping the process and cleaning the worktree). So a terminal Chief opens the session in the app instead of archiving it.

Jay approved all three defaults on 2026-10-18. There is also no Open button for terminal and background sessions.

### Safety additions

- Three levels of yes. A yes typed in the Chief's own session counts for everything. A console button, the console chat, the voice and the Remote Control bridge answer only the busy question ("it's working, stop anyway?"). A message from another session is never a yes, and `cos_act` refuses every action in a turn another session started.
- Deny rules win. Before the mod sends a message or runs `claude stop` or `claude --bg` itself, it asks the permission system and refuses on a deny. It never approves its own calls.
- No session text becomes a command-line flag. Ids must match a strict pattern, and the start task always follows `--`.
- Each action runs exactly once.
- Setup writes one allow rule, `mcp__chief-of-staff__cos_act`, to `.claude\settings.local.json` after a yes. There are no Bash rules and no `SendMessage` rule.

### Spike results

Recorded 2026-10-18, with the desktop app running:

- S1 PASS. A desktop session registers in `~/.claude/sessions/<pid>.json` with `entrypoint: "claude-desktop"` and a messaging inbox.
- S2 PASS. `claude agents --json` lists it, and its `sessionId` equals the `cliSessionId` of the matching `local_` file.
- Still open: S4 (a real terminal-to-desktop send), S11 (the prompt origin of typed and forwarded messages) and S8 (the allow rule takes effect in auto mode). The script for these and the full manual matrix is `docs/terminal-verification.md`. Its results go in the pull request.
