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
| pr_feedback | staff-engineer | rework tasks | PR gets changes requested |
| escalation | cto | decision via CLI | failures, stalemates, replans |
| research | any planner | a document | optional, to answer a question |

Choosing the builder role for a new code task:
- Touches migrations, schema or data access only: `data-engineer`.
- Touches server code (even if it reads new data): `backend-engineer`.
- Touches client or UI code: `frontend-engineer`.
- Touches CI, build scripts, infrastructure or release config: `devops-release`.
- Mixed: split it into one task per role with `depends_on` between them.

Review groups (lean profile) are set by the engine: code review per code task, plus security review
in the same group when `risk_flags` is not empty, plus task QA only for frontend tasks. Do not add
reviewers by hand except through `risk_flags` on a task.

Question routing:
- What the user should see or get, scope: `product-manager`, then `user`.
- How it should be built, interfaces, data: `staff-engineer`.
- Conflicts between gates, budget, priority, anything destructive: `user`.
