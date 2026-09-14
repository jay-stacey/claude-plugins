#!/usr/bin/env python3
"""Search index for a markdown notes vault. Two plain text files, no database.

    {vault}/.index/index.json      compacted base, one record per note
    {vault}/.index/pending.jsonl   append-only journal of recent changes

Why a journal: rewriting index.json on every save costs ~190ms at 20k notes and
grows with the vault. Appending one line is ~0.6ms and stays flat forever, which
matters because `update` runs on every single note write. Queries read the base
and replay the journal over it, so a note is searchable the moment it is saved.

The index is an optimisation, never the source of truth. The notes themselves
are. Delete .index/ at any time and `rebuild` reconstructs it from the vault.

Commands:
    rebuild <vault>                     build/repair the whole index
    update  <vault> <note>...           record a change (run after every write)
    search  <vault> [--tag T] [--text S] [--title S] [--since D] [--limit N]
    backlinks <vault> <target>          notes linking to a note or name
    tags    <vault> [--cooc TAG]        tag counts, or tags co-occurring with TAG
    status  <vault>                     index health and staleness

Exit codes: 0 ok, 2 index missing (caller should rebuild or fall back to grep),
3 bad usage. Errors go to stderr; results go to stdout as JSON.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter

SCHEMA = 1
INDEX_DIR = ".index"
BASE = "index.json"
JOURNAL = "pending.jsonl"

#: Compact one-letter keys keep index.json small; a 20k-note base is ~3MB.
#: p=path t=title g=tags c=created u=updated m=mtime l=links x=deleted
FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n", re.S)
WIKILINK = re.compile(r"\[\[([^\]|#]+)")
SKIP_DIRS = {INDEX_DIR, ".git", ".obsidian", ".trash", "node_modules", ".stversions"}


# --------------------------------------------------------------------------
# parsing
# --------------------------------------------------------------------------

def parse_note(path):
    """Return (frontmatter dict, body). Tolerates notes with no frontmatter."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return {}, ""

    match = FRONTMATTER.match(text)
    if not match:
        return {}, text

    meta, body = {}, text[match.end():]
    key = None
    for line in match.group(1).splitlines():
        # YAML block lists ("tags:\n  - a\n  - b") continue the previous key.
        item = re.match(r"\s*-\s+(.*)$", line)
        if item and key:
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(item.group(1).strip().strip("\"'"))
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if value.startswith("[") and value.endswith("]"):
            value = [v.strip().strip("\"'") for v in value[1:-1].split(",") if v.strip()]
        elif value:
            value = value.strip("\"'")
        else:
            value = []  # bare "tags:" opens a block list
        meta[key] = value
    return meta, body


def norm_tag(tag):
    """Fold a tag to its canonical form: lowercase, kebab, no leading '#'.

    Case folding matters because a vault written by hand will contain both
    'Auth0' and 'auth0', and a user searching one expects the other.
    """
    tag = unicodedata.normalize("NFKC", str(tag)).strip().lstrip("#")
    tag = re.sub(r"\s+", "-", tag.lower())
    # Keep any unicode letter/digit: a vault may legitimately tag "café" or
    # "日本語", and silently truncating those to ASCII loses the tag entirely.
    return "".join(c for c in tag if c.isalnum() or c in "._/-")


def record(vault, path):
    """Build one index record for a note, or None if it is not readable."""
    meta, body = parse_note(path)
    tags = meta.get("tags", [])
    if isinstance(tags, str):
        tags = re.split(r"[,\s]+", tags)
    tags = sorted({t for t in (norm_tag(x) for x in tags) if t})

    rel = os.path.relpath(path, vault).replace(os.sep, "/")
    try:
        mtime = int(os.path.getmtime(path))
    except OSError:
        mtime = 0

    title = meta.get("title") or os.path.basename(path)[:-3]
    return {
        "p": rel,
        "t": str(title),
        "g": tags,
        "c": str(meta.get("created", "") or ""),
        "u": str(meta.get("updated", "") or ""),
        "m": mtime,
        "l": sorted({m.strip() for m in WIKILINK.findall(body) if m.strip()}),
    }


def iter_notes(vault):
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in sorted(files):
            if name.endswith(".md"):
                yield os.path.join(root, name)


# --------------------------------------------------------------------------
# index io
# --------------------------------------------------------------------------

def paths(vault):
    d = os.path.join(vault, INDEX_DIR)
    return d, os.path.join(d, BASE), os.path.join(d, JOURNAL)


