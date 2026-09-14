# Markdown Conventions

Notes are plain markdown, so consolidated content should use syntax that stays
readable in any editor. These conventions are widely supported by markdown note
apps, but nothing here depends on a particular one.

## Linking

| Purpose | Syntax |
|---|---|
| Link to another note | `[2026-01-15](daily/2026-01-15.md)` |
| Link to a heading in a note | `[Schedule](daily/2026-01-15.md#schedule)` |
| External link | `[Title](https://example.com)` |

Some vaults use wiki-style `[[2026-01-15]]` links instead. Match whatever the
existing notes already use — read a nearby note first rather than imposing a
style, because mixed link syntax breaks a vault's navigation.

## Tags

Inline `#urgent`, `#waiting-for`, `#follow-up` work in most editors. Tags
declared in frontmatter (`tags: [daily, work]`) are better for anything a tool
needs to query. Use both only if the vault already does.

## Tasks

Standard checkbox syntax renders and is machine-readable:

```markdown
- [ ] Open task
- [x] Completed task
```

Add source attribution so an item can be traced back:

```markdown
- [ ] Reply to vendor contract email ([email](https://mail.google.com/...))
- [ ] Review PR #482 ([DMS-1043](https://linear.app/...))
```

## Grouping

Group consolidated items under the `##` section they belong to rather than
appending everything to the end of the note. The `notes` skill appends within a
section, which is what keeps a daily note usable after several runs.
