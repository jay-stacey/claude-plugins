---
role: {{role}}
version: 1
generated_by: software-factory/setup
generated_hash: pending
scan_rev: {{scan_rev}}
updated: {{date}}
sources: [{{sources}}]
---

<!-- Template for .factory/roles/<role>.md, one per active role. Keep each under about 100 lines;
     the brief inlines it. Fill only what applies to this role:
     - builders (backend, frontend, data, devops-release, tech-writer): stack, layout, commands, conventions, owned paths
     - qa-engineer: test and e2e commands, run command, screenshot command, Playwright/Cypress config
     - code-reviewer, security-reviewer, critic: conventions, security rules, forbidden areas, PR checklist
     - cto, product-manager, project-manager, staff-engineer, ui-ux-designer: stack summary, ADR titles,
       glossary terms, design system or UI library when present
     Use scan-notes rules tagged for this role plus [all]. Every rule keeps its source.
     Keep the "Local notes" section and everything under it exactly as the user left it.
     Remove this comment. -->

# {{role_title}} overlay for {{project.name}}

## Stack for this role

{{#each stack_for_role}}- `{{path}}`: {{language}}, {{frameworks}} ({{package_manager}})
{{/each}}   <!-- Workspace mode: start each path with its repo name, for example `project-neo/src` -->

{{#if workspace}}## Repos

<!-- Workspace mode only. One row per repo in config `repos` that this role works in (all repos for
     cto, product-manager, project-manager, staff-engineer, qa-engineer and the reviewers; only repos
     whose stack fits for a builder). Write `none` for a null command. In classic mode drop this
     whole section, this comment included, and use the single "Stack for this role", "Folder layout"
     and "Commands" sections as they are. -->

| Repo | Path | Stack | Build | Test | Lint |
|---|---|---|---|---|---|
{{#each repos_for_role}}| {{name}} | `{{path}}` | {{stack}} | `{{commands.build}}` | `{{commands.test}}` | `{{commands.lint}}` |
{{/each}}
Work only in the repo your task names. Run that repo's commands from inside its folder.
{{/if}}
## Folder layout

{{layout}}   <!-- 3-8 lines: where source, tests, migrations, docs and generated code live. Workspace mode: one short line per repo in the Repos table -->

## Commands

{{#if workspace}}<!-- Workspace mode: add a Repo column, one row per command per repo in the Repos table. Build, test and lint are in the Repos table; list here the other commands (install, run, e2e, migrations, screenshot) that apply to this role. -->

| Repo | Purpose | Command | Source |
|---|---|---|---|
{{#each commands_for_role}}| {{repo}} | {{purpose}} | `{{command}}` | {{source}} |
{{/each}}{{else}}| Purpose | Command | Source |
|---|---|---|
{{#each commands_for_role}}| {{purpose}} | `{{command}}` | {{source}} |
{{/each}}{{/if}}

Run commands exactly as written; extra arguments are fine. Other shell commands are blocked by the
factory's permission broker. Allowed extra commands: {{commands.extra}}.

## Conventions

{{#each conventions_for_role}}- {{rule}} ({{source}})
{{/each}}

## Files you own / do not touch

- Own (typical for this role): {{owned_globs}}   <!-- from stack paths, monorepo packages, CODEOWNERS -->
- Do not touch: `.factory/` state, CI/CD and deploy config (unless the task says so), {{do_not_touch}}

## Repo-specific rules

{{#each repo_rules}}- {{rule}} ({{source}})
{{/each}}   <!-- docs and changelog location, secret mechanism, large tables, online migrations, headers -->

## Local notes

<!-- Yours. Setup never changes anything below this heading. -->
