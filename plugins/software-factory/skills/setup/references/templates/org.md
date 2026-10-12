---
version: 1
generated_by: software-factory/setup
generated_hash: pending
scan_rev: {{scan_rev}}
updated: {{date}}
---

<!-- Template for .factory/org.md. Keep the result under about 60 lines. Remove this comment. -->

# {{project.name}} factory

## Mission

{{mission}}{{#if mission_source}} ({{mission_source}}){{/if}}

## Product context

{{architecture_summary}}   <!-- at most 6 lines from scan-notes "Architecture"; stack per package -->

## Operating guidelines

- Small, reviewable changes. One task, one branch, one handoff.
- Prefer existing patterns and libraries; ask before adding a dependency.
- Write in plain words. Lead with the result.
{{#each guidelines}}- {{rule}} ({{source}})
{{/each}}

## Reporting chain

- User (owner): approves gates, merges pull requests.
- CTO: sizes goals, forms pods, handles escalations and replans.
- Product line: Product Manager{{#if ui}} > UI/UX Designer{{/if}}.
- Delivery line: Project Manager.
- Engineering line: Staff Engineer > {{active_builders}}, DevOps/Release, Tech Writer.
- Assurance bench (reports only to the CTO): Critic, Code Reviewer, Security Reviewer, QA Engineer.

Active roles: {{roles.active}}.

## Approvals

| Gate | What | Approver | Where |
|---|---|---|---|
| G1 | PRD | {{G1.approvers}} | /software-factory:approve or the control center |
| G2 | Spec | owner | same |
| G3 | UI mockups | owner{{#unless G3.enabled}} (off){{/unless}} | same |
| G4 | Pull request | owner | review in the factory, merge on GitHub |
| budget, destructive | Top-ups, deletes | owner | always on |

## Glossary

{{#each glossary}}- {{term}}: {{meaning}}
{{/each}}
