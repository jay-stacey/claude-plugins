# Escalation decisions

Pick the smallest decision that fixes the root cause. Record it with `note` and in the handoff.

| Root cause | Decision | Commands |
|---|---|---|
| Transient: environment hiccup, usage limit, flaky infrastructure (evidence shows it) | Retry as is | `task retry <T>` |
| Author missed something the findings name clearly | Retry with the findings carried in feedback (the engine does this) | `task retry <T>` |
| Task too big or mixes roles | Split: cancel or narrow the task, create smaller tasks | `task replan <T> --file`, `task new --file` |
| Wrong order: a dependency was missing or late | Add the dependency, then retry | `task replan <T> --file` (depends_on), `task retry <T>` |
| Missing prerequisite work (fixture, shared helper, flaky test fix) | New task, make the stuck task depend on it | `task new --file`, `task replan <T> --file`, `task retry <T>` |
| Spec gap or wrong contract | New `research` or `spec` task for the staff-engineer; stuck task waits on it | `task new --file`, `task replan <T> --file` |
| qa_epic or review_epic failed | One rework code task per finding cluster, on the owning role | `task new --file` |
| Reviewer and author still disagree after 3 rounds, on a major | Decide on the evidence. Agree with the reviewer: new rework task. Agree with the author: waive the major with a logged reason | `task new --file` or `note "WAIVE <T> <F>: <reason>"` |
| Disagreement on a blocker, product question, criterion change, budget, destructive step | Block on the user | handoff `status: blocked`, `verdict: escalate`, question to `user` |
| Task no longer needed | Cancel | `task cancel <T>` |

Blocking on the user: the question states the problem in one sentence, option A and option B with
the cost of each (tokens, time, risk), and your recommendation. Nothing else.

Never:
- Waive a blocker, or waive a major without a written reason.
- Retry a third time with nothing changed.
- Put the author's reasoning into a reviewer's task description.
- Edit acceptance criteria to make work pass.
