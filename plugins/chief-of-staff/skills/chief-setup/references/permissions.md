# The Chief's permission rule

## Why it is needed

The Chief changes other sessions through one mod tool, `cos_act`
(`mcp__chief-of-staff__cos_act`): archive, stop, reply, open and start, on both hosts.
In the desktop app it also uses the app's own session tools,
`mcp__ccd_session_mgmt__archive_session` and `mcp__ccd_session_mgmt__send_message`,
when `cos_act` hands an action back to it, and `mcp__ccd_session__start_session` to start
sessions.

Claude Code asks the user to approve each of these calls, except in auto mode, where its
classifier decides. A request that arrives by voice or from the console reaches the Chief
as a prompt the mod submitted, not as text the user typed, so auto mode may refuse the
call. A permission rule allows the tools for sessions in that folder. The rule settles the
call before the classifier runs. Nothing in the plugin approves its own calls in code.

## The rule

Desktop app Chief, or both hosts:

```json
{
  "permissions": {
    "allow": [
      "mcp__chief-of-staff__cos_act",
      "mcp__ccd_session_mgmt__archive_session",
      "mcp__ccd_session_mgmt__send_message"
    ]
  }
}
```

To stop background sessions without a question each time, also add `Bash(claude stop *)`
(the stop rule below). Without any rule for it, Claude Code asks before the stop runs.

Terminal Chief:

```json
{
  "permissions": {
    "allow": [
      "mcp__chief-of-staff__cos_act"
    ]
  }
}
```

`cos_act` can only be allowed whole. Claude Code skips any `mcp__` rule with parentheses,
so a rule cannot narrow it to some actions. The mod's own checks limit what it does.

Rules not added, and why:

- `Bash(claude --bg *)`: the mod runs it itself with fixed arguments. A rule would invite
  the Chief to skip `cos_act` and its checks.
- `Bash(claude rm *)`: never allowed. The Chief never removes a background session.
- `SendMessage` and `ListAgents`: replies use the engine's cross-session send, and
  same-machine messages need no prompt. There is no `SendMessage` allow rule.

## The stop rule (`Bash(claude stop *)`)

The mod runs `claude stop <id>` itself, but Claude Code still checks that command against
the user's rules. With no rule, the answer is "ask", which a desktop Chief cannot satisfy
reliably (see "Desktop Chief and ask rules"). So to let `cos_act` stop background sessions,
add this to `permissions.allow`:

```json
"Bash(claude stop *)"
```

This does not skip the Chief's checks. The mod still asks the user first, in the Chief's
session, when the session is working, and `cos_act` is still the only way the Chief stops a
session: the shell guard refuses a shell `claude stop`. Add the rule to `permissions.deny`
instead to keep the Chief from stopping anything.

If auto mode refuses the edit of `.claude\settings.local.json` (it counts as the Chief
changing its own permissions), give the user this to paste into the file, and keep any
other keys already there:

```json
{
  "permissions": {
    "allow": [
      "mcp__chief-of-staff__cos_act",
      "mcp__ccd_session_mgmt__archive_session",
      "mcp__ccd_session_mgmt__send_message",
      "Bash(claude stop *)"
    ]
  }
}
```

## Where it goes

The file is `.claude\settings.local.json` in the git repository root of the Chief's folder
when that folder is in a git repository, else in the Chief's folder. Claude Code reads the
local file at the repository root for any subfolder, and keeps it out of git when it
creates the file itself. Setup writes it by hand, so it also checks
`git check-ignore .claude/settings.local.json` and, after a yes, adds the file to that
repository's `.gitignore` when it is not ignored.

The yes or no question names the exact file path and says "every session started in this
folder (or repository) gets this rule".

An older install wrote the two desktop rules to `.claude\settings.json`, the shared file.
Show those lines and offer to move them to the local file. Move them only after a yes.

## Merging into an existing file

1. Read the file. If it is not valid JSON, stop and show the user the problem.
2. Keep every key. Create `permissions` and `permissions.allow` only when missing.
3. Add each name to `allow` only when it is not there yet.
4. Write the file with two-space indentation.

