# Release notes template

Cap: S 20 lines, M 40, L 80. Written only from what the epic diff changed.

```markdown
# Release notes: <goal title> (<G-id>), <E-id>

## What changed
- <user-visible change, in user words> (AC-1)

## How to use it
- <steps or command; every command here was run through `evidence run`: EV-n>

## Upgrade and migration
- <config to set, migration to run, order of steps; "None." if nothing>

## Known limits
- <what is out of scope or not yet done>

## Rollback
- <how to undo: revert the PR, run the down migration, switch off the feature switch>
```

Rules:
- Never describe behaviour that is not in the diff.
- Commands are copied exactly as they were run; output shown is from the evidence log.
- No internal ids beyond goal, epic and AC ids; no personal data.
