import contextlib
import datetime as dt
import io
import json
import time
import unittest

from helpers import Sandbox

from cos import config, paths
from cos.notices import Notices, merge
from cos.server import App

CHIEF = "local_9999aaaa-0000-4000-8000-000000000007"


def s(sid, state, **kw):
    return dict({"id": sid, "title": sid.upper(), "state": state, "stateReason": "", "isChief": False,
                 "needsAction": None, "summary": None, "inView": True, "prState": None}, **kw)


class Settings(unittest.TestCase):
    def test_name_wake_ack_and_fillers(self):
        got = config.load({"chief_name": "Jarvis <b>[x]</b>; rm", "wake_word": "Hey  JARVIS!", "wake_ack": "beep",
                           "fillers": "false"}, env={})
        self.assertEqual(got["chiefName"], "Jarvis b x b rm")
        self.assertEqual(got["wakeWord"], "hey jarvis")
        self.assertEqual(got["wakeAck"], "chime")          # not one of the choices: the default
        self.assertIs(got["fillers"], False)
        self.assertEqual(config.load({"chief_name": "<>"}, env={})["chiefName"], "Chief")
        self.assertEqual(len(config.load({"chief_name": "a" * 99}, env={})["chiefName"]), 30)
        self.assertEqual(config.load({"wake_ack": "word"}, env={})["wakeAck"], "word")


