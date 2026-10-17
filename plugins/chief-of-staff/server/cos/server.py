"""The app: state, background loops, HTTP API and SSE (contracts sections 3, 5, 7, 8)."""
import datetime as dt
import itertools
import json
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import API, APP, config, paths
from .events import Hub, Mailbox, frame
from .notices import Notices, public
from .sessions import ID_RE, SessionReader, now_ms
from .transcripts import BackgroundWork, Tail, Transcript
from .voice import Voice

MAX_BODY = 64 * 1024
MAX_TEXT = 4000
MAX_SSE_CLIENTS = 16
HEARTBEAT_S = 15
CHIEF_TIMEOUT_S = 60
IDLE_EXIT_S = 12 * 3600
LIVE_ACTIVE_S = 5       # `claude agents --json` while a console or the Chief is connected
LIVE_IDLE_S = 20        # and while nobody is
SESSIONS_MIN_GAP_S = 2  # at most one full sessions event this often
ACK_TIMEOUT_S = 60      # an inbox item the mod took and did not acknowledge goes back
ARCHIVE_EXPIRY_S = 120  # an archive nobody ran by then is reported as not done
MAX_DELIVERIES = 3
FILES_EVERY_S = 10
PULSE_EVERY_S = 1
LEVEL_MIN_GAP_S = 0.1
SESSIONS_REFRESH_S = 10
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
         ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
       "form-action 'none'; frame-ancestors 'none'")
STATIC_RE = re.compile(r"^/static/((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+)$")


class HttpError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def _text_field(body, key, required=True):
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        if required:
            raise HttpError(400, f"The {key} is missing.")
        return None
    value = value.strip()
    if len(value) > MAX_TEXT:
        raise HttpError(400, f"The {key} is too long. Keep it under {MAX_TEXT} characters.")
    return value


def write_json_atomic(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, path)


