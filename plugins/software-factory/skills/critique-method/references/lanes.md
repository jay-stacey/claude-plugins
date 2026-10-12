# Critic lanes

One lane per critique task. Read the artifact under review and the upstream artifacts listed. Use
the checks as prompts for real failures, not as a form to fill. File layout: layout.md.

## Lane `prd` (tier L only in the lean profile)

Read: the PRD, the goal outcome and success criteria, the constitution.
Checks:
- Every goal success criterion is covered by at least one acceptance criterion.
- Each acceptance criterion is observable and testable by running software: a person or a test can
  say yes or no. Words like "fast", "easy", "intuitive", "robust" with no measure are a major.
- Ids exist (AC-1...), are unique, and each criterion states one behaviour.
- Out of scope is explicit. Anything a builder could reasonably assume is in scope but is not is
  listed.
- No solution design: no technology choices, data schemas or screen layouts unless the goal fixes them.
- Constraints from the constitution (privacy, compliance, platforms) are reflected.
- Failure behaviour is defined where users can hit it (invalid input, no permission, empty data).
- Claims about users or numbers have a source, or are marked as assumptions.

## Lane `spec`

Read: the spec, the PRD, the constitution, the overlay. Spot-check the codebase for named files.
Checks:
- Every PRD acceptance criterion traces to a component and a test level. A missing trace is a blocker.
- Every file the spec names exists (Glob) or is marked "new". A wrong path is a major.
- Interfaces are precise enough for two builders to work in parallel: names, inputs, outputs,
  errors, status codes.
- Data changes: expand-then-contract, reversible down, backfill plan, rollback. A destructive
  change not flagged as destructive is a blocker.
- Alternatives (tier M and L): at least one real alternative with the reason it lost.
- Risk flags match the content (auth, secrets, input parsing, file or network I/O, new dependency,
  data deletion, migration). A missing flag is a major because it skips security review.
- The approach fits existing patterns in the repo, or says why it departs from them.
- Workspace mode: the Repos section names the owning repo of every component, and each cross-repo
  contract is stated field by field with provider and consumer. A component with no repo, or a
  contract stated on one side only, is a major.
- Nothing in the spec quietly narrows or widens a PRD criterion.

## Lane `design`

Read: `design/README.md`, every screen HTML, the PRD, the spec's UI-facing parts, the overlay.
Checks:
- Every acceptance criterion with a UI surface appears on a screen.
- Every screen has empty, loading, error and populated states (and any task-specific state) in the
  state switcher.
- Layout works at 375, 768 and 1440 widths; nothing essential is hidden on the phone width.
- Uses the repo's existing tokens and components; no new UI library; no remote scripts, fonts or images.
- Accessibility: labels on inputs, visible focus, keyboard path described, contrast AA, no meaning
  carried by colour alone, error text tied to its field.
- Copy is specific (error messages say what happened and what to do).
- Handoff notes tell the frontend engineer which existing components to reuse.

## Lane `tasks` (breakdown and plan)

Read: the draft tasks (`task show`), `plan.md`, the spec, the PRD.
Checks:
- Every spec component and every PRD acceptance criterion is covered by at least one task.
- Code tasks are size S or M with 1 to 5 testable criteria each; no task mixes unrelated work.
- `files_owned` globs do not overlap inside a wave; shared hotspots are in `files_shared`.
- Dependencies match the data flow (schema before code that reads it; API before the UI that calls
  it); no cycles; the critical path is stated.
- Frontend tasks wait for G3 when the goal needs UI; backend tasks do not.
- Workspace mode: each epic has one repo, work in another repo is a task in that repo's epic, epic
  `depends_on` matches the provider-before-consumer order, and both sides of a cross-repo contract
  carry the same wording in their task descriptions.
- Risk flags carried from the spec to the tasks that touch the risky code.
- The budget forecast is within the goal budget, or the plan says what to cut.
