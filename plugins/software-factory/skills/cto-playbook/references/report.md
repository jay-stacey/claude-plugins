# CTO reports and improvement proposals

A `report` run tells the user how the factory is doing and proposes small, reversible changes to
how it works. Every number comes from `metrics_path` (built by `report data`) or the baseline.
When `last_report` is not null, read it and show the change since then ("up from 2 to 5").

## When a report runs (`report_type`)

| Type | Why it runs | Focus |
|---|---|---|
| `periodic` | `reports.every_h` passed (default 24 h), or the first report after the first task | Whole factory |
| `idle` | Nothing to dispatch, nothing running, enough events since the last report | Why work stopped; what the user can unblock |
| `cycle_review` | A team's cycle ended | That `team`: committed versus done, carryover, the cycle plan versus reality |
| `requested` | The user ran `/software-factory:report --now` | Whole factory |

## Template

Write it at `output_paths[0]` (`docs/reports/<YYYY-MM-DD>-<HHmm>-<type>[-<team>].md`; the team suffix is for `cycle_review`). At most 80 lines.
Plain words, short sentences, no emoji. Leave a section out only when it has nothing, and say so
in one line.

```
# CTO report <YYYY-MM-DD HH:mm> (<report_type>)
Period <from> to <to>. Team: <team id or "all">.

## Headline
<3 lines: the one thing that matters most; progress as one number; what needs the user now>

## Progress
- <goal id> <title>: <status>, <done>/<total> tasks, <budget pct>% of budget.
- Streams: <team> bugs +<opened> / -<closed>, tech debt +<n> / -<n>, chores +<n> / -<n>.
- Cycle (cycle_review only): <committed> committed, <done> done, <n> carried over.

## Work in flight and blockers
- <n> running, <n> ready, <n> blocked. Oldest blocked: <T-id> for <h> h, needs <who>.
- Gates waiting: <GATE-id> <type> for <h> h.
- PRs: <n> opened, <n> merged, <n> open. Human PRs overlapping factory work: <PR numbers>.

## Cost
- <tokens> tokens. Top roles: <role> <tokens>, ... Dispatcher overhead <pct>%, unattributed <pct>%.
- Estimate versus actual: <kind> <ratio>, ... (finished runs only).

## Quality
- First-pass review rate <pct>%. Rework <n>. Fix-up runs <n>. Failed tasks <n>. Escalations <n>.
- Median ready to done <h> h, p90 <h> h (code tasks).

## Process review
- <what slowed the team> - <metric> (<task, run or gate ids>).   2 to 5 lines

## Proposals
- P-1 <title>: <the change in plain words>. Risk <low|medium|high>.
Decide each one with /software-factory:approve.
```

## Picking proposals from the metrics

Propose only when the metric is clear and there are at least 5 data points behind it. At most
`reports.max_proposals` (default 5), one change each, highest expected effect first.

| Signal in metrics | Proposal | Change |
|---|---|---|
| Estimate/actual ratio above 1.5 or below 0.6 for one kind | Fix that estimate | `config` `budget.estimates.<kind>`: median actual, rounded to 50,000 |
| First-pass review rate below 60% for one builder role, same finding type repeats | Teach the role | `overlay_note` for that role naming the repeated finding and the check to run first |
| Fix-up runs or failed tasks high for one role while others are fine | Stronger model for that role | `config` `models.by_role.<role>`: `"opus"` (risk medium: cost) |
| Ready tasks wait while builders are full, and the budget has room | One more builder | `config` `concurrency.builders`: +1 (risk medium) |
| Many human PRs overlap factory work | Fewer builders until it clears | `config` `concurrency.builders`: -1, or `advice` |
| Dispatcher overhead above 10% of tokens, or many idle ticks | Tick less often | `config` `cadence.active_s` or `cadence.waiting_s`: larger values |
| Bugs opened exceed bugs closed two periods running | More stream capacity | `config` `streams.capacity_pct`: +10, at most 50 |
| A stream or the ops goal hit its budget window | Bigger window | `config` `streams.budget_tokens_per_window` or `ops.budget_tokens_per_day` |
| Reports with almost no events | Report less often | `config` `reports.every_h`: double it |
| Cycle carryover above 30% | Commit less per cycle | `advice` (the plan is yours to change next time) |
| Gates wait more than 24 h on median | Faster decisions | `advice` to the user |

Before you propose, run `gate list --all` and skip a proposal that is still pending, or was
rejected in the last 7 days unless the metric got clearly worse.

## Allowed config keys

A `config` patch may only use keys that start with: `concurrency.`, `cadence.`,
`budget.estimates.`, `budget.warn_pct`, `reviews.profile`, `models.by_role.`, `models.all`,
`streams.capacity_pct`, `streams.budget_tokens_per_window`, `streams.pull`, `streams.epic_review`,
`ops.budget_tokens_per_day`, `reports.`, `baseline.`, `cycles.plan_at_start`,
`cycles.review_at_end`. Any other key rejects the whole patch. Budgets per goal, gates, roles,
teams, tracker and repos are never proposals; ask the user in `open_questions` instead.

## Proposal shape (handoff `proposals[]`)

`{id: "P-<n>", title (<= 80 chars), why (<= 400 chars, cites the metric), change, expected_effect
(<= 200 chars), risk: low|medium|high}`. `change` is one of:
- `{"kind": "config", "patch": {"<dotted key>": <json value>}}`
- `{"kind": "overlay_note", "role": "<role id>", "note": "<= 300 chars"}`
- `{"kind": "advice"}`

```json
{
  "id": "P-1",
  "title": "Raise the code_S estimate to match real runs",
  "why": "code_S runs used 2.1x their estimate (median 520k vs 250k, 9 runs), so budget forecasts at intake are too low.",
  "change": {"kind": "config", "patch": {"budget.estimates.code_S": 500000}},
  "expected_effect": "Intake budget checks and the plan forecast match real spend within 20%.",
  "risk": "low"
}
```

Approval applies the change; you never do. A rejected `config` patch leaves the config unchanged,
and the reason is in the gate notes, so read them before the next report.
