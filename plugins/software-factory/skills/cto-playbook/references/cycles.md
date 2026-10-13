# Cycle planning

A cycle is a fixed time box per team (from Linear, or local 14-day cycles). At each cycle start the
CLI creates a `cycle_plan` task for that team. You decide what the team commits to; the CLI
dispatches stream work only when it is committed to the team's current cycle (or is P0). Goal work
is never blocked by cycles; committing it only moves it ahead of other work of the same priority.

## Inputs

| Brief field | Use |
|---|---|
| `cycle`, `next_cycle` | `{id, number, starts_at, ends_at}` of the cycle you plan and the one after |
| `capacity` | `{builder_slots, stream_builder_slots, stream_window_budget_left}` |
| `team_work[]` | The team's open items and goal tasks: `{id, kind, goal_id, title, priority, size, status, cycle}` |
| `baseline_path`, `team_baseline` | Human PRs, blocked work and tracker issues already in the cycle |
| `docs/cycles/<team>-<number - 1>-plan.md` | The previous plan, when it exists |

`node "<cli>" cycle show --team <team>` prints committed, done and open counts per cycle.

## Capacity

1. Slots: `capacity.builder_slots` times the working days left in the cycle (stream work:
   `capacity.stream_builder_slots`). Count an S code
   task as 1 slot-day and an M task as 2. A triage task is half a slot-day.
2. Budget: `capacity.stream_window_budget_left` divided by the task estimates (`budget.estimates`).
3. Capacity is the smaller of the two, minus 20 percent slack for rework and surprises.
4. Stream share: stream work may use up to `streams.capacity_pct` percent of capacity while goal
   tasks are waiting. P0 is outside every limit.

## Order

| Rank | Work | Rule |
|---|---|---|
| 1 | P0 items | Always `current`, even over capacity. Say so in the plan |
| 2 | Carryover that is still wanted | Unfinished tasks of the previous cycle (step below) |
| 3 | Goal tasks on the critical path | From `plan.md` of each goal; earliest wave first |
| 4 | P1 bugs | Oldest first |
| 5 | Tech debt and chores, then P2-P3 bugs | Up to the stream share |
| 6 | Everything else | `next` or `none` |

## Carryover

For each task still open with the previous cycle's id in `cycle`:
- Started and still needed: `current`. Note why it slipped (blocked, too big, waiting on a gate).
- Not started and still needed: rank it again with the rest; it does not keep its place for free.
- No longer needed, or a duplicate: `none`, and a `note`. Cancel nothing for this reason alone.
- Two cycles of carryover in a row: name it in the plan's headline and consider splitting it in
  the next escalation.

## Commit rules

- Commit with `node "<cli>" cycle commit <T> --cycle current|next|none`. One command per task.
- Commit a triage task, not its code tasks: code tasks created by triage copy its cycle and priority.
- Never commit work of another team. Never change a priority; ask the user in `open_questions`.
- With Linear cycles, the CLI pushes the issue's cycle. A human change in Linear comes back as a
  field update, so re-read `cycle show` before you assume your commit stands.
- Confirm with `cycle show --team <team>` at the end and quote the counts in the summary.

## Plan document

Write it at `output_paths[0]` (`docs/cycles/<team>-<number>-plan.md`), at most 60 lines:

```
# <team name> cycle <number> plan (<starts_at> to <ends_at>)
## Headline        3 lines: committed count, capacity used, the biggest risk
## Capacity        slots, budget, slack, stream share
## Committed       table: task | kind | priority | size | why
## Carryover       table: task | from cycle | decision | reason
## Not this cycle  task ids moved to next or none, one line each
## Risks           blocked work, human PRs in the same files, open gates
```
