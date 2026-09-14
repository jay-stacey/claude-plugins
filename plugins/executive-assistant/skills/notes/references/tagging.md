# Tagging

Tags are how a note is found again months later, so the only thing that matters
is that they are consistent. One shape, applied every time.

## Shape

Tags live in YAML frontmatter as a flat list:

```yaml
---
title: Auth0 scope migration
tags: [auth0, security, dp-web-ui]
created: 2026-09-14
updated: 2026-09-14
---
```

Frontmatter rather than inline `#hashtags` because every current markdown tool
(Obsidian, Foam, Dendron, and any static site generator) reads frontmatter
`tags:` as the canonical form, and a flat list parses the same everywhere.
Inline hashtags still work if the vault already uses them — the indexer reads
the frontmatter either way, and a `#release` entry inside the list is accepted.

## Rules

| Rule | Good | Bad |
|---|---|---|
| Lowercase | `auth0` | `Auth0` |
| Dashes, not spaces | `tenant-isolation` | `tenant isolation` |
| Flat, not nested | `project-neo` | `project/neo/auth` |
| Noun, not sentence | `migration` | `the-migration-we-did` |

The indexer normalises case, spaces and a leading `#` when it reads a note, so
an inconsistent vault still searches correctly. Write them in canonical form
anyway — the normalising is a safety net, not a licence.

## How many

Three to five. One is too coarse to narrow anything; ten means none of them
carry meaning.

Aim for tags that answer a question you will actually ask later:

- **What is it about** — `auth0`, `billing`, `hiring`
- **What kind of note** — `meeting`, `decision`, `reading`
- **What it belongs to** — `project-neo`, `dp-web-ui`

Searching combines them, and combining is where the speed comes from: one tag
might match a few thousand notes, three tags match a few dozen.

## Reusing existing tags

Before inventing a tag, check what the vault already uses:

```bash
python scripts/notes_index.py tags "$VAULT" --limit 50
```

Pick the existing tag over a near-synonym. `security` and `sec` and `infosec`
as three separate tags is the failure mode that makes tagging useless.

To find what usually accompanies a tag:

```bash
python scripts/notes_index.py tags "$VAULT" --cooc auth0
```

## Links are not tags

`[[Jay Stacey]]` is a link — it points at one specific note or person. `tags:
[meeting]` is a category. Use links for relationships (who was there, which
project, what decision this followed) and tags for categories.

The indexer tracks both, and links are what `backlinks` searches.

## Other frontmatter

| Field | Use |
|---|---|
| `title` | Display title when it differs from the filename |
| `created` | `YYYY-MM-DD`, set once |
| `updated` | `YYYY-MM-DD`, refreshed on every edit — search sorts by it |

Only add these to notes being created or edited. Do not backfill a vault of
existing notes: an untagged note still reads, still searches by text, and still
appears in results — rewriting every file to add metadata risks the user's only
copy for a marginal gain.
