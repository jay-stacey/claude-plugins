---
name: manager
description: This skill should be used when the user types "/manager" or asks to "review my sessions", "what sessions are stale", "which sessions need my reply", "what is waiting on me", "what can I archive", "archive finished sessions", "archive stale sessions", "bulk archive sessions", "clean up my sessions", "clean up worktrees", or "session to-do list". Reviews every open Claude desktop session, returns a short to-do list with one step per session, and offers to archive finished and long-idle ones with their worktrees.
argument-hint: "[--stale-days N] [--bulk-days N]"
allowed-tools: Agent, ToolSearch, AskUserQuestion, mcp__ccd_host__get_storage_usage
---

# /manager

Review all open sessions, then help clean up. The `session-advisor` agent carries the full sorting procedure. Do not repeat it here.

## Arguments

Arguments arrive as `$ARGUMENTS`.

| Flag | Effect | Default |
|---|---|---|
| `--stale-days N` | Days without activity before a session counts as stale | 3 |
| `--bulk-days N` | Days without activity before a stale session may be bulk archived | 14 |

If a number is not a whole number from 1 to 365, use the default and say so in one line. `--bulk-days` must not be smaller than `--stale-days`. Ignore any other text and say so in one short line.

## Process

1. Call the Agent tool with `subagent_type: "session-manager:session-advisor"`. Put `stale-days: N` and `bulk-days: N` each on its own line in the prompt. Put `today:` and the current date and time on its own line too, because the agent has no clock. Run it in the foreground, because the next step needs its report.
2. Copy the agent report into the reply in full. Do not shorten it and do not add a second summary.
3. If the report has a "Done, not archived" section, offer to archive those sessions. Ask once with AskUserQuestion. Use full sentences in the question. Give two options: archive all listed done sessions (recommended), or archive none. Let the user pick single sessions through the "Other" answer.
4. For each approved session, load `mcp__ccd_session_mgmt__archive_session` with ToolSearch, then call it with the session ID and a short reason such as "PR merged" or "work finished". Archiving also removes the session's worktree (the app's own copy of the repo), unless the worktree holds uncommitted changes. The app asks the user to approve each call. If the app refuses a session (still running, pinned, or open on screen), report that in one line and move on.
5. Bulk archive. If the report's "Bulk archive list" has sessions, show the count and group them by age (for example "14 to 30 days", "30 days or more"). Name the 5 oldest titles. Ask once with AskUserQuestion, in full sentences. Give two options: archive the oldest 20 now (recommended), or archive none. Let the user pick another number through the "Other" answer. Never archive more than 20 sessions in one run, and say how many are left. Then archive each approved session as in step 4, with the reason "stale, no activity for N days". Tell the user once, before the first call, that the app may ask for approval on each archive, and that a different permission mode can lower the number of prompts.
6. Worktree check. After any archive, call `mcp__ccd_host__get_storage_usage` with `refresh: true`. Report in two lines at most: how much space the worktrees use, and which archived sessions kept a worktree because it holds uncommitted changes. Name those sessions. Do not delete a kept worktree unless the user names that session. If the user asks, use `mcp__ccd_host__discard_kept_worktree` for that one session only, and say first that the uncommitted changes cannot be recovered. If many idle worktrees remain for sessions that were not archived, offer `mcp__ccd_host__clean_up_worktrees` with `older_than_days: 30`. The sessions and branches stay. The app shows its own approval card.
7. End with exactly one line that starts with "Next:". Pick the most urgent item from "Needs your reply". If that section is empty, pick the oldest stale session. If both are empty, write "Next: nothing needs action."

## Rules

- Archive only after the user says yes in this conversation. Never call `delete_session`.
- Bulk archive covers only sessions on the agent's "Bulk archive list". That list excludes sessions with an open PR, running sessions, and sessions that need a reply. Never add a session to it by hand.
- Never discard a worktree or clean up worktrees without a clear yes from the user for that action. A yes to archive is not a yes to discard.
- Never send a message to another session, stop a session, or change its sidebar state unless the user asks for it by name.
- Never archive a session from the "Needs your reply" or "Waiting on a pull request" sections unless the user names it.
- Keep every reply short and in simple words.
- This skill works only in the Claude desktop app Code tab. If the agent reports that session tools are missing, tell the user that in one sentence and stop.

## Output

The agent report, then the archive result (what was archived, what was refused), then the worktree line, then one "Next:" line.
