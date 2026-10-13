# Routing table

The engine creates most tasks itself. Use this table when you create tasks in an escalation.

| Kind | Role | Produces | When |
|---|---|---|---|
| intake | cto | tier, needs_ui, pod via `goal set` | first task of every goal |
| prd | product-manager | `prd.md` | after intake; gate G1; critic only for tier L |
| spec | staff-engineer | `spec.md` with Data section | after G1; gate G2; critic, plus security-reviewer when risk-flagged |
| mockup | ui-ux-designer | `design/` | after G2 when needs_ui; gate G3; critic |
| breakdown | staff-engineer | epics and draft code tasks | after G2 |
| sequence | project-manager | dependencies, estimates, `plan.md` | after breakdown |
| code | backend-engineer, frontend-engineer, data-engineer, devops-release | commits on the task branch | after sequence |
| docs | tech-writer | commits | one per epic, after epic review |
| qa_epic | qa-engineer | `qa/<E-id>.md` | all epic tasks integrated |
| review_epic | code-reviewer (stronger model) | `reviews/<E-id>.md` | after qa_epic passes |
| qa_goal | qa-engineer | `qa/<G-id>-goal.md` | workspace goals that span two or more repos: all epics of the goal are integrated and reviewed |
| pr_feedback | staff-engineer | rework tasks | PR gets changes requested |
| escalation | cto | decision via CLI | failures, stalemates, replans |
| research | any planner | a document | optional, to answer a question |
| triage | staff-engineer | item note, then one epic and 1-3 code tasks, or a question | each bug, tech-debt or chore item in a stream goal |
| assess | cto | `docs/baseline/assessment-<date>.md` | ops goal; a baseline exists and the last assess is older than `baseline.assess_every_h`, or `start` asked for one |
| report | cto | `docs/reports/<date>-<HHmm>-<type>.md` and `proposals[]` | ops goal; periodic, idle, cycle_review or requested |
| cycle_plan | cto | `docs/cycles/<team>-<number>-plan.md` and `cycle commit` calls | ops goal; a team's cycle starts (cycles on) |

Choosing the builder role for a new code task:
- Touches migrations, schema or data access only: `data-engineer`.
- Touches server code (even if it reads new data): `backend-engineer`.
- Touches client or UI code: `frontend-engineer`.
- Touches CI, build scripts, infrastructure or release config: `devops-release`.
- Work in two repos is always two tasks, one in each repo's epic, with `depends_on` when one needs the other.
- Mixed: split it into one task per role with `depends_on` between them.

Team of a new task: leave `team` out. The CLI takes it from the epic's repo, else the role's team,
else the goal's lead team. Set it only for planner work you want in a specific team.
Stream work: a bug or debt you find goes in with `item new --team <T> --class bug|tech_debt|chore`,
never as a code task in a goal epic. Triage turns the item into code tasks.

Review groups (lean profile) are set by the engine: code review per code task, plus security review
in the same group when `risk_flags` is not empty, plus task QA only for frontend tasks. Do not add
reviewers by hand except through `risk_flags` on a task.

Question routing:
- What the user should see or get, scope: `product-manager`, then `user`.
- How it should be built, interfaces, data: `staff-engineer`.
- Conflicts between gates, budget, priority, anything destructive: `user`.
