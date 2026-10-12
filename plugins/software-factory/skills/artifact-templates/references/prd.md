# PRD template

Cap: S 30 lines, M 80, L 150. For tier S, a short paragraph per section is enough.

```markdown
# PRD: <goal title> (<G-id>)

## Problem
<Who has the problem, what happens today, why it matters now. 2-5 sentences.>

## Users and job
- <user type>: <the job they are trying to get done>

## Outcome and success measure
- Outcome: <the goal outcome, restated in user terms>
- Success measure: <observable signal, with a number where possible; source or "Assumption:">

## Scope
In:
- <capability>
Out:
- <thing a builder might assume is in scope but is not>

## Acceptance criteria
- AC-1: <who/what> <does/gets> <observable result> [when <condition>]
- AC-2: <failure behaviour: invalid input / no permission / empty state>

## Constraints
- <from the constitution or the goal: privacy, platforms, compatibility, deadlines>

## Open questions
- Q-1 (blocking|non-blocking): <question> - Assumption: <what the PRD assumes meanwhile>
```

Checks before handing off:
- Every goal success criterion maps to at least one AC.
- Every AC is testable by running software and has one behaviour.
- No technology choices, schemas or screen layouts unless the goal fixes them.
- Research or numbers have a source; otherwise they are labelled "Assumption:".