Show the user the resulting file before writing, and write only after a yes. Auto mode may
refuse an edit to its own permission settings; then give the user the path and content to
create the file themselves.

## Desktop Chief and ask rules

In the desktop app, the Chief cannot tell the user's typed yes from other messages. When the
user's settings ask for `claude stop`, `claude --bg` or `SendMessage` (an unset rule counts as
ask), `cos_act` acts as follows:

- Before the user has typed anything in the Chief's session, it refuses with "Your settings
  ask before this runs", and the message gives the exact rule to add.
- After the user has typed in the Chief's session, it returns `needsConfirm`. One typed yes
  in answer to the Chief's question covers every action in that question, and an action that
  fails after the yes (for example a stop that does not confirm) keeps that yes for 2
  minutes, so a retry needs no new yes.

For a desktop Chief, advise an allow or a deny rule for these instead of relying on the ask.

## What stays safe

- Archive is the strongest action. The Chief never deletes a session.
- The Chief asks before archiving or stopping a session that is working, or whose helper
  session is.
- The mod refuses `cos_act` archive or stop, and on desktop the Chief's own archive call,
  on a working session until the user has said yes.
- The server refuses an unconfirmed console archive or stop of a working session.
- No Bash rule: the mod runs `claude stop` and `claude --bg` itself with fixed arguments.
- The Chief is steered away from shell stop and kill commands. Your own permission rules
  still decide every shell command.
- `claude rm` is never run.
- Your deny rules win. Before the mod sends a message or runs `claude stop` or
  `claude --bg`, it asks the permission system, and a deny means nothing is done.
- Three levels of yes. A yes typed in the Chief's own session counts for everything. A yes
  spoken, typed in the console chat, or given with a console button answers only "it's
  working, stop or archive anyway?", never an ask rule. A message from another session is
  never a yes.

## Why an action failed

`/chief-setup actions` runs these checks, read-only. `HOME` is
`%USERPROFILE%\.claude\chief-of-staff`. The settings files are `.claude\settings.json` and
`.claude\settings.local.json` in the git repository root of the Chief's folder when that
folder is in a git repository, else in the Chief's folder, plus
`%USERPROFILE%\.claude\settings.json`.

| Check | How | Failure means | Fix the check gives |
|---|---|---|---|
| Server version | `/api/health` `version` | not the plugin's version (`app.py start` reports `stale`) | Type `/chief`. The mod restarts an older server when no live Chief holds the role. If one does, type `/chief stop` there first |
| Desktop files seen | `python server/app.py status`: `desktop.source` (`env`, `appdata`, `msix` or `none`) and `desktop.files` | `none` or 0 while the app is open | Update the plugin, or set `COS_DESKTOP_DIR` to the package folder |
| Host tools | `/api/health` `chief.host.surface` and `chief.host.caps.desktopSessions` | false in a terminal | Expected. A desktop archive opens the session in the app |
| Allow rule | the settings files | `mcp__chief-of-staff__cos_act` missing | `/chief-setup permissions` |
| Ask rule on a desktop Chief | the settings files: an `ask` rule for `Bash(claude stop ...)`, `Bash(claude --bg ...)` or `SendMessage`, with `chief.host.surface` `desktop` | that action is always refused in the desktop app | Set it to allow or deny with `/chief-setup permissions` |
| Messaging off | the settings files: `SendMessage` in `deny`, or `crossSessionInbound: "refuse"` | messages are off on purpose | Remove the setting to allow it, only with the user's yes |
| CLI version | `claude --version` | below 2.1.234 | `claude update` |
| `claude` on PATH | `where claude` (`Get-Command claude`) | missing | The mod cannot stop or start background sessions |
| Last failures | the last 5 `act:` lines in `HOME\logs\mod.log` | the outcome and detail of each failure | Say each `detail`. A `failed` message to a held session means the target is in bypass mode |

An `act:` line has the form `act: <verb> <sessionId or -> <console or model> <outcome> <detail>`.

## Removing it

Delete the names from `permissions.allow`. The Chief then asks for approval on each action,
or is refused in auto mode, and says so.
