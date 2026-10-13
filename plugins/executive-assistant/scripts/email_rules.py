#!/usr/bin/env python3
"""Email rules for the executive assistant.

The rules live in ``{vault}/assistant/email-rules.md``, one rule per line:

    - action | mode | name | gmail query | label

The user can edit that file by hand. This script owns every machine read and
write of it, plus the per-rule match stats in ``{vault}/.assistant/email-stats.json``,
so the skills never parse or edit the file themselves. Output is JSON.

    python email_rules.py [--vault DIR] [--now ISO] <command> [args]

Commands: parse, queries, add, record, undo, filter-offers, mark-filter.
Run ``python email_rules.py <command> -h`` for flags.

Exit codes: 0 ok, 2 bad input, 5 the rules file is missing (run
``python tasks.py init`` to create it from the template).

Standard library only. Python 3.9 or later.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ACTIONS = ("keep", "support", "label", "archive", "trash")
ALIASES = {"support-owned": "support"}
MODES = ("auto", "confirm")
FILTER_ACTIONS = ("trash", "archive", "label")
FILTER_STATES = ("offered", "created", "declined")
STARRED_SAFE = ("trash", "archive")     # these never touch starred mail
LEARNED_HEADING = "Learned rules"
OFFER_MIN_RUNS = 5
OFFER_MIN_SPAN_DAYS = 10

FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
BULLET = re.compile(r"^\s*[-*]\s+(.*)$")
COMMENT = re.compile(r"<!--.*?-->")
PLACEHOLDER = re.compile(r"<[A-Za-z][A-Za-z0-9_-]*>")


class Fail(Exception):
    def __init__(self, message, code=2, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


def now_of(args):
    if getattr(args, "now", None):
        return dt.datetime.fromisoformat(args.now)
    return dt.datetime.now().replace(microsecond=0)


def norm_query(q):
    """Gmail search is case-insensitive and ignores extra spaces."""
    return " ".join(q.split()).lower()


# ---------------------------------------------------------- parsing ---------

def parse_rule(body):
    """Parse the text after '- '. Return (rule dict, None) or (None, why)."""
    text = COMMENT.sub("", body).strip()
    parts = [p.strip() for p in text.split("|")]
    if len(parts) < 4:
        return None, "A rule needs at least 4 parts split by '|': action | mode | name | gmail query."
    if len(parts) > 5:
        return None, "A rule has at most 5 parts. Remove the extra '|'."
    action = ALIASES.get(parts[0].lower(), parts[0].lower())
    mode = parts[1].lower()
    name, query = parts[2], parts[3]
    label = parts[4] if len(parts) == 5 and parts[4] else None
    if action not in ACTIONS:
        return None, f"Unknown action '{parts[0]}'. Use one of: {', '.join(ACTIONS)}."
    if mode not in MODES:
        return None, f"Unknown mode '{parts[1]}'. Use auto or confirm."
    if not name:
        return None, "The rule has no name."
    if not query:
        return None, "The rule has no Gmail query."
    if action == "label" and not label:
        return None, "A label rule needs a 5th part: the label to add."
    if label and action not in ("label", "archive"):
        return None, f"Only label and archive rules take a label, not {action}."
    return {"action": action, "mode": mode, "name": name, "query": query, "label": label}, None


def looks_like_rule(body):
    first = re.split(r"[\s|]", body.strip(), maxsplit=1)[0].lower()
    return "|" in body or first in ACTIONS or first in ALIASES


def parse_text(text):
    """Parse the rules file. Malformed lines become errors, never exceptions."""
    lines = text.splitlines()
    rules, errors, placeholders = [], [], []
    section, in_fence, start = None, False, 0
    if lines and lines[0].strip() == "---":           # skip YAML frontmatter
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break
    for i in range(start, len(lines)):
        line = lines[i]
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        h = HEADING.match(line)
        if h:
            section = h.group(2)
            continue
        b = BULLET.match(line)
        if not b or not looks_like_rule(b.group(1)):
            continue
        rule, why = parse_rule(b.group(1))
        if rule is None:
            errors.append({"line_no": i + 1, "text": line.strip(), "why": why})
            continue
        found = []
        for field in (rule["query"], rule["label"] or ""):
            for p in PLACEHOLDER.findall(field):
                if p not in found:
                    found.append(p)
        for p in found:
            if p not in placeholders:
                placeholders.append(p)
        rules.append({"n": len(rules) + 1, **rule, "section": section, "line_no": i + 1,
                      "skipped": f"placeholder {', '.join(found)}" if found else None})
    return {"rules": rules, "placeholders": placeholders, "errors": errors}


def canonical(rule):
    parts = [rule["action"], rule["mode"], rule["name"], rule["query"]]
    if rule.get("label"):
        parts.append(rule["label"])
    return "- " + " | ".join(parts)


def gmail_query(rule):
    q = f"in:inbox ({rule['query']})"
    if rule["action"] in STARRED_SAFE:
        q += " -is:starred"
    return q


# ------------------------------------------------------------- files --------

class Vault:
    def __init__(self, vault):
        if not vault:
            raise Fail("No notes folder is set. Run /plugin configure executive-assistant@personal-plugins "
                       "and set the notes vault path.")
        self.root = Path(vault).expanduser()
        if not self.root.is_dir():
            raise Fail(f"The notes folder does not exist: {self.root}")
        self.rules_path = self.root / "assistant" / "email-rules.md"
        self.stats_path = self.root / ".assistant" / "email-stats.json"

    def read_rules(self):
        """Return (text with \\n endings, newline, had_bom, ends_with_newline)."""
        if not self.rules_path.is_file():
            raise Fail(f"The email rules file is missing: {self.rules_path.as_posix()}. "
                       "Run `python tasks.py init` once to create it from the template, then try again.",
                       code=5, path=self.rules_path.as_posix())
        raw = self.rules_path.read_bytes()
        bom = raw.startswith(b"\xef\xbb\xbf")
        text = raw.decode("utf-8-sig", errors="replace")
        newline = "\r\n" if "\r\n" in text else "\n"
        text = text.replace("\r\n", "\n")
        return text, newline, bom, text.endswith("\n")

    def write_rules(self, text, newline, bom):
        data = text.replace("\n", newline).encode("utf-8")
        if bom:
            data = b"\xef\xbb\xbf" + data
        atomic_write(self.rules_path, data)

    def load_stats(self):
        if not self.stats_path.is_file():
            return {"version": 1, "rules": {}}
        try:
            data = json.loads(self.stats_path.read_text(encoding="utf-8"))
        except ValueError:
            raise Fail(f"The stats file is not valid JSON: {self.stats_path.as_posix()}. "
                       "Fix or move it; nothing was changed.")
        if not isinstance(data.get("rules"), dict):
            data["rules"] = {}
        return data

    def save_stats(self, data):
        text = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        atomic_write(self.stats_path, text.encode("utf-8"))


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def stat_entry(stats, name):
    return stats["rules"].setdefault(name, {"runs_matched": 0, "total_matched": 0, "first_date": None,
                                            "last_date": None, "undone": 0})


def date_of(text, fallback):
    if not text:
        return fallback.date().isoformat()
    try:
        return dt.date.fromisoformat(str(text)[:10]).isoformat()
    except ValueError:
        raise Fail(f"Date '{text}' must look like 2026-10-13.")


# ---------------------------------------------------------- commands --------

def cmd_parse(vault, args, now):
    text = vault.read_rules()[0]
    return {"path": vault.rules_path.as_posix(), **parse_text(text)}


def cmd_queries(vault, args, now):
    parsed = parse_text(vault.read_rules()[0])
    out = [{"n": r["n"], "name": r["name"], "action": r["action"], "mode": r["mode"], "label": r["label"],
            "query": gmail_query(r)} for r in parsed["rules"] if not r["skipped"]]
    return {"queries": out,
            "skipped": [{"n": r["n"], "name": r["name"], "skipped": r["skipped"]}
                        for r in parsed["rules"] if r["skipped"]],
            "placeholders": parsed["placeholders"], "errors": parsed["errors"],
            "note": ("Run each query in order and page through every result. A message belongs to the first "
                     "rule that returned its id; later matches for that id are ignored. Unread inbox "
                     "messages that no rule returned are the remaining mail to triage.")}


def cmd_add(vault, args, now):
    body = args.line.strip()
    m = BULLET.match(body)
    body = m.group(1) if m else body
    rule, why = parse_rule(body)
    if rule is None:
        raise Fail(f"That rule line is not valid: {why}")
    if PLACEHOLDER.search(rule["query"]) or PLACEHOLDER.search(rule["label"] or ""):
        raise Fail("That rule still holds a <placeholder>. Put the real value in first.")
    text, newline, bom, ends_nl = vault.read_rules()
    existing = parse_text(text)["rules"]
    for r in existing:
        if norm_query(r["query"]) == norm_query(rule["query"]):
            raise Fail(f"Rule {r['n']} ('{r['name']}', line {r['line_no']}) already uses that query.",
                       existing=canonical(r), line_no=r["line_no"])
        if r["name"].lower() == rule["name"].lower():
            raise Fail(f"Rule {r['n']} on line {r['line_no']} already has the name '{r['name']}'. "
                       "Names must be unique because match stats are kept by name.",
                       existing=canonical(r), line_no=r["line_no"])
    line = canonical(rule)
    why_text = " ".join((args.why or "").replace("--", "-").split())
    full = f"{line}  <!-- added {now.date().isoformat()}{': ' + why_text if why_text else ''} -->"

    lines = text.split("\n")
    if ends_nl:
        lines = lines[:-1]                       # drop the empty piece after the last newline
    head, in_fence = None, False
    for i, ln in enumerate(lines):
        if FENCE.match(ln):
            in_fence = not in_fence
            continue
        h = HEADING.match(ln)
        if not in_fence and h and h.group(1) == "##" and h.group(2).strip().lower() == LEARNED_HEADING.lower():
            head = i
            break
    if head is None:
        while lines and not lines[-1].strip():
            lines.pop()
        lines += ["", f"## {LEARNED_HEADING}", "", full]
        at = len(lines) - 1
    else:
        end, in_fence = len(lines), False
        for j in range(head + 1, len(lines)):
            if FENCE.match(lines[j]):
                in_fence = not in_fence
                continue
            h = HEADING.match(lines[j])
            if not in_fence and h and len(h.group(1)) <= 2:
                end = j
                break
        last = head
        for j in range(head + 1, end):
            if lines[j].strip():
                last = j
        b = BULLET.match(lines[last])
        insert = [full] if (b and looks_like_rule(b.group(1))) else ["", full]
        if last + 1 < len(lines) and lines[last + 1].strip():
            insert.append("")                    # keep a blank line before the next heading
        lines[last + 1:last + 1] = insert
        at = last + 1 + insert.index(full)
    new_text = "\n".join(lines) + "\n"
    vault.write_rules(new_text, newline, bom)
    return {"added": line, "line_no": at + 1, "path": vault.rules_path.as_posix(),
            "rule": next(r for r in parse_text(new_text)["rules"] if r["line_no"] == at + 1)}


def cmd_record(vault, args, now):
    try:
        run = json.loads(Path(args.run_json).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Fail(f"Cannot read the run file {args.run_json}: {e.__class__.__name__}.")
    matches = run.get("matches") if isinstance(run, dict) else None
    if not isinstance(matches, dict):
        raise Fail('The run file needs {"date": "YYYY-MM-DD", "matches": {"<rule name>": count}}.')
    for name, count in matches.items():
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise Fail(f"The count for '{name}' must be a whole number of 0 or more.")
    day = date_of(run.get("date"), now)
    known = None
    try:
        known = {r["name"] for r in parse_text(vault.read_rules()[0])["rules"]}
    except Fail:
        pass
    stats = vault.load_stats()
    updated = {}
    for name, count in matches.items():
        if count == 0:
            continue
        e = stat_entry(stats, name)
        e["runs_matched"] += 1
        e["total_matched"] += count
        e["first_date"] = min(filter(None, (e["first_date"], day)))
        e["last_date"] = max(filter(None, (e["last_date"], day)))
        updated[name] = dict(e)
    vault.save_stats(stats)
    return {"date": day, "updated": updated,
            "unknown_rules": sorted(n for n in matches if known is not None and n not in known)}


def cmd_undo(vault, args, now):
    stats = vault.load_stats()
    e = stat_entry(stats, args.rule)
    e["undone"] += 1
    vault.save_stats(stats)
    return {"rule": args.rule, "stats": e}


def cmd_filter_offers(vault, args, now):
    parsed = parse_text(vault.read_rules()[0])
    stats = vault.load_stats()["rules"]
    offers = []
    for r in parsed["rules"]:
        if r["skipped"] or r["mode"] != "auto" or r["action"] not in FILTER_ACTIONS:
            continue
        s = stats.get(r["name"])
        if not s or s.get("filter") in FILTER_STATES or s.get("undone", 0) != 0:
            continue
        if s.get("runs_matched", 0) < OFFER_MIN_RUNS or not s.get("first_date") or not s.get("last_date"):
            continue
        span = (dt.date.fromisoformat(s["last_date"]) - dt.date.fromisoformat(s["first_date"])).days
        if span < OFFER_MIN_SPAN_DAYS:
            continue
        offers.append({"rule": r["name"], "query": r["query"], "runs": s["runs_matched"],
                       "matched": s["total_matched"], "action": r["action"], "label": r["label"],
                       "span_days": span})
    return {"offers": offers}


def cmd_mark_filter(vault, args, now):
    stats = vault.load_stats()
    e = stat_entry(stats, args.rule)
    e["filter"] = args.state
    e["filter_date"] = now.date().isoformat()
    vault.save_stats(stats)
    return {"rule": args.rule, "stats": e}


# --------------------------------------------------------------- cli --------

def build_parser():
    p = argparse.ArgumentParser(prog="email_rules.py", description="Email rules for the executive assistant.")
    p.add_argument("--vault", default=os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"),
                   help="Notes folder. Default: CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH.")
    p.add_argument("--now", help="Pretend the time is this ISO value (tests).")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("parse", help="Read the rules file: rules in file order, placeholders, errors.")
    sub.add_parser("queries", help="The Gmail search to run for each active rule, in order.")
    a = sub.add_parser("add", help="Append a rule under '## Learned rules'.")
    a.add_argument("--line", required=True, help="'- action | mode | name | gmail query | label'")
    a.add_argument("--why", help="Why the rule was added, kept in a comment on the line")
    r = sub.add_parser("record", help="Add one run's per-rule match counts to the stats.")
    r.add_argument("--run-json", dest="run_json", required=True,
                   help='File holding {"date": "YYYY-MM-DD", "matches": {"<rule name>": count}}')
    u = sub.add_parser("undo", help="Count that the user pulled a message back out for this rule.")
    u.add_argument("--rule", required=True)
    sub.add_parser("filter-offers", help="Auto rules steady enough to become a real Gmail filter.")
    mf = sub.add_parser("mark-filter", help="Store that a filter was offered, created or declined.")
    mf.add_argument("--rule", required=True)
    mf.add_argument("--state", required=True, choices=FILTER_STATES)
    return p


COMMANDS = {"parse": cmd_parse, "queries": cmd_queries, "add": cmd_add, "record": cmd_record,
            "undo": cmd_undo, "filter-offers": cmd_filter_offers, "mark-filter": cmd_mark_filter}


def run(argv):
    args = build_parser().parse_args(argv)
    return COMMANDS[args.cmd](Vault(args.vault), args, now_of(args))


def main(argv=None):
    try:
        out, code = run(sys.argv[1:] if argv is None else argv), 0
    except Fail as e:
        out, code = {"error": str(e), **e.extra}, e.code
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")   # Windows consoles default to a code page
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return code


if __name__ == "__main__":
    sys.exit(main())
