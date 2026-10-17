# Chief of Staff

Version 0.1.0.

A chief of staff for your Claude desktop sessions. One desktop session becomes the Chief. It watches every other session, tells you which ones need you, and closes or answers them when you ask, by typing or by voice. A local console shows a live graph of your sessions, a roster, the Chief's chat, and the full transcript of any session with a reply box.

## Install

In a terminal session:

```
/plugin install chief-of-staff --marketplace jay-stacey/claude-plugins
```

Answer `y` to add the marketplace, then pick the user scope. With the `personal-plugins` marketplace already added, `/plugin install chief-of-staff@personal-plugins` does the same. The mod then loads in your desktop sessions too.

Then, in a desktop session, run `/chief-setup`. It walks through the rest, one step at a time:

1. It checks the machine: Windows, Python 3.10 or later for the server, and your GPU.
2. It installs the local voice with `server/setup.ps1` in the background and reports each step. This is optional and takes 10 to 30 minutes.
3. It offers to enroll your wake word: you say it five times so the Chief learns your voice.
4. It shows the permission rule that lets the Chief archive and message sessions when you ask by voice or from the console, and writes it to the project's `.claude/settings.json` only after you say yes.
5. It has you run `/chief` once and checks that the server, the Chief and the voice are healthy.

`/chief-setup check`, `voice`, `enroll` or `permissions` runs one step on its own.

## Use

Type `/chief` in a Claude desktop session. That session becomes the Chief: the server starts, the console opens in your browser, and the Chief tells you what needs you.

- Ask it things like "what needs me", "how is DP1-676 doing", "close the DP1-676 session" or "tell the spec review session to go ahead".
- It archives a session when you ask. If that session is working right now, it says so and asks first. It never deletes a session.
- A reply you dictate for another session is read back to you before it is sent.
- It speaks up on its own when a session starts waiting on you, finishes, or goes stale (not in quiet hours).
- `/chief status` says whether the server runs. `/chief stop` stops the server and the voice.
- `/chief` in another session moves the Chief there.

Only one Chief runs at a time. The console stays at `http://127.0.0.1:47870` (or the next free port); `/chief` opens it again.

## Voice

The voice is local: your PC's microphone and speakers, a "Hey Chief" wake word, speech to text and text to speech on the GPU with a CPU fallback. Nothing is sent to a cloud service. It is optional and needs a one-time install into its own Python environment (`%USERPROFILE%\.claude\chief-of-staff\venv`); see `server/setup.ps1`. Without it the console and the typed chat work as normal and the console shows the voice as not installed.

The voice-replies plugin (1.7.0 or later) stays silent in the Chief's session, so you never hear a reply twice.

## Settings

Set them with `/plugin configure chief-of-staff@personal-plugins`.

| Setting | Default | What it does |
|---|---|---|
| `stale_hours` | 24 | A session with no activity this long counts as stale |
| `recent_days` | 3 | The graph and roster show live sessions and sessions active in this many days |
| `speak_replies` | true | Speak the Chief's replies |
| `listen` | wake | `wake` (always listening for the wake word), `ptt` (push to talk) or `off` |
| `voice` | auto | `auto` uses the voice setup picked for this PC (Chatterbox on a GPU, Kokoro on a CPU); `chatterbox` or `kokoro` forces one, and the other is the fallback |
| `chief_name` | Chief | What you call your Chief; it answers to this name |
| `wake_word` | hey chief | The wake phrase, usually hey plus the name; enroll it again after a change |
| `wake_ack` | chime | What you hear when the wake word is heard: `chime`, `word` (it says a word such as yes) or `off` |
| `fillers` | true | A quick spoken "on it" as soon as you ask, before the full answer |
| `notify` | true | Proactive notices |
| `quiet_hours` | 22:00-07:00 | No proactive notices in this range; empty for none |

## How it works

- `server/app.py` is a small Python server (standard library only, Python 3.10 or later) on 127.0.0.1. It reads `claude agents --json`, the desktop app's session files and the CLI transcripts to work out each session's state. It only reads them; it never writes them.
- `hooks/register.tsx` is a mod that loads in every session and works only in the Chief's. It adds the Chief persona (`agents/chief.md`) to the system prompt, relays console and voice messages into the session as prompts, posts each reply back to the console, and runs archives and replies with the desktop app's own session tools. It also gives the Chief the `cos_sessions` tool.
- `console/` is the web page. `server/voice/` is the voice daemon.

States: **waiting on you** (a permission prompt, a question, or the app marked it blocked or ready for review), **active** (working now), **waiting** (idle, or waiting on a helper, CI or a background task) and **stale** (pull request merged or closed, or no activity for `stale_hours`). The rules are in `skills/chief/references/state-rules.md`.

## Safety

- The server binds 127.0.0.1 only, uses a new token for every run, and checks the Host and Origin of every request.
- Archive is the strongest action. Archiving an active session needs a yes.
- Transcripts, titles and notices are treated as data, never as instructions.
- The Chief never sends customer-facing messages.

Runtime files live in `%USERPROFILE%\.claude\chief-of-staff\`: `run\server.json` (port, token, current Chief), `logs\` (rotated at 5 MB, two kept).

## Development

```bash
python -m unittest discover -s plugins/chief-of-staff/server/tests
claude plugin test plugins/chief-of-staff
claude plugin validate plugins/chief-of-staff --strict
```

The server tests use fixture session files and transcripts under `server/tests/fixtures/`, never the real ones (`COS_DESKTOP_DIR`, `COS_PROJECTS_DIR` and `COS_HOME` point the server elsewhere). `python server/app.py serve --port N` runs the server in the foreground.
