import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

from helpers import SERVER, Sandbox

from cos import paths
from cos.server import App, HttpError
from cos.sessions import AgentsSource

AAA = "local_aaaa1111-0000-4000-8000-000000000001"
BBB = "local_bbbb2222-0000-4000-8000-000000000002"
APP = SERVER / "app.py"


class FakeClock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def events(q, name):
    out = []
    while not q.empty():
        e = q.get_nowait()
        if e[1] == name:
            out.append(json.loads(e[2]))
    return out


class AppState(unittest.TestCase):
    """App logic without HTTP or background loops."""

    def setUp(self):
        self.box = Sandbox().__enter__()
        self.app = App("tok", 1, voice_enabled=False, write_state=False)
        self.clock = FakeClock()
        self.app.clock = self.clock
        self.app.reader.refresh_files()
        self.app.reader.refresh_live()
        self.app.rebuild()
        self.app.chief.update(sessionId="local_9999aaaa-0000-4000-8000-000000000007", cliId="cli-wait")
        self.app.chief_poll_at = time.time()

    def tearDown(self):
        self.box.__exit__(None, None, None)

    def set_status(self, advance=5, **status_by_cli):
        rows = [dict(r) for r in self.box.agents_rows]
        for r in rows:
            if r["sessionId"] in status_by_cli:
                r["status"] = status_by_cli[r["sessionId"]]
                r.pop("waitingFor", None)
        self.box.write_agents(rows)
        self.app.reader.refresh_live()
        self.clock.now += advance
        self.app.rebuild()

    def test_archive_asks_first_when_a_child_session_is_active(self):
        self.set_status(**{"cli-busy": "idle", "cli-child": "busy"})
        with self.assertRaises(HttpError) as err:
            self.app.archive(AAA, {})
        self.assertEqual(err.exception.status, 409)
        self.assertTrue(err.exception.extra["needsConfirm"])
        self.assertIn("helper session", err.exception.extra["reason"])
        out = self.app.archive(AAA, {"confirmed": True})
        item = self.app.inbox.pending()[-1]
        self.assertEqual((item["id"], item["confirmed"]), (out["actionId"], True))
        self.app.archive(BBB, {})
        self.assertIs(self.app.inbox.pending()[-1]["confirmed"], False)

    def test_an_item_the_mod_never_acknowledges_goes_back_once_a_minute(self):
        said = self.app.say({"text": "hello"})
        items = self.app.mod_inbox({"wait": "0", "cli": "cli-wait"})["items"]
        self.assertEqual([i["id"] for i in items], [said["id"]])
        self.clock.now += 30
        self.app.sweep_inbox()
        self.assertEqual(self.app.inbox.pending(), [])
        self.clock.now += 31
        self.app.sweep_inbox()
        self.assertEqual([i["id"] for i in self.app.inbox.pending()], [said["id"]])
        again = self.app.mod_inbox({"wait": "0", "cli": "cli-wait"})["items"]
        q, _ = self.app.hub.subscribe()
        self.app.mod_result({"actionId": again[0]["id"], "ok": True})
        self.assertEqual(events(q, "action"), [])        # a prompt's ack is no action event
        self.clock.now += 120
        self.app.sweep_inbox()
        self.assertEqual(self.app.inbox.pending(), [])

    def test_an_item_is_given_up_after_three_deliveries(self):
        out = self.app.reply(BBB, {"text": "Go ahead."})
        q, _ = self.app.hub.subscribe()
        for _ in range(3):
            self.app.mod_inbox({"wait": "0", "cli": "cli-wait"})
            self.clock.now += 61
            self.app.sweep_inbox()
        self.assertEqual(self.app.inbox.pending(), [])
        self.assertEqual(events(q, "action"), [{"actionId": out["actionId"], "ok": False,
                                                "detail": "The Chief did not confirm it after three tries."}])

    def test_an_archive_nobody_runs_within_two_minutes_is_reported_as_not_done(self):
        out = self.app.archive(BBB, {})
        q, _ = self.app.hub.subscribe()
        self.clock.now += 121
        self.app.sweep_inbox()
        self.assertEqual(self.app.inbox.pending(), [])
        got = events(q, "action")
        self.assertEqual([(e["actionId"], e["ok"]) for e in got], [(out["actionId"], False)])
        # Taken by the mod but never run: also given up after two minutes.
        out = self.app.archive(BBB, {})
        self.app.mod_inbox({"wait": "0", "cli": "cli-wait"})
        self.clock.now += 121
        self.app.sweep_inbox()
        self.assertEqual([(e["actionId"], e["ok"]) for e in events(q, "action")], [(out["actionId"], False)])
        self.assertEqual(self.app.inbox.pending(), [])

    def test_sessions_events_at_most_every_two_seconds(self):
        q, _ = self.app.hub.subscribe()
        self.set_status(**{"cli-busy": "idle"})                # a change: sent
        self.set_status(advance=0.5, **{"cli-busy": "busy"})   # half a second later: held back
        self.assertEqual(len(events(q, "sessions")), 1)
        self.clock.now += 0.5
        self.assertFalse(self.app.flush_sessions())             # still inside 2 s
        self.clock.now += 1.5
        self.assertTrue(self.app.flush_sessions())
        sent = events(q, "sessions")
        self.assertEqual(len(sent), 1)
        busy = next(x for x in sent[0]["sessions"] if x["id"] == AAA)
        self.assertEqual(busy["state"], "active")              # the held-back change, not an old one
        self.assertFalse(self.app.flush_sessions())

    def test_agents_poll_every_5_seconds_with_a_client_or_chief_else_20(self):
        self.assertEqual(self.app.live_interval(), 5)       # the Chief is connected
        self.app.chief.update(sessionId=None, cliId=None)
        self.assertEqual(self.app.live_interval(), 20)
        q, _ = self.app.hub.subscribe()
        self.assertEqual(self.app.live_interval(), 5)
        self.app.hub.unsubscribe(q)
        calls = []
        self.app.reader.agents.run = lambda: calls.append(1) or self.box.agents_rows
        self.app.last_live_at = self.clock.now
        self.clock.now += 19
        self.assertFalse(self.app.tick_live())
        self.clock.now += 1
        self.assertTrue(self.app.tick_live())
        self.assertEqual(len(calls), 1)

    def test_agents_never_runs_twice_at_once(self):
        source = AgentsSource()
        started, release, calls = threading.Event(), threading.Event(), []

        def slow():
            calls.append(1)
            started.set()
            release.wait(5)
            return []
        source.run = slow
        t = threading.Thread(target=source.poll)
        t.start()
        started.wait(5)
        source.rows = [{"sessionId": "last"}]
        self.assertEqual(source.poll(), [{"sessionId": "last"}])   # returns at once, no second run
        release.set()
        t.join(5)
        self.assertEqual(len(calls), 1)


