#!/usr/bin/env python3
"""Task store for the executive assistant.

Every task is one markdown file in ``{vault}/tasks/`` with YAML frontmatter.
This script owns every read and write of those files, so skills, the
dashboard and the chat cannot drift apart on the format. Output is JSON.

    python tasks.py [--vault DIR] [--now ISO] <command> [args]

Commands: init, add, parse, list, show, update, move, done, drop, park,
resume, archive, log, stats, context, brief-save, brief-get, shutdown-save.
Run ``python tasks.py <command> -h`` for flags.

Exit codes: 0 ok, 2 bad input, 3 the file changed since you read it
(``--if-sha``), 4 a list limit was hit, 5 not found.

Standard library only. Python 3.9 or later.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

LISTS = ("now", "today", "week", "later", "done", "dropped")
PRIORITIES = ("high", "med", "low")
TODAY_CAP = 5      # now + today together
PARK_CAP = 3
FIELD_ORDER = ("id", "title", "list", "priority", "due", "estimate", "actual",
               "first_step", "next_step", "parked_at", "source", "tags",
               "created", "updated", "done_at")
POINTS = {"high": 3, "med": 2, "low": 1}
EVENT_POINTS = {"brief": 3, "shutdown": 3, "focus": 2}
PLUGIN_ROOT = Path(__file__).resolve().parent.parent


class Fail(Exception):
    def __init__(self, message, code=2, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


# ---------------------------------------------------------------- time ------

def now_of(args):
    if getattr(args, "now", None):
        return dt.datetime.fromisoformat(args.now)
    return dt.datetime.now().replace(microsecond=0)


def iso_min(t):
    return t.strftime("%Y-%m-%dT%H:%M")


def parse_minutes(text):
    """'30m', '1h', '1h30m', '90' -> minutes, or None."""
    if text is None or text == "":
        return None
    s = str(text).strip().lower()
    if s.isdigit():
        return int(s)
    m = re.fullmatch(r"(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minutes))?", s)
    if not m or not (m.group(1) or m.group(2)):
        raise Fail(f"Cannot read '{text}' as a duration. Use 30m, 1h or 1h30m.")
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def fmt_minutes(n):
    if n is None:
        return None
    h, m = divmod(int(n), 60)
    return f"{h}h{m:02d}m" if h and m else f"{h}h" if h else f"{m}m"


# ------------------------------------------------------- frontmatter --------

PLAIN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9 _./@+()&,'-]*$")


def _scalar_out(v, in_list=False):
    if v is None:
        return ""
    s = str(v)
    risky = in_list and any(c in s for c in ",[]{}")
    if PLAIN.match(s) and not risky and s.strip() == s and \
            s.lower() not in ("true", "false", "null", "yes", "no", "on", "off", "~"):
        return s
    return json.dumps(s, ensure_ascii=False)


def _scalar_in(raw):
    s = raw.strip()
    if s in ("", "~", "null"):
        return None
    if s.startswith('"'):
        try:
            return json.loads(s)
        except ValueError:
            return s.strip('"')
    if s.startswith("'") and s.endswith("'") and len(s) >= 2:
        return s[1:-1].replace("''", "'")
    return s


def _list_in(raw):
    inner = raw.strip()[1:-1]
    items, cur, quote = [], "", None
    for ch in inner:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            cur += ch
        elif ch == ",":
            items.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        items.append(cur)
    return [x for x in (_scalar_in(i) for i in items) if x not in (None, "")]


def split_doc(text):
    """Return (fields dict, body). Unknown keys survive a round trip."""
    text = text.replace("\r\n", "\n")
    if not text.startswith("---\n"):
        return {}, text
    if text.startswith("---\n---"):
        return {}, text[7:].lstrip("\n")
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    head, body = text[4:end], text[end + 4:]
    body = body[1:] if body.startswith("\n") else body
    fields, key = {}, None
    for line in head.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^\s+-\s+(.*)$", line)
        if m and key is not None:
            if not isinstance(fields.get(key), list):
                fields[key] = []
            item = _scalar_in(m.group(1))
            if item not in (None, ""):
                fields[key].append(item)
            continue
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s?(.*)$", line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2)
        if raw.strip().startswith("[") and raw.strip().endswith("]"):
            fields[key] = _list_in(raw)
        else:
            fields[key] = _scalar_in(raw)
    return fields, body


def join_doc(fields, body):
    keys = [k for k in FIELD_ORDER if k in fields] + [k for k in fields if k not in FIELD_ORDER]
    lines = ["---"]
    for k in keys:
        v = fields[k]
        if isinstance(v, list):
            lines.append(f"{k}: [{', '.join(_scalar_out(x, in_list=True) for x in v)}]")
        else:
            lines.append(f"{k}: {_scalar_out(v)}".rstrip())
    lines.append("---")
    body = body or ""
    return "\n".join(lines) + "\n" + (body if body.endswith("\n") or not body else body + "\n")


# ------------------------------------------------------------ store ---------

def sha_of(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return (s[:48].rstrip("-") or "task")


class Store:
    def __init__(self, vault):
        if not vault:
            raise Fail("No notes folder is set. Run /plugin configure executive-assistant@personal-plugins "
                       "and set the notes vault path.")
        self.vault = Path(vault).expanduser()
        if not self.vault.is_dir():
            raise Fail(f"The notes folder does not exist: {self.vault}")
        self.dir = self.vault / "tasks"
        self.state = self.vault / ".assistant"

    # files
    def files(self, archived=False):
        if not self.dir.is_dir():
            return []
        out = sorted(p for p in self.dir.glob("t-*.md") if p.is_file())
        if archived and (self.dir / "archive").is_dir():
            out += sorted((self.dir / "archive").rglob("t-*.md"))
        return out

    def load(self, path):
        data = path.read_bytes()
        fields, body = split_doc(data.decode("utf-8", errors="replace"))
        if not fields.get("id"):
            m = re.match(r"t-\d+", path.stem)
            fields["id"] = m.group(0) if m else path.stem
        fields.setdefault("list", "later")
        fields.setdefault("priority", "med")
        if not isinstance(fields.get("tags"), list):
            fields["tags"] = [fields["tags"]] if fields.get("tags") else []
        return {"fields": fields, "body": body, "path": path, "sha": sha_of(data)}

    def all(self, archived=False):
        return [self.load(p) for p in self.files(archived)]

    def find(self, task_id):
        raw = str(task_id).strip()
        if re.fullmatch(r"\d+", raw):
            tid = f"t-{int(raw):04d}"
        elif re.fullmatch(r"t-\d+", raw):
            tid = raw
        else:
            raise Fail(f"'{raw}' is not a task id. Ids look like t-0142.")
        for p in self.files(archived=True):
            if p.stem == tid or p.stem.startswith(tid + "-"):
                return self.load(p)
        raise Fail(f"No task {tid}.", code=5)

    def save(self, task, if_sha=None):
        if if_sha:
            current = sha_of(task["path"].read_bytes())
            if current != if_sha:
                raise Fail("The task changed on disk since you opened it. Reload it and try again.",
                           code=3, sha=current)
        text = join_doc(task["fields"], task["body"])
        atomic_write(task["path"], text)
        task["sha"] = sha_of(text.encode("utf-8"))
        return task

    def create(self, fields, body):
        self.dir.mkdir(parents=True, exist_ok=True)
        nums = [int(m.group(1)) for p in self.files(archived=True)
                for m in [re.match(r"t-(\d+)", p.stem)] if m]
        n = max(nums, default=0) + 1
        while True:
            tid = f"t-{n:04d}"
            path = self.dir / f"{tid}-{slugify(fields['title'])}.md"
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                break
            except FileExistsError:
                n += 1
        fields["id"] = tid
        task = {"fields": fields, "body": body, "path": path, "sha": None}
        return self.save(task)

    # limits
    def count(self, lists, tasks=None, exclude=None):
        tasks = tasks if tasks is not None else self.all()
        return sum(1 for t in tasks if t["fields"]["list"] in lists and t["fields"]["id"] != exclude)

    def place(self, task, target, now):
        """Move a task to a list, applying the Now and Today limits."""
        if target not in LISTS:
            raise Fail(f"Unknown list '{target}'. Use one of: {', '.join(LISTS)}.")
        f = task["fields"]
        tasks = self.all()
        tid = f["id"]
        demoted = None
        # Check the limit before touching any file, so a refusal changes nothing.
        # Now counts toward Today. The old Now task drops to Today, so the total
        # grows only when the task comes from outside Now and Today.
        if target in ("now", "today") and f["list"] not in ("now", "today"):
            if self.count(("now", "today"), tasks, exclude=tid) >= TODAY_CAP:
                raise Fail(f"Today is full ({TODAY_CAP}). Move something out first.", code=4)
        if target == "now":
            for other in tasks:
                if other["fields"]["list"] == "now" and other["fields"]["id"] != tid:
                    other["fields"]["list"] = "today"
                    other["fields"]["updated"] = iso_min(now)
                    self.save(other)
                    demoted = other["fields"]["id"]
        f["list"] = target
        f["updated"] = iso_min(now)
        if target == "done":
            f["done_at"] = iso_min(now)
        elif target != "dropped":
            f.pop("done_at", None)
        return demoted

    # log
    def log(self, event, now, **data):
        self.state.mkdir(parents=True, exist_ok=True)
        rec = {"ts": iso_min(now), "event": event, **{k: v for k, v in data.items() if v is not None}}
        with open(self.state / "log.jsonl", "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec

    def events(self):
        p = self.state / "log.jsonl"
        if not p.exists():
            return []
        out = []
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out


def summary(task, full=False):
    f = dict(task["fields"])
    out = {k: f.get(k) for k in FIELD_ORDER if f.get(k) not in (None, "", [])}
    out["tags"] = f.get("tags") or []
    out["path"] = task["path"].as_posix()
    out["sha"] = task["sha"]
    est = f.get("estimate")
    try:
        out["estimate_min"] = parse_minutes(est) if est else None
    except Fail:
        out["estimate_min"] = None
    if full:
        out["body"] = task["body"]
        out["extra"] = {k: v for k, v in f.items() if k not in FIELD_ORDER}
    return out


# ----------------------------------------------------------- parser ---------

WEEKDAYS = {"mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1, "wed": 2, "weds": 2,
            "wednesday": 2, "thu": 3, "thur": 3, "thurs": 3, "thursday": 3, "fri": 4,
            "friday": 4, "sat": 5, "saturday": 5, "sun": 6, "sunday": 6}


def parse_quick(text, now):
    """Quick-add text -> fields. 'call bank fri 15m !high #admin'."""
    words, out = [], {"priority": "med", "tags": []}
    today = now.date()
    for w in text.split():
        lw = w.lower()
        m = re.fullmatch(r"!(high|h|med|m|medium|low|l)", lw)
        if m:
            out["priority"] = {"h": "high", "m": "med", "l": "low"}[m.group(1)[0]]
            continue
        if re.fullmatch(r"\d+(?:m|min|h|hr)|\d+h\d+m", lw):
            out["estimate"] = fmt_minutes(parse_minutes(lw))
            continue
        if lw in ("today", "tonight"):
            out["due"] = today.isoformat()
            continue
        if lw in ("tomorrow", "tmr", "tmrw"):
            out["due"] = (today + dt.timedelta(days=1)).isoformat()
            continue
        if lw in WEEKDAYS:
            ahead = (WEEKDAYS[lw] - today.weekday()) % 7
            out["due"] = (today + dt.timedelta(days=ahead)).isoformat()
            continue
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", lw):
            out["due"] = lw
            continue
        if lw.startswith("#") and len(lw) > 1:
            out["tags"].append(lw[1:])
            continue
        words.append(w)
    out["title"] = " ".join(words).strip()
    out["list"] = default_list(out.get("due"), today)
    return out


def default_list(due, today):
    """New tasks without a day go to This week, so capture never clutters Today."""
    if not due:
        return "week"
    d = dt.date.fromisoformat(due)
    if d <= today:
        return "today"
    week_end = today + dt.timedelta(days=6 - today.weekday())
    return "week" if d <= week_end else "later"


# --------------------------------------------------------- commands ---------

def cmd_init(store, args, now):
    made = []
    for d in (store.dir, store.dir / "archive", store.state, store.vault / "assistant"):
        if not d.exists():
            d.mkdir(parents=True)
            made.append(d.as_posix())
    for name in ("email-rules.md", "profile.md"):
        dest = store.vault / "assistant" / name
        if not dest.exists():
            shutil.copyfile(PLUGIN_ROOT / "templates" / name, dest)
            made.append(dest.as_posix())
    return {"created": made, "vault": store.vault.as_posix()}


def fields_from_args(args, now, base=None):
    f = dict(base or {})
    if getattr(args, "parse", None):
        f.update({k: v for k, v in parse_quick(args.parse, now).items() if v not in (None, "", [])})
    for key in ("title", "due", "first_step", "next_step", "source"):
        v = getattr(args, key, None)
        if v is not None:
            f[key] = v.strip() or None
    if getattr(args, "priority", None):
        if args.priority not in PRIORITIES:
            raise Fail(f"Priority must be one of: {', '.join(PRIORITIES)}.")
        f["priority"] = args.priority
    for key in ("estimate", "actual"):
        v = getattr(args, key, None)
        if v is not None:
            f[key] = fmt_minutes(parse_minutes(v)) if v else None
    if getattr(args, "tags", None) is not None:
        f["tags"] = [t.strip().lstrip("#") for t in args.tags.split(",") if t.strip()]
    if f.get("due"):
        try:
            dt.date.fromisoformat(f["due"])
        except ValueError:
            raise Fail(f"Due date '{f['due']}' must look like 2026-10-16.")
    return {k: v for k, v in f.items() if v is not None}


def read_body(args):
    if getattr(args, "body_file", None):
        return Path(args.body_file).read_text(encoding="utf-8")
    if getattr(args, "notes", None) is not None:
        return args.notes.replace("\\n", "\n")
    return None


def cmd_add(store, args, now):
    f = fields_from_args(args, now)
    if not f.get("title"):
        raise Fail("A task needs a title.")
    f.setdefault("priority", "med")
    f.setdefault("tags", [])
    wanted = args.list or f.get("list") or default_list(f.get("due"), now.date())
    f["list"] = "later"
    f["created"] = f["updated"] = iso_min(now)
    body = read_body(args) or ""
    task = store.create(f, body)
    note = None
    try:
        demoted = store.place(task, wanted, now)
        if demoted:
            note = f"{demoted} moved from Now to Today."
    except Fail as e:
        if e.code != 4:
            raise
        store.place(task, "week", now)
        note = f"Today is full ({TODAY_CAP}), so this went to This week."
    store.save(task)
    return {"task": summary(task), "note": note}


def cmd_parse(store, args, now):
    return parse_quick(args.text, now)


def cmd_list(store, args, now):
    tasks = store.all(archived=args.archived)
    lists = set(args.list.split(",")) if args.list else {"now", "today", "week", "later"}
    if args.all:
        lists = set(LISTS)
    rank = {k: i for i, k in enumerate(LISTS)}
    prio = {k: i for i, k in enumerate(PRIORITIES)}
    picked = [t for t in tasks if t["fields"]["list"] in lists]
    if args.tag:
        picked = [t for t in picked if args.tag in (t["fields"].get("tags") or [])]
    picked.sort(key=lambda t: (rank.get(t["fields"]["list"], 9), prio.get(t["fields"].get("priority"), 1),
                               t["fields"].get("due") or "9999", t["fields"]["id"]))
    counts = {k: sum(1 for t in tasks if t["fields"]["list"] == k) for k in LISTS}
    parked = sum(1 for t in tasks if t["fields"].get("parked_at") and t["fields"]["list"] not in ("done", "dropped"))
    return {"tasks": [summary(t) for t in picked], "counts": counts, "parked": parked,
            "today_cap": TODAY_CAP, "today_used": counts["now"] + counts["today"]}


def cmd_show(store, args, now):
    return {"task": summary(store.find(args.id), full=True)}


def cmd_update(store, args, now):
    task = store.find(args.id)
    if args.if_sha and task["sha"] != args.if_sha:
        raise Fail("The task changed on disk since you opened it. Reload it and try again.",
                   code=3, sha=task["sha"])
    new = fields_from_args(args, now, base=task["fields"])
    target = args.list
    task["fields"] = {**new, "list": task["fields"]["list"]}
    body = read_body(args)
    if body is not None:
        task["body"] = body
    demoted = store.place(task, target, now) if target and target != task["fields"]["list"] else None
    task["fields"]["updated"] = iso_min(now)
    store.save(task, if_sha=args.if_sha)
    return {"task": summary(task), "demoted": demoted}


def cmd_move(store, args, now):
    if args.list == "done":
        return cmd_done(store, argparse.Namespace(id=args.id, actual=None), now)
    task = store.find(args.id)
    demoted = store.place(task, args.list, now)
    store.save(task)
    return {"task": summary(task), "demoted": demoted}


def cmd_done(store, args, now):
    task = store.find(args.id)
    f = task["fields"]
    if f["list"] == "done":
        return {"task": summary(task), "points": 0, "note": "Already done."}
    if args.actual:
        f["actual"] = fmt_minutes(parse_minutes(args.actual))
    was_now = f["list"] == "now"
    store.place(task, "done", now)
    f.pop("parked_at", None)
    store.save(task)
    pts = POINTS.get(f.get("priority"), 2)
    est = parse_minutes(f.get("estimate")) if f.get("estimate") else None
    act = parse_minutes(f.get("actual")) if f.get("actual") else None
    store.log("done", now, task=f["id"], points=pts, estimate_min=est, actual_min=act)
    nxt = None
    if was_now:
        today = [t for t in store.all() if t["fields"]["list"] == "today"]
        prio = {k: i for i, k in enumerate(PRIORITIES)}
        today.sort(key=lambda t: (prio.get(t["fields"].get("priority"), 1), t["fields"].get("due") or "9999"))
        if today:
            nxt = summary(today[0])
    return {"task": summary(task), "points": pts, "suggest_now": nxt}


def cmd_drop(store, args, now):
    task = store.find(args.id)
    store.place(task, "dropped", now)
    store.save(task)
    return {"task": summary(task)}


def cmd_park(store, args, now):
    task = store.find(args.id)
    f = task["fields"]
    if f["list"] in ("done", "dropped"):
        raise Fail("Finished tasks cannot be parked.")
    parked = [t for t in store.all() if t["fields"].get("parked_at") and t["fields"]["id"] != f["id"]
              and t["fields"]["list"] not in ("done", "dropped")]
    if len(parked) >= PARK_CAP:
        raise Fail(f"{PARK_CAP} tasks are already parked. Resume one before you park another.", code=4,
                   parked=[t["fields"]["id"] for t in parked])
    f["parked_at"] = iso_min(now)
    if args.next:
        f["next_step"] = args.next
    if f["list"] == "now":
        store.place(task, "today", now)
    f["updated"] = iso_min(now)
    store.save(task)
    return {"task": summary(task)}


def cmd_resume(store, args, now):
    task = store.find(args.id)
    task["fields"].pop("parked_at", None)
    demoted = store.place(task, "now", now)
    store.save(task)
    return {"task": summary(task), "demoted": demoted}


def cmd_archive(store, args, now):
    cutoff = now - dt.timedelta(days=args.days)
    moved = []
    for t in store.all():
        f = t["fields"]
        stamp = f.get("done_at") or f.get("updated")
        if f["list"] not in ("done", "dropped") or not stamp:
            continue
        try:
            when = dt.datetime.fromisoformat(stamp)
        except ValueError:
            continue
        if when <= cutoff:
            dest = store.dir / "archive" / when.strftime("%Y-%m") / t["path"].name
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(t["path"], dest)
            moved.append(f["id"])
    return {"archived": moved}


def cmd_log(store, args, now):
    if args.event not in EVENT_POINTS and args.event != "off":
        raise Fail(f"Event must be one of: {', '.join(list(EVENT_POINTS) + ['off'])}.")
    when = now
    if args.date:
        when = dt.datetime.combine(dt.date.fromisoformat(args.date), now.time())
    rec = store.log(args.event, when, points=EVENT_POINTS.get(args.event), task=args.task,
                    minutes=parse_minutes(args.minutes) if args.minutes else None)
    return {"logged": rec}


def cmd_stats(store, args, now):
    day = dt.date.fromisoformat(args.date) if args.date else now.date()
    events = store.events()

    def on(d):
        return [e for e in events if e.get("ts", "").startswith(d.isoformat())]

    week_start = day - dt.timedelta(days=day.weekday())
    pts_today = sum(e.get("points") or 0 for e in on(day))
    pts_week = sum(e.get("points") or 0 for e in events
                   if week_start.isoformat() <= e.get("ts", "")[:10] <= day.isoformat())

    def complete(d):
        kinds = {e["event"] for e in on(d)}
        return {"brief", "shutdown"} <= kinds

    def off(d):
        return d.weekday() >= 5 or any(e["event"] == "off" for e in on(d))

    streak, d = 0, day
    if not complete(d):
        d -= dt.timedelta(days=1)       # today still counts once its shutdown runs
    for _ in range(366):
        if off(d):
            d -= dt.timedelta(days=1)
            continue
        if not complete(d):
            break
        streak += 1
        d -= dt.timedelta(days=1)

    ratios = [e["actual_min"] / e["estimate_min"] for e in events
              if e.get("event") == "done" and e.get("estimate_min") and e.get("actual_min")][-20:]
    if len(ratios) >= 3:
        s = sorted(ratios)
        mid = len(s) // 2
        speed = s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2
        speed = round(min(4.0, max(0.5, speed)), 2)
    else:
        speed = 1.0
    done_today = [e for e in on(day) if e["event"] == "done"]
    return {"date": day.isoformat(), "points_today": pts_today, "points_week": pts_week,
            "streak": streak, "speed": speed, "speed_samples": len(ratios),
            "done_today": len(done_today),
            "brief_done": any(e["event"] == "brief" for e in on(day)),
            "shutdown_done": any(e["event"] == "shutdown" for e in on(day))}


# ------------------------------------------------- brief and shutdown -------

def _day_file(store, kind, day):
    return store.state / kind / f"{day}.json"


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _save_day_json(store, kind, args, now, required=()):
    try:
        data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Fail(f"Cannot read {kind} JSON from {args.file}: {e}")
    if not isinstance(data, dict):
        raise Fail(f"The {kind} file must hold one JSON object.")
    day = data.get("date") or now.date().isoformat()
    try:
        dt.date.fromisoformat(day)
    except ValueError:
        raise Fail(f"'date' must look like 2026-10-13, not '{day}'.")
    missing = [k for k in required if k not in data]
    if missing:
        raise Fail(f"The {kind} file is missing: {', '.join(missing)}.")
    data["date"] = day
    data.setdefault("generated_at", iso_min(now))
    path = _day_file(store, kind, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, path)
    # Points and streak count one brief and one shutdown per day, however
    # often the user re-runs them.
    event = {"brief": "brief", "shutdown": "shutdown"}[kind]
    already = any(e.get("event") == event and e.get("ts", "").startswith(day) for e in store.events())
    if not already:
        when = dt.datetime.combine(dt.date.fromisoformat(day), now.time())
        store.log(event, when, points=EVENT_POINTS[event])
    return {"saved": path.as_posix(), "points": 0 if already else EVENT_POINTS[event]}


def cmd_brief_save(store, args, now):
    return _save_day_json(store, "brief", args, now, required=("email", "calendar", "plan"))


def cmd_shutdown_save(store, args, now):
    return _save_day_json(store, "shutdown", args, now, required=("first_step",))


def cmd_brief_get(store, args, now):
    folder = store.state / "brief"
    if args.date:
        path = folder / f"{args.date}.json"
    else:
        files = sorted(folder.glob("*.json")) if folder.is_dir() else []
        path = files[-1] if files else None
    data = _read_json(path) if path else None
    if data is None:
        raise Fail("No brief saved yet." if not args.date else f"No brief for {args.date}.", code=5)
    return data


def workdays_between(a, b, off_days=()):
    """Workdays strictly after a and strictly before b."""
    n, d = 0, a + dt.timedelta(days=1)
    while d < b:
        if d.weekday() < 5 and d.isoformat() not in off_days:
            n += 1
        d += dt.timedelta(days=1)
    return n


def cmd_context(store, args, now):
    """Everything the morning brief needs to know before it gathers anything."""
    today = now.date()
    events = store.events()
    off = {e["ts"][:10] for e in events if e.get("event") == "off"}
    briefs = sorted({e["ts"][:10] for e in events if e.get("event") == "brief"})
    before = [d for d in briefs if d < today.isoformat()]
    last_brief = before[-1] if before else None
    missed = workdays_between(dt.date.fromisoformat(last_brief), today, off) if last_brief else None

    shut_dir = store.state / "shutdown"
    shut_files = sorted(p for p in shut_dir.glob("*.json") if p.stem < today.isoformat()) if shut_dir.is_dir() else []
    last_shut = _read_json(shut_files[-1]) if shut_files else None

    tasks = store.all()
    open_ = [t for t in tasks if t["fields"]["list"] not in ("done", "dropped")]
    week_end = today + dt.timedelta(days=6 - today.weekday())

    def due(t):
        try:
            return dt.date.fromisoformat(t["fields"].get("due")) if t["fields"].get("due") else None
        except ValueError:
            return None

    now_task = next((t for t in open_ if t["fields"]["list"] == "now"), None)
    return {
        "date": today.isoformat(),
        "weekday": today.strftime("%a"),
        "is_workday": today.weekday() < 5 and today.isoformat() not in off,
        "is_monday": today.weekday() == 0,
        "brief_today": today.isoformat() in briefs,
        "last_brief": last_brief,
        "workdays_missed": missed,
        "catch_up": bool(missed is not None and missed >= 2),
        "first_use": last_brief is None and not briefs,
        "last_shutdown": {"date": shut_files[-1].stem, "first_step": last_shut.get("first_step"),
                          "tonight": last_shut.get("tonight")} if last_shut else None,
        "now": summary(now_task) if now_task else None,
        "today": [summary(t) for t in open_ if t["fields"]["list"] == "today"],
        "parked": [summary(t) for t in open_ if t["fields"].get("parked_at")],
        "overdue": [summary(t) for t in open_ if due(t) and due(t) < today],
        "due_this_week": [summary(t) for t in open_ if due(t) and today <= due(t) <= week_end],
        "counts": {k: sum(1 for t in tasks if t["fields"]["list"] == k) for k in LISTS},
        "stats": cmd_stats(store, argparse.Namespace(date=None), now),
        "files": {"rules": (store.vault / "assistant" / "email-rules.md").exists(),
                  "profile": (store.vault / "assistant" / "profile.md").exists()},
    }


# -------------------------------------------------------------- cli ---------

def build_parser():
    p = argparse.ArgumentParser(prog="tasks.py", description="Markdown task store for the executive assistant.")
    p.add_argument("--vault", default=os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"),
                   help="Notes folder. Default: CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH.")
    p.add_argument("--now", help="Pretend the time is this ISO value (tests).")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Create tasks/, assistant/ rules and profile files if missing.")

    def task_fields(sp, add=False):
        sp.add_argument("--title")
        sp.add_argument("--list", choices=LISTS)
        sp.add_argument("--priority")
        sp.add_argument("--due", help="YYYY-MM-DD; empty string clears it")
        sp.add_argument("--estimate", help="30m, 1h, 1h30m")
        sp.add_argument("--actual", help="Time it really took")
        sp.add_argument("--first-step", dest="first_step")
        sp.add_argument("--next-step", dest="next_step")
        sp.add_argument("--source", help="Link or reference, e.g. a Linear URL")
        sp.add_argument("--tags", help="Comma-separated")
        sp.add_argument("--notes", help="Body text (\\n for new lines)")
        sp.add_argument("--body-file", dest="body_file", help="Read the body from this file")
        if add:
            sp.add_argument("--parse", help="Quick-add text: 'call bank fri 15m !high #admin'")

    a = sub.add_parser("add", help="Create a task.")
    task_fields(a, add=True)
    pr = sub.add_parser("parse", help="Show how quick-add text is read, without saving.")
    pr.add_argument("text")
    ls = sub.add_parser("list", help="List open tasks.")
    ls.add_argument("--list", help="Comma-separated lists, e.g. now,today")
    ls.add_argument("--all", action="store_true", help="Include done and dropped")
    ls.add_argument("--archived", action="store_true", help="Include the archive folder")
    ls.add_argument("--tag")
    sh = sub.add_parser("show", help="Show one task with its body.")
    sh.add_argument("id")
    up = sub.add_parser("update", help="Change fields of a task.")
    up.add_argument("id")
    task_fields(up)
    up.add_argument("--if-sha", dest="if_sha", help="Refuse if the file changed since this sha")
    mv = sub.add_parser("move", help="Move a task to another list.")
    mv.add_argument("id")
    mv.add_argument("list", choices=LISTS)
    dn = sub.add_parser("done", help="Mark a task done and log its points.")
    dn.add_argument("id")
    dn.add_argument("--actual", help="Time it really took, e.g. 50m")
    dr = sub.add_parser("drop", help="Drop a task. The file stays on disk.")
    dr.add_argument("id")
    pk = sub.add_parser("park", help="Save your place in a task before you switch.")
    pk.add_argument("id")
    pk.add_argument("--next", help="The next step, in a few words")
    rs = sub.add_parser("resume", help="Make a parked task the Now task again.")
    rs.add_argument("id")
    ar = sub.add_parser("archive", help="Move old done and dropped tasks to tasks/archive/<yyyy-mm>/.")
    ar.add_argument("--days", type=int, default=7)
    lg = sub.add_parser("log", help="Record brief, shutdown, focus or off (a day away).")
    lg.add_argument("event")
    lg.add_argument("--task")
    lg.add_argument("--minutes")
    lg.add_argument("--date")
    st = sub.add_parser("stats", help="Points, streak and your usual speed.")
    st.add_argument("--date")
    sub.add_parser("context", help="What the morning brief needs: catch-up, last shutdown, due tasks.")
    bs = sub.add_parser("brief-save", help="Save the brief JSON for the dashboard and log the brief.")
    bs.add_argument("file")
    bg = sub.add_parser("brief-get", help="Read a saved brief (latest by default).")
    bg.add_argument("--date")
    ss = sub.add_parser("shutdown-save", help="Save the shutdown JSON and log the shutdown.")
    ss.add_argument("file")
    return p


COMMANDS = {"init": cmd_init, "add": cmd_add, "parse": cmd_parse, "list": cmd_list, "show": cmd_show,
            "update": cmd_update, "move": cmd_move, "done": cmd_done, "drop": cmd_drop, "park": cmd_park,
            "resume": cmd_resume, "archive": cmd_archive, "log": cmd_log, "stats": cmd_stats,
            "context": cmd_context, "brief-save": cmd_brief_save, "brief-get": cmd_brief_get,
            "shutdown-save": cmd_shutdown_save}


def run(argv):
    args = build_parser().parse_args(argv)
    now = now_of(args)
    if args.cmd == "parse":
        return cmd_parse(None, args, now)
    return COMMANDS[args.cmd](Store(args.vault), args, now)


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
