---
name: chief-setup
description: This skill should be used when the user asks to "set up the chief", "install chief of staff", "chief setup", "set up the chief of staff voice", "set up my wake word", "enroll the wake word", or "why can't the chief archive sessions". It checks the machine (Windows, Python, GPU), installs the local voice with server/setup.ps1, offers wake-word enrollment, explains and, after a yes, writes the permission rule that lets the Chief archive and message sessions, then starts the Chief once and checks it is healthy.
when_to_use: Trigger phrases include "set up the chief", "install chief of staff", "chief setup", "set up the voice for the chief", "enroll my wake word", "train hey chief on my voice", "the chief can't archive", "first time setup for the chief".
argument-hint: "[check | voice | enroll | permissions]"
allowed-tools: Bash, PowerShell, Read, Write, Edit
---

# Chief of Staff setup

Sets up the chief-of-staff plugin on this machine, for a new user or a new PC. Run the
steps in order and tell the user, in short plain sentences, what each step found and
what comes next. An argument runs one step only: `check` (step 1), `voice` (step 2),
`enroll` (step 3), `permissions` (step 4).

`${CLAUDE_PLUGIN_ROOT}` is the plugin folder. `HOME` below is
`%USERPROFILE%\.claude\chief-of-staff`.

## 1. Check the machine

Run these and report one line each:

- Windows: `$env:OS` is `Windows_NT`. The voice and the desktop session files are Windows only today; on another system, say the console and typed chat still work and skip steps 2 and 3.
- Python 3.10 or later for the app server: `python --version` (then `py -3 --version`). Without it, say how to install it (python.org, tick "Add to PATH") and stop.
- GPU: `powershell -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/server/setup.ps1" -CheckOnly`. It reports the NVIDIA card, its memory and driver, and which recipe it would pick: CUDA (Chatterbox voice, larger speech model) or CPU (Kokoro voice, smaller speech model). Say which and why in one sentence.

## 2. Install the voice

Optional; the console and typed chat work without it. Ask before starting, and say it
downloads a few gigabytes and takes 10 to 30 minutes.

Run it in the background, never in the foreground, because it outlasts a tool call:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/server/setup.ps1" > "%TEMP%\chief-setup.log" 2>&1
```

Use the shell tool's background option. Report progress from the log as it runs: each
line that starts with `==> ` is a step, so tell the user the new step in a few words
whenever one appears (check about every minute, not more often). The last line starts
with `DONE: ` on success and names the device, voices and speech model. On failure,
quote the last two meaningful lines and suggest `-Device cpu` when the GPU step failed.
Delete the log when done. Details: `references/voice-install.md`.

## 3. Enroll the wake word (optional)

The stock wake word model was trained on synthetic voices and may miss a real voice.
Enrollment records the user saying the wake word five times and tunes detection to it.
Offer it after the voice is installed, and ask before starting, because it uses the
microphone.

1. Read the wake word from the plugin settings (`wake_word`, default "hey chief").
2. Tell the user they will say it five times, a second apart, in a normal voice.
3. Run `"HOME\venv\Scripts\python.exe" "${CLAUDE_PLUGIN_ROOT}/server/voice/voiced.py" --enroll 5` and relay its prompts.
4. If the command says `--enroll` is unknown, the installed voice is older: say so and skip.

## 4. Allow the Chief to archive and message sessions

The Chief archives and messages other sessions with the desktop app's session tools. In
auto mode, a request that arrives by voice or from the console is not typed in the
session, so the app may refuse the call. A project permission rule fixes that. Explain
this, show the exact file below, and ask before writing it. Never write it without a yes.

The file is `.claude\settings.json` in the folder the Chief's session runs in. Merge into
an existing file instead of replacing it, keeping every other key and rule:

```json
{
  "permissions": {
    "allow": [
      "mcp__ccd_session_mgmt__archive_session",
      "mcp__ccd_session_mgmt__send_message"
    ]
  }
}
```

Say what it allows in plain words: sessions in this folder may archive and message other
sessions without asking. The Chief's own rules still apply on top: it asks before archiving
a session that is working, and the mod refuses that archive until the user says yes.
If writing the file is refused (auto mode may block a change to its own permissions),
give the user the file content and its path to create themselves. More:
`references/permissions.md`.

## 5. Start the Chief and check it

1. Tell the user to type `/chief` in the desktop session that should become the Chief.
   Do not run it from here when this session is not meant to be the Chief.
2. Then check health: `python "${CLAUDE_PLUGIN_ROOT}/server/app.py" status`, and read
   `http://127.0.0.1:<port>/api/health` (no token needed). Report: the server runs, a
   Chief is connected, the voice state (`not-installed`, `starting`, `listening` and so on)
   and the Chief's name and wake word from `settings`.
3. If the voice shows `error`, quote its `detail` and point to `HOME\logs\voiced.log`.

End with one line on how to change the name, wake word and fillers:
`/plugin configure chief-of-staff@personal-plugins`.

## Additional resources

- `references/voice-install.md`: what setup.ps1 installs, where, the recipes, and fixes for common failures.
- `references/permissions.md`: why the rule is needed, how to merge it, and how to remove it.
