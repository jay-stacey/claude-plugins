# Daily Note Template

Fallback skeleton used when the vault has no `templates/daily.md`. Sections are
the ones the assistant's other skills write into, so keep the headings stable if
you customise this — `task-consolidator` and `notes` both locate content by
`##` heading text.

```markdown
---
date: {{date}}
tags: [daily]
---

# {{date}}

## Today's Focus

## Inbox

## Schedule

## Urgent

## Important

## Routine

## Notes

## Reflection
```

## Placeholders

| Placeholder | Replaced with |
|---|---|
| `{{date}}` | The note's date in the configured format |
| `{{date:FORMAT}}` | The date in an explicit format, e.g. `{{date:DD MMM YYYY}}` |
| `{{title}}` | The note title, defaults to the date |

Substitute every placeholder before writing. An unreplaced `{{...}}` left in a
file is a visible defect in the user's notes.
