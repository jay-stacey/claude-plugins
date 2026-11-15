---
name: chief
description: This skill should be used when the user wants a chief of staff for their Claude Code sessions, in the desktop app or a terminal, asks to "start the chief", "open the console", "what needs me", "chief of staff", "which sessions are waiting on me", or types /chief. It makes the current session the Chief, starts the local Chief of Staff server, opens its console, and greets the user with what needs them. /chief stop and /chief status manage the server.
when_to_use: Trigger phrases include "chief of staff", "start the chief", "open the console", "open the chief console", "what needs me", "be my chief of staff", "stop the chief", "is the chief running", "start the chief in this terminal".
argument-hint: "[stop | status]"
allowed-tools: Bash, Read
---

# Chief of Staff

This session becomes the Chief: Jay's spoken chief of staff for every other
Claude Code session, in the desktop app or a terminal. The chief-of-staff mod does the plumbing when /chief
runs. It marks this session as the Chief, adds the Chief persona
(`agents/chief.md`) to the system prompt, starts the local server, opens the
console in the browser, and relays console and voice messages into this
session as prompts.

## Arguments

- `stop`: run `python "${CLAUDE_PLUGIN_ROOT}/server/app.py" stop` and say in one sentence that the Chief of Staff server and its voice are stopped. Do nothing else.
- `status`: run `python "${CLAUDE_PLUGIN_ROOT}/server/app.py" status` and say in one sentence whether it runs and whether a Chief is connected. Do nothing else.
- No argument: start, as below.

## Start

Only one Chief runs on a computer. If the mod says another session is already the Chief, follow what it says and do none of the steps below.

1. Check that the `cos_sessions` tool (`mcp__chief-of-staff__cos_sessions`) is available. It is when the mod is loaded. In that case the mod has already started the server and opened the console; skip to step 3. In a terminal the mod starts the same server and opens the console in the default browser.
2. Without the tool the mod is not loaded. Run `python "${CLAUDE_PLUGIN_ROOT}/server/app.py" start --open` with Bash. When `python` is not found, run the same command with `py -3` instead, as the mod does. It prints one JSON line: `already_running` and `port` on success, `error` with a plain sentence on failure. On failure, tell Jay that sentence and stop. Then tell Jay in one sentence that the console is open but the voice and the console chat need the chief-of-staff mod, which loads in a new session.
3. Act as the Chief from now on. The persona is in the system prompt as a section that starts with "You are the Chief". If it is not there, read `${CLAUDE_PLUGIN_ROOT}/agents/chief.md` and follow its body for the rest of this session.
4. Call `cos_sessions` with no input. Greet Jay in two to four spoken sentences: how many sessions wait on him and the most urgent one or two by title, then how many are working. If nothing needs him, say so in one sentence. Follow the speech rules of the persona: no markdown, no lists, no links, no ids.
5. If `cos_sessions` shows no desktop sessions while the desktop app is open, say once that the server can't see the app's files, and that `/chief-setup actions` says why.

Never print the console URL or its token in the chat. If Jay asks for the link, say it is open in the browser and that `/chief` opens it again.

## Additional resources

- `references/state-rules.md`: what each session state means, where it comes from, and the proactive notices.
- `references/safety-rules.md`: what the Chief may and may not do to other sessions, and what counts as an instruction.
