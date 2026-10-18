---
name: chief-setup
description: This skill should be used when the user asks to "set up the chief", "install chief of staff", "chief setup", "set up the chief of staff voice", "set up my wake word", "enroll the wake word", or "why can't the chief archive sessions". It checks the machine (Windows, Python, GPU), installs the local voice with server/setup.ps1, sets up Jev (the local, hosted or rules-only decision model), offers wake-word enrollment, explains and, after a yes, writes the permission rule that lets the Chief archive and message sessions, explains why the Chief can't archive, stop or message a session, then starts the Chief once and checks it is healthy.
when_to_use: Trigger phrases include "set up the chief", "set up Jev", "install chief of staff", "chief setup", "set up the voice for the chief", "enroll my wake word", "train hey chief on my voice", "the chief can't archive", "the chief can't message", "why did the chief's action fail", "chief in the terminal", "first time setup for the chief".
argument-hint: "[check | voice | jev | enroll | permissions | actions]"
allowed-tools: Bash, PowerShell, Read, Write, Edit, AskUserQuestion
---

# Chief of Staff setup

Sets up the chief-of-staff plugin on this machine, for a new user or a new PC. Run the
steps in order and tell the user, in short plain sentences, what each step found and
what comes next. An argument runs one step only: `check` (step 1), `voice` (step 2),
`jev` (step 3), `enroll` (step 4), `permissions` (step 5), `actions` (step 6).

`${CLAUDE_PLUGIN_ROOT}` is the plugin folder. `HOME` below is
`%USERPROFILE%\.claude\chief-of-staff`.

## 1. Check the machine

Run these and report one line each:

- Windows: `$env:OS` is `Windows_NT`. The voice is Windows only today. Terminal sessions work on any system. Desktop sessions are read on Windows. On another system, say the console and typed chat still work and skip steps 2, 3 and 4.
- Claude Code: `claude --version` is 2.1.234 or later, which cross-session messages need on Windows. If it is older, say to run `claude update`.
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

## 3. Set up Jev

Jev is a small, fast step that advises the Chief before it acts: which model a new
session uses, whether to start a new session, and whether the work runs in the background.
It runs on a local model, a hosted model, or rules only. Rules are always the fallback.
Run this after the voice install, because the scan measures memory with the voice in place.

`jev_setup.py` runs with the same Python as the app server. Every command prints `==> `
steps and ends with one JSON line; read that line.

1. Scan: `python "${CLAUDE_PLUGIN_ROOT}/server/jev_setup.py" scan`. It is read-only and needs
   no admin rights. `pick.tier` is `local-gpu`, `local-cpu`, `local-cpu-min` or `hosted`;
   `pick.model` is the local model; `pick.reasons` and `pick.warnings` are plain sentences.
2. Tell the user the result in one short block of plain words, no table. For example:
   "Your machine can run Jev locally. 8 cores with AVX2 and 9 GB of memory free, no usable
   NVIDIA card. Jev would use Qwen3.5-0.8B, a 530 MB download, on the processor." Add each
   warning as one more sentence.
3. Ask with AskUserQuestion. Three choices, the first one marked recommended:
   - Local (recommended when the tier is not `hosted`): free, no key, and no request text
     leaves the machine.
   - Hosted: a cloud model with an API key. Recommended when the tier is `hosted`.
   - Rules only: no model, no download, no key.

**Local.**
1. Run `python "${CLAUDE_PLUGIN_ROOT}/server/jev_setup.py" local --model <pick.model>` first,
   without `--yes`. It downloads nothing; it says what it would fetch. Tell the user the file,
   its size and its source (`download.url`, Hugging Face at a pinned commit) and the runtime:
   an existing Ollama on 127.0.0.1, or llama.cpp `llama-server`.
2. Ask before the download. Never add `--yes` without a yes for this download.
3. If `runtime.download` is set, llama-server must be downloaded too (a pinned llama.cpp
   build from GitHub, about 20 to 35 MB). Ask about that separately, and add `--yes-runtime`
   only after its own yes.
4. Run it again with `--yes` (and `--yes-runtime` when agreed) in the background, and report
   each `==> ` step. It checks the file's SHA256, starts the runtime on 127.0.0.1, and runs a
   live test of 10 decisions.
5. Read the last line. `ok: true`: say the model, the runtime and the p50 and p95 times.
   `stepDown` set: the model was too slow; offer the smaller model and repeat from step 1
   with it (a new download needs a new yes). Any other `ok: false`: quote `error` and offer
   hosted or rules.

**Hosted.** Explain the choice in a few sentences:
- Anthropic, Claude Haiku 5.5 (recommended): `--adapter anthropic`. Request text and session
  titles go to Anthropic.
- Groq with zero data retention turned on in the Groq console: `--adapter openai_compat
  --endpoint https://api.groq.com/openai/v1 --model <model>`.
- A self-hosted server: `--adapter openai_compat --endpoint <https URL> --model <model>`.

Setup refuses Gemini, Mistral, OpenRouter and Cerebras because of their data policies, and
GitHub Models because it has closed.

The key never goes in the chat. If the user pastes one, say so, do not repeat it, and tell
them to revoke it and make a new one. The script reads the key from a hidden terminal prompt:

```
python "${CLAUDE_PLUGIN_ROOT}/server/jev_setup.py" hosted --adapter anthropic
```

Run that where the user can type: the app's Terminal panel when it has one, or give the user
the exact command to run in their own PowerShell window. Tell them to paste the key at the
prompt and press Enter. The script makes one test call, stores the key in Windows Credential
Manager, and writes no key to any file. Then check with
`python "${CLAUDE_PLUGIN_ROOT}/server/jev_setup.py" status` and report the provider and model.

