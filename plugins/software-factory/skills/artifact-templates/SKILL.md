---
name: artifact-templates
description: Templates, document paths and S/M/L line caps for software-factory artifacts - PRD, spec, design, plan, QA, review and release notes.
user-invocable: false
---

# Artifact templates

Every planning and assurance document in the factory has a fixed shape and a line cap that depends
on the goal tier (`tier` in the brief). Fixed shapes let the critic, the CTO, the control center and
the human at a gate find things fast. Line caps keep documents short enough to read.

## 1. Where documents go

Under `<factory_home>/docs/<goal folder>/` (for example `docs/G-001-vin-lookup/`). The brief's
`output_paths` always win over this list.

| Document | Path | Written by |
|---|---|---|
| PRD | `prd.md` | product-manager |
| Spec | `spec.md` | staff-engineer |
| Plan | `plan.md` | project-manager |
| Design | `design/README.md` + `design/<screen>.html` | ui-ux-designer |
| Critique | `critique/<lane>-r<round>.md` (lane prd, spec, design, tasks) | critic |
| Code review | `reviews/<T-id>-code-reviewer-r<round>.md`, epic: `reviews/<E-id>.md` | code-reviewer |
| Security review | `reviews/<T-id>-security-reviewer-r<round>.md`; spec: `critique/spec-security-r<round>.md` | security-reviewer |
| QA | `qa/<T-id>-r<round>.md`, epic: `qa/<E-id>.md` | qa-engineer |
| Question answer | `questions/<Q-id>.md` | the role asked |
| Release notes | `release-notes.md` | tech-writer |

## 2. Line caps by tier (S / M / L)

| Document | Cap | Template |
|---|---|---|
| PRD | 30 / 80 / 150 | `references/prd.md` |
| Spec | 40 / 120 / 250 | `references/spec.md` |
| Design README | 30 / 60 / 120, plus at most 1 / 3 / 8 HTML screens | `references/design.md` |
| Plan | 20 / 40 / 80, plus 5 lines per task | `references/plan.md` |
| QA | 40 / 80 / 150 | `references/qa.md` |
| Code or security review | 60 | `references/review.md` |
| Critique | 60 | `critique-method` references/layout.md |
| Release notes | 20 / 40 / 80 | `references/release-notes.md` |

A cap is a ceiling, not a target. If the content truly does not fit, the scope is probably too big:
say so in `open_questions` (to `cto`) rather than going over.

## 3. Rules for every document

- Use the template's headings, in order. Do not rename or drop a heading. Write "None." under an
  empty one.
- Plain words, short sentences, active voice. One idea per sentence.
- Ids are stable: `AC-n` for acceptance criteria, `F-n` for findings, `Q-n` for questions, `R-n` for
  risks. Never renumber after a gate; add new ids at the end.
- Name real things: file paths, commands, field names, numbers. No "several", "some", "etc.".
- No secrets, no personal data, no copied customer text. Use invented sample data.
- Link upstream: a spec names the PRD criteria it covers; a review names the task and head SHA.
- Mark assumptions as assumptions (`Assumption:`) and keep them out of acceptance criteria.

## 4. Acceptance criteria rules (PRD, spec, tasks)

- Format: `AC-n: <who/what> <does/gets> <observable result> [when <condition>]`.
- Each criterion is one behaviour, testable by running the software, with a yes or no answer.
- Include the failure behaviour where a user can hit it: `AC-4: An unknown VIN returns a
  not-found message and no partial data.`
- No solution words in the PRD (no table, endpoint, component names) unless the goal fixes them.
- Tasks carry 1 to 5 criteria, derived from the spec and never weaker than the PRD criterion they serve.

## 5. Rework rounds

On round 2+ keep the same file (planners) or write the new round's file (bench). Planners add a
short `## Changes in round <n>` section at the end listing each finding id and what changed.

## 6. Gates and freezing

After a gate is approved (PRD at G1, spec at G2, design at G3) the document is frozen. A later change
is a new task with its own review, never a silent edit.
