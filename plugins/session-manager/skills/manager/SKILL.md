---
name: manager
description: This skill should be used when the user types "/manager" or asks to "review my sessions", "what sessions are stale", "which sessions need my reply", "what is waiting on me", "what can I archive", "archive finished sessions", "clean up my sessions", or "session to-do list". Reviews every open Claude desktop session, returns a short to-do list with one step per session, and offers to archive finished ones.
argument-hint: "[--stale-days N]"
allowed-tools: Agent, ToolSearch, AskUserQuestion
---

# /manager

Review all open sessions, then help clean up. The `session-advisor` agent carries the full sorting procedure. Do not repeat it here.

## Arguments

Arguments arrive as `$ARGUMENTS`.

| Flag | Effect | Default |
|---|---|---|
| `--stale-days N` | Days without activity before a session counts as stale | 3 |

If N is not a whole number from 1 to 365, use 3 and say so in one line. Ignore any other text and say so in one short line.

## Process

1. Call the Agent tool with `subagent_type: "session-manager:session-advisor"`. Put `stale-days: N` on its own line in the prompt. Put `today:` and the current date and time on its own line too, because the agent has no clock. Run it in the foreground, because the next step needs its report.
2. Copy the agent report into the reply in full. Do not shorten it and do not add a second summary.
3. If the report has a "Done, not archived" section, offer to archive those sessions. Ask once with AskUserQuestion. Use full sentences in the question. Give two options: archive all listed done sessions (recommended), or archive none. Let the user pick single sessions through the "Other" answer.
4. For each approved session, load `mcp__ccd_session_mgmt__archive_session` with ToolSearch, then call it with the session ID and a short reason such as "PR merged" or "work finished". The app asks the user to approve each call. If the app refuses a session (still running, pinned, or open on screen), report that in one line and move on.
5. End with exactly one line that starts with "Next:". Pick the most urgent item from "Needs your reply". If that section is empty, pick the oldest stale session. If both are empty, write "Next: nothing needs action."

## Rules

- Archive only after the user says yes in this conversation. Never call `delete_session`.
- Never send a message to another session, stop a session, or change its sidebar state unless the user asks for it by name.
- Never archive a session from the "Needs your reply" or "Stale" sections unless the user names it.
- Keep every reply short and in simple words.
- This skill works only in the Claude desktop app Code tab. If the agent reports that session tools are missing, tell the user that in one sentence and stop.

## Output

The agent report, then the archive result (what was archived, what was refused), then one "Next:" line.
