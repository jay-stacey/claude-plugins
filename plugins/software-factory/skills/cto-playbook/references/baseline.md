# Baseline and assessment

The baseline is the current state of the repos, teams and work in flight. The CLI collects it
(`baseline collect`); you never do. An `assess` run reads it and lines the factory's plans up with
what people are already doing.

## Files

| File | What it holds |
|---|---|
| `runs/<run_id>/baseline.json` (`baseline_path`) | Copy of `state/baseline.json` for this run |
| `docs/baseline/factory.md` | Whole-factory summary, at most 80 lines |
| `docs/baseline/teams/<team>.md` (`team_baselines[]`) | One per team, at most 80 lines |
| `docs/baseline/assessment-<YYYY-MM-DD>.md` (`output_paths[0]`) | Your assessment |

`baseline.json` keys: `repos.<repo>` has `team`, `base_branch`, `head_sha`, `recent_commits_7d`,
`open_prs[]` (`number, title, url, head, author, draft, review_decision, updated_at, files[],
factory`), `pr_error`, `branches[]` (`name, ahead, behind, last_commit_at`) and
`factory_branches`. `factory.teams.<team>` has `tasks {<status>: n}`, `blocked[]` (`task_id,
title, since, needs`), `items_open` and `cycle`. `factory.gates_pending[]` has `id, type, age_h`.
`tracker.<key>` has `counts`, `in_progress[]` (`key, title, state, url, cycle_number`) and `cycle`.

## What to look for

Read open factory work with `task list` and `epic list`. Then check each row, in this order.

| Look for | How to see it | Action |
|---|---|---|
| Human PR (`factory: false`) changing files in an open task's `files_owned` | glob-match PR `files[]` against `files_owned` of tasks not `done` | Same work: `task block <T> --needs human --question "PR #<n> already does <x>. Cancel <T> or keep both?"`. Only overlap: `note` and list it; the builder sees it as `wip_conflicts` |
| Human PR that does part of a goal still in planning | PR title and files against the goal outcome | Non-blocking question to `user` in the handoff; name the PR |
| Tracker issue in progress that duplicates a factory task or item | `tracker.<key>.in_progress[]` titles against open task titles | `task block <T> --needs human --question "<KEY> is in progress and looks the same as <T>. Which one stays?"` |
| Stale factory branch (in `factory_branches`, no open task or epic uses it) | `task list`, `epic list` | List it in the assessment; propose cleanup as `advice` |
| Stale human branch (ahead of base, no commit for 30 days) | `branches[].last_commit_at` | List it only. Never act on human branches |
| Blocked task older than 24 hours | `factory.teams.<team>.blocked[]` | Cause gone: `task replan` or `task retry`. Waiting on a human: restate the question in the headline |
| Gate pending more than 48 hours | `factory.gates_pending[]` | Headline line naming the gate; never decide it |
| `pr_error` set on a repo | `repos.<repo>.pr_error` | Say PR checks were not possible and why; make no PR-based decision for that repo |
| Bug or debt seen in the repo or tracker with no item (streams on) | tracker counts, failing checks on base | `item list --team <T>`, then `item new` if it is not there |
| Goal work touching a team not in `goal.teams` | epics and repos of the goal | `goal set <G> --teams <a,b,c>` |
| Committed work that no longer fits the cycle (cycles on) | `cycle show --team <T>` | `cycle commit <T> --cycle next` with a `note` |

Decisions and commands are the same as in an escalation: the smallest one that fixes the finding.
A finding you cannot act on is still written down with its evidence.

## Assessment document

Keep it under 60 lines.

```
# Assessment <YYYY-MM-DD>
## Headline            3 lines: the most important finding, what you did, what needs the user
## Findings            table: # | finding | evidence (repo, PR number, task id, tracker key) | action
## Commands run        one line per command, with its result
## For the user        open questions, the same as in the handoff
```

`proposals[]` are allowed in an assess handoff (shape in `report.md`). Use them only for a process
change the findings clearly show, for example a lower `concurrency.builders` while many human PRs
overlap factory work.
