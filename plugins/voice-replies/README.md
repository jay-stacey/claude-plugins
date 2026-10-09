# voice-replies

Reads Claude Code's replies aloud. When the main agent finishes a turn, the plugin asks Haiku to rewrite the reply as a short spoken script (outcome first, no code, paths or markdown), then speaks it with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on your GPU. If Kokoro is not running it falls back to the built-in Windows voice (or the system voice on macOS).

It speaks only the main agent's final answer in a session someone is watching. Subagent turns, stopped turns, `claude -p` runs and SDK sessions with no app attached stay silent.

## Install

1. Set up the Kokoro voice server (Windows, Python 3.10 to 3.12, about 3 GB of downloads):

   ```powershell
   powershell -ExecutionPolicy Bypass -File plugins\voice-replies\server\setup.ps1
   ```

   Use `-Cuda cpu` on a machine without an NVIDIA GPU. Everything goes into `%USERPROFILE%\.claude\voice-replies`; delete that folder to remove it.

2. Install the plugin:

   ```
   /plugin install voice-replies@personal-plugins
   ```

The plugin starts the server hidden in the background when it first needs it. One server is shared by every session, and it exits after two idle hours.

## Use

A row above the prompt shows whether voice replies are on and which engine speaks, with a **Turn off** / **Turn on** button, a **Stop** button while speaking, and **Voice** and **Speed** pickers.

| Command | Does |
| --- | --- |
| `/voice` | Toggles voice replies on or off |
| `/voice on`, `/voice off` | Turns them on or off |
| `/voice stop` | Stops the current speech |
| `/voice voice bm_george` | Picks a voice |
| `/voice speed 1.2` | Picks a speed: 0.8, 0.9, 1.0, 1.1, 1.2, 1.3 or 1.5 |
| `/voice voices` | Lists the 28 English voices |
| `/voice test` | Plays a sample with the current voice and speed |

Choices are kept across sessions. Sending a new prompt stops the current speech.

## Cost

Each spoken reply makes one Haiku call: about 200 tokens of rules plus the reply in, and 60 to 150 tokens out. Nothing is added to the main conversation's context. Kokoro runs locally and uses no tokens. With voice replies off there is no extra call.

## How it works

| Piece | Job |
| --- | --- |
| `hooks/register.tsx` | The hooks module: listens for the end of each turn, writes the speech script, draws the row above the prompt, and handles `/voice` |
| `server/server.py` | A local HTTP server on `127.0.0.1:47861` that keeps Kokoro loaded on the GPU. `POST /speak` returns at once with a job id, `GET /status?id=N` reports progress, `POST /stop` stops playback |
| `server/setup.ps1` | Creates the Python environment, installs PyTorch and Kokoro, and copies `server.py` into place. Run it again after updating the plugin |

The server log is at `%USERPROFILE%\.claude\voice-replies\logs\server.log`.

## Develop

```
claude plugin validate plugins/voice-replies
claude plugin test plugins/voice-replies
```
