#!/usr/bin/env python3
"""Export a notes vault to the Notes Viewer artifact, and apply edits made there.

The artifact is a hosted page and cannot read the local disk, so the vault
travels as a snapshot: one manifest of metadata plus a few JSON chunks of note
text, published next to the page. Edits made in the page are stored in the
artifact's database and come back here through `apply`, which writes them to
disk only when the note has not changed locally since the snapshot.

Commands:
    export <vault> <out_dir> [--folder F] [--tag T] [--since D] [--limit N]
                             [--exclude F] [--include-flagged] [--inline]
    apply  <vault> <edits.json|edits_dir> [--dry-run] [--overwrite PATH] [--copy PATH]
    state  <vault> [--url URL]

Exit codes: 0 ok, 3 bad usage, 4 export too large. Results go to stdout as JSON.
"""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
INDEX_SCRIPT = os.path.join(SKILL, "..", "notes", "scripts", "notes_index.py")
TEMPLATE = os.path.join(SKILL, "assets", "viewer.html")
EDITOR = os.path.join(SKILL, "assets", "editor.bundle.js")
PAGE = "notes-viewer.html"
STATE_DIR = ".notes-viewer"
SCHEMA = 1

sys.path.insert(0, os.path.dirname(os.path.abspath(INDEX_SCRIPT)))
from notes_index import iter_notes, norm_tag, record  # noqa: E402

#: Patterns that should never leave the machine in a published artifact. A
#: flagged note is held back unless the caller passes --include-flagged.
#: Only the reason is reported, never the matched text.
SECRETS = [
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("API secret key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("JSON web token", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.")),
    ("connection string", re.compile(r"(?i)\b(?:password|pwd)\s*=\s*[^;\s]{4,}")),
    ("password", re.compile(r"(?im)^\s*[-*]?\s*password\s*[:=]\s*\S{4,}")),
]
CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")


def luhn(digits):
    total, alt = 0, False
    for d in reversed(digits):
        n = int(d)
        if alt:
            n = n * 2 - 9 if n > 4 else n * 2
        total += n
        alt = not alt
    return total % 10 == 0


def scan(text):
    """Return the reason a note looks like it holds a secret, or None."""
    for reason, pattern in SECRETS:
        if pattern.search(text):
            return reason
    for match in CARD.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        if 13 <= len(digits) <= 19 and luhn(digits):
            return "payment card number"
    return None


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def note_id(rel):
    """Stable document id for a note. The page keys edits by it, and the
    artifact database only accepts [A-Za-z0-9_-.~:@+] in a path segment."""
    return "n" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:23]


