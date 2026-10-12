# Spec template

Cap: S 40 lines, M 120, L 250. Tier S may merge Approach and Components into one section and
skip Alternatives.

```markdown
# Spec: <goal title> (<G-id>)

PRD: <path>. Covers AC-1..AC-n.

## Summary
<3-5 sentences: what will be built and the main design choice.>

## Approach
<How it works end to end. Name the existing patterns in the repo it follows, with paths.>

## Components and files
| Component | Files (exists / new) | Role | Notes |
|---|---|---|---|
| <name> | `src/x/y.ts` (exists), `src/x/z.ts` (new) | backend-engineer | |

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
- Every path in Components exists (checked with Glob) or is marked "new".
- Every new dependency is named here; builders may add no others.
- Risk flags match the content; any flag adds a security review.
