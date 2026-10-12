# Spec template

Cap: S 40 lines, M 120, L 250. Tier S may merge Approach and Components into one section and
skip Alternatives. The Repos section counts toward the cap; keep it to the table and one line per contract.

```markdown
# Spec: <goal title> (<G-id>)

PRD: <path>. Covers AC-1..AC-n.

## Summary
<3-5 sentences: what will be built and the main design choice.>

## Approach
<How it works end to end. Name the existing patterns in the repo it follows, with paths.>

## Repos
<Workspace mode only (the brief has `workspace: true`); in a single-repo setup write "None.".
Which repo owns which component, and every contract that crosses repos (route, payload, status
codes, event), stated once here and copied into both sides' tasks.>
| Repo | Owns | Depends on |
|---|---|---|
| dealerpull-api | `POST /vin/decode` handler and tests | none |
| project-neo | VIN lookup screen that calls it | dealerpull-api contract above |

## Components and files
| Component | Repo (workspace only) | Files (exists / new) | Role | Notes |
|---|---|---|---|---|
| <name> | <repo> | `src/x/y.ts` (exists), `src/x/z.ts` (new) | backend-engineer | |

## Interfaces and contracts
<Each new or changed route, payload, event, function or schema: name, inputs, outputs, errors,
status codes, nullability. Precise enough for two builders to work in parallel.>

## Data
<Only if data changes. Schema change, expand-then-contract steps, backfill (idempotent, batched),
down migration, rollback steps. Mark anything destructive: "DESTRUCTIVE: <what>".>

## Alternatives (tier M and L)
- <alternative>: rejected because <reason>.

## Risks and flags
- risk_flags: <auth | secrets | input-parsing | file-io | network-io | new-dependency | data-deletion | migration | none>
- R-1: <risk> - mitigation: <how>

## Test strategy
| AC | Component | Test level | Where |
|---|---|---|---|
| AC-1 | <component> | unit / integration / e2e | `test/...` (new) |

## Rollout
<Order of release, feature switch if any, how to roll back, what to watch after merge.>
```

Checks before handing off:
- Every PRD AC appears in the Test strategy table with a component and a test level.
- In workspace mode every component names its repo, and every cross-repo contract is in Interfaces and contracts.
- Every path in Components exists (checked with Glob) or is marked "new".
- Every new dependency is named here; builders may add no others.
- Risk flags match the content; any flag adds a security review.
