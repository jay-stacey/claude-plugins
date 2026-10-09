# session-manager

Type `/manager` in a new session. It reviews your open Claude sessions and gives you a short to-do list with one next step each.

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
| Skill | `skills/manager/SKILL.md` | The `/manager` command. Runs the agent, then offers to archive done sessions. |
| Agent | `agents/session-advisor.md` | Reads sessions and writes the report. Read only. |

## Rules

- The agent only reads. It never changes a session.
- The skill archives a session only after you say yes in chat. The app also asks you to approve each archive.
- It never deletes a session and never messages another session on its own.
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
```

If another plugin also has a `/manager` command, type `/session-manager:manager` instead.
