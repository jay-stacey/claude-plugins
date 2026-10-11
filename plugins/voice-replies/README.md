# voice-replies

Reads Claude Code's replies aloud. When the main agent finishes a turn, the plugin asks Haiku to rewrite the reply as a short spoken script (outcome first, no code, paths or markdown), then speaks it with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on your GPU, or on your CPU when the GPU cannot run it. If Kokoro is not running it falls back to the built-in Windows voice (or the system voice on macOS).

It speaks only the main agent's final answer in a session someone is watching. Subagent turns, stopped turns, `claude -p` runs and SDK sessions with no app attached stay silent.

## Install

1. Install the plugin:

   ```
   /plugin install voice-replies@personal-plugins
   ```

2. Install the Kokoro voice server (Windows only):

   ```
   /voice install
   ```

   It takes 5 to 15 minutes. The voice panel shows each step, and the Windows voice speaks until it is done. A toast says when it is done and whether Kokoro runs on the GPU or the CPU.

Until step 2 is done, replies use the Windows voice.

### How the installer picks GPU or CPU

`/voice install` runs `server/setup.ps1`. It checks the machine first:

| The machine has | Kokoro runs on | PyTorch build |
| --- | --- | --- |
| An NVIDIA card with 2 GB or more of video memory, compute capability 5.0 to 9.x, and driver 528.33 or newer | GPU | CUDA 12.6 |
| An NVIDIA RTX 50 series (Blackwell) card and driver 570.65 or newer | GPU | CUDA 12.8 |
| An older, smaller or out-of-date NVIDIA card, AMD or Intel graphics, or Windows on ARM | CPU | CPU |

After installing, it speaks a test phrase into memory on the chosen device. If the GPU fails that test, it switches to the CPU by itself. The choice is saved in `config.json`, and the server reads it each time it starts. Kokoro is small (82 million parameters), so a modern CPU still speaks faster than real time.

To force a choice, use `/voice install gpu` or `/voice install cpu`. To see what it would pick without installing anything:

```powershell
powershell -ExecutionPolicy Bypass -File server\setup.ps1 -CheckOnly
```

You do not need Python. The installer gets [uv](https://github.com/astral-sh/uv) (a small Python installer), and uv puts Python 3.12 in the same folder. It needs no admin rights. Downloads are about 3 GB for the GPU and about 700 MB for the CPU. Everything goes into `%USERPROFILE%\.claude\voice-replies`; delete that folder to remove it. Run `/voice install` again after a plugin update or a new GPU. It keeps what is already in place.

The plugin starts the server hidden in the background when it first needs it. One server is shared by every session, and it exits after two idle hours.

## Use

A small **Voice replies** panel sits just above the prompt, under any other mod's panel (such as session-brief). It has a **Voice** dropdown and a **Speed** dropdown. Pick **Off** in the Voice dropdown to turn voice replies off; pick any voice to turn them back on. The dropdown's label says when it is preparing or speaking, or when the Windows voice stands in for Kokoro. A **Stop** button shows while it speaks.

| Command | Does |
| --- | --- |
| `/voice` | Toggles voice replies on or off |
| `/voice on`, `/voice off` | Turns them on or off |
| `/voice stop` | Stops the current speech |
| `/voice voice bm_george` | Picks a voice |
| `/voice speed 1.2` | Picks a speed: 0.8, 0.9, 1.0, 1.1, 1.2, 1.3 or 1.5 |
| `/voice voices` | Lists the 28 English voices |
| `/voice test` | Plays a sample with the current voice and speed |
| `/voice install` | Installs Kokoro on the GPU, or on the CPU if the GPU cannot run it |
| `/voice install gpu`, `/voice install cpu` | Installs Kokoro on the device you name |

Choices are kept across sessions. Sending a new prompt stops the current speech.

## Cost

Each spoken reply makes one Haiku call: about 200 tokens of rules plus the reply in, and 60 to 150 tokens out. Nothing is added to the main conversation's context. Kokoro runs locally and uses no tokens. With voice replies off there is no extra call.

## How it works

| Piece | Job |
| --- | --- |
| `hooks/register.tsx` | The hooks module: listens for the end of each turn, writes the speech script, draws the voice panel above the prompt, and handles `/voice` |
| `server/server.py` | A local HTTP server on `127.0.0.1:47861` that keeps Kokoro loaded on the device in `config.json`. `POST /speak` returns at once with a job id, `GET /status?id=N` reports progress, `POST /stop` stops playback |
| `server/setup.ps1` | Run by `/voice install`. Checks the GPU, installs Python, PyTorch and Kokoro, copies `server.py` into place, tests Kokoro, and writes `config.json` |

The server log is at `%USERPROFILE%\.claude\voice-replies\logs\server.log`. The install log is `install.log` in the same folder.

## Develop

```
claude plugin validate plugins/voice-replies
claude plugin test plugins/voice-replies
```