class VoiceJobs(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().__enter__()
        self.app = App("tok", 1, voice_enabled=False, write_state=True)
        self.app.voice.installed = True
        self.app.voice.status["state"] = "listening"
        self.app.reader.refresh_files()
        self.app.reader.refresh_live()
        self.app.rebuild()
        self.app.mod_hello({"cliId": "cli-wait", "isChief": True, "options": {"chief_name": "Friday"}})

    def tearDown(self):
        self.box.__exit__(None, None, None)

    def jobs(self):
        return self.app.voice_jobs_poll({"wait": "0"})["jobs"]

    def test_health_names_the_chief_and_its_wake_word(self):
        self.assertEqual(self.app.health()["settings"], {"chiefName": "Friday", "wakeWord": "hey chief"})

    def test_the_daemon_gets_its_settings_on_its_first_poll_and_after_a_change(self):
        first = self.jobs()
        self.assertEqual(len(first), 1)
        self.assertEqual({k: first[0][k] for k in ("kind", "wakeWord", "wakeAck", "fillers", "chiefName")},
                         {"kind": "control", "wakeWord": "hey chief", "wakeAck": "chime", "fillers": True,
                          "chiefName": "Friday"})
        self.assertEqual(self.jobs(), [])
        self.app.mod_hello({"cliId": "cli-wait", "isChief": True, "options": {"chief_name": "Friday"}})
        self.assertEqual(self.jobs(), [])                  # nothing changed
        self.app.mod_hello({"cliId": "cli-wait", "isChief": True,
                            "options": {"chief_name": "Friday", "wake_word": "hey friday", "wake_ack": "word"}})
        changed = self.jobs()
        self.assertEqual([(j["kind"], j["wakeWord"], j["wakeAck"]) for j in changed], [("control", "hey friday", "word")])

    def test_a_spoken_request_gets_a_quick_acknowledgment(self):
        self.jobs()
        self.app.voice_event({"type": "final", "text": "what needs me"})
        self.assertEqual([j["kind"] for j in self.jobs()], ["ack"])
        self.app.say({"text": "typed", "source": "typed"})        # speak is on
        self.assertEqual([j["kind"] for j in self.jobs()], ["ack"])
        self.app.voice_control({"speak": False})
        self.jobs()
        self.app.say({"text": "typed", "source": "typed"})        # speak off: typed gets none
        self.assertEqual(self.jobs(), [])
        self.app.voice_event({"type": "final", "text": "spoken"})  # spoken still does
        self.assertEqual([j["kind"] for j in self.jobs()], ["ack"])
        self.app.settings["fillers"] = False
        self.app.voice_event({"type": "final", "text": "spoken"})
        self.assertEqual(self.jobs(), [])

    def test_no_acknowledgment_without_a_voice(self):
        self.jobs()
        self.app.voice.installed = False
        self.app.voice.status["state"] = "not-installed"
        self.app.voice_event({"type": "final", "text": "what needs me"})
        self.assertEqual(self.jobs(), [])

    def test_a_barge_drops_what_waits_to_be_said(self):
        self.jobs()
        self.app.mod_reply({"text": "First reply.", "turnId": "t1"})
        self.app.mod_reply({"text": "Second reply.", "turnId": "t2"})
        self.app.voice_event({"type": "barge"})
        self.assertEqual(self.jobs(), [])

    def test_near_misses_go_to_the_log_only(self):
        q, _ = self.app.hub.subscribe()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(self.app.voice_event({"type": "nearMiss", "score": 0.41}), {"ok": True})
        self.assertIn('"nearMiss"', err.getvalue())
        self.assertIn("0.41", err.getvalue())
        self.assertTrue(q.empty())

    def test_listen_and_speak_toggles_survive_a_restart(self):
        self.app.voice_control({"listen": "ptt", "speak": False})
        saved = json.loads((paths.run_dir() / "voice-state.json").read_text(encoding="utf-8"))
        self.assertEqual(saved, {"listen": "ptt", "speak": False})
        again = App("tok", 1, voice_enabled=False, write_state=True)
        self.assertEqual((again.voice.status["listen"], again.voice.status["speak"]), ("ptt", False))
        # A new Chief's settings do not undo the console's own choice.
        again.reader.refresh_files()
        again.mod_hello({"cliId": "cli-wait", "isChief": True, "options": {"listen": "wake", "speak_replies": True}})
        self.assertEqual((again.voice.status["listen"], again.voice.status["speak"]), ("ptt", False))


class NoticeBatches(unittest.TestCase):
    def test_one_line_per_session_with_its_latest_state(self):
        a1 = {"id": "1", "sessionId": "a", "kind": "done", "_prompt": "a done"}
        b1 = {"id": "2", "sessionId": "b", "kind": "you", "_prompt": "b you"}
        a2 = {"id": "3", "sessionId": "a", "kind": "you", "_prompt": "a you"}
        b2 = {"id": "4", "sessionId": "b", "kind": "done", "_prompt": "b done"}
        stale = {"id": "5", "sessionId": None, "kind": "stale", "_prompt": "stale"}
        self.assertEqual([n["_prompt"] for n in merge([a1, b1, a2, b2, stale])], ["a you", "b you", "stale"])

    def test_waiting_on_jay_is_said_once_per_session_per_ten_minutes(self):
        clock = [1000.0]
        n = Notices(clock=lambda: clock[0])
        n.observe([s("a", "wait")])
        self.assertEqual([x["kind"] for x in n.observe([s("a", "you")])], ["you"])
        n.observe([s("a", "active")])
        clock[0] += 60
        self.assertEqual(n.observe([s("a", "you")]), [])           # again within 10 minutes: quiet
        n.observe([s("a", "wait")])
        clock[0] += 600
        self.assertEqual([x["kind"] for x in n.observe([s("a", "you")])], ["you"])

    def test_the_batch_today_jay_got_reads_as_one_line(self):
        clock = [1000.0]
        n = Notices(clock=lambda: clock[0])
        n.observe([s("a", "active")])
        for states in (["you"], ["active"], ["you"], ["wait"]):
            for x in n.observe([s("a", states[0])]):
                n.queue(x, 0)
        text = n.due(30, chief_connected=True, chief_busy=False, notify_on=True, quiet="", local_minutes=600)
        self.assertEqual(text.count("session a "), 1)
        self.assertIn("changed to waiting on Jay", text)
        self.assertNotIn("finished its turn", text)

    def test_the_daily_stale_notice_survives_a_restart(self):
        with Sandbox():
            path = paths.run_dir() / "notices.json"
            n = Notices(path)
            sessions = [s("a", "stale")]
            self.assertIsNotNone(n.stale_digest(sessions, dt.datetime(2026, 10, 17, 9, 30)))
            again = Notices(path)
            self.assertIsNone(again.stale_digest(sessions, dt.datetime(2026, 10, 17, 14, 0)))
            self.assertIsNotNone(again.stale_digest(sessions, dt.datetime(2026, 10, 18, 9, 30)))

    def test_the_ten_minute_memory_survives_a_restart(self):
        with Sandbox():
            path = paths.run_dir() / "notices.json"
            now = time.time()
            n = Notices(path, clock=lambda: now)
            n.observe([s("a", "wait")])
            n.observe([s("a", "you")])
            again = Notices(path, clock=lambda: now + 60)
            again.observe([s("a", "wait")])
            self.assertEqual(again.observe([s("a", "you")]), [])


if __name__ == "__main__":
    unittest.main()
