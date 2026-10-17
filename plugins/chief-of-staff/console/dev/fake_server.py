"""Fake app server for building and testing the console without the real one.

Stdlib only. Serves console/ like the real server (GET / and /static/...),
implements every console-facing endpoint from docs/contracts.md section 5 with
sample data, and runs an SSE stream that emits pulses, messages, Chief
activity, notices, chat, voice status and level events on a timer.

It enforces the same rules as contracts.md section 3: per-run token in the
X-COS-Token header (or ?k= on /api/stream), Host must be 127.0.0.1:<port> or
localhost:<port>, Origin absent or same origin, no CORS headers, JSON bodies
up to 64 KB.

    python fake_server.py                  # sample data, prints the console URL
    python fake_server.py --graph 40       # 40 generated in-view sessions
    python fake_server.py --graph 3        # 3 in-view sessions
    python fake_server.py --no-chief       # no Chief connected (say -> 409)
    python fake_server.py --no-voice       # voice.state = not-installed
    python fake_server.py --quiet          # no timed events (for screenshots)

Test hooks (token required): POST /api/dev/kick closes every SSE stream,
POST /api/dev/chief {"connected": bool}, POST /api/dev/voice {"state": "..."},
POST /api/dev/notify sends one notice now, POST /api/dev/wake runs one spoken question,
POST /api/dev/nearmiss sends a near miss, POST /api/dev/speak starts a long reply,
POST /api/dev/barge talks over it, POST /api/dev/settings {"chiefName", "wakeWord"}.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import queue
import random
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

CONSOLE = Path(__file__).resolve().parent.parent
MAX_BODY = 64 * 1024
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")


def now_ms() -> int:
    return int(time.time() * 1000)


MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR

# --------------------------------------------------------------------------- data


def mk(sid, title, state, reason, *, parent=None, live=False, live_status=None, waiting_for=None,
       kind="interactive", repo=None, branch=None, pr=None, pr_state=None, ago=0, created_ago=None,
       summary="", needs=None, app_status=None, is_chief=False, cwd="C:\\Dealerpull", model="claude-sonnet-5-5"):
    t = now_ms()
    return {
        "id": sid,
        "cliId": secrets.token_hex(8) if not sid.startswith("bg_") else sid[3:],
        "title": title,
        "kind": kind,
        "state": state,
        "stateReason": reason,
        "live": live,
        "liveStatus": live_status,
        "waitingFor": waiting_for,
        "parentId": parent,
        "childIds": [],
        "cwd": cwd,
        "repo": repo,
        "branch": branch,
        "prNumber": pr,
        "prState": pr_state,
        "createdAt": t - (created_ago if created_ago is not None else ago + 3 * HOUR),
        "lastActivityAt": t - ago,
        "model": model,
        "effort": "high",
        "permissionMode": "auto",
        "summary": summary,
        "needsAction": needs,
        "appStatus": app_status,
        "isChief": is_chief,
        "link": f"claude://claude.ai/epitaxy/{sid}",
        "inView": True,
    }


def sample_sessions():
    W = "C:\\Dealerpull\\worktrees\\"
    s = [
        mk("local_chief0000", "Chief of staff", "active", "Working now", live=True, live_status="idle",
           is_chief=True, model="claude-opus-5-5", summary="The Chief's own session."),
        mk("local_spec0001", "Dealerpull product spec review", "you",
           "Needs your decision: split PRO-994 into 3 stories", live=True, live_status="idle", ago=4 * MIN,
           summary="Reviewed PRO-994 and PRO-921. Wants a yes on splitting PRO-994 into 3 stories before it writes them.",
           needs="Jay's decision: split PRO-994 into 3 stories", app_status="blocked"),
        mk("local_p9210002", "Plan PRO-921 into engineering stories", "you", "Waiting for a permission prompt",
           parent="local_spec0001", live=True, live_status="waiting", waiting_for="permission prompt", ago=11 * MIN,
           summary="Drafted 4 stories. Blocked on the vendor name switch and a permission prompt to write the plan file."),
        mk("local_p9940003", "PRO-994 spec gate", "wait", "Idle, finished its last turn", parent="local_spec0001",
           live=True, live_status="idle", ago=9 * MIN,
           summary="Ran the seven Spec Ready checks. Six pass; the story split check waits on the parent session."),
        mk("local_dp6760004", "DP1-676", "active", "Working now", live=True, live_status="busy",
           repo="dp-web-ui", branch="DP/dp1-676-ab438c", cwd=W + "dp-web-ui\\dp1-676", ago=0,
           summary="Fixing the inventory form save bug. The stock number is cleared when you save twice. 17 turns in."),
        mk("local_dp676v005", "DP1-676 local verifier", "active", "Working now", parent="local_dp6760004", live=True,
           live_status="busy", repo="dp-web-ui", ago=0, summary="Running the browser test matrix on the local stack."),
        mk("local_dp676u006", "DP1-676 unit test fixer", "wait", "Waiting on a helper session",
           parent="local_dp6760004", live=True, live_status="idle", repo="dp-web-ui", ago=6 * MIN,
           summary="Fixed 3 failing specs. Waiting for the verifier to finish before it re-runs the suite."),
        mk("local_apipr007", "API PR review session", "stale", "PR 1216 merged", repo="dealerpull-api",
           branch="DP/if-49-rin", pr=1216, pr_state="MERGED", ago=2 * HOUR,
           summary="PR 1216 merged. IF-49 now reads the vendor's RIN from the feed. Safe to archive."),
        mk("local_web00008", "Website editor browser performance", "wait", "Waiting on a background task",
           live=True, live_status="idle", ago=6 * MIN,
           summary="Started a 10 minute profile run of the editor. Will read the trace when it finishes."),
        mk("local_cos00009", "Chief of staff plugin build", "active", "Working now", live=True, live_status="busy",
           repo="claude-plugins", branch="DP/chief-of-staff-plugin", cwd=W + "claude-plugins\\chief-of-staff", ago=0,
           summary="Lead session. Three build sessions run in parallel: console, core server, voice daemon."),
        mk("local_cosr0010", "Voice stack research", "wait", "Idle, finished its last turn", parent="local_cos00009",
           live=True, live_status="idle", repo="claude-plugins", ago=25 * MIN,
           summary="Compared wake word and speech models. Recommends faster-whisper large-v3-turbo and Chatterbox."),
        mk("local_cosc0011", "Console build", "active", "Working now", parent="local_cos00009", live=True,
           live_status="busy", repo="claude-plugins", ago=0,
           summary="Building the console against a fake server. Graph, roster, page view and Chief panel."),
        mk("local_coss0012", "Console screenshot check", "you", "Needs your decision: keep the dark-only theme",
           parent="local_cosc0011", live=True, live_status="idle", repo="claude-plugins", ago=2 * MIN,
           summary="Took screenshots at 1280, 1920 and 2560. Asks whether the console stays dark only.",
           needs="Jay's decision: keep the dark-only theme", app_status="review_ready"),
        mk("local_neo00013", "NEO-412 inventory grid filters", "stale", "No activity for 3 days", repo="project-neo",
           branch="DP/neo-412", live=True, live_status="idle", ago=3 * DAY + 2 * HOUR,
           summary="Filters done, tests pending. The branch is 41 commits behind development."),
        mk("local_dd000014", "Day Desk dashboard fix", "stale", "PR 24 merged", repo="claude-plugins", pr=24,
           pr_state="MERGED", ago=26 * HOUR, summary="PR 24 merged yesterday. Safe to archive."),
        mk("bg_7f3a9c21d0e4", "Nightly inventory feed check", "active", "Background job, working", kind="background",
           live=True, live_status=None, repo="InventoryFeeds", ago=0, model="claude-haiku-5-5",
           summary="Checks every dealer feed for missing photos and bad prices. 212 of 340 feeds done."),
    ]
    topics = ["Intercom inbox triage", "DP1-5{0} tax rounding", "NEO-3{0} deal jacket layout", "Release notes R2026-09",
              "IF-{0} feed mapping", "Auth0 trigger review", "Cycle planning DP1", "Bug intake: duplicate VIN",
              "Spec PRO-8{0}", "QA pass NEO-2{0}"]
    rnd = random.Random(7)
    for i in range(30):
        title = topics[i % len(topics)].format(10 + i)
        ago = (4 + i) * DAY + rnd.randint(0, 20) * HOUR
        merged = i % 3 == 0
        x = mk(f"local_old{i:05d}", title, "stale",
               f"PR {900 + i} merged" if merged else f"No activity for {ago // DAY} days",
               pr=900 + i if merged else None, pr_state="MERGED" if merged else None, ago=ago,
               summary="Finished long ago. Nothing left to do here.")
        x["inView"] = False
        s.append(x)
    return s


def generated_sessions(n: int):
    rnd = random.Random(n)
    states = ["you", "active", "wait", "stale"]
    reasons = {"you": "Needs your decision: pick a name", "active": "Working now",
               "wait": "Idle, finished its last turn", "stale": "No activity for 2 days"}
    out = [mk("local_chief0000", "Chief of staff", "active", "Working now", live=True, is_chief=True)]
    ids = []
    for i in range(n):
        st = rnd.choice(states)
        parent = None
        if ids and rnd.random() < 0.45:
            parent = rnd.choice(ids)
        sid = f"local_gen{i:05d}"
        out.append(mk(sid, f"Session {i + 1} {rnd.choice(['spec', 'bug fix', 'review', 'plan', 'QA', 'docs'])}", st,
                      reasons[st], parent=parent, live=st != "stale", live_status="busy" if st == "active" else "idle",
                      ago=0 if st == "active" else rnd.randint(1, 120) * MIN,
                      summary=f"Generated session {i + 1} for the layout test."))
        ids.append(sid)
    return out


# --------------------------------------------------------------------------- transcripts

USER_LINES = [
    "Pick up {t}. Start with the failing case and tell me what you find.",
    "Run the tests again and show me only what fails.",
    "Keep the change small. Do not touch the shared helpers.",
    "Looks good. Open the PR when the checks pass.",
    "What is left before this is done?",
]
ASSISTANT_LINES = [
    "Found it. The save handler resets the form **before** the second request comes back, so `stockNumber` is "
    "cleared.\n\nPlan:\n\n1. Hold the reset until the save finishes.\n2. Add a test for the double save.\n"
    "3. Run the verifier on the local stack.",
    "Unit tests pass. The verifier is now running the save twice in the browser on the local stack.",
    "Two specs fail, both on the date filter. The fixture uses a UTC midnight date, so the day shifts by one:\n\n"
    "```ts\nconst from = new Date('2026-10-01'); // UTC midnight, Sep 30 in Toronto\n"
    "const fixed = parseLocalDate('2026-10-01');\n```\n\nI will switch the fixture to `parseLocalDate`.",
    "## Done\n\nThe change is 3 files and 41 lines.\n\n| File | Change |\n|---|---|\n"
    "| `inventory-form.component.ts` | hold the reset until the save returns |\n"
    "| `inventory-form.component.spec.ts` | new double-save test |\n| `date-utils.ts` | no change |\n\n"
    "Next I will run the full suite. See the [contract](https://code.claude.com/docs/en/plugins-reference) for details.",
    "Status:\n\n- [x] Fix the save handler\n- [x] Unit tests\n- [ ] Browser check\n  - double save\n  - save after edit\n\n"
    "> The verifier owns the browser check. I will *not* touch it.",
]
TOOLS = [
    ("Bash", "npm test -- inventory-form", "Tests: 42 passed, 42 total (3.1 s)", False),
    ("Edit", "src/app/inventory/inventory-form.component.ts", "Updated with 6 additions and 2 removals", False),
    ("Read", "docs/contracts.md", "Read 201 lines", False),
    ("Grep", "stockNumber", "Found 7 matches in 3 files", False),
    ("Agent", "started a local verifier", None, False),
    ("Bash", "dotnet test Dealerpull.Tests --filter Inventory", "Failed: 2, Passed: 118. DateFilterTests.FromIsInclusive", True),
]
QUESTION = {
    "questions": [{
        "header": "Story split",
        "question": "Split **PRO-994** into 3 stories before I write them?",
        "multiSelect": False,
        "options": [
            {"label": "Split into 3", "description": "Search, filters and export as separate stories."},
            {"label": "Keep one story", "description": "One larger story with sub-tasks."},
        ],
    }],
    "answer": None,
}


def tool_turn(uid, at, tool):
    name, summ, result, err = tool
    return {"uuid": uid, "role": "tool", "at": at, "text": summ, "toolName": name, "toolSummary": summ,
            "toolResult": result, "toolError": err, "fromSession": None}


class Transcripts:
    def __init__(self):
        self.lock = threading.Lock()
        self.by_id: dict[str, list] = {}

    def _make(self, s):
        rnd = random.Random(s["id"])
        n = rnd.randint(90, 160)
        end = s["lastActivityAt"]
        start = min(s["createdAt"], end - n * 20_000)
        turns = []
        for i in range(n):
            at = start + (end - start) * i // max(1, n - 1)
            k = i % 5
            uid = f"{s['id'][-8:]}-{i:05d}"
            if i == n - 12:
                # an answered question, a few pages up from the newest turn
                q = json.loads(json.dumps(QUESTION))
                q["questions"][0]["header"] = "Field name"
                q["questions"][0]["question"] = "Keep the old field name, or rename it everywhere?"
                q["questions"][0]["options"] = [{"label": "Keep it", "description": "No migration needed."},
                                                {"label": "Rename everywhere", "description": "Needs a migration."}]
                q["answer"] = "Keep it"
                turns.append({"uuid": uid, "role": "tool", "at": at, "text": "AskUserQuestion",
                              "toolName": "AskUserQuestion", "toolSummary": None, "question": q, "fromSession": None})
            elif k == 0:
                text = rnd.choice(USER_LINES).format(t=s["title"])
                from_s = "Chief of staff" if (i % 25 == 0 and i) else None
                if from_s:
                    text = "Jay asks: where does this stand? Reply in two sentences."
                turns.append({"uuid": uid, "role": "user", "at": at, "text": text, "toolName": None,
                              "toolSummary": None, "fromSession": from_s})
            elif k in (2, 3):
                turns.append(tool_turn(uid, at, rnd.choice(TOOLS)))
            else:
                turns.append({"uuid": uid, "role": "assistant", "at": at, "text": rnd.choice(ASSISTANT_LINES),
                              "toolName": None, "toolSummary": None, "fromSession": None})
        if s.get("needsAction"):
            # sessions waiting on a decision end on an open question
            turns.append({"uuid": f"{s['id'][-8:]}-{n:05d}", "role": "tool", "at": end, "text": "AskUserQuestion",
                          "toolName": "AskUserQuestion", "toolSummary": None,
                          "question": json.loads(json.dumps(QUESTION)), "fromSession": None})
        return turns

    def get(self, s):
        with self.lock:
            if s["id"] not in self.by_id:
                self.by_id[s["id"]] = self._make(s)
            return self.by_id[s["id"]]

    def append(self, s, role, text, from_session=None, tool=None):
        turns = self.get(s)
        with self.lock:
            i = len(turns)
            uid = f"{s['id'][-8:]}-{i:05d}"
            turns.append(tool_turn(uid, now_ms(), tool) if tool else
                         {"uuid": uid, "role": role, "at": now_ms(), "text": text, "toolName": None,
                          "toolSummary": None, "fromSession": from_session})

    def page(self, s, limit, before):
        turns = self.get(s)
        with self.lock:
            end = len(turns)
            if before:
                idx = next((i for i, t in enumerate(turns) if t["uuid"] == before), None)
                if idx is None:
                    return None
                end = idx
            start = max(0, end - limit)
            chunk = turns[start:end]
            return {"turns": chunk, "cursor": chunk[0]["uuid"] if start > 0 and chunk else None}


# --------------------------------------------------------------------------- state + SSE


class Hub:
    def __init__(self, args):
        self.args = args
        self.lock = threading.RLock()
        self.sessions = generated_sessions(args.graph) if args.graph else sample_sessions()
        self._link_children()
        self.transcripts = Transcripts()
        self.chat: list[dict] = []
        self.chief = {"connected": not args.no_chief, "sessionId": None if args.no_chief else "local_chief0000",
                      "busy": False}
        self.voice = {
            "state": "not-installed" if args.no_voice else "listening", "listen": "wake", "speak": True,
            "device": None if args.no_voice else "cuda",
            "stt": None if args.no_voice else "faster-whisper large-v3-turbo",
            "tts": None if args.no_voice else "chatterbox", "wakeWord": args.wake_word,
            "detail": "Voice is not installed. Run server/setup.ps1 to add it." if args.no_voice else None,
        }
        self.settings = {"chiefName": args.chief_name, "wakeWord": args.wake_word}
        self.clients: list[queue.Queue] = []
        self.ring: list[tuple[int, str, str]] = []
        self.seq = 0
        self.pending_confirm = None
        if self.chief["connected"]:
            self._seed_chat()

    # ---- sessions
    def _link_children(self):
        by = {s["id"]: s for s in self.sessions}
        for s in self.sessions:
            s["childIds"] = []
        for s in self.sessions:
            p = by.get(s["parentId"])
            if p:
                p["childIds"].append(s["id"])

    def find(self, sid):
        return next((s for s in self.sessions if s["id"] == sid), None)

    def sessions_body(self):
        counts = {"you": 0, "active": 0, "wait": 0, "stale": 0}
        for s in self.sessions:
            if not s["isChief"]:
                counts[s["state"]] += 1
        return {"generatedAt": now_ms(), "liveStale": False, "counts": counts, "sessions": self.sessions}

    def in_view(self):
        return [s for s in self.sessions if s["inView"] and not s["isChief"]]

    # ---- chat
    def _seed_chat(self):
        t = now_ms()
        self.chat = [
            {"id": "msg_seed1", "role": "chief", "source": None, "at": t - 9 * MIN, "confirm": None,
             "text": "Morning, Jay. Two things need you. The PRO-921 plan is stuck on a permission prompt, and the "
                     "spec review wants a yes on the story split. DP1-676 is still building, so leave that one alone."},
            {"id": "msg_seed2", "role": "me", "source": "voice", "at": t - 7 * MIN, "confirm": None,
             "text": "What is the console build doing?"},
            {"id": "msg_seed3", "role": "chief", "source": None, "at": t - 7 * MIN + 4000, "confirm": None,
             "text": "It is building the graph and the page view against a fake server. Its screenshot helper is "
                     "waiting on you about the dark-only theme."},
        ]

    def add_chat(self, role, text, source=None, confirm=None):
        m = {"id": "msg_" + secrets.token_hex(5), "role": role, "source": source, "text": text, "at": now_ms(),
             "confirm": confirm}
        with self.lock:
            self.chat.append(m)
            self.chat = self.chat[-100:]
        self.emit("chat", m)
        return m

    # ---- SSE
    def emit(self, event, data):
        with self.lock:
            self.seq += 1
            payload = json.dumps(data, separators=(",", ":"))
            item = (self.seq, event, payload)
            self.ring.append(item)
            del self.ring[:-500]
            for q in list(self.clients):
                q.put(item)

    def snapshot(self):
        return {"sessions": self.sessions_body(), "chat": self.chat[-100:], "voice": self.voice, "chief": self.chief}

    def subscribe(self, last_id):
        q: queue.Queue = queue.Queue()
        with self.lock:
            backlog = [x for x in self.ring if last_id is not None and x[0] > last_id]
            self.clients.append(q)
        return q, backlog

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def kick(self):
        with self.lock:
            for q in self.clients:
                q.put(None)

    # ---- voice
    def set_voice(self, **kw):
        with self.lock:
            self.voice.update(kw)
            v = dict(self.voice)
        self.emit("voice", v)
        return v

    def set_chief(self, **kw):
        with self.lock:
            self.chief.update(kw)
            c = dict(self.chief)
        self.emit("chief", c)
        return c

    # ---- the fake Chief's replies
    def chief_answer(self, text, source):
        def run():
            installed = self.voice["state"] != "not-installed"
            self.set_chief(busy=True)
            if installed:
                self.soft_voice("thinking")
            time.sleep(1.2)
            low = text.lower().strip().rstrip(".")
            confirm = None
            reply = None
            if self.pending_confirm and low in (self.pending_confirm["yes"].lower().rstrip("."), "yes"):
                s = self.find(self.pending_confirm["sid"])
                if s:
                    self.remove_session(s["id"])
                    reply = f"Done. {s['title']} is archived. You can bring it back from the archived list."
                else:
                    reply = "That session is already gone."
                self.pending_confirm = None
            elif self.pending_confirm and low in (self.pending_confirm["no"].lower().rstrip("."), "no"):
                reply = "Okay, leaving it running. I'll tell you when it finishes."
                self.pending_confirm = None
            elif low.startswith("tell me about "):
                name = text[len("tell me about "):].strip().rstrip(".")
                s = next((x for x in self.sessions if x["title"].lower() == name.lower()), None)
                reply = (f"{s['title']} is {STATE_WORD[s['state']]}. {s['summary']}" if s
                         else f"I can't find a session called {name}.")
                if s:
                    self.emit("activity", {"kind": "chief", "to": s["id"]})
            elif "close" in low or "archive" in low:
                s = self.find("local_dp6760004") or (self.in_view() or [None])[0]
                if s:
                    confirm = {"question": f"Archive {s['title']}?", "yes": "Archive anyway", "no": "Leave it running"}
                    self.pending_confirm = {"sid": s["id"], **confirm}
                    reply = (f"Heads up, {s['title']} is active right now. It has one helper running. "
                             "Want me to archive it anyway?")
                    self.emit("activity", {"kind": "chief", "to": s["id"]})
            if reply is None:
                you = [s for s in self.in_view() if s["state"] == "you"]
                reply = (f"{len(you)} sessions need you. The first is {you[0]['title']}: {you[0]['stateReason']}."
                         if you else "Nothing needs you right now.")
            self.add_chat("chief", reply, None, confirm)
            self.set_chief(busy=False)
            if installed and self.voice["speak"]:
                self.soft_voice("speaking")
                time.sleep(2.5)
            if installed:
                self.soft_voice(idle_state(self.voice))

        threading.Thread(target=run, daemon=True).start()

    def soft_voice(self, st):
        """Change the voice state unless the user is talking right now (never cut off "hearing")."""
        if self.voice["state"] not in ("hearing", "not-installed"):
            self.set_voice(state=st)

    def remove_session(self, sid):
        with self.lock:
            self.sessions = [s for s in self.sessions if s["id"] != sid]
            self._link_children()
        self.emit("sessions", self.sessions_body())


STATE_WORD = {"you": "waiting on you", "active": "working now", "wait": "waiting on something else",
              "stale": "stale"}


def idle_state(v):
    return {"wake": "listening", "ptt": "listening", "off": "off"}[v["listen"]]


# --------------------------------------------------------------------------- timed events


def ticker(hub: Hub):
    rnd = random.Random(42)
    t0 = time.time()
    next_msg = t0 + 4
    next_chief = t0 + 7
    next_notify = t0 + 9
    next_confirm = t0 + 16
    next_voice = t0 + 22
    next_flip = t0 + 30
    next_near = t0 + 12
    while True:
        time.sleep(0.25)
        now = time.time()
        live = [s for s in hub.in_view() if s["state"] == "active"]
        # pulses: each active session grows about once every 1-3 s
        for s in live:
            if rnd.random() < 0.1:
                s["lastActivityAt"] = now_ms()
                if rnd.random() < 0.3:
                    hub.transcripts.append(s, "tool", "", tool=rnd.choice(TOOLS))
                hub.emit("activity", {"kind": "pulse", "id": s["id"]})
        if now >= next_msg:
            next_msg = now + rnd.uniform(4, 8)
            views = hub.in_view()
            kids = [s for s in views if s["parentId"] and hub.find(s["parentId"])]
            if kids and rnd.random() < 0.75:
                k = rnd.choice(kids)
                a, b = (k["parentId"], k["id"]) if rnd.random() < 0.5 else (k["id"], k["parentId"])
            elif len(views) >= 2:
                a, b = (x["id"] for x in rnd.sample(views, 2))
            else:
                continue
            src = hub.find(a)
            dst = hub.find(b)
            if src and dst:
                hub.transcripts.append(dst, "user", f"Message from {src['title']}: the check you asked for is done.",
                                       from_session=src["title"])
                hub.emit("activity", {"kind": "message", "from": a, "to": b})
        if now >= next_chief:
            next_chief = now + rnd.uniform(6, 10)
            views = hub.in_view()
            if views and hub.chief["connected"]:
                hub.emit("activity", {"kind": "chief", "to": rnd.choice(views)["id"]})
        if now >= next_notify:
            next_notify = now + rnd.uniform(35, 50)
            send_notice(hub, rnd)
        if now >= next_confirm and hub.chief["connected"]:
            next_confirm = now + 10_000
            s = hub.find("local_dp6760004")
            if s:
                hub.add_chat("me", "Close the DP1-676 session.", "voice")
                time.sleep(0.2)
                confirm = {"question": "Archive DP1-676?", "yes": "Archive anyway", "no": "Leave it running"}
                hub.pending_confirm = {"sid": s["id"], **confirm}
                hub.emit("activity", {"kind": "chief", "to": s["id"]})
                hub.add_chat("chief", "Heads up, DP1-676 is active right now. It's halfway through the inventory "
                                      "form fix and has one helper running. Want me to archive it anyway?",
                             None, confirm)
        if now >= next_near:
            next_near = now + rnd.uniform(15, 25)
            if hub.voice["state"] == "listening" and hub.voice["listen"] == "wake":
                hub.emit("nearMiss", {"score": round(rnd.uniform(0.25, 0.45), 2)})
        if now >= next_voice and hub.voice["state"] == "listening" and hub.voice["listen"] == "wake":
            next_voice = now + rnd.uniform(30, 45)
            threading.Thread(target=fake_utterance, args=(hub, "What needs me right now?"), daemon=True).start()
        if now >= next_flip:
            next_flip = now + rnd.uniform(20, 30)
            flip_state(hub, rnd)


def fake_utterance(hub: Hub, text: str, wake=True):
    if wake:
        hub.emit("wake", {"score": round(random.uniform(0.72, 0.95), 2)})
        hub.emit("level", {"rms": 0.6})
    hub.set_voice(state="hearing")
    words = text.split()
    for i in range(30):
        hub.emit("level", {"rms": round(abs(random.gauss(0.35, 0.18)) % 1, 3)})
        if i % 6 == 5:
            hub.emit("partial", {"text": " ".join(words[: 1 + i // 6]).lower()})
        time.sleep(0.1)
    hub.emit("level", {"rms": 0.0})
    hub.set_voice(state="thinking")
    hub.add_chat("me", text, "voice")
    hub.chief_answer(text, "voice")


def send_notice(hub: Hub, rnd):
    you = [s for s in hub.in_view() if s["state"] == "you"]
    done = [s for s in hub.in_view() if s["state"] == "wait"]
    if you and rnd.random() < 0.6:
        s = rnd.choice(you)
        hub.emit("notify", {"id": "ntf_" + secrets.token_hex(4), "sessionId": s["id"], "kind": "you",
                            "text": f"{s['title']} is waiting on you: {s['stateReason'].lower()}."})
    elif done:
        s = rnd.choice(done)
        hub.emit("notify", {"id": "ntf_" + secrets.token_hex(4), "sessionId": s["id"], "kind": "done",
                            "text": f"{s['title']} finished its turn."})


def flip_state(hub: Hub, rnd):
    cands = [s for s in hub.in_view() if s["state"] in ("wait", "you") and s["live"]]
    if not cands:
        return
    s = rnd.choice(cands)
    if s["state"] == "wait":
        s.update(state="you", stateReason="Waiting for a permission prompt", liveStatus="waiting",
                 waitingFor="permission prompt")
        hub.emit("notify", {"id": "ntf_" + secrets.token_hex(4), "sessionId": s["id"], "kind": "you",
                            "text": f"{s['title']} is waiting for a permission prompt."})
    else:
        s.update(state="wait", stateReason="Idle, finished its last turn", liveStatus="idle", waitingFor=None,
                 needsAction=None, appStatus=None)
    s["lastActivityAt"] = now_ms()
    hub.emit("sessions", hub.sessions_body())


# --------------------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    hub: Hub = None  # set in main
    token = ""
    port = 0
    server_version = "cos-fake/1"
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *a):
        if self.hub.args.verbose:
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    # ---- helpers
    def send_json(self, code, data, extra=None):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def err(self, code, msg):
        self.send_json(code, {"error": msg})

    def host_ok(self):
        host = self.headers.get("Host", "")
        return host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}")

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin in (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    def token_ok(self, query):
        got = self.headers.get("X-COS-Token", "")
        if not got and urlsplit(self.path).path == "/api/stream":
            got = (query.get("k") or [""])[0]
        return bool(got) and secrets.compare_digest(got.encode(), self.token.encode())

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            self.err(413, "The request body is too large.")
            return None
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            self.err(400, "The request body is not valid JSON.")
            return None
        if not isinstance(data, dict):
            self.err(400, "The request body must be a JSON object.")
            return None
        return data

    # ---- routing
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        if not self.host_ok():
            return self.err(403, "This server only answers on 127.0.0.1.")
        if not self.origin_ok():
            return self.err(403, "Requests from other sites are not allowed.")
        parts = urlsplit(self.path)
        path, query = parts.path, parse_qs(parts.query)
        if method == "GET" and path == "/":
            return self.static("index.html")
        if method == "GET" and path.startswith("/static/"):
            return self.static(path[len("/static/"):])
        if method == "GET" and path == "/api/health":
            h = self.hub
            return self.send_json(200, {"ok": True, "api": 1, "voice": h.voice, "settings": h.settings,
                                        "chief": {"connected": h.chief["connected"],
                                                  "sessionId": h.chief["sessionId"]}})
        if not path.startswith("/api/"):
            return self.err(404, "Not found.")
        if not self.token_ok(query):
            return self.err(401, "The access key is missing or wrong.")
        try:
            return self.api(method, path, query)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 - the fake logs and answers 500 like the real one would
            sys.stderr.write(f"error: {e!r}\n")
            try:
                self.err(500, "Something went wrong in the fake server.")
            except OSError:
                pass

    def static(self, rel):
        if rel.startswith("dev/") or rel == "dev":
            return self.err(404, "Not found.")
        target = (CONSOLE / rel).resolve()
        try:
            target.relative_to(CONSOLE)
        except ValueError:
            return self.err(404, "Not found.")
        if not target.is_file():
            return self.err(404, "Not found.")
        body = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if rel == "index.html":
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)

    def api(self, method, path, query):
        h = self.hub
        m = re.fullmatch(r"/api/sessions/([A-Za-z0-9_\-]+)(/[a-z]+)?", path)
        if method == "GET" and path == "/api/sessions":
            return self.send_json(200, h.sessions_body())
        if method == "GET" and path == "/api/chat":
            return self.send_json(200, {"messages": h.chat[-100:]})
        if method == "GET" and path == "/api/stream":
            return self.stream()
        if m:
            s = h.find(m.group(1))
            sub = m.group(2)
            if not s:
                return self.err(404, "That session is not open any more.")
            if method == "GET" and sub is None:
                return self.send_json(200, s)
            if method == "GET" and sub == "/transcript":
                try:
                    limit = max(1, min(200, int((query.get("limit") or ["60"])[0])))
                except ValueError:
                    return self.err(400, "limit must be a number.")
                before = (query.get("before") or [None])[0]
                page = h.transcripts.page(s, limit, before)
                if page is None:
                    return self.err(404, "That place in the conversation was not found.")
                if self.hub.args.slow:
                    time.sleep(0.8)
                return self.send_json(200, page)
            if method == "POST" and sub == "/reply":
                body = self.read_json()
                if body is None:
                    return
                text = str(body.get("text") or "").strip()
                if not text:
                    return self.err(400, "The reply is empty.")
                act = "act_" + secrets.token_hex(5)

                def done():
                    time.sleep(1.0)
                    h.transcripts.append(s, "user", text, from_session="Chief of staff")
                    h.emit("activity", {"kind": "chief", "to": s["id"]})
                    h.emit("activity", {"kind": "pulse", "id": s["id"]})
                    h.emit("action", {"actionId": act, "ok": True, "detail": f"Sent to {s['title']}."})

                threading.Thread(target=done, daemon=True).start()
                return self.send_json(200, {"actionId": act})
            if method == "POST" and sub == "/archive":
                body = self.read_json()
                if body is None:
                    return
                if s["state"] == "active" and not body.get("confirmed"):
                    kids = [c for c in s["childIds"] if (h.find(c) or {}).get("state") == "active"]
                    reason = f"{s['title']} is working right now."
                    if kids:
                        reason += f" It has {len(kids)} helper{'s' if len(kids) > 1 else ''} running."
                    return self.send_json(409, {"needsConfirm": True, "reason": reason})
                act = "act_" + secrets.token_hex(5)

                def gone():
                    time.sleep(1.5)
                    if self.hub.args.fail_archive:
                        h.emit("action", {"actionId": act, "ok": False,
                                          "detail": "The desktop app refused: the session is busy."})
                        return
                    h.remove_session(s["id"])
                    h.emit("action", {"actionId": act, "ok": True, "detail": f"Archived {s['title']}."})

                threading.Thread(target=gone, daemon=True).start()
                return self.send_json(200, {"actionId": act})
            if method == "POST" and sub == "/open":
                sys.stderr.write(f"open: {s['link']}\n")
                h.emit("activity", {"kind": "chief", "to": s["id"]})
                return self.send_json(200, {"ok": True})
            return self.err(404, "Not found.")
        if method == "POST" and path == "/api/chief/say":
            body = self.read_json()
            if body is None:
                return
            text = str(body.get("text") or "").strip()
            source = body.get("source") if body.get("source") in ("typed", "voice") else "typed"
            if not text:
                return self.err(400, "The message is empty.")
            if not h.chief["connected"]:
                return self.err(409, "No Chief is connected. Run /chief in a Claude session first.")
            msg = h.add_chat("me", text, source)
            h.chief_answer(text, source)
            return self.send_json(200, {"id": msg["id"]})
        if method == "POST" and path == "/api/voice/control":
            body = self.read_json()
            if body is None:
                return
            v = h.voice
            if v["state"] == "not-installed":
                return self.send_json(200, v)
            upd = {}
            if body.get("listen") in ("wake", "ptt", "off"):
                upd["listen"] = body["listen"]
                upd["state"] = idle_state({"listen": body["listen"]})
            if isinstance(body.get("speak"), bool):
                upd["speak"] = body["speak"]
            if body.get("stop") is True and v["state"] == "speaking":
                upd["state"] = idle_state(v)
            if upd:
                v = h.set_voice(**upd)
            if body.get("pttDown") is True and v["state"] == "speaking":
                h.emit("barge", {})
            if body.get("pttDown") is True and v["listen"] == "ptt":
                v = h.set_voice(state="hearing")
                h.ptt_started = time.time()

                def levels():
                    while h.voice["state"] == "hearing":
                        h.emit("level", {"rms": round(abs(random.gauss(0.4, 0.2)) % 1, 3)})
                        time.sleep(0.1)

                threading.Thread(target=levels, daemon=True).start()
            elif body.get("pttDown") is False and v["state"] == "hearing":
                h.emit("level", {"rms": 0.0})
                h.set_voice(state="thinking")
                if h.chief["connected"]:
                    h.add_chat("me", "What needs me right now?", "voice")
                    h.chief_answer("What needs me right now?", "voice")
                else:
                    h.set_voice(state=idle_state(h.voice))
                v = h.voice
            return self.send_json(200, v)
        # ---- dev hooks
        if method == "POST" and path == "/api/dev/kick":
            h.kick()
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/dev/chief":
            body = self.read_json() or {}
            c = bool(body.get("connected"))
            h.set_chief(connected=c, sessionId="local_chief0000" if c else None, busy=False)
            return self.send_json(200, h.chief)
        if method == "POST" and path == "/api/dev/voice":
            body = self.read_json() or {}
            st = body.get("state", "listening")
            extra = {"detail": "Voice is not installed. Run server/setup.ps1 to add it."} if st == "not-installed" \
                else {"detail": None, "device": "cuda", "stt": "faster-whisper large-v3-turbo", "tts": "chatterbox"}
            return self.send_json(200, h.set_voice(state=st, **extra))
        if method == "POST" and path == "/api/dev/notify":
            send_notice(h, random.Random())
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/dev/wake":
            threading.Thread(target=fake_utterance, args=(h, "What needs me right now?"), daemon=True).start()
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/dev/nearmiss":
            h.emit("nearMiss", {"score": 0.38})
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/dev/speak":
            h.set_voice(state="speaking")
            return self.send_json(200, h.voice)
        if method == "POST" and path == "/api/dev/barge":
            if h.voice["state"] == "speaking":
                h.emit("barge", {})

                def after():
                    time.sleep(1.5)   # the daemon reports its own status a moment later
                    h.set_voice(state="hearing")
                    time.sleep(1.5)
                    h.set_voice(state=idle_state(h.voice))

                threading.Thread(target=after, daemon=True).start()
            return self.send_json(200, {"ok": True})
        if method == "POST" and path == "/api/dev/settings":
            body = self.read_json() or {}
            for k in ("chiefName", "wakeWord"):
                if isinstance(body.get(k), str):
                    h.settings[k] = body[k]
            h.set_voice(wakeWord=h.settings["wakeWord"])
            return self.send_json(200, h.settings)
        return self.err(404, "Not found.")

    def stream(self):
        h = self.hub
        try:
            last = int(self.headers.get("Last-Event-ID", ""))
        except ValueError:
            last = None
        q, backlog = h.subscribe(last)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(b"retry: 2000\n\n")
            with h.lock:
                seq = h.seq
            self.wfile.write(f"id: {seq}\nevent: snapshot\ndata: {json.dumps(h.snapshot())}\n\n".encode())
            for sid, ev, data in backlog:
                self.wfile.write(f"id: {sid}\nevent: {ev}\ndata: {data}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if item is None:
                    break
                sid, ev, data = item
                self.wfile.write(f"id: {sid}\nevent: {ev}\ndata: {data}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            h.unsubscribe(q)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=47871)
    ap.add_argument("--token", default=None, help="fixed token (default: random per run)")
    ap.add_argument("--graph", type=int, default=0, help="generate N in-view sessions instead of the sample set")
    ap.add_argument("--no-chief", action="store_true")
    ap.add_argument("--no-voice", action="store_true")
    ap.add_argument("--chief-name", default="Chief")
    ap.add_argument("--wake-word", default="hey chief")
    ap.add_argument("--quiet", action="store_true", help="no timed events")
    ap.add_argument("--slow", action="store_true", help="delay transcript pages by 0.8 s")
    ap.add_argument("--fail-archive", action="store_true", help="archive actions report ok: false")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    hub = Hub(args)
    Handler.hub = hub
    Handler.token = args.token or secrets.token_urlsafe(24)
    Handler.port = args.port
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    if not args.quiet:
        threading.Thread(target=ticker, args=(hub,), daemon=True).start()
    print(f"Fake Chief of Staff server on http://127.0.0.1:{args.port}/#{Handler.token}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
