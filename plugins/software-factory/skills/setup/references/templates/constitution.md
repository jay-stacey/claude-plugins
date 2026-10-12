---
version: 1
generated_by: software-factory/setup
generated_hash: pending
scan_rev: {{scan_rev}}
updated: {{date}}
---

<!-- Template for .factory/constitution.md. Keep the result under about 80 lines.
     Every rule has a stable id so agents and reviewers can cite it ("violates C-T2").
     Fill {{...}} from the answers and scan-notes. Drop a bullet the user turned off; never renumber
     the remaining ids on a re-run (keep ids stable, leave gaps). Remove this comment. -->

# Constitution

The rules every factory agent follows in this repo. Precedence: a role's Never rules and the factory
protocol, then this file, then the brief, then the role overlay.

{{#if workspace}}## Repos

<!-- Workspace mode only. One row per repo in config `repos` (the repos the factory may change).
     Fill from `repos.<name>`: path, stack summary (language and frameworks), build, test, lint.
     Write `none` for a null command. In classic mode drop this whole section, this comment
     included, and keep C-Q2 as written below. -->

This workspace holds several repos. Each task and epic belongs to one repo; work only inside it.
Default repo: {{workspace.default_repo}}.

| Repo | Path | Stack | Build | Test | Lint |
|---|---|---|---|---|---|
{{#each repos}}| {{name}} | `{{path}}` | {{stack}} | `{{commands.build}}` | `{{commands.test}}` | `{{commands.lint}}` |
{{/each}}
{{/if}}
## Quality bars (C-Q)

- C-Q1: Change only what the task needs. Prefer the existing patterns in the code over new ones.
- C-Q2: Code builds, lints and passes the test suite at the branch head (`{{commands.build}}`, `{{commands.lint}}`, `{{commands.test}}`){{#if workspace}}; use the commands of the task's repo from the Repos table{{/if}}.
- C-Q3: No dead code, commented-out code, or TODOs without a follow-up in the handoff.

## Testing (C-T)

- C-T1: {{testing_answer}}
- C-T2: Tests are deterministic: no real network, no wall-clock sleeps, no shared state between tests.
- C-T3: A bug fix starts with a test that fails before the fix.
{{#each testing_rules}}- C-T{{n}}: {{rule}} ({{source}})
{{/each}}

## Security and privacy (C-S)

{{#each security_answers}}- C-S{{n}}: {{rule}}
{{/each}}{{#each security_rules}}- C-S{{n}}: {{rule}} ({{source}})
{{/each}}

## Coding standards (C-C)

Linters and formatters are the first authority: {{lint_configs}}.
{{#each conventions_all}}- C-C{{n}}: {{rule}} ({{source}})
{{/each}}

## Forbidden actions (C-F)

{{#each forbidden_answers}}- C-F{{n}}: {{rule}}
{{/each}}- C-F{{n}}: Pushing, merging to the base branch, or calling `gh` from an agent. The CLI delivers.
{{#each forbidden_areas}}- C-F{{n}}: Do not edit {{path}} ({{source}})
{{/each}}

## Definition of done (C-D)

- C-D1: Every acceptance criterion is met and backed by evidence: the command, its exit code and a log path, recorded with `evidence run`.
- C-D2: The CLI re-runs the checks at the branch head; only CLI evidence counts for gates.
- C-D3: Only QA marks a task verified. Reviewers report; they do not fix.
- C-D4: The handoff file validates and the final message is one `HANDOFF` line.

## Escalate to the human when (C-E)

- C-E1: A change would touch data in a non-local environment, delete user data, or break a public contract.
- C-E2: The spec and the code disagree and the spec cannot be followed safely.
- C-E3: The same task fails review 3 times, or a budget gate opens.
- C-E4: A new dependency, service or paid API is needed and the spec does not name it.
