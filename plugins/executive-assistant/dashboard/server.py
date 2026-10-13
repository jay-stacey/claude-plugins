#!/usr/bin/env python3
"""Day Desk: the executive assistant's local dashboard.

Serves the page in ``static/`` and the JSON API described in ``API.md`` on
127.0.0.1 only. Every API call needs the per-run token. Tasks go through
``scripts/tasks.py``; notes are read and written straight from the vault with
a sha check, so an edit never overwrites a newer file.

    python server.py start [--port 0] [--no-toast] [--no-open] [--dev]
    python server.py status
    python server.py stop
    python server.py serve --port N       # foreground; the token comes from DAY_DESK_TOKEN

Standard library only. Python 3.9 or later.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
PLUGIN_ROOT = HERE.parent
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))
sys.path.insert(0, str(HERE))
import tasks  # noqa: E402

STATIC = HERE / "static"
EDITOR_BUNDLE = PLUGIN_ROOT / "skills" / "notes-viewer" / "assets" / "editor.bundle.js"
NOTES_INDEX = PLUGIN_ROOT / "skills" / "notes" / "scripts" / "notes_index.py"
STATUS_FOR_CODE = {2: 400, 3: 409, 4: 422, 5: 404}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
         ".ico": "image/x-icon", ".json": "application/json"}
SKIP_DIRS = {"tasks", "node_modules"}
MAX_NOTE_BYTES = 2_000_000
MAX_BODY = 4_000_000


class HttpError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


# ----------------------------------------------------------- profile -------

def parse_profile(text, env=os.environ):
    """Read the workday out of profile.md. Missing lines fall back to config."""
    prof = {"start": env.get("CLAUDE_PLUGIN_OPTION_WORKING_HOURS_START") or "06:30",
            "stop": env.get("CLAUDE_PLUGIN_OPTION_WORKING_HOURS_END") or "15:00",
            "deep": None, "admin_after": "13:30", "shutdown_reminder_min": 30}
    tm = r"(\d{1,2}:\d{2})"
    for line in (text or "").splitlines():
        low = line.strip().lstrip("-* ").lower()
        m = re.match(rf"start:\s*{tm}", low)
        if m:
            prof["start"] = m.group(1).zfill(5)
        m = re.match(rf"stop:\s*{tm}", low)
        if m:
            prof["stop"] = m.group(1).zfill(5)
        m = re.match(rf"deep work window:\s*{tm}\s*(?:to|-)\s*{tm}", low)
        if m:
            prof["deep"] = [m.group(1).zfill(5), m.group(2).zfill(5)]
        m = re.match(rf"admin and catch-up:\s*after\s*{tm}", low)
        if m:
            prof["admin_after"] = m.group(1).zfill(5)
        m = re.match(r"shutdown reminder:\s*(\d+)\s*min", low)
        if m:
            prof["shutdown_reminder_min"] = int(m.group(1))
    if not prof["deep"]:
        prof["deep"] = [prof["start"], "11:30"]
    return prof


# -------------------------------------------------------------- app --------

class App:
    def __init__(self, vault, token, toast=True, dev=False, fixed_now=None, claude_cmd=None):
        self.vault = Path(vault).expanduser()
        if not self.vault.is_dir():
            raise SystemExit(f"The notes folder does not exist: {self.vault}")
        self.token = token
        self.fixed_now = fixed_now
        self.state_dir = self.vault / ".assistant"
        self.lock = threading.Lock()
        self.refreshing = False
        self.note_cache = {}
        self.chat = None
        self.nudger = None
        self.started_at = tasks.iso_min(self.now())
        try:
            import chat as chat_mod
            self.chat_mod = chat_mod
            self.chat = chat_mod.ChatRunner(str(self.vault), str(PLUGIN_ROOT), claude_cmd=claude_cmd, dev=dev)
        except Exception as e:      # chat stays off; the page says so
            self.chat_mod, self.chat_error = None, f"Chat is not available: {e.__class__.__name__}."
        try:
            import nudges as nudges_mod
            self.nudges_mod = nudges_mod
            self.nudger = nudges_mod.Nudger(self.nudge_inputs, toasts=toast, clock=self.now)
        except Exception:
            self.nudges_mod = None

    def now(self):
        if self.fixed_now:
            return dt.datetime.fromisoformat(self.fixed_now)
        return dt.datetime.now().replace(microsecond=0)

    # --- task tool, in process
    def t(self, *argv):
        args = ["--vault", str(self.vault)]
        if self.fixed_now:
            args += ["--now", self.fixed_now]
        try:
            with self.lock:
                return tasks.run(args + [str(a) for a in argv])
        except tasks.Fail as e:
            raise HttpError(STATUS_FOR_CODE.get(e.code, 400), str(e), **e.extra)

    def read_json(self, path):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def profile(self):
        p = self.vault / "assistant" / "profile.md"
        text = p.read_text(encoding="utf-8") if p.exists() else ""
        return parse_profile(text)

    # --- schedule
    def schedule(self):
        today = self.now().date().isoformat()
        brief = self.read_json(self.state_dir / "brief" / f"{today}.json") or {}
        cal = brief.get("calendar") or {}
        fresh = self.read_json(self.state_dir / "schedule" / f"{today}.json")

        def today_events(src):
            if not src:
                return None
            if isinstance(src.get("events"), list):
                return src["events"]
            for d in src.get("days") or []:
                if d.get("date") == today:
                    return d.get("events") or []
            return None

        out = {"source": "none", "as_of": None, "refreshing": self.refreshing, "date": today,
               "events": [], "days": cal.get("days") or [], "flags": cal.get("flags") or [],
               "week_summary": cal.get("week_summary") or brief.get("week_summary")}
        candidates = []
        if today_events(fresh) is not None:
            candidates.append(("refresh", fresh.get("generated_at") or "", today_events(fresh)))
        if today_events(cal) is not None:
            candidates.append(("brief", brief.get("generated_at") or "", today_events(cal)))
        if candidates:
            source, as_of, events = max(candidates, key=lambda c: c[1])
            out.update(source=source, as_of=as_of or None,
                       events=sorted(events, key=lambda e: e.get("start") or ""))
        return out

    def start_refresh(self):
        if not self.chat:
            raise HttpError(503, "Refresh needs the chat runner, which is not available.")
        if self.refreshing:
            return {"started": False, "note": "A refresh is already running."}
        self.refreshing = True

        def work():
            try:
                self.chat.refresh_schedule(self.now().date().isoformat())
            except Exception:
                pass
            finally:
                self.refreshing = False

        threading.Thread(target=work, daemon=True).start()
        return {"started": True}

    # --- state
    def state(self):
        today = self.now().date().isoformat()
        brief = self.read_json(self.state_dir / "brief" / f"{today}.json")
        if brief:
            brief = {k: brief.get(k) for k in ("date", "generated_at", "mode", "email", "elsewhere",
                                                "followups", "pending", "week_summary", "plan", "first_step")}
        chat_state = {"available": bool(self.chat), "busy": False, "session_id": None}
        if self.chat:
            chat_state["busy"] = bool(getattr(self.chat, "busy", False))
            try:
                chat_state["session_id"] = self.chat.history().get("session_id")
            except Exception:
                pass
        else:
            chat_state["error"] = getattr(self, "chat_error", None)
        return {"now": tasks.iso_min(self.now()), "context": self.t("context"),
                "focus": self.t("focus-status"), "profile": self.profile(),
                "schedule": self.schedule(), "brief": brief,
                "nudges": self.nudger.pending() if self.nudger else [],
                "chat": chat_state, "server": {"started_at": self.started_at}}

    def nudge_inputs(self):
        """What the nudger needs, read fresh each tick."""
        today = self.now().date().isoformat()
        return {"now": self.now(), "events": self.schedule()["events"],
                "focus": self.t("focus-status"), "profile": self.profile(),
                "shutdown_today": self.read_json(self.state_dir / "shutdown" / f"{today}.json"),
                "brief_today": self.read_json(self.state_dir / "brief" / f"{today}.json")}

    # --- notes
    def safe_rel(self, rel):
        if not isinstance(rel, str) or not rel.strip():
            raise HttpError(400, "A note path is required.")
        rel = rel.strip().replace("\\", "/")
        parts = rel.split("/")
        if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or any(p in ("", ".", "..") for p in parts):
            raise HttpError(400, "Use a path inside the notes folder, like projects/idea.md.")
        if any(p.startswith(".") for p in parts) or parts[0].lower() in SKIP_DIRS:
            raise HttpError(400, "That folder is managed by the assistant. Use the Tasks view for tasks.")
        if not rel.lower().endswith(".md"):
            raise HttpError(400, "Only markdown notes (.md) can be opened here.")
        full = (self.vault / rel).resolve()
        if self.vault.resolve() not in full.parents:
            raise HttpError(400, "Use a path inside the notes folder.")
        return rel, full

    def note_meta(self, full, rel):
        st = full.stat()
        hit = self.note_cache.get(rel)
        if hit and hit[0] == st.st_mtime_ns:
            return hit[1]
        raw = full.read_bytes()[:MAX_NOTE_BYTES].decode("utf-8", errors="replace")
        fields, body = tasks.split_doc(raw)
        title = fields.get("title")
        if not title:
            m = re.search(r"^#\s+(.+)$", body, re.M)
            title = m.group(1).strip() if m else full.stem
        tags = fields.get("tags") if isinstance(fields.get("tags"), list) else []
        meta = {"path": rel, "title": str(title), "tags": tags, "size": st.st_size,
                "updated": dt.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%dT%H:%M"),
                "_text": raw.lower()}
        self.note_cache[rel] = (st.st_mtime_ns, meta)
        return meta

    def notes(self, q="", limit=200):
        found = []
        root = self.vault
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = Path(dirpath).relative_to(root).as_posix()
            dirnames[:] = [d for d in dirnames if not d.startswith(".")
                           and not (rel_dir == "." and d.lower() in SKIP_DIRS)]
            for name in filenames:
                if not name.lower().endswith(".md") or name.startswith("."):
                    continue
                full = Path(dirpath) / name
                rel = full.relative_to(root).as_posix()
                try:
                    found.append(self.note_meta(full, rel))
                except OSError:
                    continue
        if q:
            words = q.lower().split()
            found = [n for n in found if all(w in n["_text"] or w in n["path"].lower() or w in n["title"].lower()
                                             for w in words)]
        found.sort(key=lambda n: n["updated"], reverse=True)
        return {"notes": [{k: v for k, v in n.items() if k != "_text"} for n in found[:limit]]}

    def read_note(self, rel):
        rel, full = self.safe_rel(rel)
        if not full.is_file():
            raise HttpError(404, f"No note at {rel}.")
        data = full.read_bytes()
        if len(data) > MAX_NOTE_BYTES:
            raise HttpError(400, "That note is too large to edit here.")
        return {"path": rel, "content": data.decode("utf-8", errors="replace").replace("\r\n", "\n"),
                "sha": tasks.sha_of(data)}

    def write_note(self, body):
        rel, full = self.safe_rel(body.get("path"))
        content = body.get("content")
        if not isinstance(content, str):
            raise HttpError(400, "The note text is missing.")
        base = body.get("base_sha")
        with self.lock:
            crlf = False
            if full.exists():
                current = full.read_bytes()
                if base is None:
                    raise HttpError(409, f"A note already exists at {rel}.", sha=tasks.sha_of(current))
                if tasks.sha_of(current) != base:
                    raise HttpError(409, "This note changed on disk since you opened it.",
                                    sha=tasks.sha_of(current))
                crlf = b"\r\n" in current
            elif base is not None:
                raise HttpError(409, "This note was moved or deleted on disk.", sha=None)
            text = content.replace("\r\n", "\n")
            if crlf:
                text = text.replace("\n", "\r\n")
            data = text.encode("utf-8")
            full.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=full.parent, prefix=".tmp-", suffix=".md")
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.replace(tmp, full)
        self.reindex(rel)
        return {"path": rel, "sha": tasks.sha_of(data)}

    def reindex(self, rel):
        if not NOTES_INDEX.exists():
            return

        def work():
            try:
                subprocess.run([sys.executable, str(NOTES_INDEX), "update", str(self.vault), rel],
                               capture_output=True, timeout=30)
            except Exception:
                pass
        threading.Thread(target=work, daemon=True).start()

    # --- shutdown
    def daily_note_path(self, day):
        folder = os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_DAILY_FOLDER") or "daily"
        fmt = os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_DATE_FORMAT") or "YYYY-MM-DD"
        name = fmt.replace("YYYY", f"{day.year:04d}").replace("MM", f"{day.month:02d}").replace("DD", f"{day.day:02d}")
        return self.vault / folder / f"{name}.md"

    def append_section(self, path, heading, lines):
        text = path.read_text(encoding="utf-8") if path.exists() else f"# {path.stem}\n"
        crlf = "\r\n" in text
        text = text.replace("\r\n", "\n")
        block = "\n".join(lines).rstrip() + "\n"
        rows = text.split("\n")
        idx = next((i for i, r in enumerate(rows) if r.strip().lower() == heading.lower()), None)
        if idx is None:
            text = text.rstrip("\n") + f"\n\n{heading}\n\n{block}"
        else:
            end = next((j for j in range(idx + 1, len(rows)) if rows[j].startswith("## ")), len(rows))
            insert = rows[idx + 1:end]
            while insert and not insert[-1].strip():
                insert.pop()
            rows[idx + 1:end] = insert + [""] + block.rstrip("\n").split("\n") + ([""] if end < len(rows) else [])
            text = "\n".join(rows)
            if not text.endswith("\n"):
                text += "\n"
        if crlf:
            text = text.replace("\n", "\r\n")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="")

    def shutdown(self, body):
        if not isinstance(body, dict) or not body.get("first_step"):
            raise HttpError(400, "Tomorrow's first step is missing.")
        now = self.now()
        done_titles = []
        for tid in body.get("done") or []:
            try:
                r = self.t("done", tid)
                done_titles.append(r["task"])
            except HttpError as e:
                if e.status != 404:
                    raise
        week_end = now.date() + dt.timedelta(days=6 - now.date().weekday())
        moved = []
        for m in body.get("moved") or []:
            to = m.get("to")
            try:
                day = dt.date.fromisoformat(to)
            except (TypeError, ValueError):
                raise HttpError(400, f"'{to}' is not a date like 2026-10-14.")
            r = self.t("update", m.get("id"), "--due", to, "--list", "week" if day <= week_end else "later")
            moved.append((r["task"]["title"], to))
        data = {k: body.get(k) for k in ("done", "moved", "finish_today", "brain_dump", "first_step",
                                         "first_task", "tonight")}
        data["date"] = now.date().isoformat()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.state_dir, prefix=".tmp-shutdown-", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        try:
            saved = self.t("shutdown-save", tmp)
        finally:
            Path(tmp).unlink(missing_ok=True)
        self.t("archive", "--days", "7")
        lines = []
        all_done = [t for t in self.t("list", "--all")["tasks"]
                    if t.get("list") == "done" and str(t.get("done_at", "")).startswith(data["date"])]
        if all_done:
            lines.append("Done today:")
            lines += [f"- {t['done_at'][11:]} {t['title']}" for t in sorted(all_done, key=lambda t: t["done_at"])]
        if moved:
            lines.append("Moved:")
            lines += [f"- {title} to {to}" for title, to in moved]
        lines.append(f"Tomorrow starts with: {data['first_step']}")
        tonight = data.get("tonight")
        if isinstance(tonight, dict) and tonight.get("until"):
            lines.append(f"Tonight: one task until {tonight['until']}.")
        try:
            self.append_section(self.daily_note_path(now.date()), "## Shutdown", lines)
        except OSError:
            pass
        return {"saved": saved["saved"], "points": saved["points"], "stats": self.t("stats")}


# ---------------------------------------------------------- handler --------

def make_handler(app, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "DayDesk"
        sys_version = ""

        def log_message(self, fmt, *args):   # never log paths or bodies; they can hold note titles
            pass

        # --- helpers
        def send_json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise HttpError(413, "That request is too large.")
            if not n:
                return {}
            try:
                return json.loads(self.rfile.read(n).decode("utf-8"))
            except ValueError:
                raise HttpError(400, "The request body is not valid JSON.")

        def guard(self, need_token):
            if self.headers.get("Host") not in allowed_hosts:
                raise HttpError(403, "Open Day Desk at 127.0.0.1.")
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{h}" for h in allowed_hosts}:
                raise HttpError(403, "Requests from other sites are refused.")
            if need_token:
                given = self.headers.get("X-Day-Desk-Token") or ""
                if not secrets.compare_digest(given, app.token):
                    raise HttpError(403, "The Day Desk key is missing or wrong.")

        def handle_any(self, method):
            url = urlparse(self.path)
            path = url.path
            query = {k: v[-1] for k, v in parse_qs(url.query).items()}
            try:
                if not path.startswith("/api/"):
                    self.guard(need_token=False)
                    if method != "GET":
                        raise HttpError(405, "Not allowed.")
                    return self.static(path)
                if path == "/api/health":
                    self.guard(need_token=False)
                    return self.send_json(200, {"ok": True, "app": "day-desk"})
                self.guard(need_token=True)
                if path == "/api/chat" and method == "POST":
                    return self.chat_stream(self.body())
                result = route(app, method, path, query, self.body() if method in ("POST", "PATCH", "PUT") else {})
                self.send_json(200, result)
            except HttpError as e:
                self.send_json(e.status, {"error": str(e), **e.extra})
            except Exception:
                self.send_json(500, {"error": "Something went wrong in Day Desk. Details are in .assistant/dashboard.log."})
                import traceback
                traceback.print_exc()

        def static(self, path):
            if path in ("/", "/index.html"):
                target = STATIC / "index.html"
            elif path == "/static/editor.bundle.js":
                target = EDITOR_BUNDLE
            elif re.fullmatch(r"/static/[A-Za-z0-9_.-]+", path):
                target = STATIC / path.rsplit("/", 1)[1]
            else:
                raise HttpError(404, "Not found.")
            if not target.is_file():
                raise HttpError(404, "Not found.")
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(target.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if target.suffix == ".html":
                self.send_header("Content-Security-Policy",
                                 "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                                 "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
                                 "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(data)

        def chat_stream(self, body):
            if not app.chat:
                raise HttpError(503, getattr(app, "chat_error", None) or "Chat is not available.")
            message = (body.get("message") or "").strip()
            if not message:
                raise HttpError(400, "Type a message first.")
            try:
                events = app.chat.stream(message, new=bool(body.get("new")))
                first = next(events)
            except StopIteration:
                raise HttpError(500, "The assistant did not answer.")
            except Exception as e:
                if app.chat_mod and isinstance(e, getattr(app.chat_mod, "Busy", ())):
                    raise HttpError(409, "The assistant is still answering.")
                raise
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                for ev in [first]:
                    self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
                    self.wfile.flush()
                for ev in events:
                    self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                events.close()
            self.close_connection = True

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PATCH(self):
            self.handle_any("PATCH")

        def do_PUT(self):
            self.handle_any("PUT")

    return Handler


TASK_FLAGS = {"title": "--title", "list": "--list", "priority": "--priority", "due": "--due",
              "estimate": "--estimate", "actual": "--actual", "first_step": "--first-step",
              "next_step": "--next-step", "source": "--source"}


def task_args(body):
    argv = []
    for key, flag in TASK_FLAGS.items():
        if key in body and body[key] is not None:
            argv += [flag, str(body[key])]
    if isinstance(body.get("tags"), list):
        argv += ["--tags", ",".join(str(t) for t in body["tags"])]
    return argv


def body_file(app, text):
    app.state_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=app.state_dir, prefix=".tmp-body-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return tmp


def route(app, method, path, query, body):
    m = re.fullmatch(r"/api/tasks/(t-\d+)(?:/(move|done|drop|park|resume))?", path)
    if path == "/api/state" and method == "GET":
        return app.state()
    if path == "/api/tasks" and method == "GET":
        lists = query.get("lists") or "now,today,week,later,done"
        out = app.t("list", "--list", lists)
        cutoff = (app.now() - dt.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")
        out["tasks"] = [t for t in out["tasks"] if t.get("list") != "done" or str(t.get("done_at", "")) >= cutoff]
        return out
    if path == "/api/tasks" and method == "POST":
        argv = ["add"]
        if body.get("parse"):
            argv += ["--parse", str(body["parse"])]
        argv += task_args(body)
        if body.get("notes"):
            tmp = body_file(app, str(body["notes"]))
            try:
                return app.t(*argv, "--body-file", tmp)
            finally:
                Path(tmp).unlink(missing_ok=True)
        return app.t(*argv)
    if path == "/api/parse" and method == "GET":
        return app.t("parse", query.get("text", ""))
    if m and method == "GET" and not m.group(2):
        return app.t("show", m.group(1))
    if m and method == "PATCH" and not m.group(2):
        argv = ["update", m.group(1)] + task_args(body)
        if body.get("if_sha"):
            argv += ["--if-sha", body["if_sha"]]
        if "body" in body and isinstance(body["body"], str):
            tmp = body_file(app, body["body"])
            try:
                return app.t(*argv, "--body-file", tmp)
            finally:
                Path(tmp).unlink(missing_ok=True)
        return app.t(*argv)
    if m and method == "POST" and m.group(2):
        tid, action = m.group(1), m.group(2)
        if action == "move":
            return app.t("move", tid, body.get("list", ""))
        if action == "done":
            return app.t("done", tid, *(["--actual", str(body["actual"])] if body.get("actual") else []))
        if action == "park":
            return app.t("park", tid, *(["--next", str(body["next"])] if body.get("next") else []))
        return app.t(action, tid)
    if path == "/api/focus/start" and method == "POST":
        return app.t("focus-start", body.get("id", ""), "--minutes", f"{int(body.get('minutes') or 25)}m")
    if path == "/api/focus/end" and method == "POST":
        argv = ["focus-end", "--result", body.get("result") or "stopped"]
        if body.get("minutes"):
            argv += ["--minutes", f"{int(body['minutes'])}m"]
        if body.get("more"):
            argv += ["--more", f"{int(body['more'])}m"]
        return app.t(*argv)
    if path == "/api/schedule" and method == "GET":
        return app.schedule()
    if path == "/api/schedule/refresh" and method == "POST":
        return app.start_refresh()
    if path == "/api/notes" and method == "GET":
        return app.notes(query.get("q", ""), int(query.get("limit") or 200))
    if path == "/api/notes/file" and method == "GET":
        return app.read_note(query.get("path"))
    if path == "/api/notes/file" and method == "PUT":
        return app.write_note(body)
    if path == "/api/shutdown" and method == "POST":
        return app.shutdown(body)
    if path == "/api/chat/history" and method == "GET":
        if not app.chat:
            return {"session_id": None, "messages": []}
        return app.chat.history()
    if path == "/api/chat/reset" and method == "POST":
        if app.chat:
            app.chat.reset()
        return {}
    m2 = re.fullmatch(r"/api/nudges/([^/]+)/dismiss", path)
    if m2 and method == "POST":
        if app.nudger:
            app.nudger.dismiss(unquote(m2.group(1)))
        return {}
    raise HttpError(404, "No such API call.")


# -------------------------------------------------------- lifecycle --------

def state_file(vault):
    return Path(vault).expanduser() / ".assistant" / "dashboard.json"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def healthy(port, timeout=1.0):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/health")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read()).get("app") == "day-desk"
    except Exception:
        return False


def make_server(app, port=0):
    server = ThreadingHTTPServer(("127.0.0.1", port), None)
    server.RequestHandlerClass = make_handler(app, server.server_address[1])
    server.daemon_threads = True
    return server


def cmd_serve(args):
    token = os.environ.get("DAY_DESK_TOKEN") or secrets.token_urlsafe(24)
    app = App(args.vault, token, toast=not args.no_toast, dev=args.dev)
    server = make_server(app, args.port)
    if app.nudger:
        app.nudger.start()
    # The token stays out of the log on purpose; `start` hands the URL over.
    print(json.dumps({"serving": server.server_address[1], "at": tasks.iso_min(app.now())}), flush=True)
    if not os.environ.get("DAY_DESK_TOKEN"):
        print(f"Open http://127.0.0.1:{server.server_address[1]}/#{token}", file=sys.stderr, flush=True)
    server.serve_forever()


def cmd_start(args):
    sf = state_file(args.vault)
    old = app_state(sf)
    if old and healthy(old.get("port")):
        if not args.no_open:
            webbrowser.open(old["url"])
        return {"url": old["url"], "port": old["port"], "pid": old.get("pid"), "already_running": True}
    port = args.port or free_port()
    token = secrets.token_urlsafe(24)
    sf.parent.mkdir(parents=True, exist_ok=True)
    log = open(sf.parent / "dashboard.log", "ab")
    cmd = [sys.executable, str(Path(__file__).resolve()), "serve", "--vault", str(args.vault), "--port", str(port)]
    cmd += [f for f, on in (("--no-toast", args.no_toast), ("--dev", args.dev)) if on]
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200   # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    env = dict(os.environ, DAY_DESK_TOKEN=token)
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, close_fds=True, **kwargs)
    for _ in range(50):
        if healthy(port, timeout=0.3):
            break
        if proc.poll() is not None:
            raise SystemExit("Day Desk stopped while starting. See .assistant/dashboard.log.")
        time.sleep(0.1)
    else:
        raise SystemExit("Day Desk did not start within 5 seconds. See .assistant/dashboard.log.")
    url = f"http://127.0.0.1:{port}/#{token}"
    info = {"port": port, "pid": proc.pid, "url": url, "started_at": tasks.iso_min(dt.datetime.now())}
    sf.write_text(json.dumps(info, indent=1), encoding="utf-8")
    if not args.no_open:
        webbrowser.open(url)
    return {"url": url, "port": port, "pid": proc.pid, "already_running": False}


def app_state(sf):
    try:
        return json.loads(sf.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cmd_status(args):
    info = app_state(state_file(args.vault))
    if not info:
        return {"running": False}
    return {"running": healthy(info.get("port")), "url": info.get("url"), "port": info.get("port"),
            "pid": info.get("pid"), "started_at": info.get("started_at")}


def cmd_stop(args):
    sf = state_file(args.vault)
    info = app_state(sf)
    if not info:
        return {"stopped": False, "note": "Day Desk is not running."}
    pid = info.get("pid")
    if pid and healthy(info.get("port")):
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
            else:
                os.kill(pid, 15)
        except Exception:
            pass
    sf.unlink(missing_ok=True)
    return {"stopped": True}


def main(argv=None):
    p = argparse.ArgumentParser(prog="server.py", description="Day Desk, the local dashboard.")
    p.add_argument("--vault", default=os.environ.get("CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"))
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("start", "serve"):
        sp = sub.add_parser(name)
        sp.add_argument("--port", type=int, default=0)
        sp.add_argument("--no-toast", action="store_true")
        sp.add_argument("--dev", action="store_true", help="Chat loads this plugin folder with --plugin-dir")
        if name == "start":
            sp.add_argument("--no-open", action="store_true")
        else:
            sp.add_argument("--vault", dest="vault_sub")
    sub.add_parser("status")
    sub.add_parser("stop")
    args = p.parse_args(argv)
    if getattr(args, "vault_sub", None):
        args.vault = args.vault_sub
    if not args.vault:
        print(json.dumps({"error": "No notes folder is set. Run /plugin configure executive-assistant@personal-plugins."}))
        return 2
    if args.cmd == "serve":
        cmd_serve(args)
        return 0
    try:
        out = {"start": cmd_start, "status": cmd_status, "stop": cmd_stop}[args.cmd](args)
    except SystemExit as e:
        print(json.dumps({"error": str(e)}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
