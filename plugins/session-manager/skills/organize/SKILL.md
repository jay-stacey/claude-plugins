---
name: organize
description: This skill should be used when the user types "/organize" or asks to "organize my sessions", "group my sessions", "sort my sidebar", "put my sessions into sections", "file sessions by project", "my sidebar is a mess", or "regroup sessions". Sorts the open Claude desktop sessions into one sidebar section per project (repo), reusing sections that already exist, and moves each batch only after one yes.
argument-hint: "[--regroup] [--dry-run]"
allowed-tools: ToolSearch, AskUserQuestion, Read
---

# /organize

Sort open sessions into sidebar sections, one per project. The project list lives in `${CLAUDE_PLUGIN_ROOT}/hooks/projects.ts`. The auto-file hook in the same plugin uses that list for each new session, so both always agree.

## Arguments

Arguments arrive as `$ARGUMENTS`.

| Flag | Effect |
|---|---|
| `--regroup` | Also re-sort sessions that are already in a section. Without it, a session the user filed stays where it is. |
| `--dry-run` | Show the plan and stop. Move nothing. |

Ignore any other text and say so in one short line.

## Process

1. Load the tools in one ToolSearch call: `select:mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__get_session,mcp__ccd_session_mgmt__list_events,mcp__ccd_sidebar__list_sections,mcp__ccd_sidebar__create_section,mcp__ccd_sidebar__move_sessions`. If they are missing, say "The sidebar tools only exist in the Claude desktop app, Code tab." and stop.
2. Read `${CLAUDE_PLUGIN_ROOT}/hooks/projects.ts` for the project list: each project's `section` name, its `aliases` and its `patterns`.
3. Call `list_sessions` with `limit: 200`. Call `list_sections`. If a session has no `group` key at all, the app has not reported groups yet. Say so and stop, because a move could undo the user's own filing.
4. Pick the sessions to sort. Skip a session when any of these is true:
   - It is pinned. A move would unpin it.
   - It already has a `group`, unless `--regroup` was given.
   - It is this session.
5. Classify each picked session, in this order:
   - Test the patterns against the title, then the branch, then the folder (`cwd`). The first project in the list whose pattern matches wins. This is the same rule the hook uses.
   - No match: read the session's first 10 events with `list_events` and pick the project the work is about, judged by the repo, ticket keys (NEO-, DP1-, IF-, ADM-, PRO-) and file paths named. Read at most 15 sessions this way, newest first.
   - Still unclear: leave the session out. A wrong section is worse than none.
   Note: many sessions share one workspace folder, so the folder alone rarely tells the project.
6. Map each project to a section. Use an existing `manual` section whose name equals the project's `section` or one of its `aliases`, ignoring case. Otherwise the section will be created. Never rename or delete a section the user made.
7. Show the plan as one table: section, number of sessions, three example titles, and "new" when the section will be created. Under it, one line for the count left ungrouped and why. If `--dry-run`, stop here with a "Next:" line.
8. Ask once with AskUserQuestion, in full sentences. Two options: move all as planned (recommended), or move none. The user can change single sessions through "Other". Say in the question that the app may ask to approve each section's move.
9. On yes: create each missing section with `create_section`, then call `move_sessions` once per section with all its session ids and `section_id`. One call per section keeps the approval prompts few. If the app refuses a move, report it in one line and go on.
10. Report in at most three lines: how many sessions moved, into how many sections, and how many were left ungrouped. End with exactly one line that starts with "Next:". Suggest `/manager` for the stale check when there are more than 15 open sessions.

## Rules

- Never move a pinned session, and never move a session the user filed unless `--regroup` was given.
- Never delete, rename or reorder sections. Never archive, stop or message a session here. Cleanup is `/manager`'s job.
- Never put customer details in the plan or report. Session titles that hold a customer name get the name left out.
- Keep every reply short and in simple words.
