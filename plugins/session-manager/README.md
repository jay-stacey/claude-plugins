# session-manager

Keeps the Code tab sidebar tidy.

- **Auto-file:** each new session files itself into a sidebar section for its project (for example `dealerpull-api`, `InventoryFeeds`, `Security`). It happens after a turn ends, once the session has a real title.
- **`/organize`:** sorts all ungrouped sessions into sections in one go, after one yes.
- **`/manager`:** reviews your open sessions, gives a short to-do list with one next step each, offers to archive done and stale ones with their worktrees, then groups what is left.

## What it sorts

| Bucket | Meaning |
|---|---|
| Needs your reply | The session asked a question or waits for approval. |
| Done, not archived | The PR merged or closed, or the work is finished. |
| Stale | No activity for 3 days (change with `--stale-days N`). |
| Waiting on a pull request | PR is open and the session is idle. |
| Active | Running now, or recently used. |

## Parts

| Part | File | Job |
|---|---|---|
| Skill | `skills/manager/SKILL.md` | The `/manager` command. Runs the agent, offers to archive done and long-idle sessions, checks worktrees, then groups the rest. |
| Skill | `skills/organize/SKILL.md` | The `/organize` command. Sorts ungrouped sessions into project sections. |
| Agent | `agents/session-advisor.md` | Reads sessions and writes the report. Read only. |
| Hooks mod | `hooks/register.ts` | Auto-file: moves this session into its project section after a turn. Adds `/organize-self`. |
| Project list | `hooks/projects.ts` | Sections, old names they replace, and the title patterns. Edit this to add a project. |

## Grouping

- A session goes to the first project in `hooks/projects.ts` whose pattern matches its title, branch or folder. `Security` is first, so security work goes there even when it touches one repo.
- An existing section is reused when its name matches the project or one of its aliases (an existing `DP1` section is used for dp-web-ui).
- A session you filed yourself, or a pinned session, is never moved. `/organize --regroup` re-sorts filed sessions too.
- No match means no move. A wrong section is worse than none.
- Auto-file only ever moves its own session, so the app does not ask. `/organize` moves other sessions, so the app may ask once per section.
- `/organize-self` files this session now. `/organize-self off` turns auto-file off everywhere; `on` turns it back.

## Bulk archive and worktrees

After the report, `/manager` can archive many sessions at once.

- **Done sessions:** archived on your yes.
- **Stale sessions:** idle for 14 days or more (change with `--bulk-days N`), no open PR, not running, and not waiting on you. Up to 20 per run, oldest first.
- **Worktrees:** archiving a session also removes its worktree (the app's own copy of the repo). A worktree with uncommitted changes is kept. `/manager` lists those sessions. It discards one only when you name that session, because the changes cannot be recovered.
- **Leftover worktrees:** for sessions that are not archived, `/manager` can offer the app's "clean up inactive sessions" step (30 days). Sessions and branches stay.
- The app may ask you to approve each archive. A different permission mode lowers the number of prompts.

## Rules

- The agent only reads. It never changes a session.
- The skill archives a session only after you say yes in chat. The app also asks you to approve each archive.
- It never deletes a session and never messages another session on its own.
- It never archives a session with an open PR, a running session, or one that waits on you, unless you name it.
- It does not put customer details in the report.

## Requirements

The Claude desktop app, Code tab. The session tools (`list_sessions`, `list_events`, `archive_session`) come from the app. They are not there in the plain terminal.

## Install

```bash
claude plugin marketplace add jay-stacey/claude-plugins
claude plugin install session-manager@personal-plugins
```

To test from a folder, without installing:

```bash
claude --plugin-dir ./plugins/session-manager
```

## Usage

```
/manager
/manager --stale-days 7
/manager --bulk-days 30
/manager --no-group
/organize
/organize --dry-run
/organize --regroup
```

If another plugin also has a `/manager` command, type `/session-manager:manager` instead.