def write_json(path, payload):
    """Write via a temp file + replace so an interrupted run cannot truncate
    an index that was previously good."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(tmp, path)


def load(vault, require=True):
    """Load the base index with the journal replayed over it.

    Returns (records_by_path, journal_line_count). Later journal entries win,
    so a note saved twice resolves to its newest state.
    """
    _, base_path, journal_path = paths(vault)
    if not os.path.exists(base_path):
        if require:
            sys.stderr.write(
                f"no index at {base_path}\nrun: notes_index.py rebuild {vault}\n")
            sys.exit(2)
        return {}, 0

    with open(base_path, encoding="utf-8") as fh:
        base = json.load(fh)
    if base.get("schema") != SCHEMA:
        sys.stderr.write(
            f"index schema {base.get('schema')} != {SCHEMA}; rebuild required\n")
        sys.exit(2)

    notes = {n["p"]: n for n in base.get("notes", [])}

    replayed = 0
    if os.path.exists(journal_path):
        with open(journal_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a torn final line is expected after a crash
                if entry.get("x"):
                    notes.pop(entry["p"], None)
                else:
                    notes[entry["p"]] = entry
                replayed += 1
    return notes, replayed


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_rebuild(args):
    vault = args.vault
    index_dir, base_path, journal_path = paths(vault)
    os.makedirs(index_dir, exist_ok=True)

    notes = [record(vault, p) for p in iter_notes(vault)]
    notes = [n for n in notes if n]
    write_json(base_path, {"schema": SCHEMA, "count": len(notes), "notes": notes})

    # The journal is folded into the base, so it must not be replayed again.
    if os.path.exists(journal_path):
        os.remove(journal_path)

    gitignore = os.path.join(index_dir, ".gitignore")
    if not os.path.exists(gitignore):
        with open(gitignore, "w", encoding="utf-8") as fh:
            fh.write("*\n")  # a derived index does not belong in version control

    print(json.dumps({"ok": True, "indexed": len(notes), "index": base_path}))


def cmd_update(args):
    """Append one journal line per changed note. Runs on every save, so it must
    stay O(1) in vault size — never rewrite the base here."""
    vault = args.vault
    index_dir, base_path, journal_path = paths(vault)
    if not os.path.exists(base_path):
        sys.stderr.write(f"no index at {base_path}; run rebuild first\n")
        sys.exit(2)
    os.makedirs(index_dir, exist_ok=True)

    written = []
    with open(journal_path, "a", encoding="utf-8") as fh:
        for note in args.notes:
            path = note if os.path.isabs(note) else os.path.join(vault, note)
            rel = os.path.relpath(path, vault).replace(os.sep, "/")
            if os.path.exists(path):
                entry = record(vault, path)
            else:
                entry = {"p": rel, "x": 1}  # tombstone: note was deleted
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            written.append(rel)

    # Compact once the journal gets long enough to slow reads down.
    lines = sum(1 for _ in open(journal_path, encoding="utf-8"))
    compacted = False
    if lines >= args.compact_at:
        notes, _ = load(vault)
        write_json(base_path, {"schema": SCHEMA, "count": len(notes),
                               "notes": sorted(notes.values(), key=lambda n: n["p"])})
        os.remove(journal_path)
        compacted = True

    print(json.dumps({"ok": True, "updated": written,
                      "journal": 0 if compacted else lines,
                      "compacted": compacted}))


def matches(note, args):
    if args.tag:
        wanted = {norm_tag(t) for t in args.tag}
        if not wanted.issubset(set(note["g"])):
            return False
    if args.title and args.title.lower() not in note["t"].lower():
        return False
    if args.since and (note.get("u") or note.get("c") or "") < args.since:
        return False
    return True


def cmd_search(args):
    """Narrow by metadata first, then read only the survivors for --text.

    Reading files is the expensive part, so the tag/title/date filters exist to
    shrink that set before any file is opened.
    """
    vault = args.vault
    notes, _ = load(vault)
    candidates = [n for n in notes.values() if matches(n, args)]

    if args.text:
        needle = re.compile(re.escape(args.text), re.I)
        hits = []
        for note in candidates:
            path = os.path.join(vault, note["p"])
            try:
                with open(path, encoding="utf-8") as fh:
                    body = fh.read()
            except (OSError, UnicodeDecodeError):
                continue
            found = needle.search(body)
            if found:
                line_no = body.count("\n", 0, found.start()) + 1
                line = body.splitlines()[line_no - 1].strip()
                note = dict(note, snippet=line[:200], line=line_no)
                hits.append(note)
        candidates = hits

    candidates.sort(key=lambda n: (n.get("u") or n.get("c") or "", n["m"]), reverse=True)
    total = len(candidates)
    if args.limit:
        candidates = candidates[:args.limit]
    print(json.dumps({"ok": True, "total": total, "shown": len(candidates),
                      "results": candidates}, indent=2))


def cmd_backlinks(args):
    """Notes whose [[wikilinks]] point at a target, by note name or path."""
    notes, _ = load(args.vault)
    target = args.target
    stem = os.path.basename(target)
    if stem.endswith(".md"):
        stem = stem[:-3]
    wanted = {target.lower(), stem.lower()}

    hits = [{"p": n["p"], "t": n["t"], "g": n["g"]}
            for n in notes.values()
            if any(link.lower() in wanted or os.path.basename(link).lower() in wanted
                   for link in n["l"])]
    hits.sort(key=lambda n: n["p"])
    print(json.dumps({"ok": True, "target": target, "count": len(hits),
                      "results": hits}, indent=2))


def cmd_tags(args):
    """Tag counts, or the tags that co-occur with one tag.

    Co-occurrence is the cheap half of a graph: it surfaces clusters ("auth0
    always shows up with tenant-isolation") that no single text search reveals.
    """
    notes, _ = load(args.vault)
    if args.cooc:
        target = norm_tag(args.cooc)
        counts = Counter()
        matched = 0
        for note in notes.values():
            if target in note["g"]:
                matched += 1
                counts.update(t for t in note["g"] if t != target)
        print(json.dumps({"ok": True, "tag": target, "notes": matched,
                          "cooccurring": counts.most_common(args.limit or 20)},
                         indent=2))
        return

    counts = Counter(t for n in notes.values() for t in n["g"])
    print(json.dumps({"ok": True, "distinct": len(counts),
                      "tags": counts.most_common(args.limit or 50)}, indent=2))


def cmd_status(args):
    """Report drift between the vault and the index, so a caller can decide
    whether to trust it or fall back to a plain search."""
    vault = args.vault
    _, base_path, journal_path = paths(vault)
    if not os.path.exists(base_path):
        print(json.dumps({"ok": False, "exists": False,
                          "hint": f"run: notes_index.py rebuild {vault}"}))
        sys.exit(2)

    notes, replayed = load(vault)
    on_disk = {os.path.relpath(p, vault).replace(os.sep, "/") for p in iter_notes(vault)}
    indexed = set(notes)
    stale = [p for p, n in notes.items()
             if p in on_disk
             and int(os.path.getmtime(os.path.join(vault, p))) > n.get("m", 0)]

    print(json.dumps({
        "ok": True,
        "exists": True,
        "indexed": len(indexed),
        "on_disk": len(on_disk),
        "missing_from_index": sorted(on_disk - indexed)[:20],
        "stale": sorted(stale)[:20],
        "journal_entries": replayed,
        "size_mb": round(os.path.getsize(base_path) / 1048576, 2),
        "healthy": not (on_disk - indexed) and not stale,
    }, indent=2))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("rebuild"); p.add_argument("vault"); p.set_defaults(fn=cmd_rebuild)

    p = sub.add_parser("update")
    p.add_argument("vault"); p.add_argument("notes", nargs="+")
    p.add_argument("--compact-at", type=int, default=500,
                   help="fold the journal into the base at this many entries")
    p.set_defaults(fn=cmd_update)

    p = sub.add_parser("search")
    p.add_argument("vault")
    p.add_argument("--tag", action="append", help="repeatable; all must match")
    p.add_argument("--text", help="substring to find in the note body")
    p.add_argument("--title", help="substring to find in the title")
    p.add_argument("--since", help="only notes updated/created on or after YYYY-MM-DD")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("backlinks")
    p.add_argument("vault"); p.add_argument("target"); p.set_defaults(fn=cmd_backlinks)

    p = sub.add_parser("tags")
    p.add_argument("vault"); p.add_argument("--cooc"); p.add_argument("--limit", type=int)
    p.set_defaults(fn=cmd_tags)

    p = sub.add_parser("status"); p.add_argument("vault"); p.set_defaults(fn=cmd_status)

    args = ap.parse_args(argv)
    if not os.path.isdir(args.vault):
        sys.stderr.write(f"vault not found: {args.vault}\n")
        sys.exit(3)
    args.fn(args)


if __name__ == "__main__":
    main()
