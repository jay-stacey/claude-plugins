#!/usr/bin/env python3
"""Nudges for Day Desk: which reminders are due, and Windows toasts.

``due_nudges`` is a pure function: give it the time and the day's inputs, and
it returns the reminders due now. Each reminder has a stable id, and the
caller keeps the ids already fired, so each one goes out once.

``Nudger`` is the thread the server runs. Every 30 seconds it asks the server
for the inputs, fires what is due, keeps a short queue for ``/api/state``, and
shows a Windows toast unless the server turned toasts off.

Standard library only. Python 3.9 or later.
"""
import base64
import datetime as dt
import logging
import subprocess
import sys
import threading
from xml.sax.saxutils import escape

log = logging.getLogger("daydesk.nudges")

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DEFAULT_WORKDAYS = (0, 1, 2, 3, 4)
NO_BRIEF_AFTER_MIN = 30
TOAST_TIMEOUT_S = 5
# The AppUserModelID of Windows PowerShell, which every Windows install has.
TOAST_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"


# ------------------------------------------------------------------ time ----

def _at(now, value):
    """'10:00' or '2026-10-13T10:00' -> a datetime on now's day, or None."""
    if not value or not isinstance(value, str):
        return None
    try:
        if "T" in value or len(value) > 5:
            return dt.datetime.fromisoformat(value).replace(tzinfo=None, second=0, microsecond=0)
        h, m = value.split(":")
        return now.replace(hour=int(h), minute=int(m), second=0, microsecond=0)
    except (ValueError, TypeError):
        return None


def _hm(t):
    return t.strftime("%H:%M")


def _workdays(profile):
    raw = (profile or {}).get("workdays")
    if not raw:
        return DEFAULT_WORKDAYS
    out = set()
    for d in raw:
        if isinstance(d, int) and 0 <= d <= 6:
            out.add(d)
        elif isinstance(d, str) and d[:3].lower() in WEEKDAYS:
            out.add(WEEKDAYS.index(d[:3].lower()))
    return tuple(sorted(out)) or DEFAULT_WORKDAYS


def is_workday(now, profile):
    return now.weekday() in _workdays(profile)


def _nudge(nid, kind, title, text, at):
    return {"id": nid, "kind": kind, "title": title, "text": text, "at": _hm(at)}


def _event_id(ev):
    return str(ev.get("id") or f"{ev.get('start')}-{ev.get('title')}")


def _attends(ev):
    if ev.get("kind") != "meet":
        return False
    if str(ev.get("response") or "").lower() == "declined":
        return False
    return True


# -------------------------------------------------------------- decision ----

def due_nudges(now, events, focus, profile, shutdown_today, brief_today, fired):
    """The nudges due at `now` that are not in `fired`.

    now: a naive local datetime.
    events: today's schedule events (``start``/``end`` as HH:MM or ISO, ``kind``,
        ``attendees``, ``id``, ``title``).
    focus: ``tasks.py focus-status`` output, or None.
    profile: ``start``, ``stop``, ``shutdown_reminder_min``, optional ``workdays``.
    shutdown_today / brief_today: today's saved JSON, or None.
    fired: ids already sent today.
    """
    fired = set(fired or ())
    profile = profile or {}
    out = []
    today = now.date().isoformat()

    def add(n):
        if n["id"] not in fired:
            fired.add(n["id"])
            out.append(n)

    for ev in events or []:
        if not isinstance(ev, dict) or not _attends(ev):
            continue
        if ev.get("date") and ev.get("date") != today:
            continue
        start, end = _at(now, ev.get("start")), _at(now, ev.get("end"))
        title = (ev.get("title") or "Your meeting").strip()
        eid = _event_id(ev)
        if start and now < start:
            ten, two = start - dt.timedelta(minutes=10), start - dt.timedelta(minutes=2)
            if two <= now:
                add(_nudge(f"meeting_2:{eid}", "meeting_2", "Starting soon",
                           f"{title} starts in 2 minutes.", two))
            elif ten <= now:
                add(_nudge(f"meeting_10:{eid}", "meeting_10", "Heads-up",
                           f"{title} starts in 10 minutes.", ten))
        if end and int(ev.get("attendees") or 0) >= 2:
            since = (now - end).total_seconds()
            if 60 <= since < 240:
                add(_nudge(f"meeting_ended:{eid}", "meeting_ended", "Follow-up",
                           f"Anything you promised in {title}? Add it as a task.",
                           end + dt.timedelta(minutes=1)))

    session = (focus or {}).get("session") if isinstance(focus, dict) else None
    if isinstance(session, dict):
        ends = _at(now, session.get("ends_at"))
        if ends and ends <= now:
            what = session.get("title") or session.get("task") or "your task"
            add(_nudge(f"focus_end:{session.get('task')}:{session.get('ends_at')}", "focus_end",
                       "Focus time is up",
                       f"Time is up on {what}. Done, 15 more minutes, or stuck?", ends))

    workday = is_workday(now, profile)
    stop = _at(now, profile.get("stop"))
    if workday and stop and not shutdown_today:
        try:
            lead = int(profile.get("shutdown_reminder_min") or 30)
        except (TypeError, ValueError):
            lead = 30
        remind = stop - dt.timedelta(minutes=lead)
        if remind <= now < stop:
            add(_nudge(f"shutdown_reminder:{today}", "shutdown_reminder", "Shutdown soon",
                       f"Your day ends at {_hm(stop)}. Run /shutdown when you are ready.", remind))

    tonight = (shutdown_today or {}).get("tonight") if isinstance(shutdown_today, dict) else None
    if isinstance(tonight, dict):
        until = _at(now, tonight.get("until"))
        if until and until <= now < until + dt.timedelta(hours=1):
            add(_nudge(f"tonight_stop:{today}", "tonight_stop", "Time to stop",
                       f"You planned to stop at {_hm(until)}. Save your place and stop for tonight.",
                       until))

    start = _at(now, profile.get("start"))
    if workday and start and brief_today is None:
        due = start + dt.timedelta(minutes=NO_BRIEF_AFTER_MIN)
        if due <= now and (stop is None or now < stop):
            add(_nudge(f"no_brief:{today}", "no_brief", "Morning brief",
                       "No morning brief yet. Run /morning-brief, or open the chat.", due))
    return out