def read_text(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    return raw, raw.decode("utf-8")


def rel_of(vault, path):
    return os.path.relpath(path, vault).replace(os.sep, "/")


def out(payload, code=0):
    print(json.dumps(payload, indent=2))
    sys.exit(code)


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------

def in_folder(rel, folders):
    return any(rel == f or rel.startswith(f.rstrip("/") + "/") for f in folders)


def write_chunk(path, items):
    """One note per line, so the file can be paged through with a line-based
    reader before it is published."""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("[\n")
        fh.write(",\n".join(json.dumps(i, ensure_ascii=False) for i in items))
        fh.write("\n]\n")


def cmd_export(args):
    vault = os.path.abspath(args.vault)
    folders = [f.strip("/").replace("\\", "/") for f in args.folder or []]
    excluded = [f.strip("/").replace("\\", "/") for f in args.exclude or []]
    wanted_tags = {norm_tag(t) for t in args.tag or []}

    chosen, flagged = [], []
    total_on_disk = 0
    for path in iter_notes(vault):
        total_on_disk += 1
        rel = rel_of(vault, path)
        if folders and not in_folder(rel, folders):
            continue
        if excluded and in_folder(rel, excluded):
            continue
        rec = record(vault, path)
        if wanted_tags and not wanted_tags.issubset(rec["g"]):
            continue
        if args.since and (rec["u"] or rec["c"] or
                           dt.date.fromtimestamp(rec["m"]).isoformat()) < args.since:
            continue
        chosen.append((path, rec))

    # Most recently changed first, so --limit keeps what is being worked on.
    chosen.sort(key=lambda pr: pr[1]["m"], reverse=True)
    matched = len(chosen)
    if args.limit:
        chosen = chosen[:args.limit]

    notes, bodies = [], []
    for path, rec in chosen:
        try:
            raw, text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        reason = scan(text)
        if reason and not args.include_flagged:
            flagged.append({"p": rec["p"], "reason": reason})
            continue
        notes.append({
            "id": note_id(rec["p"]), "p": rec["p"], "t": rec["t"], "g": rec["g"],
            "c": rec["c"], "u": rec["u"], "m": rec["m"], "l": rec["l"],
            "sha": sha256(raw), "size": len(raw),
        })
        bodies.append({"p": rec["p"], "body": text})

    # Split bodies into chunks so no single published file is large.
    limit = int(args.chunk_mb * 1048576)
    chunks, current, size = [], [], 0
    for note, body in zip(notes, bodies):
        n = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
        if current and size + n > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(body)
        note["k"] = len(chunks)
        size += n
    if current:
        chunks.append(current)

    total_bytes = sum(n["size"] for n in notes)
    if total_bytes > args.max_mb * 1048576:
        out({"ok": False, "error": "export too large",
             "mb": round(total_bytes / 1048576, 1), "max_mb": args.max_mb,
             "hint": "narrow with --folder, --tag, --since or --limit"}, 4)

    os.makedirs(args.out_dir, exist_ok=True)
    manifest = {
        "schema": SCHEMA,
        "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "vault": os.path.basename(vault.rstrip("\\/")) or "notes",
        "daily_folder": os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_DAILY_FOLDER", "daily"),
        "count": len(notes),
        "chunks": [f"data/notes-{i:03d}.json" for i in range(len(chunks))],
        "notes": notes,
    }

    with open(TEMPLATE, encoding="utf-8") as fh:
        page = fh.read()
    # The editor is inlined: the artifact frame only loads scripts from a few
    # CDNs, and those serve CodeMirror as many modules at mismatched versions.
    if not os.path.exists(EDITOR):
        out({"ok": False, "error": "editor bundle missing", "path": EDITOR,
             "hint": "run `npm install && npm run build` in skills/notes-viewer/editor"}, 3)
    with open(EDITOR, encoding="utf-8") as fh:
        bundle = fh.read().replace("</script", "<\\/script")
    page = page.replace("<!--EDITOR-BUNDLE-->", f"<script>{bundle}</script>")
    page_path = os.path.join(args.out_dir, PAGE)
    files = {}

    if args.inline:
        payload = dict(manifest, chunks=[], bodies={b["p"]: b["body"] for b in bodies})
        blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
        page = page.replace(
            "<!--INLINE-DATA-->",
            f'<script type="application/json" id="inline-data">{blob}</script>')
    else:
        data_dir = os.path.join(args.out_dir, "data")
        if os.path.isdir(data_dir):
            shutil.rmtree(data_dir)  # drop chunks from an earlier, larger export
        os.makedirs(data_dir)
        manifest_path = os.path.join(data_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({k: v for k, v in manifest.items() if k != "notes"},
                                ensure_ascii=False)[:-1])
            fh.write(',"notes":[\n')
            fh.write(",\n".join(json.dumps(n, ensure_ascii=False) for n in notes))
            fh.write("\n]}\n")
        files["data/manifest.json"] = os.path.abspath(manifest_path)
        for i, chunk in enumerate(chunks):
            chunk_path = os.path.join(data_dir, f"notes-{i:03d}.json")
            write_chunk(chunk_path, chunk)
            files[f"data/notes-{i:03d}.json"] = os.path.abspath(chunk_path)

    with open(page_path, "w", encoding="utf-8") as fh:
        fh.write(page)

    out({
        "ok": True,
        "page": os.path.abspath(page_path),
        "files": files,
        "notes": len(notes),
        "matched": matched,
        "on_disk": total_on_disk,
        "mb": round(total_bytes / 1048576, 2),
        "held_back": flagged,
    })


# --------------------------------------------------------------------------
# apply
# --------------------------------------------------------------------------

def safe_target(vault, rel):
    """Resolve a note path from the artifact, or return why it is refused.

    The path arrives from a web page, so it is untrusted: it must be a
    relative .md path that stays inside the vault and avoids dot folders
    (.index, .git, .obsidian and this skill's own state)."""
    if not isinstance(rel, str) or not rel.strip():
        return None, "missing path"
    rel = rel.strip().replace("\\", "/")
    if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
        return None, "absolute path"
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None, "path leaves the vault or enters a hidden folder"
    if not rel.lower().endswith(".md"):
        return None, "not a .md file"
    root = os.path.realpath(vault)
    target = os.path.realpath(os.path.join(root, *parts))
    if os.path.commonpath([root, target]) != root:
        return None, "path leaves the vault"
    return target, None


def load_edits(path):
    """Accept the edits however they were saved: a directory of one JSON file
    per document (ArtifactData `list` with `out_dir`), a list of documents, an
    {"docs": [...]} wrapper, or documents with their fields under "data"."""
    raw = []
    if os.path.isdir(path):
        for root, _, names in os.walk(path):
            for name in sorted(names):
                if name.endswith(".json"):
                    with open(os.path.join(root, name), encoding="utf-8") as fh:
                        item = json.load(fh)
                    if isinstance(item, dict):
                        item.setdefault("id", item.get("doc_id") or name[:-5])
                        raw.append(item)
    else:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, dict):
            raw = raw.get("docs") or raw.get("documents") or raw.get("results") or []
    edits = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        merged = {**item, **data}
        merged["id"] = item.get("id") or item.get("doc_id")
        merged["version"] = item.get("version")
        edits.append(merged)
    return edits


