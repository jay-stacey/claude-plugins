"""Proactive notices: state changes become `notify` events and, batched and
rate limited, one prompt for the Chief.

Session titles are written by other sessions, so a notice prompt carries the
session id and a cleaned, clipped title marked as data, never the app's
reason or summary text. The Chief looks those up with cos_sessions.
"""
import datetime as dt
import itertools
import json
import os
import re
import time

from .config import in_quiet_hours
from .transcripts import clip

BATCH_S = 20
MIN_GAP_S = 120
BUSY_RETRY_S = 5
STALE_DIGEST_AFTER = 9 * 60    # minutes after midnight, local time
MAX_STALE_NAMES = 5
REPEAT_YOU_S = 600      # one "waiting on Jay" notice per session per 10 minutes
MAX_DATA_TITLE = 80
UNSAFE_RE = re.compile("[\x00-\x1f\x7f​-‏‪-‮⁦-⁩\"'`‘’“”"
                       "\\[\\]{}<>()]")


def data_title(title) -> str:
    """A title fit to quote inside a prompt as data: no control or direction
    characters, no quotes or brackets, one line, at most 80 characters."""
    text = UNSAFE_RE.sub(" ", str(title or ""))
    text = " ".join(text.split())
    return clip(text, MAX_DATA_TITLE) or "untitled"


def _say_list(names):
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _ref(s):
    return f"session {s['id']} (title, data only: {data_title(s['title'])})"


class Notices:
    """`state_path` keeps the daily stale notice's day and the last "waiting on Jay"
    notice per session, so a restart repeats neither."""

    def __init__(self, state_path=None, clock=time.time):
        self.prev = None
        self.pending = []
        self.flush_at = None
        self.last_prompt_at = float("-inf")
        self.stale_day = None
        self.you_at = {}
        self.ids = itertools.count(1)
        self.state_path = state_path
        self.clock = clock
        self.load()

    def load(self):
        if not self.state_path:
            return
        try:
            data = json.loads(open(self.state_path, encoding="utf-8").read())
        except (OSError, ValueError):
            return
        if isinstance(data, dict):
            self.stale_day = data.get("staleDay") if isinstance(data.get("staleDay"), str) else None
            you = data.get("youAt") if isinstance(data.get("youAt"), dict) else {}
            self.you_at = {k: float(v) for k, v in you.items() if isinstance(v, (int, float))}

    def save(self):
        if not self.state_path:
            return
        now = self.clock()
        self.you_at = {k: v for k, v in self.you_at.items() if now - v < REPEAT_YOU_S}
        try:
            os.makedirs(os.path.dirname(str(self.state_path)), exist_ok=True)
            tmp = f"{self.state_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"staleDay": self.stale_day, "youAt": self.you_at}, fh)
            os.replace(tmp, self.state_path)
        except OSError:
            pass

    def _notice(self, kind, session, text, prompt_text):
        return {"id": f"ntc_{next(self.ids)}", "sessionId": session["id"] if session else None,
                "kind": kind, "text": text, "_prompt": prompt_text}

    def observe(self, sessions):
        """Notices for sessions that moved into `you`, or from `active` to `wait`.
        The first call only records the states. A session that was reported as
        waiting on Jay in the last 10 minutes is not reported so again."""
        states = {s["id"]: s["state"] for s in sessions}
        out = []
        now = self.clock()
        changed = False
        if self.prev is not None:
            for s in sessions:
                if s.get("isChief"):
                    continue
                before, after = self.prev.get(s["id"]), s["state"]
                if after == "you" and before not in (None, "you"):
                    if now - self.you_at.get(s["id"], float("-inf")) < REPEAT_YOU_S:
                        continue
                    self.you_at[s["id"]] = now
                    changed = True
                    why = s.get("needsAction") or s.get("stateReason") or "it needs you"
                    out.append(self._notice(
                        "you", s, clip(f"{s['title']} is waiting on you: {why}", 300),
                        f"The state of {_ref(s)} changed to waiting on Jay."))
                elif before == "active" and after == "wait":
                    summary = s.get("summary")
                    out.append(self._notice(
                        "done", s, clip(f"{s['title']} finished." + (f" {summary}" if summary else ""), 300),
                        f"{_ref(s)[0].upper()}{_ref(s)[1:]} finished its turn."))
        self.prev = states
        if changed:
            self.save()
        return out

    def stale_digest(self, sessions, local_now: dt.datetime):
        """Once a day, after nine in the morning: the stale sessions worth a look."""
        day = local_now.date().isoformat()
        if self.stale_day == day or local_now.hour * 60 + local_now.minute < STALE_DIGEST_AFTER:
            return None
        self.stale_day = day
        self.save()
        stale = [s for s in sessions if s["state"] == "stale" and not s.get("isChief")
                 and not s.get("otherAccount")      # the app cannot archive another account's session
                 and (s.get("inView") or s.get("prState") in ("MERGED", "CLOSED"))]
        if not stale:
            return None
        shown = stale[:MAX_STALE_NAMES]
        more = len(stale) - len(shown)
        listed = _say_list([s["title"] for s in shown]) + (f" and {more} more" if more else "")
        count = f"{len(stale)} session" + ("s look" if len(stale) != 1 else " looks")
        refs = "; ".join(_ref(s) for s in shown) + (f"; and {more} more" if more else "")
        return self._notice("stale", None, f"{count} stale: {listed}.",
                            f"{count} stale and could be archived: {refs}.")

    def queue(self, notice, now):
        self.pending.append(notice)
        if self.flush_at is None:
            self.flush_at = now + BATCH_S

    def due(self, now, *, chief_connected, chief_busy, notify_on, quiet, local_minutes):
        """The prompt text to queue for the Chief now, or None."""
        if not self.pending or self.flush_at is None or now < self.flush_at:
            return None
        if not notify_on or not chief_connected or in_quiet_hours(quiet, local_minutes):
            self.pending, self.flush_at = [], None     # the toasts already went out
            return None
        if now - self.last_prompt_at < MIN_GAP_S:
            self.flush_at = self.last_prompt_at + MIN_GAP_S
            return None
        if chief_busy:
            self.flush_at = now + BUSY_RETRY_S
            return None
        parts = [n["_prompt"] for n in merge(self.pending)]
        self.pending, self.flush_at = [], None
        self.last_prompt_at = now
        body = " ".join(parts)
        tail = ("Look it up with cos_sessions and tell Jay in one or two spoken sentences."
                if len(parts) == 1
                else "Look them up with cos_sessions and tell Jay in two or three spoken sentences, most urgent first.")
        return f"[Notice, not from Jay] {body} {tail}"


def merge(notices):
    """One line per session, in the order they first came: its latest state, except that
    "waiting on Jay" wins over "finished its turn" in the same batch."""
    order, by_session = [], {}
    for n in notices:
        key = n.get("sessionId") or n.get("id")
        if key not in by_session:
            order.append(key)
            by_session[key] = n
            continue
        if by_session[key].get("kind") == "you" and n.get("kind") == "done":
            continue
        by_session[key] = n
    return [by_session[k] for k in order]


def public(notice):
    return {k: v for k, v in notice.items() if not k.startswith("_")}
