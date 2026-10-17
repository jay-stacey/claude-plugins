"""Session reader: `claude agents --json` + desktop session files + transcripts.

Read only. The desktop session files are not a documented format: every
field is optional, a bad file is skipped, and a file is parsed again only
when its mtime changes.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import paths
from .transcripts import clip

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
GREW_WINDOW_MS = 30_000
BACKGROUND_MAX_AGE_MS = 2 * HOUR_MS     # older unfinished background work is ignored
MAX_SUMMARY = 400
ID_RE = re.compile(r"^(local|bg|cli)_[A-Za-z0-9-]{1,80}$")
LINK = "claude://claude.ai/epitaxy/{}"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def now_ms() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------ sources -----

class AgentsSource:
    """Runs `claude agents --json`; on failure keeps the last good rows."""

    def __init__(self, command=None, timeout=20):
        self.command = command
        self.timeout = timeout
        self.rows = []
        self.stale = False
        self.ok_once = False
        self.running = threading.Lock()

    def argv(self):
        if self.command:
            return list(self.command)
        override = os.environ.get("COS_CLAUDE_CMD")
        if override:
            return json.loads(override) if override.startswith("[") else [override, "agents", "--json"]
        exe = shutil.which("claude") or "claude"
        return [exe, "agents", "--json"]

    def run(self):
        """One `claude agents --json` call: its rows, or an exception."""
        out = subprocess.run(self.argv(), capture_output=True, timeout=self.timeout,
                             stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        rows = json.loads(out.stdout.decode("utf-8", errors="replace") or "null")
        if out.returncode != 0 or not isinstance(rows, list):
            raise ValueError("agents failed")
        return rows

    def poll(self):
        """Refreshes the rows; a call while one runs returns the last rows at once."""
        if not self.running.acquire(blocking=False):
            return self.rows
        try:
            rows = self.run()
            self.rows = [r for r in rows if isinstance(r, dict)]
            self.stale = False
            self.ok_once = True
        except Exception:
            self.stale = True
        finally:
            self.running.release()
        return self.rows


class DesktopSource:
    """The desktop app's local_*.json files, cached by mtime."""

    def __init__(self, root=None):
        self.root = Path(root) if root else None
        self.cache = {}     # path -> (mtime_ns, record or None)

    def scan(self):
        root = self.root or paths.desktop_root()
        seen = {}
        try:
            accounts = list(os.scandir(root))
        except OSError:
            accounts = []
        for acc in accounts:
            if not acc.is_dir():
                continue
            try:
                orgs = list(os.scandir(acc.path))
            except OSError:
                continue
            for org in orgs:
                if not org.is_dir():
                    continue
                try:
                    files = list(os.scandir(org.path))
                except OSError:
                    continue
                for f in files:
                    if not (f.name.startswith("local_") and f.name.endswith(".json")):
                        continue
                    try:
                        mtime = f.stat().st_mtime_ns
                    except OSError:
                        continue
                    hit = self.cache.get(f.path)
                    if hit and hit[0] == mtime:
                        seen[f.path] = hit
                        continue
                    seen[f.path] = (mtime, read_desktop_file(f.path))
        self.cache = seen
        out = {}
        for _, rec in seen.values():
            if rec and not rec.get("isArchived"):
                out[rec["sessionId"]] = rec
        return out


