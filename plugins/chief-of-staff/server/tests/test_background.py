import json
import time
import unittest

from helpers import FIXTURE_NOW, FIXTURES, Sandbox
from make_fixtures import background_rows

from cos.server import App
from cos.sessions import classify
from cos.transcripts import BackgroundWork

BG = FIXTURES / "projects" / "C--work-dp-web-ui" / "cli-bg.jsonl"
CHIEF_LIKE = "local_9999aaaa-0000-4000-8000-000000000007"     # live, idle, app note "completed"
H = 3_600_000


class Scan(unittest.TestCase):
    def test_only_unfinished_background_work_stays_open(self):
        # bg1 (notified), bg3 (queued notice by task id), bg4 (failed start), bg5 (hand-back)
        # and bg6 (stopped) are done; only bg2 runs on.
        work = BackgroundWork(BG)
        self.assertEqual(work.poll(), [FIXTURE_NOW - 300000])
        self.assertEqual(list(work.open), ["tu_bg2"])
        self.assertEqual(work.open["tu_bg2"]["taskId"], "b2")

    def test_a_later_notification_closes_it(self):
        with Sandbox() as box:
            path = box.dir / "bg.jsonl"
            path.write_bytes(BG.read_bytes())
            work = BackgroundWork(path)
            self.assertEqual(len(work.poll()), 1)
            note = {"type": "user", "uuid": "z", "origin": {"kind": "task-notification"},
                    "message": {"content": "<task-notification>\n<task-id>b2</task-id>\n"
                                           "<status>completed</status>\n</task-notification>"}}
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(note) + "\n")
            self.assertEqual(work.poll(), [])

    def test_bad_rows_never_raise(self):
        work = BackgroundWork(BG)
        for row in (None, 3, {"type": "assistant", "message": {"content": [None, {"type": "tool_use"}]}},
                    {"type": "queue-operation", "content": 5}, {"type": "user", "origin": {"kind": "peer"}}):
            work.read_row(row)


class States(unittest.TestCase):
    def session(self, **kw):
        return dict({"live": True, "liveStatus": "idle", "kind": "cli", "appStatus": "review_ready",
                     "lastActivityAt": FIXTURE_NOW - 60000}, **kw)

    def test_open_background_work_makes_a_live_session_active(self):
        s = self.session(_background=[FIXTURE_NOW - 5 * 60000])
        self.assertEqual(classify(s, FIXTURE_NOW, 24), ("active", "Running background work"))
        s = self.session(_background=[FIXTURE_NOW - 5 * 60000], needsAction="Pick one", appStatus="blocked")
        self.assertEqual(classify(s, FIXTURE_NOW, 24)[0], "active")

    def test_finished_or_old_work_leaves_the_normal_rules(self):
        self.assertEqual(classify(self.session(_background=[]), FIXTURE_NOW, 24), ("you", "Ready for your review"))
        old = self.session(_background=[FIXTURE_NOW - 2 * H - 1000])
        self.assertEqual(classify(old, FIXTURE_NOW, 24), ("you", "Ready for your review"))
        stopped = self.session(live=False, liveStatus=None, _background=[FIXTURE_NOW - 60000])
        self.assertEqual(classify(stopped, FIXTURE_NOW, 24)[0], "you")

    def test_a_live_prompt_still_wins(self):
        s = self.session(liveStatus="waiting", waitingFor="permission prompt", _background=[FIXTURE_NOW])
        self.assertEqual(classify(s, FIXTURE_NOW, 24), ("you", "Waiting for a permission prompt"))


class Server(unittest.TestCase):
    def test_the_pulse_finds_background_work_in_a_live_session(self):
        with Sandbox() as box:
            now = int(time.time() * 1000)
            path = box.dir / "projects" / "C--work-dp-web-ui" / "cli-wait.jsonl"
            path.write_text("".join(json.dumps(r) + "\n" for r in background_rows(now)), encoding="utf-8")
            app = App("tok", 1, voice_enabled=False, write_state=False)
            app.reader.transcripts.every_s = 0          # see the new transcript at once
            app.reader.refresh_files()
            app.reader.refresh_live()
            app.rebuild()
            self.assertEqual(app.reader.get(CHIEF_LIKE)["state"], "wait")
            app.pulse()
            app.rebuild()
            s = app.reader.get(CHIEF_LIKE)
            self.assertEqual((s["state"], s["stateReason"]), ("active", "Running background work"))
            self.assertNotIn("_background", s)
            # The work finishes: back to the normal rules.
            note = {"type": "user", "uuid": "z", "origin": {"kind": "task-notification"},
                    "message": {"content": "<task-notification><tool-use-id>tu_bg2</tool-use-id>"
                                           "<status>completed</status></task-notification>"}}
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(note) + "\n")
            app.pulse()
            self.assertIsNone(app.reader.background.get("cli-wait"))
            app.reader.grew.pop("cli-wait", None)        # as if the 30 s growth window had passed
            app.rebuild()
            self.assertEqual(app.reader.get(CHIEF_LIKE)["state"], "wait")


if __name__ == "__main__":
    unittest.main()
