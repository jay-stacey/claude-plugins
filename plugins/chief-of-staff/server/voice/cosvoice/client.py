"""HTTP link to the app server (contracts sections 3 and 5).

Reads HOME\\run\\server.json for port and token, sends X-COS-Token, long-polls
GET /api/voice/jobs and posts VoiceEvents to POST /api/voice/event. Events go out on
their own thread so the audio thread never waits on the network. "level" events are
coalesced to at most level_max_hz per second. Backoff on failure: 1 s doubling to 30 s.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from typing import Callable

from . import config

LOG = logging.getLogger("cosvoice")


class Unauthorized(Exception):
    pass


class ServerLink:
    def __init__(self, read_info: Callable[[], dict | None] = config.read_server_info,
                 level_max_hz: float = 10.0, gone_after_s: float = 120.0) -> None:
        self._read_info = read_info
        self.info: dict | None = None
        self.level_gap = 1.0 / max(0.1, level_max_hz)
        self.gone_after_s = gone_after_s
        self.last_ok = time.monotonic()
        self._events: queue.Queue = queue.Queue(maxsize=500)
        self._level: float | None = None
        self._level_lock = threading.Lock()
        self._last_level_at = 0.0
        self._stop = threading.Event()
        self._sender: threading.Thread | None = None
        self.sent: dict[str, int] = {}

    # --------------------------------------------------------------- basics
    @property
    def base(self) -> str | None:
        if not self.info:
            return None
        return f"http://127.0.0.1:{int(self.info['port'])}"

    def refresh(self) -> bool:
        info = self._read_info()
        if info:
            self.info = info
        return bool(info)

    def gone(self) -> bool:
        """True when the server has not answered for gone_after_s seconds."""
        return time.monotonic() - self.last_ok > self.gone_after_s

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 10.0):
        if not self.info and not self.refresh():
            raise ConnectionError("server.json is missing")
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("X-COS-Token", str(self.info["token"]))
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                self.info = None  # token changed: the server restarted; read server.json again
                raise Unauthorized(path) from e
            raise
        self.last_ok = time.monotonic()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def health(self) -> dict | None:
        try:
            return self.request("GET", "/api/health", timeout=5)
        except Exception as e:
            LOG.debug("health failed: %s", e)
            return None

    def wait_for_server(self, stop: threading.Event, max_wait_s: float | None = None) -> dict | None:
        """Poll until /api/health answers. Returns its body, or None on stop or timeout."""
        delay, start = 1.0, time.monotonic()
        limit = self.gone_after_s if max_wait_s is None else max_wait_s
        while not stop.is_set():
            self.refresh()
            h = self.health() if self.info else None
            if h is not None:
                return h
            if time.monotonic() - start > limit:
                return None
            stop.wait(delay)
            delay = min(30.0, delay * 2)
        return None

    # ----------------------------------------------------------------- jobs
    def poll_jobs(self, wait: int = 25) -> list[dict]:
        body = self.request("GET", f"/api/voice/jobs?wait={wait}", timeout=wait + 10)
        jobs = body.get("jobs") if isinstance(body, dict) else None
        return [j for j in (jobs or []) if isinstance(j, dict)]

    def run_jobs(self, handle: Callable[[dict], None], stop: threading.Event, wait: int = 25) -> None:
        """Long-poll loop with backoff. Returns when stop is set or the server is gone."""
        delay = 1.0
        while not stop.is_set():
            try:
                jobs = self.poll_jobs(wait)
                delay = 1.0
                for job in jobs:
                    try:
                        handle(job)
                    except Exception:
                        LOG.exception("job %s failed", job.get("id"))
                continue
            except Unauthorized:
                LOG.warning("token refused; reading server.json again")
                self.refresh()
            except Exception as e:
                LOG.info("job poll failed (%s); retry in %.0fs", e.__class__.__name__, delay)
            if self.gone():
                LOG.warning("app server gone for %.0f s", self.gone_after_s)
                return
            stop.wait(delay)
            delay = min(30.0, delay * 2)
            self.refresh()

    # --------------------------------------------------------------- events
    def start_sender(self) -> None:
        self._sender = threading.Thread(target=self._send_loop, name="events", daemon=True)
        self._sender.start()

    def post(self, event: dict) -> None:
        """Queue one VoiceEvent. "level" is coalesced; the newest value wins."""
        if event.get("type") == "level":
            with self._level_lock:
                self._level = float(event.get("rms", 0.0))
            return
        try:
            self._events.put_nowait(event)
        except queue.Full:
            LOG.warning("event queue full; dropped %s", event.get("type"))

    def _send(self, event: dict) -> None:
        delay = 0.5
        for _ in range(4):
            try:
                self.request("POST", "/api/voice/event", event, timeout=5)
                self.sent[event["type"]] = self.sent.get(event["type"], 0) + 1
                return
            except Unauthorized:
                self.refresh()
            except urllib.error.HTTPError as e:
                if 400 <= e.code < 500:  # the server refuses this event (an older server); no retry
                    LOG.info("server refused event %s (%s)", event.get("type"), e.code)
                    return
                LOG.debug("event %s failed: %s", event.get("type"), e)
            except Exception as e:
                LOG.debug("event %s failed: %s", event.get("type"), e)
            if self._stop.wait(delay):
                return
            delay *= 2
        LOG.info("dropped event %s after retries", event.get("type"))

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            try:
                event = self._events.get(timeout=0.05)
            except queue.Empty:
                event = None
            if event is not None:
                self._send(event)
            now = time.monotonic()
            with self._level_lock:
                lvl = self._level if now - self._last_level_at >= self.level_gap else None
                if lvl is not None:
                    self._level = None
                    self._last_level_at = now
            if lvl is not None:
                try:
                    self.request("POST", "/api/voice/event", {"type": "level", "rms": round(lvl, 3)}, timeout=2)
                    self.sent["level"] = self.sent.get("level", 0) + 1
                except Exception:
                    pass

    def flush(self, timeout: float = 3.0) -> None:
        end = time.monotonic() + timeout
        while not self._events.empty() and time.monotonic() < end:
            time.sleep(0.05)

    def close(self) -> None:
        self._stop.set()
        if self._sender:
            self._sender.join(timeout=3)
