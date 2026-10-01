# Notes Desk design

## Why a snapshot

An artifact runs on claude.ai, not on the user's machine. It has no route to the
local notes folder. The options were:

| Route | Works where | Cost |
|---|---|---|
| Snapshot published with the page, edits in the artifact db | Every device, web and app | Copy goes stale until refreshed |
| Live reads through a local MCP server (`mcp` capability, `host:` server) | Only the desktop app, on the machine that has the server | A bundled MCP server, and nothing works on a phone |

The snapshot wins because reading notes on a phone is a main use. A live mode
can be added later without changing the edit format.

## The editor

The page edits markdown with a live-preview editor (CodeMirror 6), the same
model Obsidian uses. The markdown text is the only document. Headings, bold,
lists, quotes, links, tables and task boxes are drawn from it, and their marks
hide while the cursor is on another line. A "Source" switch shows every mark.

A true rich-text editor (ProseMirror, Toast UI, Milkdown) was rejected. Those
convert markdown to a document tree and write it back, which reformats lines
the user never touched: list markers, escapes, spacing, wikilinks. Every sync
would then show noise in the diff, on notes that are often the only copy. With
live preview, an edit changes exactly the characters typed.

Changes save to the edit store 0.7 seconds after the user stops typing, one
write at a time. Switching notes, hiding the tab, or opening the sync tray
saves first. Typing a note back to its snapshot text deletes its edit.

### Building the bundle

The artifact frame loads scripts only from a few CDNs, and those serve
CodeMirror as separate modules at mismatched versions, which breaks it. So the
editor is bundled into one file, `assets/editor.bundle.js`, and `export`
inlines it into the page. The bundle is committed, so using the skill needs no
Node.js. After changing `editor/src/editor.js`:

```bash
cd skills/notes-viewer/editor
npm install
npm run build        # writes ../assets/editor.bundle.js
```

The bundle uses the markdown language alone, not `markdown()`, which would add
HTML, CSS and JavaScript parsers and triple its size (about 315 KB now).

## Published files

```
notes-viewer.html        the page: assets/viewer.html with the editor inlined
data/manifest.json       metadata for every exported note
data/notes-000.json      note text, about 1 MB per chunk
data/notes-001.json      ...
```

Each manifest entry:

| Key | Meaning |
|---|---|
| `id` | Stable id from the path hash. Used as the edit document id and the `#` deep link. |
| `p` | Path relative to the vault |
| `t` | Title: frontmatter `title`, else the filename |
| `g` | Tags, normalised like the search index |
| `c`, `u` | `created` and `updated` from frontmatter |
| `m` | File modified time, in seconds |
| `l` | Wikilink targets |
| `sha` | SHA-256 of the file bytes at export time |
| `k` | Chunk number that holds the text |

`export --inline` puts the same data into one HTML file instead. It is for
local, read-only viewing when the Artifact tool is not available.

## The edit store

One collection, `edits`, one document per changed note:

```json
{
  "path": "projects/auth0-migration.md",
  "content": "full note text, LF line endings",
  "title": "Auth0 scope migration",
  "base_sha": "sha of the snapshot copy, or null for a new note",
  "kind": "edit | new",
  "saved_at": "2026-10-01T14:03:00.000Z",
  "status": "pending | conflict",
  "reason": "set by sync when it holds an edit back"
}
```

The page writes a whole document on each autosave, keyed by the note's `id`.
Typing a note back to its snapshot text deletes the document. A new note is
saved the moment it is created and gets a `new-...` id.

`base_sha` is what makes sync safe. `apply` compares it with the file on disk.
A match means nobody touched the note since the snapshot, so the edit can
replace it. A mismatch is a conflict, and the user decides.

`apply` keeps the note's line endings. If the disk copy uses CRLF, the edit is
written with CRLF.

## Limits

| Limit | Value | Effect |
|---|---|---|
| Edit document size | 256 KiB | The page refuses to save a note over about 250 KB |
| Documents per artifact | 25,000 | Far above any real number of pending edits |
| Published files per publish | 255 | About 250 MB of notes at 1 MB chunks |
| Export cap | `--max-mb 40` | Export stops with exit code 4 above this |

## Privacy

The artifact is private to its owner. The `edits` rule sets read and write to
`owner`, so even someone given view access later cannot read pending edits.
The snapshot itself is readable by anyone the owner shares the page with, so
the skill does not share it.