**Rules only.** Run `python "${CLAUDE_PLUGIN_ROOT}/server/jev_setup.py" rules` and say Jev
uses quick rules; the user can run `/chief-setup jev` again at any time.

## 4. Enroll the wake word (optional)

The stock wake word model was trained on synthetic voices and may miss a real voice.
Enrollment records the user saying the wake word five times and tunes detection to it.
Offer it after the voice is installed, and ask before starting, because it uses the
microphone.

1. Read the wake word from the plugin settings (`wake_word`, default "hey chief").
2. Tell the user they will say it five times, a second apart, in a normal voice.
3. Run `"HOME\venv\Scripts\python.exe" "${CLAUDE_PLUGIN_ROOT}/server/voice/voiced.py" --enroll 5` and relay its prompts.
4. If the command says `--enroll` is unknown, the installed voice is older: say so and skip.

## 5. Allow the Chief to act on sessions

The Chief acts on other sessions through one tool, `cos_act` (archive, stop, reply, open
and start). In auto mode, a request that arrives by voice or from the console is not typed
in the session, so the classifier may refuse the call. A permission rule fixes that.

1. Ask with AskUserQuestion where the Chief will run: Desktop app, Terminal, or Both.
2. Find the target file. It is `.claude\settings.local.json` at the git repository root of
   the Chief's folder when that folder is in a git repository
   (`git -C <folder> rev-parse --show-toplevel`), else in the Chief's folder. It is
   personal and stays out of git.
3. Show the matching JSON from `references/permissions.md` (Desktop app or Both: `cos_act`
   and the two desktop tools; Terminal: `cos_act` only), merged into the file as it is now.
4. Say what the rule means, in these plain words: "With this rule, the Chief can reply to
   sessions, stop background sessions, start background sessions, archive desktop sessions
   and open desktop sessions without asking you each time. It asks you first only when the
   session shows as working, or its helper session does. It does not ask for a session that
   shows as idle or waiting, even if that session was in the middle of a task. There are
   three levels of yes. First, a yes you type in the Chief's own session counts for
   everything. Second, a yes you speak, type in the console chat, or give with a console
   button answers only "it's working, stop or archive anyway?". When your own settings say
   ask for a command or a message, type your yes in the Chief's session. Third, a message
   from another session never counts as your yes, and the Chief does nothing in a turn that
   another session started. It never deletes a session, and it never ends a terminal
   session. The rule is written to .claude\settings.local.json in this folder, or at the
   root of its git repository when it is in one. So it applies to every session started
   there, and it stays out of git."
5. Ask the yes or no question. Name the exact file path, and say "every session started in
   this folder (or repository) gets this rule". Write the file only after a yes, merged as
   `references/permissions.md` says. Never write it without a yes.
6. Say in one sentence that no Bash rule is needed: the mod runs `claude stop` and
   `claude --bg` itself with fixed arguments, so a Bash rule would only invite the Chief to
   skip `cos_act` and its checks.
7. Run `git -C <folder> check-ignore .claude/settings.local.json`. When the file is not
   ignored, offer to add `.claude/settings.local.json` to that repository's `.gitignore`,
   and add it only after a yes.
8. An older install wrote the two desktop rules to `.claude\settings.json`. If they are
   there, show those lines and offer to move them to the local file. Move them only after
   a yes.

**Desktop Chief.** When the Chief runs in the desktop app, advise allow or deny rules, not
ask rules, for `claude stop`, `claude --bg` and `SendMessage`. Say why in one sentence: in
the desktop app the Chief cannot tell Jay's typed yes from other messages, so an ask rule
always refuses. The `actions` check (step 6) reports any such ask rule in a desktop Chief's
settings, with this fix.

Recommend running the Chief in its own folder, for example
`%USERPROFILE%\.claude\chief-of-staff\desk`, because the rule reaches every session started
in that folder. Offer to create that folder.

If writing the file is refused (auto mode may block a change to its own permissions),
give the user the file content and its path to create themselves. More:
`references/permissions.md`.

## 6. Check why an action fails (`actions`)

Read-only. It changes nothing. Run each check in the table in `references/permissions.md`
("Why an action failed"): the server version, the desktop files the server sees, the host
tools, the allow rule, ask rules on a desktop Chief, messaging turned off, the CLI version,
`claude` on the PATH, and the last failures in `HOME\logs\mod.log`.

Report one plain line per check. Then add one line for each action that does not work, with
its fix. Never change a setting from this step. When a fix needs a settings change, offer
the step that makes it (`/chief-setup permissions`), or say what Jay can change himself.

## 7. Start the Chief and check it

1. Tell the user to type `/chief` in the session that should become the Chief, in the
   desktop app or a terminal.
   Do not run it from here when this session is not meant to be the Chief.
2. Then check health: `python "${CLAUDE_PLUGIN_ROOT}/server/app.py" status`, and read
   `http://127.0.0.1:<port>/api/health` (no token needed). Report: the server runs, its
   `version`, a Chief is connected, the desktop files it sees (`desktop.source` and
   `desktop.files` from `status`), the voice state (`not-installed`, `starting`,
   `listening` and so on) and the Chief's name and wake word from `settings`.
3. If the voice shows `error`, quote its `detail` and point to `HOME\logs\voiced.log`.

End with one line on how to change the name, wake word and fillers:
`/plugin configure chief-of-staff@personal-plugins`.

## Additional resources

- `references/voice-install.md`: what setup.ps1 installs, where, the recipes, and fixes for common failures.
- `references/permissions.md`: why the rule is needed, the exact rules, how to merge them, the `actions` checks, and how to remove the rule.
