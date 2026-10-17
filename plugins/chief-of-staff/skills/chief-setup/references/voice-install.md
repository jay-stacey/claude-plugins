# Voice install

`server/setup.ps1` installs the voice daemon (`server/voice/voiced.py`) into its own
environment. It needs no admin rights and no Python of the user's own: it fetches `uv`,
which fetches Python 3.11.

## What goes where

All under `%USERPROFILE%\.claude\chief-of-staff` (HOME):

| Path | What |
|---|---|
| `HOME\venv` | The voice daemon's Python environment |
| `HOME\models` | Kokoro voice files and the keyword-spotting model |
| `HOME\voice.json` | The recipe setup picked (device, voices, speech model) |
| `HOME\logs` | `voiced.log` and `server.log`, rotated at 5 MB, two kept |

Large models (faster-whisper, Chatterbox) go to the Hugging Face cache in the user profile.

## Recipes

- **CUDA**: an NVIDIA card with at least 6 GB of video memory, a driver of 528.33 or later,
  and a compute capability from 5.0 to 9.0. Chatterbox speaks, Kokoro is the fallback,
  faster-whisper large-v3-turbo transcribes.
- **CPU**: everything else. Kokoro speaks, faster-whisper small.en (int8) transcribes.

After installing, setup proves the choice with a self-check: it loads every model, speaks a
phrase into memory and transcribes it. If the GPU fails the self-check it switches to the
CPU recipe by itself.

## Flags

- `-CheckOnly`: report what it would do, install nothing.
- `-Device cpu` or `-Device gpu`: force a recipe.
- `-SkipSelfCheck`: install only.

Running it again is safe: it skips what is already in place.

## Reading progress

Each step prints a line starting with `==> `. The last line starts with `DONE: ` and names
the device, voices, speech model and wake word engine. Anything else is detail.

## Common failures

| Symptom | Fix |
|---|---|
| The GPU self-check fails | Run again with `-Device cpu`. |
| A download times out | Run again; finished downloads are kept. |
| `uv` cannot be fetched | Check the network or proxy, then run again. |
| The voice shows `error` in the console | Read `HOME\logs\voiced.log`; the last lines say why. |
| The wake word is rarely heard | Run the enrollment step, or use push to talk in the console. |

The app server starts the daemon by itself when `HOME\venv` exists; after an install,
restart the Chief with `/chief` (or `python server/app.py restart`) so it starts the voice.