def run_app(*args, env=None):
    out = subprocess.run([sys.executable, str(APP), *args], capture_output=True, text=True, timeout=60, env=env)
    return json.loads(out.stdout.strip().splitlines()[-1])


class Lifecycle(unittest.TestCase):
    def test_two_starts_at_once_make_one_server(self):
        with Sandbox() as box:
            results = []
            port = 47960 + os.getpid() % 30
            threads = [threading.Thread(target=lambda: results.append(run_app("start", "--port", str(port))))
                       for _ in range(2)]
            try:
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(60)
                self.assertEqual(len(results), 2, results)
                self.assertEqual(len({r["pid"] for r in results}), 1, results)
                self.assertEqual(sorted(r["already_running"] for r in results), [False, True])
                self.assertFalse((box.dir / "home" / "run" / "start.lock").exists())
            finally:
                self.assertTrue(run_app("stop")["stopped"])

    def test_stop_keeps_server_json_when_the_pid_is_not_our_server(self):
        with Sandbox() as box:
            other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            try:
                info = {"api": 1, "port": 1, "pid": other.pid, "token": "x", "url": "http://127.0.0.1:1/#x"}
                path = box.dir / "home" / "run" / "server.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(info), encoding="utf-8")
                out = run_app("stop")
                self.assertFalse(out["stopped"])
                self.assertTrue(path.exists())
                self.assertIsNone(other.poll())                  # the other process lives on
            finally:
                other.kill()
                other.wait(10)

    def test_open_never_puts_the_token_on_a_command_line(self):
        with Sandbox():
            import app
            opened = []
            if os.name != "nt":
                self.skipTest("Windows opens the console with os.startfile")
            with mock.patch.object(app.os, "startfile", side_effect=opened.append):
                self.assertTrue(app.open_url("http://127.0.0.1:47870/#secret-token"))
            self.assertEqual(len(opened), 1)
            self.assertNotIn("secret-token", opened[0])
            self.assertTrue(opened[0].startswith("file:"))
            page = (paths.run_dir() / "open.html").read_text(encoding="utf-8")
            self.assertIn("url=http://127.0.0.1:47870/#secret-token", page)


if __name__ == "__main__":
    unittest.main()
