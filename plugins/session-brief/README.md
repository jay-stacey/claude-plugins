# session-brief

A band above the prompt that tells you, at a glance, what a session was about:

- **Started:** the command or skill the session opened with, and what it was asked to do.
- **Left off:** what is done, what is not, and whether the last turn waits on you.
- **Next:** up to three concrete steps. After a planning or triage session, "go implement" is one option, not the default.
- **You should know:** up to three risks, blockers, open decisions or things that were not verified.

It also renames the session to say what the work is. "DP1-676" becomes something like "Triage DP1 queue: 7 routed, 3 held".

## How it works

1. After each main turn ends, the mod reads the session's messages: the first four (where the commands and skills are) and the last sixteen.
2. It sends that digest to Haiku with a fixed set of rules and gets back a small JSON brief.
3. It saves the brief per session, so reopening the session shows it at once with no model call.
4. It renames the session through the desktop app's own session tool (`set_session_title` on `ccd_session_mgmt`). If you typed the current title yourself, the app asks you before it changes it.

A resumed session that has no brief yet gets one when it starts. Subagent turns, interrupted turns and sessions nobody watches (`claude -p`, scheduled tasks) are skipped. A turn that did not add messages does not call the model again.

## Commands

| Command | What it does |
| --- | --- |
| `/brief` | Writes the brief again now |
| `/brief hide` / `/brief show` | Hides or shows the band for this session |
| `/brief rename` | Applies the brief's title to the session now |
| `/brief autorename off` / `on` | Turns automatic renaming off or on, for every session |

The band also has **Collapse**, **Refresh** and **Hide** buttons.

## Install

```
/plugin install session-brief@personal-plugins
```

## Tests

```
claude plugin test plugins/session-brief
```
