# Tiering rules

Pick the smallest tier whose every condition holds. If any condition of a tier fails, move up.
When in doubt between two tiers, choose the larger one.

| Tier | Conditions | Budget default | What changes |
|---|---|---|---|
| S | 3 code tasks or fewer; one area of the codebase; no schema change; no new dependency; no risk flag | 5M tokens | PRD and spec presented together (G1 and G2 on one screen, two records); short templates |
| M | 10 code tasks or fewer, or any schema change; no risk flag | 15M tokens | Normal flow |
| L | More than 10 code tasks; several services or deployables; new infrastructure; or any risk flag (auth, secrets, input parsing, file or network I/O, new dependency, data deletion) | 40M tokens | Critic reviews the PRD; alternatives required; security review on the spec |

Signals to check in the repo:
- Count the areas the outcome touches (folders, services, packages). More than one: not S.
- A new table, column, index or stored data shape: at least M.
- A new runtime dependency, external service, authentication, authorisation, secrets, payments,
  personal data, untrusted input parsing, file or network I/O, or deletion of user data: L.
- A new deployable, pipeline or environment: L.

`needs_ui` is independent of tier. A UI goal adds the mockup task and gate G3, and the frontend
tasks wait for G3.

Pod members by signal:
- Server code, APIs, jobs: `backend-engineer`.
- Schema, migrations, backfills, data access: `data-engineer`.
- Screens or client code: `frontend-engineer` (and the goal has `needs_ui: true`).
- CI, build, infrastructure, release configuration: `devops-release`.
- `tech-writer` joins every pod that changes public behaviour (one docs task per epic).

Budget sanity check: estimate code tasks times `code_S` or `code_M`, plus one review per code task,
one QA per UI task and per epic, plus planning (`prd`, `spec`, `mockup`, `breakdown`, `sequence`).
If that exceeds 80 percent of the tier default, say so at intake.
