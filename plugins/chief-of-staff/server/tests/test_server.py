import http.client
import json
import socket
import threading
import time
import unittest

from helpers import Sandbox, snapshot_tree

from cos import paths
from cos.server import App, bind

AAA = "local_aaaa1111-0000-4000-8000-000000000001"
BBB = "local_bbbb2222-0000-4000-8000-000000000002"
CHIEF = "local_9999aaaa-0000-4000-8000-000000000007"
TOKEN = "test-token-123"


class Api(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().__enter__()
        self.desk_before = snapshot_tree(self.box.dir / "desktop")
        self.proj_before = snapshot_tree(self.box.dir / "projects")
        self.app = App(TOKEN, 0, voice_enabled=False)
        self.server = bind(self.app, 0)
        self.port = self.app.port
        self.app.start_loops()
        self.assertTrue(self.app.ready.wait(10))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.app.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()
        # The server only reads the desktop files and transcripts.
        self.assertEqual(self.desk_before, snapshot_tree(self.box.dir / "desktop"))
        self.assertEqual(self.proj_before, snapshot_tree(self.box.dir / "projects"))
        self.box.__exit__(None, None, None)

    def call(self, method, path, body=None, token=TOKEN, host=None, origin=None, raw=None, timeout=10):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if token:
            headers["X-COS-Token"] = token
        if origin:
            headers["Origin"] = origin
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        res = conn.getresponse()
        text = res.read().decode("utf-8")
        conn.close()
        try:
            return res.status, json.loads(text)
        except ValueError:
            return res.status, text

    def hello(self, cli="cli-wait"):
        return self.call("POST", "/api/mod/hello", {"cliId": cli, "isChief": True, "options": {"stale_hours": 24}})

    # --- security
    def test_health_needs_no_token_and_the_rest_do(self):
        status, body = self.call("GET", "/api/health", token=None)
        self.assertEqual(status, 200)
        self.assertEqual((body["ok"], body["api"]), (True, 1))
        self.assertEqual(body["voice"]["state"], "not-installed")
        self.assertEqual(body["chief"], {"connected": False, "sessionId": None, "cliId": None, "busy": False})
        self.assertEqual(self.call("GET", "/api/sessions", token=None)[0], 401)
        self.assertEqual(self.call("GET", "/api/sessions", token="wrong")[0], 401)

    def test_host_and_origin_are_checked(self):
        self.assertEqual(self.call("GET", "/api/health", host="evil.test")[0], 403)
        self.assertEqual(self.call("GET", "/api/sessions", host=f"evil.test:{self.port}")[0], 403)
        self.assertEqual(self.call("GET", "/api/sessions", origin="http://evil.test")[0], 403)
        self.assertEqual(self.call("GET", "/api/sessions", origin=f"http://127.0.0.1:{self.port}")[0], 200)
        self.assertEqual(self.call("GET", "/api/sessions", host=f"localhost:{self.port}")[0], 200)

    def test_big_bodies_get_413(self):
        status, body = self.call("POST", "/api/chief/say", raw=b'{"text": "' + b"a" * 70000 + b'"}')
        self.assertEqual(status, 413)
        self.assertIn("error", body)

    def test_console_page_and_modules_are_served(self):
        if not (paths.CONSOLE_DIR / "index.html").exists():
            self.skipTest("the console is not in this checkout")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/", headers={"Host": f"127.0.0.1:{self.port}"})
        res = conn.getresponse()
        res.read()
        self.assertEqual(res.status, 200)
        self.assertIn("script-src 'self'", res.getheader("Content-Security-Policy"))
        self.assertIn("frame-ancestors 'none'", res.getheader("Content-Security-Policy"))
        module = next(iter(sorted(paths.CONSOLE_DIR.glob("js/*.mjs"))), None)
        if module is not None:
            conn.request("GET", f"/static/js/{module.name}", headers={"Host": f"127.0.0.1:{self.port}"})
            res = conn.getresponse()
            res.read()
            self.assertEqual((res.status, res.getheader("Content-Type")), (200, "text/javascript; charset=utf-8"))
        conn.close()

    def test_chief_event_when_the_chief_connects_and_leaves(self):
        q, _ = self.app.hub.subscribe()
        self.hello()
        self.app.chief_poll_at = 0                 # as if it stopped polling a minute ago
        self.app.tick_chief()
        events = []
        while not q.empty():
            e = q.get_nowait()
            if e[1] == "chief":
                events.append(json.loads(e[2])["connected"])
        self.assertEqual(events[0], True)
        self.assertEqual(events[-1], False)

    def test_static_files_stay_inside_the_console(self):
        self.assertIn(self.call("GET", "/static/../server/app.py", token=None)[0], (404,))
        self.assertEqual(self.call("GET", "/static/dev/fake_server.py", token=None)[0], 404)
        self.assertEqual(self.call("GET", "/static/DEV/fake_server.py", token=None)[0], 404)
        self.assertEqual(self.call("GET", "/static/Dev/fake_server.py", token=None)[0], 404)
        self.assertEqual(self.call("GET", "/api/nothing")[0], 404)

    # --- sessions
    def test_sessions_and_one_session_and_transcript(self):
        status, body = self.call("GET", "/api/sessions")
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"generatedAt", "liveStale", "counts", "countsInView", "sessions"})
        states = {s["id"]: s["state"] for s in body["sessions"]}
        self.assertEqual(states[AAA], "active")
        self.assertEqual(states[BBB], "you")
        status, one = self.call("GET", f"/api/sessions/{AAA}")
        self.assertEqual((status, one["title"]), (200, "DP1-676"))
        self.assertEqual(self.call("GET", "/api/sessions/local_nope")[0], 404)
        self.assertEqual(self.call("GET", "/api/sessions/..%2f..")[0], 404)
        status, page = self.call("GET", f"/api/sessions/{AAA}/transcript?limit=2")
        self.assertEqual([t["uuid"] for t in page["turns"]], ["u-6", "a-4"])
        self.assertEqual(page["cursor"], "u-6")

    # --- chief
    def test_say_needs_a_chief_then_queues_a_prompt(self):
        self.assertEqual(self.call("POST", "/api/chief/say", {"text": "hello"})[0], 409)
        status, hello = self.hello()
        self.assertEqual((status, hello["sessionId"]), (200, CHIEF))
        self.assertEqual(hello["settings"]["staleHours"], 24)
        info = json.loads(paths.server_json().read_text(encoding="utf-8"))
        self.assertEqual((info["chiefSessionId"], info["chiefCliId"]), (CHIEF, "cli-wait"))
        self.assertEqual(info["token"], TOKEN)
        status, said = self.call("POST", "/api/chief/say", {"text": "What needs me?", "source": "voice"})
        self.assertEqual(status, 200)
        status, inbox = self.call("GET", f"/api/mod/inbox?wait=1&session={CHIEF}&cli=cli-wait")
        self.assertEqual([{k: i[k] for k in ("id", "type", "text")} for i in inbox["items"]],
                         [{"id": said["id"], "type": "prompt", "text": "What needs me?"}])
        self.assertEqual(inbox["items"][0]["jev"]["route"], "chief")
        self.assertTrue(inbox["items"][0]["hint"].startswith("Jev suggests:"))
        chat = self.call("GET", "/api/chat")[1]["messages"]
        self.assertEqual((chat[-1]["role"], chat[-1]["source"]), ("me", "voice"))
        sessions = {s["id"]: s for s in self.call("GET", "/api/sessions")[1]["sessions"]}
        self.assertTrue(sessions[CHIEF]["isChief"])

    def test_only_the_chief_gets_inbox_items_and_a_second_chief_is_refused(self):
        self.hello()
        self.call("POST", "/api/chief/say", {"text": "one"})
        status, other = self.call("GET", f"/api/mod/inbox?wait=0&session={BBB}&cli=cli-needs")
        self.assertEqual(other, {"items": [], "isChief": False})
        # While the Chief still polls, a second session's hello is refused and told where it is.
        status, refused = self.hello("cli-needs")
        self.assertEqual(status, 409)
        self.assertTrue(refused["refused"])
        self.assertEqual(refused["chief"]["sessionId"], CHIEF)
        self.assertEqual(self.call("GET", "/api/health")[1]["chief"]["sessionId"], CHIEF)
        # Its own hello again is fine: a reload of the Chief session.
        self.assertEqual(self.hello()[0], 200)
        # Once the Chief has stopped polling for a minute, the role is free.
        with self.app.lock:
            self.app.chief_poll_at = time.time() - 120
        self.assertEqual(self.hello("cli-needs")[0], 200)
        health = self.call("GET", "/api/health")[1]
        self.assertEqual(health["chief"]["sessionId"], BBB)
        status, mine = self.call("GET", f"/api/mod/inbox?wait=1&session={BBB}&cli=cli-needs")
        self.assertEqual([i["text"] for i in mine["items"]], ["one"])

    def test_inbox_long_poll_wakes_when_an_item_arrives(self):
        self.hello()
        got = {}

        def poll():
            got["res"] = self.call("GET", f"/api/mod/inbox?wait=10&cli=cli-wait", timeout=15)

        t = threading.Thread(target=poll)
        start = time.monotonic()
        t.start()
        time.sleep(0.3)
        self.call("POST", "/api/chief/say", {"text": "wake up"})
        t.join(timeout=12)
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(got["res"][1]["items"][0]["text"], "wake up")

    def test_archive_asks_first_for_an_active_session(self):
        self.hello()
        status, body = self.call("POST", f"/api/sessions/{AAA}/archive", {"confirmed": False})
        self.assertEqual(status, 409)
        self.assertTrue(body["needsConfirm"])
        self.assertIn("working right now", body["reason"])
        status, ok = self.call("POST", f"/api/sessions/{AAA}/archive", {"confirmed": True})
        self.assertEqual(status, 200)
        status, ok2 = self.call("POST", f"/api/sessions/{BBB}/archive", {})
        self.assertEqual(status, 200)
        items = self.call("GET", "/api/mod/inbox?wait=0&cli=cli-wait")[1]["items"]
        self.assertEqual([(i["type"], i["sessionId"], i["id"]) for i in items],
                         [("archive", AAA, ok["actionId"]), ("archive", BBB, ok2["actionId"])])
        self.assertEqual(self.call("POST", f"/api/sessions/{CHIEF}/archive", {"confirmed": True})[0], 409)
        self.assertEqual(self.call("POST", "/api/sessions/bg_bg-blocked/archive", {"confirmed": True})[0], 409)

    def test_reply_is_queued_for_the_mod(self):
        self.assertEqual(self.call("POST", f"/api/sessions/{BBB}/reply", {"text": "Use vendor A."})[0], 409)
        self.hello()
        self.assertEqual(self.call("POST", f"/api/sessions/{BBB}/reply", {"text": ""})[0], 400)
        status, body = self.call("POST", f"/api/sessions/{BBB}/reply", {"text": "Use vendor A."})
        self.assertEqual(status, 200)
        items = self.call("GET", "/api/mod/inbox?wait=0&cli=cli-wait")[1]["items"]
        self.assertEqual(items, [{"id": body["actionId"], "type": "reply", "sessionId": BBB,
                                  "title": "Plan PRO-921 into engineering stories", "text": "Use vendor A."}])

    def test_mod_reply_busy_and_result(self):
        self.hello()
        status, body = self.call("POST", "/api/mod/reply", {
            "text": "Two sessions need you.", "turnId": "t1",
            "confirm": {"question": "Archive it?", "yes": "Archive anyway", "no": "Leave it running"}})
        self.assertEqual(status, 200)
        last = self.call("GET", "/api/chat")[1]["messages"][-1]
        self.assertEqual((last["role"], last["text"], last["confirm"]["yes"]),
                         ("chief", "Two sessions need you.", "Archive anyway"))
        self.assertEqual(self.call("POST", "/api/mod/busy", {"busy": True})[0], 200)
        self.assertTrue(self.call("GET", "/api/health")[1]["chief"]["busy"])
        self.assertEqual(self.call("GET", "/api/health")[1]["voice"]["state"], "thinking")
        self.assertEqual(self.call("POST", "/api/mod/result", {"actionId": "act_1", "ok": True})[0], 200)

    def test_voice_jobs_and_events(self):
        self.app.voice.installed = True
        self.app.voice.status["state"] = "listening"
        self.hello()
        self.call("POST", "/api/mod/reply", {"text": "Done.", "turnId": "t1"})
        jobs = self.call("GET", "/api/voice/jobs?wait=0")[1]["jobs"]
        # The first poll starts with the daemon's settings.
        self.assertEqual(jobs[0]["kind"], "control")
        self.assertEqual({k: jobs[0][k] for k in ("wakeWord", "wakeAck", "fillers", "chiefName")},
                         {"wakeWord": "hey chief", "wakeAck": "chime", "fillers": True, "chiefName": "Chief"})
        self.assertEqual([(j["kind"], j["text"]) for j in jobs[1:]], [("speak", "Done.")])
        status = self.call("POST", "/api/voice/control", {"speak": False, "listen": "ptt", "stop": True})[1]
        self.assertEqual((status["speak"], status["listen"]), (False, "ptt"))
        jobs = self.call("GET", "/api/voice/jobs?wait=0")[1]["jobs"]
        self.assertEqual([j["kind"] for j in jobs], ["stop", "control"])
        self.call("POST", "/api/mod/reply", {"text": "Quiet now.", "turnId": "t2"})
        self.assertEqual(self.call("GET", "/api/voice/jobs?wait=0")[1]["jobs"], [])
        self.assertEqual(self.call("POST", "/api/voice/event", {"type": "status", "status": {
            "state": "speaking", "device": "cuda", "listen": "off"}})[0], 200)
        health = self.call("GET", "/api/health")[1]["voice"]
        self.assertEqual((health["state"], health["device"], health["listen"]), ("speaking", "cuda", "ptt"))
        self.call("POST", "/api/voice/event", {"type": "final", "text": "what needs me"})
        items = self.call("GET", "/api/mod/inbox?wait=0&cli=cli-wait")[1]["items"]
        self.assertEqual(items[-1]["text"], "what needs me")
        self.assertEqual(self.call("POST", "/api/voice/event", {"type": "bogus"})[0], 400)

    def test_mic_failure_still_speaks_replies(self):
        """The mic failed on Jay's PC (MME error 32) and every reply went silent. A mic
        failure arrives as micError, so replies still make speak jobs."""
        self.app.voice.installed = True
        self.hello()
        self.call("GET", "/api/voice/jobs?wait=0")                  # the first poll's settings job
        problem = "The microphone did not open (PortAudioError). Replies are still spoken. Type to talk to the Chief."
        self.assertEqual(self.call("POST", "/api/voice/event", {"type": "status", "status": {
            "state": "listening", "micError": problem, "detail": problem}})[0], 200)
        self.call("POST", "/api/mod/reply", {"text": "Two sessions need you.", "turnId": "t1"})
        jobs = self.call("GET", "/api/voice/jobs?wait=0")[1]["jobs"]
        self.assertEqual([(j["kind"], j["text"]) for j in jobs], [("speak", "Two sessions need you.")])
        health = self.call("GET", "/api/health")[1]["voice"]
        self.assertEqual((health["state"], health["micError"], health["detail"]), ("listening", problem, problem))
        # The mic opens later: the daemon clears micError.
        self.call("POST", "/api/voice/event", {"type": "status", "status": {"state": "listening", "micError": None}})
        self.assertIsNone(self.call("GET", "/api/health")[1]["voice"]["micError"])

    def test_voice_error_still_blocks_speech(self):
        self.app.voice.installed = True
        self.hello()
        self.call("GET", "/api/voice/jobs?wait=0")
        self.call("POST", "/api/voice/event", {"type": "status", "status": {
            "state": "error", "detail": "The voice daemon did not start (OSError)."}})
        self.call("POST", "/api/mod/reply", {"text": "Nobody hears this.", "turnId": "t1"})
        self.assertEqual(self.call("GET", "/api/voice/jobs?wait=0")[1]["jobs"], [])

    # --- SSE
    def test_stream_sends_a_snapshot_then_events(self):
        self.assertEqual(self.call("GET", "/api/stream", token=None)[0], 401)
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        sock.sendall(f"GET /api/stream?k={TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
        buf = b""
        deadline = time.monotonic() + 10
        while b"event: snapshot" not in buf or b"\n\n" not in buf.split(b"event: snapshot", 1)[1]:
            buf += sock.recv(65536)
            self.assertLess(time.monotonic(), deadline)
        self.assertIn(b"text/event-stream", buf)
        snap = json.loads(buf.split(b"event: snapshot\ndata: ", 1)[1].split(b"\n\n", 1)[0])
        self.assertEqual(set(snap), {"sessions", "chat", "voice", "chief"})
        self.hello()
        self.call("POST", "/api/chief/say", {"text": "ping"})
        buf = b""
        while b"event: chat" not in buf:
            buf += sock.recv(65536)
            self.assertLess(time.monotonic(), deadline)
        self.assertIn(b"id: ", buf)
        sock.close()

    def test_activity_pulse_when_a_live_transcript_grows(self):
        q, _ = self.app.hub.subscribe()
        path = self.box.dir / "projects" / "C--work-dp-web-ui" / "cli-busy.jsonl"
        self.app.pulse()                      # starts the tail at the current end
        # Growth is simulated on a copy, so the fixture file itself stays unchanged.
        tail = self.app.tails["cli-busy"]
        copy = self.box.dir / "grow.jsonl"
        copy.write_bytes(path.read_bytes())
        tail.path, tail.offset = str(copy), copy.stat().st_size
        with open(copy, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "user", "uuid": "p-1", "isMeta": True,
                                 "origin": {"kind": "peer", "from": BBB},
                                 "message": {"content": "<cross-session-message name=\"Plan\">hi</cross-session-message>"}}) + "\n")
        self.app.pulse()                      # the pulse loop may get there first; either is fine
        acts, deadline = [], time.monotonic() + 3
        while len([a for a in acts if a.get("to") == AAA or a.get("id") == AAA]) < 2 and time.monotonic() < deadline:
            try:
                e = q.get(timeout=0.2)
            except Exception:
                continue
            if e[1] == "activity":
                acts.append(json.loads(e[2]))
        self.assertIn({"id": AAA, "kind": "pulse"}, acts)
        self.assertIn({"kind": "message", "from": BBB, "to": AAA}, acts)


if __name__ == "__main__":
    unittest.main()