# ----------------------------------------------------------------- toast ----

def _ps_quote(text):
    return "'" + str(text).replace("'", "''") + "'"


def toast_script(title, text):
    xml = ("<toast><visual><binding template=\"ToastGeneric\">"
           f"<text>{escape(str(title))}</text><text>{escape(str(text))}</text>"
           "</binding></visual></toast>")
    return (
        "$ErrorActionPreference = 'Stop'\n"
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null\n"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null\n"
        "$x = New-Object Windows.Data.Xml.Dom.XmlDocument\n"
        f"$x.LoadXml({_ps_quote(xml)})\n"
        "$t = New-Object Windows.UI.Notifications.ToastNotification $x\n"
        f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier({_ps_quote(TOAST_APP_ID)}).Show($t)\n"
    )


def send_toast(title, text):
    """Show a Windows toast. No-op off Windows; never raises; at most 5 s."""
    if not sys.platform.startswith("win"):
        return False
    try:
        encoded = base64.b64encode(toast_script(title, text).encode("utf-16-le")).decode("ascii")
        # Windows PowerShell 5.1, not pwsh: only it loads the WinRT types above.
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                        "-EncodedCommand", encoded],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=TOAST_TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return True
    except Exception:   # a toast is never worth an error
        return False


# ---------------------------------------------------------------- thread ----

class Nudger(threading.Thread):
    """Runs due_nudges every `interval` seconds.

    get_inputs(): a dict with events, focus, profile, shutdown_today, brief_today.
    deliver(nudge): optional callback for each new nudge.
    """

    def __init__(self, get_inputs, deliver=None, toasts=True, interval=30, clock=None,
                 toast=send_toast, keep=20):
        super().__init__(name="day-desk-nudges", daemon=True)
        self.get_inputs = get_inputs
        self.deliver = deliver
        self.toasts = toasts
        self.interval = interval
        self.clock = clock or (lambda: dt.datetime.now().replace(microsecond=0))
        self.toast = toast
        self.keep = keep
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._day = None
        self._fired = set()
        self._queue = []

    def tick(self):
        now = self.clock()
        try:
            inputs = self.get_inputs() or {}
        except Exception:
            log.exception("Nudge inputs failed.")
            return []
        with self._lock:
            if self._day != now.date():
                self._day = now.date()
                self._fired = set()
                self._queue = []
            try:
                due = due_nudges(now, inputs.get("events"), inputs.get("focus"), inputs.get("profile"),
                                 inputs.get("shutdown_today"), inputs.get("brief_today"), self._fired)
            except Exception:
                log.exception("Nudge decision failed.")
                return []
            for n in due:
                self._fired.add(n["id"])
                self._queue.append(n)
            self._queue = self._queue[-self.keep:]
        for n in due:
            if self.deliver:
                try:
                    self.deliver(n)
                except Exception:
                    log.exception("Nudge delivery failed.")
            if self.toasts:
                self.toast(n["title"], n["text"])
        return due

    def pending(self):
        with self._lock:
            return list(self._queue)

    def dismiss(self, nid):
        with self._lock:
            before = len(self._queue)
            self._queue = [n for n in self._queue if n["id"] != nid]
            return len(self._queue) != before

    def run(self):
        self.tick()
        while not self._stop_event.wait(self.interval):
            self.tick()

    def stop(self):
        self._stop_event.set()