class App:
    def __init__(self, token, port=0, reader=None, voice_enabled=True, write_state=True, settings=None):
        self.token = token
        self.port = port
        self.write_state = write_state
        self.settings = settings or config.load()
        self.reader = reader or SessionReader()
        self.hub = Hub()
        self.inbox = Mailbox()
        self.voice_jobs = Mailbox(limit=50)
        self.voice = Voice(self.settings, enabled=voice_enabled)
        self.notices = Notices(paths.run_dir() / "notices.json" if write_state else None)
        self.voice_config_sent = False
        self.has_voice_state = self.load_voice_state()
        self.chat = deque(maxlen=200)
        self.lock = threading.RLock()
        self.build_lock = threading.Lock()
        self.chief = {"sessionId": None, "cliId": None, "busy": False}
        self.chief_poll_at = 0.0
        self.chief_polling = 0
        self.last_connected = False
        self.last_mod_at = time.time()
        self.voice_poll_at = 0.0
        self.last_level_at = 0.0
        self.tails = {}
        self.bg_work = {}       # cliId -> BackgroundWork, for live sessions
        self.pulse_lock = threading.Lock()
        self.transcripts = OrderedDict()
        self.last_public = None
        self.last_sessions_at = 0.0
        self.sessions_dirty = False
        self.last_live_at = 0.0
        self.clock = time.time
        self.inflight = {}      # item id -> {"item", "deliveredAt", "tries"}
        self.queued_at = {}     # item id -> when it was first queued
        self.started_at = now_ms()
        self.ids = itertools.count(1)
        self.stopping = threading.Event()
        self.ready = threading.Event()
        self.server = None

    # ------------------------------------------------------------ helpers --
    def new_id(self, prefix):
        return f"{prefix}_{secrets.token_hex(6)}"

    def chief_connected(self):
        with self.lock:
            has = bool(self.chief["cliId"] or self.chief["sessionId"])
            return has and (self.chief_polling > 0 or time.time() - self.chief_poll_at < CHIEF_TIMEOUT_S)

    def publish_chief(self):
        self.last_connected = self.chief_connected()
        self.hub.publish("chief", self.chief_public())

    def chief_public(self):
        with self.lock:
            return {"connected": self.chief_connected(), "sessionId": self.chief["sessionId"],
                    "cliId": self.chief["cliId"], "busy": self.chief["busy"]}

    def voice_status(self):
        return self.voice.snapshot(busy=self.chief["busy"])

    def is_chief_caller(self, session, cli):
        with self.lock:
            c = self.chief
            return bool((cli and cli == c["cliId"]) or (session and c["sessionId"] and session == c["sessionId"]))

    def state_info(self):
        return {"api": API, "port": self.port, "pid": os.getpid(), "token": self.token,
                "url": f"http://127.0.0.1:{self.port}/#{self.token}",
                "chiefSessionId": self.chief["sessionId"], "chiefCliId": self.chief["cliId"],
                "voicePid": self.voice.pid(), "startedAt": self.started_at}

    def save_state(self):
        if self.write_state:
            write_json_atomic(paths.server_json(), self.state_info())

    def add_chat(self, role, text, source=None, confirm=None):
        msg = {"id": self.new_id("msg"), "role": role, "source": source, "text": text,
               "at": now_ms(), "confirm": confirm}
        with self.lock:
            self.chat.append(msg)
        self.hub.publish("chat", msg)
        return msg

    # ----------------------------------------------------------- sessions --
    def rebuild(self):
        with self.build_lock:
            sessions = self.reader.build(self.settings, self.chief["sessionId"])
            snap = self.reader.snapshot()
            body = json.dumps(snap["sessions"], sort_keys=True) + json.dumps(snap["liveStale"])
            now = self.clock()
            changed = body != self.last_public
            self.last_public = body
            # Unchanged sessions still go out every 10 s, so the console's "refreshed" time is
            # true; changes go out at most every 2 s, since lastActivityAt moves all the time.
            wanted = changed or self.sessions_dirty or now - self.last_sessions_at >= SESSIONS_REFRESH_S
            send = wanted and now - self.last_sessions_at >= SESSIONS_MIN_GAP_S
            if send:
                self.last_sessions_at = now
                self.sessions_dirty = False
            elif changed:
                self.sessions_dirty = True
            notices = self.notices.observe(sessions)
        if send:
            self.hub.publish("sessions", snap)
        now = time.time()
        for n in notices:
            self.hub.publish("notify", public(n))
            self.notices.queue(n, now)
        return snap

    def flush_sessions(self):
        """Sends a sessions event held back by the 2 s limit."""
        with self.build_lock:
            if not self.sessions_dirty or self.clock() - self.last_sessions_at < SESSIONS_MIN_GAP_S:
                return False
            self.sessions_dirty = False
            self.last_sessions_at = self.clock()
            snap = self.reader.snapshot()
        self.hub.publish("sessions", snap)
        return True

    def live_interval(self):
        return LIVE_ACTIVE_S if self.hub.client_count() > 0 or self.chief_connected() else LIVE_IDLE_S

    def tick_live(self):
        """Runs `claude agents --json` when it is due; never two at once (AgentsSource)."""
        now = self.clock()
        if now - self.last_live_at < self.live_interval():
            return False
        self.last_live_at = now
        self.reader.refresh_live()
        self.rebuild()
        return True

    # -------------------------------------------------------------- inbox --
    def queue_item(self, item):
        self.queued_at[item["id"]] = self.clock()
        self.inbox.put(item)

    def delivered(self, items):
        now = self.clock()
        with self.lock:
            for item in items:
                entry = self.inflight.get(item["id"])
                self.inflight[item["id"]] = {"item": item, "deliveredAt": now,
                                             "tries": (entry["tries"] if entry else 0) + 1}

    def ack(self, item_id):
        with self.lock:
            entry = self.inflight.pop(item_id, None)
            self.queued_at.pop(item_id, None)
        return entry

    def fail_action(self, item, detail):
        self.queued_at.pop(item["id"], None)
        if item.get("type") in ("archive", "reply"):
            self.hub.publish("action", {"actionId": item["id"], "ok": False, "detail": detail})

    def sweep_inbox(self):
        """Puts back items the mod took and never acknowledged, and gives up on
        archives nobody ran within two minutes, so the console stops waiting."""
        now = self.clock()
        late_note = "The Chief did not get to it within two minutes, so nothing was archived."

        def expired(item):
            return item.get("type") == "archive" and now - self.queued_at.get(item["id"], now) > ARCHIVE_EXPIRY_S

        for item in self.inbox.pending():
            if expired(item):
                self.inbox.drop(lambda x, iid=item["id"]: x["id"] == iid)
                self.fail_action(item, late_note)
        with self.lock:
            late = [(iid, e) for iid, e in self.inflight.items() if now - e["deliveredAt"] > ACK_TIMEOUT_S]
            for iid, _ in late:
                del self.inflight[iid]
        for iid, entry in late:
            item = entry["item"]
            if expired(item):
                self.fail_action(item, late_note)
            elif entry["tries"] >= MAX_DELIVERIES:
                self.fail_action(item, "The Chief did not confirm it after three tries.")
            else:
                with self.lock:
                    self.inflight[iid] = {"item": item, "deliveredAt": float("inf"), "tries": entry["tries"]}
                self.inbox.put(item)

    def tick_notices(self):
        now = time.time()
        local = dt.datetime.now()
        digest = self.notices.stale_digest(self.reader.sessions, local) if self.reader.agents.ok_once else None
        if digest:
            self.hub.publish("notify", public(digest))
            self.notices.queue(digest, now)
        text = self.notices.due(now, chief_connected=self.chief_connected(), chief_busy=self.chief["busy"],
                                notify_on=bool(self.settings.get("notify")), quiet=self.settings.get("quietHours", ""),
                                local_minutes=local.hour * 60 + local.minute)
        if text:
            self.queue_item({"id": self.new_id("ntc"), "type": "prompt", "text": text})

    def tick_chief(self):
        """A `chief` event when the Chief's connection comes or goes (it stops polling)."""
        connected = self.chief_connected()
        if connected != self.last_connected:
            self.last_connected = connected
            self.publish_chief()

    def pulse(self):
        """Transcript growth of live sessions: activity pulses and peer messages."""
        with self.pulse_lock:
            return self._pulse()

    def _pulse(self):
        grew_any = False
        live = [s for s in self.reader.sessions if s["live"] and s["cliId"]]
        seen = set()
        for s in live:
            cli = s["cliId"]
            seen.add(cli)
            work = self.bg_work.get(cli)
            if work is None:
                path = self.reader.transcript_path(cli)
                if path:
                    work = self.bg_work[cli] = BackgroundWork(path)
            if work is not None:
                started = work.poll()
                if started != self.reader.background.get(cli, []):
                    self.reader.set_background(cli, started)
                    grew_any = True
            tail = self.tails.get(cli)
            if tail is None:
                path = self.reader.transcript_path(cli)
                if path:
                    self.tails[cli] = Tail(path)
                continue
            grew, peers = tail.poll()
            if grew:
                grew_any = True
                self.reader.mark_grew(cli, now_ms())
                if not s["isChief"]:
                    self.hub.publish("activity", {"id": s["id"], "kind": "pulse"})
            for p in peers:
                self.hub.publish("activity", {"kind": "message", "from": p["from"], "to": s["id"]})
        for cli in list(self.tails):
            if cli not in seen:
                del self.tails[cli]
        for cli in list(self.bg_work):
            if cli not in seen:
                del self.bg_work[cli]
                self.reader.set_background(cli, [])
                grew_any = True
        return grew_any

    def transcript(self, cli):
        path = self.reader.transcript_path(cli)
        if not path:
            return None
        with self.lock:
            t = self.transcripts.get(path)
            if t is None:
                t = Transcript(path)
                self.transcripts[path] = t
                while len(self.transcripts) > 24:
                    self.transcripts.popitem(last=False)
            else:
                self.transcripts.move_to_end(path)
        return t

    # -------------------------------------------------------------- loops --
    def start_loops(self):
        def every(seconds, fn, name):
            def run():
                while not self.stopping.is_set():
                    try:
                        fn()
                    except Exception:
                        traceback.print_exc()
                    self.stopping.wait(seconds)
            threading.Thread(target=run, name=name, daemon=True).start()

        def first():
            # The first read of every desktop file can take seconds; health and
            # the static page answer meanwhile, and the snapshot is empty.
            try:
                self.reader.refresh_files()
                self.reader.refresh_live()
                self.rebuild()
            except Exception:
                traceback.print_exc()
            finally:
                self.ready.set()
            self.last_live_at = self.clock()
            every(1, live, "cos-live")
            every(FILES_EVERY_S, files, "cos-files")
            every(PULSE_EVERY_S, pulse, "cos-pulse")

        def live():
            self.tick_live()

        def files():
            self.reader.refresh_files()
            self.rebuild()

        def pulse():
            if self.pulse():
                self.rebuild()
            self.flush_sessions()
            self.tick_notices()
            self.tick_chief()
            self.sweep_inbox()

        def watchdog():
            idle = time.time() - max(self.hub.last_client_at, self.last_mod_at)
            if self.hub.client_count() == 0 and self.chief_polling == 0 and idle > IDLE_EXIT_S:
                self.shutdown()
            if self.voice.installed and self.voice.enabled and self.voice.wanted() and self.voice.pid() is None \
                    and self.voice.status["state"] not in ("error",):
                self.voice.start()

        threading.Thread(target=first, name="cos-first", daemon=True).start()
        every(60, watchdog, "cos-watchdog")

    def shutdown(self):
        if self.stopping.is_set():
            return
        self.stopping.set()
        self.voice.stop(ask_quit=lambda: self.voice_jobs.put({"id": self.new_id("ctl"), "kind": "quit", "text": ""}))
        with self.inbox.cond:
            self.inbox.cond.notify_all()
        with self.voice_jobs.cond:
            self.voice_jobs.cond.notify_all()
        if self.server:
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    # -------------------------------------------------------------- voice --
    def voice_state_path(self):
        return paths.run_dir() / "voice-state.json"

    def load_voice_state(self):
        """The console's listen and speak toggles from the last run, over the settings."""
        if not self.write_state:
            return False
        try:
            data = json.loads(self.voice_state_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict):
            return False
        self.voice.control(data.get("listen"), data.get("speak") if isinstance(data.get("speak"), bool) else None)
        return True

    def save_voice_state(self):
        if not self.write_state:
            return
        status = self.voice.snapshot()
        write_json_atomic(self.voice_state_path(), {"listen": status["listen"], "speak": status["speak"]})
        self.has_voice_state = True

    def voice_config_job(self):
        return {"id": self.new_id("ctl"), "kind": "control", "text": "",
                **{k: self.settings.get(k) for k in config.VOICE_KEYS}}

    def maybe_ack(self, source):
        """A quick spoken filler ("On it") the moment Jay asks, before the Chief's turn ends:
        for every spoken request, and for a typed one while replies are spoken."""
        if not self.settings.get("fillers", True):
            return
        status = self.voice.snapshot()
        if not self.voice.installed or status["state"] in ("not-installed", "error"):
            return
        if source == "voice" or status["speak"]:
            self.voice_jobs.put({"id": self.new_id("ack"), "kind": "ack", "text": ""})

    # ---------------------------------------------------------------- API --
    def health(self):
        return {"ok": True, "api": API, "app": APP, "voice": self.voice_status(), "chief": self.chief_public(),
                "settings": {"chiefName": self.settings.get("chiefName"), "wakeWord": self.settings.get("wakeWord")}}

    def session_or_404(self, sid):
        if not ID_RE.match(sid or ""):
            raise HttpError(404, "There is no session with that id.")
        s = self.reader.get(sid)
        if not s:
            raise HttpError(404, "There is no session with that id. It may be archived.")
        return s

    def require_chief(self):
        if not self.chief_connected():
            raise HttpError(409, "No Chief is connected. Type /chief in a desktop session first.")

    def say(self, body):
        text = _text_field(body, "text")
        source = body.get("source") if body.get("source") in ("typed", "voice") else "typed"
        self.require_chief()
        msg = self.add_chat("me", text, source)
        self.queue_item({"id": msg["id"], "type": "prompt", "text": text})
        self.maybe_ack(source)
        return {"id": msg["id"]}

    def reply(self, sid, body):
        s = self.session_or_404(sid)
        text = _text_field(body, "text")
        if s["isChief"]:
            raise HttpError(409, "That is the Chief's own session. Talk to it in the chat instead.")
        if not sid.startswith("local_"):
            raise HttpError(409, "Only desktop sessions can get a reply from here.")
        self.require_chief()
        action = self.new_id("act")
        self.queue_item({"id": action, "type": "reply", "sessionId": sid, "title": s["title"], "text": text})
        self.hub.publish("activity", {"kind": "chief", "to": sid})
        return {"actionId": action}

    def archive(self, sid, body):
        s = self.session_or_404(sid)
        if s["isChief"]:
            raise HttpError(409, "That is the Chief's own session. Archive it from the desktop app.")
        if not sid.startswith("local_"):
            raise HttpError(409, "Only desktop sessions can be archived from here.")
        busy = self.active_family(s)
        if busy and body.get("confirmed") is not True:
            why = (f"{s['title']} is working right now. Archiving it stops that work." if busy == "self" else
                   f"A helper session of {s['title']} is working right now. Archiving it can stop that work.")
            raise HttpError(409, why, needsConfirm=True, reason=why)
        self.require_chief()
        action = self.new_id("act")
        reason = _text_field(body, "reason", required=False) or "Archived from the Chief of Staff console"
        self.queue_item({"id": action, "type": "archive", "sessionId": sid, "title": s["title"], "reason": reason,
                         "confirmed": body.get("confirmed") is True})
        self.hub.publish("activity", {"kind": "chief", "to": sid})
        return {"actionId": action}

    def active_family(self, s):
        """"self" when the session is active, "child" when one of its child sessions is, else None."""
        if s["state"] == "active":
            return "self"
        for cid in s.get("childIds") or []:
            child = self.reader.get(cid)
            if child and child["state"] == "active":
                return "child"
        return None

    def open_session(self, sid):
        s = self.session_or_404(sid)
        if not s.get("link"):
            raise HttpError(409, "That session has no desktop link.")
        try:
            if os.name == "nt":
                os.startfile(s["link"])        # noqa: the link is built from a checked id
            else:
                subprocess.Popen(["xdg-open", s["link"]], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            raise HttpError(500, "The desktop app did not open the session.")
        return {"ok": True}

    def voice_control(self, body):
        listen = body.get("listen") if body.get("listen") in ("wake", "ptt", "off") else None
        speak = body.get("speak") if isinstance(body.get("speak"), bool) else None
        status = self.voice.control(listen, speak)
        if body.get("stop") is True:
            self.voice_jobs.drop(lambda j: j.get("kind") == "speak")
            self.voice_jobs.put({"id": self.new_id("spk"), "kind": "stop", "text": ""})
        control = {k: v for k, v in (("listen", listen), ("speak", speak),
                                     ("pttDown", body.get("pttDown") if isinstance(body.get("pttDown"), bool) else None))
                   if v is not None}
        if control:
            self.voice_jobs.put({"id": self.new_id("ctl"), "kind": "control", "text": "", **control})
        if listen is not None or speak is not None:
            self.save_voice_state()
        if self.voice.wanted() and self.voice.pid() is None:
            self.voice.start()
        status = self.voice_status()
        self.hub.publish("voice", status)
        return status

    def mod_inbox(self, query):
        try:
            wait = min(30.0, max(0.0, float(query.get("wait") or 25)))
        except ValueError:
            wait = 25.0
        session, cli = query.get("session") or None, query.get("cli") or None
        self.last_mod_at = time.time()
        if not self.is_chief_caller(session, cli):
            return {"items": [], "isChief": False}
        with self.lock:
            self.chief_polling += 1
            self.chief_poll_at = time.time()
        try:
            items = self.inbox.take(wait if not self.stopping.is_set() else 0)
        finally:
            with self.lock:
                self.chief_polling -= 1
                self.chief_poll_at = time.time()
        if not self.is_chief_caller(session, cli):     # another session took over while we waited
            for item in items:
                self.inbox.put(item)
            return {"items": [], "isChief": False}
        self.delivered(items)
        return {"items": items, "isChief": True}

    def mod_hello(self, body):
        cli = _text_field(body, "cliId")
        options = body.get("options") if isinstance(body.get("options"), dict) else None
        self.last_mod_at = time.time()
        if body.get("isChief") is False:
            with self.lock:
                if self.chief["cliId"] == cli:
                    self.chief.update(sessionId=None, cliId=None, busy=False)
            self.save_state()
            self.rebuild()
            self.publish_chief()
            return {"ok": True, "sessionId": None, "settings": self.settings}
        local = self.reader.local_id_for(cli)
        with self.lock:
            new_chief = self.chief["cliId"] != cli
            self.chief.update(sessionId=local, cliId=cli, busy=False)
            self.chief_poll_at = time.time()
        if options is not None:
            before = {k: self.settings.get(k) for k in config.VOICE_KEYS}
            self.settings = config.load(options)
            # The console's own listen and speak toggles, once set, outlive a new Chief.
            if new_chief and not self.has_voice_state:
                self.voice.control(self.settings["listen"], bool(self.settings["speakReplies"]))
            self.voice.status["wakeWord"] = self.settings.get("wakeWord") or None
            if self.voice_config_sent and before != {k: self.settings.get(k) for k in config.VOICE_KEYS}:
                self.voice_jobs.put(self.voice_config_job())
        self.save_state()
        self.rebuild()
        self.publish_chief()
        self.hub.publish("voice", self.voice_status())
        return {"ok": True, "sessionId": local, "settings": self.settings}

    def mod_reply(self, body):
        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            raise HttpError(400, "The text is missing.")
        text = text.strip()[:20000]
        confirm = None
        c = body.get("confirm")
        if isinstance(c, dict) and isinstance(c.get("yes"), str) and isinstance(c.get("no"), str):
            confirm = {"question": c.get("question") if isinstance(c.get("question"), str) else "",
                       "yes": c["yes"].strip()[:60], "no": c["no"].strip()[:60]}
        msg = self.add_chat("chief", text, None, confirm)
        status = self.voice.snapshot()
        if status["speak"] and self.voice.installed and status["state"] not in ("not-installed", "error"):
            self.voice_jobs.put({"id": self.new_id("spk"), "kind": "speak", "text": text})
        return {"id": msg["id"]}

    def mod_result(self, body):
        action = body.get("actionId")
        if not isinstance(action, str) or not action:
            raise HttpError(400, "The actionId is missing.")
        entry = self.ack(action)
        if entry and entry["item"].get("type") == "prompt":
            return {"ok": True}                 # a prompt's acknowledgement, not an action
        event = {"actionId": action, "ok": bool(body.get("ok")),
                 "detail": str(body.get("detail") or "")[:500]}
        self.hub.publish("action", event)
        return {"ok": True}

    def mod_busy(self, body):
        with self.lock:
            self.chief["busy"] = bool(body.get("busy"))
            self.chief_poll_at = time.time()
        self.publish_chief()
        self.hub.publish("voice", self.voice_status())
        return {"ok": True}

    def voice_jobs_poll(self, query):
        try:
            wait = min(30.0, max(0.0, float(query.get("wait") or 25)))
        except ValueError:
            wait = 25.0
        self.voice_poll_at = time.time()
        if not self.voice_config_sent:
            # The daemon's first poll: the wake word, its acknowledgment, fillers and the name.
            self.voice_config_sent = True
            self.voice_jobs.put_front(self.voice_config_job())
        return {"jobs": self.voice_jobs.take(wait if not self.stopping.is_set() else 0)}

    def voice_event(self, body):
        kind = body.get("type")
        if kind == "status":
            self.voice.report(body.get("status"))
            self.hub.publish("voice", self.voice_status())
        elif kind == "wake":
            self.hub.publish("voice", self.voice_status())
        elif kind == "partial":
            if isinstance(body.get("text"), str):
                self.hub.publish("partial", {"text": body["text"][:500]}, keep=False)
        elif kind == "level":
            now = time.monotonic()
            rms = body.get("rms")
            if isinstance(rms, (int, float)) and now - self.last_level_at >= LEVEL_MIN_GAP_S:
                self.last_level_at = now
                self.hub.publish("level", {"rms": max(0.0, min(1.0, float(rms)))}, keep=False)
        elif kind == "final":
            text = body.get("text")
            if isinstance(text, str) and text.strip():
                if self.chief_connected():
                    return self.say({"text": text, "source": "voice"})
                self.add_chat("me", text.strip()[:MAX_TEXT], "voice")
                self.add_chat("chief", "No Chief is connected yet. Type slash chief in a desktop session first.", "notice")
        elif kind == "barge":
            # Jay talked over the Chief: what was still waiting to be said goes too.
            self.voice_jobs.drop(lambda j: j.get("kind") in ("speak", "ack"))
            self.hub.publish("voice", self.voice_status())
        elif kind == "nearMiss":
            # A wake word that almost matched: for tuning, in the server log only.
            score = body.get("score")
            print(json.dumps({"voice": "nearMiss", "score": score if isinstance(score, (int, float)) else None,
                              "at": now_ms()}), file=sys.stderr, flush=True)
        elif kind == "spoken":
            pass
        else:
            raise HttpError(400, "Unknown voice event type.")
        return {"ok": True}

    def snapshot_event(self):
        with self.lock:
            chat = list(self.chat)[-100:]
        return {"sessions": self.reader.snapshot(), "chat": chat, "voice": self.voice_status(),
                "chief": self.chief_public()}


# ------------------------------------------------------------- routing -----

SESSION_RE = re.compile(r"^/api/sessions/([^/]+)(?:/(transcript|reply|archive|open))?$")


def route(app, method, path, query, body):
    if method == "GET" and path == "/api/sessions":
        return app.reader.snapshot()
    if method == "GET" and path == "/api/chat":
        with app.lock:
            return {"messages": list(app.chat)[-100:]}
    m = SESSION_RE.match(path)
    if m:
        sid, sub = m.group(1), m.group(2)
        if method == "GET" and not sub:
            s = app.session_or_404(sid)
            if query.get("by") == "chief":
                app.hub.publish("activity", {"kind": "chief", "to": sid})
            return s
        if method == "GET" and sub == "transcript":
            s = app.session_or_404(sid)
            t = app.transcript(s["cliId"]) if s["cliId"] else None
            if not t:
                return {"turns": [], "cursor": None}
            try:
                limit = int(query.get("limit") or 60)
            except ValueError:
                raise HttpError(400, "The limit must be a number.")
            return t.page(limit, query.get("before") or None)
        if method == "POST" and sub == "reply":
            return app.reply(sid, body)
        if method == "POST" and sub == "archive":
            return app.archive(sid, body)
        if method == "POST" and sub == "open":
            return app.open_session(sid)
    if method == "POST" and path == "/api/chief/say":
        return app.say(body)
    if method == "POST" and path == "/api/voice/control":
        return app.voice_control(body)
    if method == "GET" and path == "/api/mod/inbox":
        return app.mod_inbox(query)
    if method == "POST" and path == "/api/mod/hello":
        return app.mod_hello(body)
    if method == "POST" and path == "/api/mod/reply":
        return app.mod_reply(body)
    if method == "POST" and path == "/api/mod/result":
        return app.mod_result(body)
    if method == "POST" and path == "/api/mod/busy":
        return app.mod_busy(body)
    if method == "GET" and path == "/api/voice/jobs":
        return app.voice_jobs_poll(query)
    if method == "POST" and path == "/api/voice/event":
        return app.voice_event(body)
    if method == "POST" and path == "/api/shutdown":
        app.shutdown()
        return {"ok": True}
    raise HttpError(404, "There is no such API call.")


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ChiefOfStaff"
        sys_version = ""

        def log_message(self, fmt, *args):     # paths and bodies can hold session titles
            pass

        def allowed_hosts(self):
            return {f"127.0.0.1:{app.port}", f"localhost:{app.port}"}

        def send_json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def read_body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise HttpError(400, "The request length is not a number.")
            if n > MAX_BODY:
                # Read (and drop) a bounded amount first, so the client gets the
                # answer instead of a reset connection.
                left = min(n, 1024 * 1024)
                while left > 0:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                raise HttpError(413, "That request is too large.")
            if n <= 0:
                return {}
            raw = self.rfile.read(n)
            try:
                body = json.loads(raw.decode("utf-8"))
            except ValueError:
                raise HttpError(400, "The request body is not valid JSON.")
            if not isinstance(body, dict):
                raise HttpError(400, "The request body must be a JSON object.")
            return body

        def guard(self, need_token, query=None):
            host = self.headers.get("Host")
            if host not in self.allowed_hosts():
                raise HttpError(403, "Open the console at 127.0.0.1.")
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{host}":
                raise HttpError(403, "Requests from other sites are refused.")
            if need_token:
                given = self.headers.get("X-COS-Token") or ""
                if not given and query is not None:
                    given = query.get("k") or ""
                if not given or not secrets.compare_digest(given.encode(), app.token.encode()):
                    raise HttpError(401, "The console key is missing or wrong. Open the link from /chief again.")

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
                    if method != "GET":
                        raise HttpError(405, "Not allowed.")
                    return self.send_json(200, app.health())
                if path == "/api/stream" and method == "GET":
                    self.guard(need_token=True, query=query)
                    return self.stream()
                self.guard(need_token=True)
                body = self.read_body() if method == "POST" else {}
                self.send_json(200, route(app, method, path, query, body))
            except HttpError as e:
                self.send_json(e.status, {"error": str(e), **e.extra})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception:
                traceback.print_exc()
                try:
                    self.send_json(500, {"error": "Something went wrong in the Chief of Staff server. Details are in its log."})
                except Exception:
                    pass

        def static(self, path):
            root = paths.CONSOLE_DIR.resolve()
            if path in ("/", "/index.html"):
                target = root / "index.html"
            else:
                m = STATIC_RE.match(path)
                if not m or ".." in m.group(1).split("/") or m.group(1).lower().startswith("dev/"):
                    raise HttpError(404, "Not found.")
                target = (root / m.group(1)).resolve()
                if root not in target.parents:
                    raise HttpError(404, "Not found.")
            if not target.is_file():
                raise HttpError(404, "Not found.")
            data = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES.get(target.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if target.suffix.lower() == ".html":
                self.send_header("Content-Security-Policy", CSP)
            self.end_headers()
            self.wfile.write(data)

        def stream(self):
            if app.hub.client_count() >= MAX_SSE_CLIENTS:
                raise HttpError(503, "Too many console windows are open. Close one and reload.")
            try:
                last = int(self.headers.get("Last-Event-ID")) if self.headers.get("Last-Event-ID") else None
            except ValueError:
                last = None
            q, replay = app.hub.subscribe(last)
            self.close_connection = True
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Connection", "close")
                self.end_headers()
                if replay is None:
                    snap = json.dumps(app.snapshot_event(), ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(frame(None, "snapshot", snap))
                else:
                    for item in replay:
                        self.wfile.write(frame(*item))
                self.wfile.flush()
                while not app.stopping.is_set():
                    try:
                        item = q.get(timeout=HEARTBEAT_S)
                    except queue.Empty:
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
                        continue
                    self.wfile.write(frame(*item))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                app.hub.unsubscribe(q)

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PUT(self):
            self.handle_any("PUT")

        def do_DELETE(self):
            self.handle_any("DELETE")

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        # On Windows SO_REUSEADDR lets a second server bind a busy port; ask for
        # the port alone so a busy one fails and the next one is tried.
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def bind(app, port, tries=10):
    """Binds 127.0.0.1 on `port` or one of the next tries-1 ports; port 0 picks any."""
    last = None
    for p in ([0] if port == 0 else range(port, port + tries)):
        try:
            server = Server(("127.0.0.1", p), make_handler(app))
        except OSError as e:
            last = e
            continue
        app.port = server.server_address[1]
        app.server = server
        return server
    raise SystemExit(f"No free port from {port} to {port + tries - 1} ({last}).")


def serve(port, token):
    app = App(token, port)
    server = bind(app, port)
    app.voice.start()
    app.save_state()
    app.start_loops()
    print(json.dumps({"serving": app.port, "pid": os.getpid()}), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        app.shutdown()
        try:
            info = json.loads(paths.server_json().read_text(encoding="utf-8"))
            if info.get("pid") == os.getpid():
                paths.server_json().unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
    return 0
