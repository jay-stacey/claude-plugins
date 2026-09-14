# Search

The index makes recall fast, but it is only an optimisation. The notes are the
source of truth. If the index is missing, stale, or broken, fall back to Grep —
the answer is slower, never wrong.

## The index

Two plain text files under the vault:

```
{vault}/.index/index.json      one record per note: path, title, tags, dates, links
{vault}/.index/pending.jsonl   recent changes, one JSON object per line
```

No database, no schema to migrate, no background process. `index.json` holds
metadata only — never note text — so it stays around 3 MB at 20,000 notes.

Writes append one line to `pending.jsonl` instead of rewriting `index.json`.
That is what keeps saving a note at well under a millisecond no matter how large
the vault grows. Queries read the base and replay the journal over it, so a note
is searchable the instant it is saved. The journal folds back into the base
automatically once it reaches 500 entries.

Both files are derived data. Deleting `.index/` loses nothing.

## Commands

Run with the vault root as the first argument. `$VAULT` below is
`CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH`.

```bash
S="${CLAUDE_PLUGIN_ROOT}/skills/notes/scripts/notes_index.py"

python "$S" search "$VAULT" --tag auth0 --tag security   # all tags must match
python "$S" search "$VAULT" --text "collation"           # substring in body
python "$S" search "$VAULT" --tag auth0 --text collation # narrow, then read
python "$S" search "$VAULT" --title "migration"
python "$S" search "$VAULT" --since 2026-09-01 --limit 10

python "$S" backlinks "$VAULT" "Jay Stacey"    # notes linking here
python "$S" tags "$VAULT"                      # every tag, by frequency
python "$S" tags "$VAULT" --cooc auth0         # tags that accompany auth0

python "$S" rebuild "$VAULT"                   # build or repair
python "$S" update "$VAULT" daily/2026-09-14.md   # after every write
python "$S" status "$VAULT"                    # health and drift
```

Output is JSON on stdout. Exit `2` means the index is missing or its schema
changed — rebuild, or fall back to Grep.

## Why narrowing matters

`--text` opens files, which is the expensive part. The metadata filters exist to
shrink that set first. Measured end to end on a 20,000-note vault, including
Python startup (~90 ms of every figure below):

| Query | Time |
|---|---|
| `--text` alone, no narrowing | ~3.1 s |
| two `--tag` + `--text` | ~280 ms |
| one `--tag`, metadata only | ~160 ms |
| `tags --cooc`, metadata only | ~130 ms |
| `update` one note | ~100 ms |
| `rebuild` all 20,000 | ~5.5 s |

So lead with tags and add `--text` last — narrowing is worth roughly 11x here.
Metadata-only queries never open a note at all.

The index itself is 2.55 MB at 20,000 notes, and `update` appends a single line,
so save cost does not grow with the vault.

## What the index cannot do

There is no relevance ranking across the whole vault. Ranked full-text search
needs a real search engine, and that cost is not worth a personal vault — it
would make every save roughly 3,000 times slower for a feature that tag
narrowing already covers.

For a vague recall ("something about rounding errors, months ago"), run
`--text` with no tags and accept the wait, or ask the user which project it
belonged to and narrow first.

## Keeping it current

Run `update` after every note write. It is the one rule that keeps the index
trustworthy:

```bash
python "$S" update "$VAULT" "$RELATIVE_PATH"
```

It handles all three cases — new note, edited note, deleted note (recorded as a
tombstone so the note stops appearing in results).

Notes edited outside this skill (in Obsidian, in an editor) are invisible to the
index until a rebuild. `status` reports that drift:

```bash
python "$S" status "$VAULT"
```

`healthy: false`, a non-empty `missing_from_index`, or a non-empty `stale` all
mean rebuild. A rebuild of 20,000 notes takes about five seconds, so when in
doubt, rebuild.

## Fallback

If the index is missing and rebuilding is not wanted, Grep still answers
everything:

| Instead of | Use |
|---|---|
| `--tag auth0` | Grep `^tags:.*auth0` across `**/*.md` |
| `--text foo` | Grep `foo` across `**/*.md` |
| `backlinks X` | Grep `\[\[X` across `**/*.md` |

Slower on a large vault, and no tag normalising, but correct.