def match_newlines(text, like):
    text = text.replace("\r\n", "\n")
    return text.replace("\n", "\r\n") if "\r\n" in like else text


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".viewer-tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    os.replace(tmp, path)


def backup(vault, target, stamp):
    rel = rel_of(vault, target)
    dest = os.path.join(vault, STATE_DIR, "backups", stamp, *rel.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(target, dest)
    return rel_of(vault, dest)


def conflict_copy_path(target, stamp):
    stem = target[:-3]
    return f"{stem}.viewer-{stamp}.md"


def diff_preview(old, new, rel, max_lines=60):
    lines = list(difflib.unified_diff(
        old.replace("\r\n", "\n").splitlines(), new.replace("\r\n", "\n").splitlines(),
        fromfile=f"disk/{rel}", tofile=f"viewer/{rel}", lineterm="", n=2))
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... {len(lines) - max_lines} more diff lines"]
    return "\n".join(lines)


def cmd_apply(args):
    vault = os.path.abspath(args.vault)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    overwrite = {p.replace("\\", "/") for p in args.overwrite or []}
    copy = {p.replace("\\", "/") for p in args.copy or []}

    results, written = [], []
    for edit in load_edits(args.edits):
        rel = (edit.get("path") or "").replace("\\", "/")
        content = edit.get("content")
        base = edit.get("base_sha")
        res = {"id": edit.get("id"), "version": edit.get("version"), "path": rel}
        target, why = safe_target(vault, rel)

        if why:
            res.update(status="rejected", reason=why)
        elif not isinstance(content, str):
            res.update(status="rejected", reason="no content")
        elif not base:
            # A note created in the viewer. Never replace a file that exists.
            if os.path.exists(target):
                res.update(status="exists", reason="a note already exists at this path")
            else:
                res.update(status="would_create" if args.dry_run else "created",
                           lines=content.count("\n") + 1)
                if not args.dry_run:
                    atomic_write(target, content)
                    written.append(rel)
        elif not os.path.exists(target):
            res.update(status="missing", reason="the note was moved or deleted on disk")
        else:
            raw, current = read_text(target)
            new = match_newlines(content, current)
            if new.replace("\r\n", "\n") == current.replace("\r\n", "\n"):
                res.update(status="unchanged")
            elif sha256(raw) != base and rel not in overwrite and rel not in copy:
                res.update(status="conflict",
                           reason="the note changed on disk after the snapshot",
                           diff=diff_preview(current, new, rel))
            elif sha256(raw) != base and rel in copy:
                dest = conflict_copy_path(target, stamp)
                res.update(status="would_copy" if args.dry_run else "copied",
                           copy=rel_of(vault, dest))
                if not args.dry_run:
                    atomic_write(dest, new)
                    written.append(rel_of(vault, dest))
            else:
                res["diff"] = diff_preview(current, new, rel)
                if args.dry_run:
                    res["status"] = "would_apply"
                else:
                    res["backup"] = backup(vault, target, stamp)
                    atomic_write(target, new)
                    res["status"] = "applied"
                    written.append(rel)
        results.append(res)

    index = None
    if written and os.path.exists(INDEX_SCRIPT):
        proc = subprocess.run([sys.executable, INDEX_SCRIPT, "update", vault, *written],
                              capture_output=True, text=True)
        index = "updated" if proc.returncode == 0 else (
            "no index yet" if proc.returncode == 2 else "update failed")

    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    out({"ok": True, "dry_run": args.dry_run, "counts": counts,
         "written": written, "index": index, "results": results})


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------

def cmd_state(args):
    """Remember which artifact belongs to this vault, so a refresh updates the
    same link instead of minting a new one."""
    vault = os.path.abspath(args.vault)
    state_dir = os.path.join(vault, STATE_DIR)
    path = os.path.join(state_dir, "state.json")
    state = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            state = json.load(fh)
    if args.url:
        os.makedirs(state_dir, exist_ok=True)
        ignore = os.path.join(state_dir, ".gitignore")
        if not os.path.exists(ignore):
            with open(ignore, "w", encoding="utf-8") as fh:
                fh.write("backups/\n")
        state.update(url=args.url,
                     published=dt.datetime.now().astimezone().isoformat(timespec="seconds"))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
    out({"ok": True, "state": state})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("export")
    p.add_argument("vault"); p.add_argument("out_dir")
    p.add_argument("--folder", action="append", help="repeatable; only notes under it")
    p.add_argument("--exclude", action="append", help="repeatable; skip notes under it")
    p.add_argument("--tag", action="append", help="repeatable; all must match")
    p.add_argument("--since", help="only notes updated on or after YYYY-MM-DD")
    p.add_argument("--limit", type=int, default=200,
                   help="most recently changed notes to keep; 0 for all")
    p.add_argument("--include-flagged", action="store_true",
                   help="publish notes that look like they hold a secret")
    p.add_argument("--inline", action="store_true",
                   help="embed the data in one HTML file for local viewing")
    p.add_argument("--chunk-mb", type=float, default=1.0)
    p.add_argument("--max-mb", type=float, default=40.0)
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("apply")
    p.add_argument("vault"); p.add_argument("edits")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--overwrite", action="append",
                   help="repeatable; replace this conflicted note with the viewer copy")
    p.add_argument("--copy", action="append",
                   help="repeatable; save this conflicted note's viewer copy beside it")
    p.set_defaults(fn=cmd_apply)

    p = sub.add_parser("state")
    p.add_argument("vault"); p.add_argument("--url")
    p.set_defaults(fn=cmd_state)

    args = ap.parse_args(argv)
    if not os.path.isdir(args.vault):
        sys.stderr.write(f"vault not found: {args.vault}\n")
        sys.exit(3)
    args.fn(args)


if __name__ == "__main__":
    main()