def read_desktop_file(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    sid = data.get("sessionId")
    if not isinstance(sid, str) or not ID_RE.match(sid):
        sid = Path(path).stem
        if not ID_RE.match(sid):
            return None
    keep = ("cliSessionId", "cwd", "originCwd", "createdAt", "lastActivityAt", "isArchived", "title",
            "model", "effort", "permissionMode", "branch", "prs", "prNumber", "prState", "spawnedFrom",
            "postTurnSummary", "turnWrapUp", "lastTurnReport", "scheduledTaskId", "worktreePath")
    rec = {k: data.get(k) for k in keep if k in data}
    rec["sessionId"] = sid
    return rec


class TranscriptIndex:
    """cliId -> transcript path, rebuilt from the projects folder now and then."""

    def __init__(self, root=None, every_s=60):
        self.root = Path(root) if root else None
        self.every_s = every_s
        self.index = {}
        self.built_at = 0.0
        self.lock = threading.Lock()

    def rebuild(self):
        root = self.root or paths.projects_root()
        index = {}
        try:
            dirs = list(os.scandir(root))
        except OSError:
            dirs = []
        for d in dirs:
            if not d.is_dir():
                continue
            try:
                for f in os.scandir(d.path):
                    if f.name.endswith(".jsonl"):
                        index[f.name[:-6]] = f.path
            except OSError:
                continue
        with self.lock:
            self.index = index
            self.built_at = time.time()

    def path(self, cli_id):
        if not cli_id:
            return None
        with self.lock:
            hit = self.index.get(cli_id)
            stale = time.time() - self.built_at > self.every_s
        if hit and os.path.exists(hit):
            return hit
        if stale:
            self.rebuild()
            with self.lock:
                return self.index.get(cli_id)
        return None


# ------------------------------------------------------------- shaping -----

CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")


def _text(value):
    """A non-empty string with control and direction characters removed, else None."""
    if not isinstance(value, str):
        return None
    value = CONTROL_RE.sub("", value).strip()
    return value or None


def _int(value):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def plain(text):
    """Report text to one plain line: no markdown marks, no link targets."""
    text = text.replace("⏎", " ")
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`#>]+", "", text)
    return " ".join(text.split())


def summary_of(rec):
    wrap = rec.get("turnWrapUp")
    if isinstance(wrap, dict) and _text(wrap.get("description")):
        return clip(plain(wrap["description"]), MAX_SUMMARY)
    report = rec.get("lastTurnReport")
    if isinstance(report, dict):
        report = report.get("text") or report.get("summary") or report.get("description")
    if _text(report):
        return clip(plain(report), MAX_SUMMARY)
    pts = rec.get("postTurnSummary")
    if isinstance(pts, dict) and _text(pts.get("status_detail")):
        return clip(plain(pts["status_detail"]), MAX_SUMMARY)
    return None


def pr_of(rec):
    """(number, state) from prNumber/prState or the prs list (the branch's, else the last)."""
    number, state = _int(rec.get("prNumber")), _text(rec.get("prState"))
    prs = rec.get("prs")
    if isinstance(prs, list) and prs:
        rows = [p for p in prs if isinstance(p, dict)]
        mine = [p for p in rows if p.get("branch") and p.get("branch") == rec.get("branch")]
        pick = (mine or rows or [None])[-1]
        if pick:
            number = _int(pick.get("prNumber")) or number
            state = _text(pick.get("state")) or state
    return number, (state.upper() if state else None)


def repo_of(rec):
    origin = _text(rec.get("originCwd")) or _text(rec.get("cwd"))
    if not origin:
        return None
    return Path(origin.replace("\\", "/")).name or None


BG_LIVE = {"working": "busy", "blocked": "waiting", "failed": "waiting"}


def classify(s, now, stale_hours, grew_at=None):
    """(state, stateReason), first match wins.

    A live session waiting on a prompt is `you`. A live session with background
    work it started less than 2 hours ago and has not seen finish is `active`,
    whatever the app's note says. A blocked or failed background job is `you`.
    Then work in progress is `active`. A session that is not running and has a
    merged or closed pull request, or no activity for stale_hours, is `stale`
    even when the app's old note still asks for Jay. Then the app's note
    (`needs_action`, blocked, review ready) makes it `you`."""
    live, status, bg = s["live"], s["liveStatus"], s.get("_bgState")
    busy = live and status == "busy"
    last = s.get("lastActivityAt") or s.get("createdAt") or 0
    aged = now - last > stale_hours * HOUR_MS
    if live and s["kind"] == "interactive" and status == "waiting":
        return "you", waiting_reason(s.get("waitingFor"))
    if live and any(now - at <= BACKGROUND_MAX_AGE_MS for at in s.get("_background") or []):
        return "active", "Running background work"
    if bg in ("blocked", "failed"):
        return "you", "Background job is blocked" if bg == "blocked" else "Background job failed"
    if busy:
        return "active", "Working now"
    if bg == "working":
        return "active", "Background job is working"
    if not live:
        if s.get("prState") in ("MERGED", "CLOSED"):
            verb = "merged" if s["prState"] == "MERGED" else "closed"
            return "stale", f"PR {s['prNumber']} {verb}" if s.get("prNumber") else f"PR {verb}"
        if aged:
            return "stale", f"No activity for {ago(now - last)}"
    if s.get("needsAction"):
        return "you", clip(f"Needs your decision: {s['needsAction']}", 200)
    if s.get("appStatus") == "blocked":
        return "you", "Blocked, waiting on you"
    if s.get("appStatus") == "review_ready":
        return "you", "Ready for your review"
    if grew_at and now - grew_at <= GREW_WINDOW_MS:
        return "active", "Working now"
    if aged:
        return "stale", f"No activity for {ago(now - last)}"
    if bg in ("done", "stopped"):
        return "wait", "Background job finished" if bg == "done" else "Background job stopped"
    if s.get("appStatus") == "completed":
        return "wait", "Idle, finished its last turn"
    if live:
        return "wait", "Idle"
    return "wait", "Not running, finished its last turn"


def waiting_reason(what):
    """"permission prompt" -> "Waiting for a permission prompt"; "input needed" -> "Waiting for your input"."""
    what = " ".join(str(what or "").split())
    if what.endswith(" needed"):
        what = what[: -len(" needed")]
    if not what or what in ("input", "answer", "reply", "response", "decision"):
        return f"Waiting for your {what or 'input'}"
    if what.startswith(("a ", "an ", "the ", "your ")):
        return f"Waiting for {what}"
    return f"Waiting for {'an' if what[0] in 'aeiou' else 'a'} {what}"


def ago(ms):
    hours = ms / HOUR_MS
    if hours < 1:
        return "under an hour"
    if hours < 48:
        n = int(hours)
        return f"{n} hour" + ("s" if n != 1 else "")
    n = int(hours // 24)
    return f"{n} days"


def build_sessions(desktop, agent_rows, settings, now, chief_id=None, transcript_info=None, grew=None,
                   background=None):
    """Pure: joins the sources into the contract's Session list.

    desktop: {local_id: record}; agent_rows: `claude agents --json` rows;
    transcript_info: {cliId: mtime_ms}; grew: {cliId: ms of last growth};
    background: {cliId: [start ms of background work not seen to finish]}.
    """
    transcript_info = transcript_info or {}
    grew = grew or {}
    background = background or {}
    by_cli = {}
    for row in agent_rows:
        sid = row.get("sessionId")
        if isinstance(sid, str) and sid:
            by_cli[sid] = row
    sessions = []
    used = set()
    for local_id, rec in desktop.items():
        cli = _text(rec.get("cliSessionId"))
        row = by_cli.get(cli) if cli else None
        if row:
            used.add(cli)
        sessions.append(_session(local_id, cli, rec, row, transcript_info, chief_id))
    for cli, row in by_cli.items():
        if cli in used:
            continue
        kind = "background" if row.get("kind") == "background" else "interactive"
        local_id = ("bg_" if kind == "background" else "cli_") + re.sub(r"[^A-Za-z0-9-]", "", cli)[:80]
        sessions.append(_session(local_id, cli, {}, row, transcript_info, chief_id))

    by_id = {s["id"]: s for s in sessions}
    for s in sessions:
        parent = by_id.get(s["parentId"]) if s["parentId"] else None
        if parent:
            parent["childIds"].append(s["id"])
        elif s["parentId"]:
            s["parentId"] = None
    stale_hours = float(settings.get("staleHours") or 24)
    recent_ms = float(settings.get("recentDays") or 3) * DAY_MS
    for s in sessions:
        s["_background"] = background.get(s["cliId"]) or []
        s["state"], s["stateReason"] = classify(s, now, stale_hours, grew.get(s["cliId"]))
        s["inView"] = bool(s["live"] or now - (s["lastActivityAt"] or 0) <= recent_ms)
    # Parents and children of in-view sessions are in view too.
    queue = [s for s in sessions if s["inView"]]
    while queue:
        s = queue.pop()
        for other in [by_id.get(s["parentId"])] + [by_id.get(c) for c in s["childIds"]]:
            if other and not other["inView"]:
                other["inView"] = True
                queue.append(other)
    for s in sessions:
        s.pop("_bgState", None)
        s.pop("_background", None)
    sessions.sort(key=lambda s: -(s["lastActivityAt"] or 0))
    return sessions


def _session(local_id, cli, rec, row, transcript_info, chief_id):
    row = row or {}
    kind = "background" if row.get("kind") == "background" else "interactive"
    live = bool(row)
    bg_state = _text(row.get("state")) if kind == "background" else None
    if kind == "interactive":
        live_status = _text(row.get("status")) if live else None
    else:
        live_status = BG_LIVE.get(bg_state, "idle") if live else None
    pts = rec.get("postTurnSummary") if isinstance(rec.get("postTurnSummary"), dict) else {}
    spawned = rec.get("spawnedFrom") if isinstance(rec.get("spawnedFrom"), dict) else {}
    number, state = pr_of(rec)
    created = _int(rec.get("createdAt")) or _int(row.get("startedAt"))
    activity = max([v for v in (_int(rec.get("lastActivityAt")), transcript_info.get(cli), created) if v] or [0]) or None
    parent = _text(spawned.get("sessionId"))
    return {
        "id": local_id,
        "cliId": cli,
        "title": _text(rec.get("title")) or _text(row.get("name")) or "Untitled session",
        "kind": kind,
        "state": "wait",
        "stateReason": "",
        "live": live,
        "liveStatus": live_status,
        "waitingFor": _text(row.get("waitingFor")) if live_status == "waiting" else None,
        "parentId": parent if parent and parent != local_id else None,
        "childIds": [],
        "cwd": _text(rec.get("cwd")) or _text(row.get("cwd")),
        "repo": repo_of(rec) if rec else repo_of({"cwd": row.get("cwd")}),
        "branch": _text(rec.get("branch")),
        "prNumber": number,
        "prState": state,
        "createdAt": created,
        "lastActivityAt": activity,
        "model": _text(rec.get("model")),
        "effort": _text(rec.get("effort")),
        "permissionMode": _text(rec.get("permissionMode")),
        "summary": summary_of(rec),
        "needsAction": _text(pts.get("needs_action")),
        "appStatus": _text(pts.get("status_category")),
        "isChief": bool(chief_id and local_id == chief_id),
        "link": LINK.format(local_id) if local_id.startswith("local_") else None,
        "_bgState": bg_state,
    }


def counts_of(sessions):
    counts = {"you": 0, "active": 0, "wait": 0, "stale": 0}
    for s in sessions:
        if not s["isChief"]:
            counts[s["state"]] = counts.get(s["state"], 0) + 1
    return counts


# ------------------------------------------------------------- reader -----

class SessionReader:
    """Holds the sources and the latest snapshot. Thread safe."""

    def __init__(self, agents=None, desktop=None, transcripts=None):
        self.agents = agents or AgentsSource()
        self.desktop_source = desktop or DesktopSource()
        self.transcripts = transcripts or TranscriptIndex()
        self.lock = threading.Lock()
        self.desktop = {}
        self.mtimes = {}
        self.grew = {}
        self.background = {}
        self.sessions = []
        self.generated_at = 0

    def refresh_files(self):
        desktop = self.desktop_source.scan()
        mtimes = {}
        for rec in desktop.values():
            cli = rec.get("cliSessionId")
            path = self.transcripts.path(cli) if isinstance(cli, str) else None
            if path:
                try:
                    mtimes[cli] = int(os.path.getmtime(path) * 1000)
                except OSError:
                    pass
        with self.lock:
            self.desktop = desktop
            self.mtimes.update(mtimes)

    def refresh_live(self):
        rows = self.agents.poll()
        for row in rows:
            cli = row.get("sessionId")
            if isinstance(cli, str) and cli not in self.mtimes:
                path = self.transcripts.path(cli)
                if path:
                    try:
                        self.mtimes[cli] = int(os.path.getmtime(path) * 1000)
                    except OSError:
                        pass
        return rows

    def set_background(self, cli, started):
        with self.lock:
            if started:
                self.background[cli] = list(started)
            else:
                self.background.pop(cli, None)

    def mark_grew(self, cli, at):
        with self.lock:
            self.grew[cli] = at
            self.mtimes[cli] = max(self.mtimes.get(cli, 0), at)

    def build(self, settings, chief_id=None, now=None):
        now = now or now_ms()
        with self.lock:
            desktop = dict(self.desktop)
            mtimes = dict(self.mtimes)
            grew = dict(self.grew)
            background = dict(self.background)
        sessions = build_sessions(desktop, self.agents.rows, settings, now, chief_id, mtimes, grew, background)
        with self.lock:
            self.sessions = sessions
            self.generated_at = now
        return sessions

    def snapshot(self):
        with self.lock:
            sessions = self.sessions
            return {"generatedAt": self.generated_at, "liveStale": self.agents.stale,
                    "counts": counts_of(sessions),
                    "countsInView": counts_of([s for s in sessions if s["inView"]]),
                    "sessions": sessions}

    def get(self, sid):
        with self.lock:
            return next((s for s in self.sessions if s["id"] == sid), None)

    def local_id_for(self, cli):
        """The desktop id for a CLI session id, reading the files again on a miss."""
        def find():
            with self.lock:
                return next((sid for sid, rec in self.desktop.items() if rec.get("cliSessionId") == cli), None)
        hit = find()
        if hit is None:
            self.refresh_files()
            hit = find()
        return hit

    def transcript_path(self, cli):
        return self.transcripts.path(cli)
