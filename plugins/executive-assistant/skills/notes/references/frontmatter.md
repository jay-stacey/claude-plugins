# Frontmatter Handling

Markdown notes often open with a YAML block between `---` fences. It carries
metadata other tools depend on, so preserving it exactly matters more than
parsing it cleverly.

## Parsing

Frontmatter counts only when the opening `---` is the file's first line. A
`---` appearing later is a horizontal rule, not frontmatter.

Read to the closing `---`, parse the block as YAML, and treat everything after
it as the body. A file with no frontmatter is normal — return an empty map and
the whole file as body.

## Preserving

When editing a note, leave the frontmatter untouched unless the caller asked to
change it. Other tools (note apps, static site generators, sync services) read
these fields, and silently reordering or reformatting them causes churn the user
did not ask for.

When adding a field, append it rather than rewriting the block, so existing key
order and any comments survive.

## Common fields

| Field | Typical use |
|---|---|
| `date` | The note's date, usually matching the filename |
| `tags` | List of tags |
| `title` | Display title when it differs from the filename |

Do not invent fields. If a workflow needs new metadata, add it under a single
namespaced key rather than scattering top-level fields into the user's notes.
