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
