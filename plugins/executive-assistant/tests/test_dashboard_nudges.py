"""Tests for dashboard/nudges.py. Run: python -m unittest discover -s plugins/executive-assistant/tests"""
import base64
import datetime as dt
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dashboard"))
import nudges  # noqa: E402

TUE = dt.date(2026, 10, 13)       # a Tuesday
SAT = dt.date(2026, 10, 17)
PROFILE = {"start": "06:30", "stop": "15:00", "shutdown_reminder_min": 30}
EVENTS = [
    {"id": "evt-queue", "start": "10:00", "end": "10:30", "title": "Support queue review",
     "kind": "meet", "attendees": 3},
    {"id": "evt-1on1", "start": "13:15", "end": "13:45", "title": "1:1 with Nick", "kind": "meet",
     "attendees": 2},
    {"id": "evt-solo", "start": "11:05", "end": "11:20", "title": "Dentist call", "kind": "meet",
     "attendees": 1},
    {"id": "evt-focus", "start": "08:00", "end": "09:00", "title": "[Focus] Deep work", "kind": "focus",
     "attendees": 1, "ours": True},
    {"id": "evt-declined", "start": "12:00", "end": "12:30", "title": "Vendor pitch", "kind": "meet",
     "attendees": 4, "response": "declined"},
]
BRIEF = {"date": "2026-10-13"}


def at(hm, day=TUE, sec=0):
    h, m = map(int, hm.split(":"))
    return dt.datetime.combine(day, dt.time(h, m, sec))


def due(now, events=EVENTS, focus=None, profile=PROFILE, shutdown=None, brief=BRIEF, fired=()):
    return nudges.due_nudges(now, events, focus, profile, shutdown, brief, set(fired))


def ids(out):
    return [n["id"] for n in out]


class Day:
    """Replays a day minute by minute, keeping `fired` like the Nudger does."""

    def __init__(self, **kw):
        self.kw = kw
        self.fired = set()
        self.log = []    # (minute, id)

    def run(self, start, end, day=TUE, step_s=30):
        t, stop = at(start, day), at(end, day)
        while t <= stop:
            for n in nudges.due_nudges(t, self.kw.get("events", EVENTS), self.kw.get("focus"),
                                       self.kw.get("profile", PROFILE), self.kw.get("shutdown"),
                                       self.kw.get("brief", BRIEF), self.fired):
                self.fired.add(n["id"])
                self.log.append((t.strftime("%H:%M:%S"), n["id"]))
            t += dt.timedelta(seconds=step_s)
        return self.log


class MeetingTests(unittest.TestCase):
    def test_heads_up_at_10_and_2_minutes_once_each(self):
        log = Day().run("09:40", "10:05")
        self.assertEqual(log, [("09:50:00", "meeting_10:evt-queue"), ("09:58:00", "meeting_2:evt-queue")])

    def test_not_before_ten_minutes(self):
        self.assertEqual(due(at("09:49", sec=59)), [])

    def test_text_and_shape(self):
        n = due(at("09:50"))[0]
        self.assertEqual(n, {"id": "meeting_10:evt-queue", "kind": "meeting_10", "title": "Heads-up",
                             "text": "Support queue review starts in 10 minutes.", "at": "09:50"})

    def test_started_meeting_gets_no_heads_up(self):
        self.assertEqual([i for i in ids(due(at("10:00"))) if i.startswith("meeting_")], [])
        self.assertEqual(ids(due(at("10:05"))), [])

    def test_late_start_inside_two_minutes_gives_only_the_two_minute_nudge(self):
        self.assertEqual(ids(due(at("09:59"))), ["meeting_2:evt-queue"])

    def test_focus_blocks_and_declined_meetings_are_skipped(self):
        log = Day().run("07:45", "12:40")
        self.assertFalse([i for _, i in log if "evt-focus" in i or "evt-declined" in i])

    def test_meeting_ended_one_to_three_minutes_after_with_two_or_more(self):
        log = Day().run("10:25", "10:40")
        self.assertEqual(log, [("10:31:00", "meeting_ended:evt-queue")])
        n = due(at("10:31"))[0]
        self.assertEqual(n["text"], "Anything you promised in Support queue review? Add it as a task.")
        self.assertEqual(ids(due(at("10:30", sec=59))), [])
        self.assertEqual(ids(due(at("10:34"))), [])
        self.assertIn("meeting_ended:evt-1on1", ids(due(at("13:48"))))

    def test_no_follow_up_for_a_solo_meeting(self):
        log = Day().run("11:15", "11:30")
        self.assertNotIn("meeting_ended:evt-solo", [i for _, i in log])

    def test_events_on_another_day_are_skipped(self):
        other = [dict(EVENTS[0], id="evt-wed", date="2026-10-14")]
        self.assertEqual(due(at("09:50"), events=other), [])

    def test_iso_times_work(self):
        ev = [dict(EVENTS[0], id="evt-iso", start="2026-10-13T10:00:00-04:00", end="2026-10-13T10:30")]
        self.assertEqual(ids(due(at("09:52"), events=ev)), ["meeting_10:evt-iso"])


class FocusTests(unittest.TestCase):
    SESSION = {"running": True, "session": {"task": "t-0107", "title": "Write the spec",
                                            "ends_at": "2026-10-13T10:13", "over": False}}

    def test_fires_once_when_time_is_up(self):
        log = Day(events=[], focus=self.SESSION).run("10:00", "10:30")
        self.assertEqual(log, [("10:13:00", "focus_end:t-0107:2026-10-13T10:13")])
        n = due(at("10:20"), events=[], focus=self.SESSION)[0]
        self.assertEqual(n["kind"], "focus_end")
        self.assertIn("Write the spec", n["text"])
        self.assertEqual(n["at"], "10:13")

    def test_no_session_no_nudge(self):
        self.assertEqual(due(at("10:20"), events=[], focus={"running": False, "session": None}), [])


class ShutdownTests(unittest.TestCase):
    def test_reminder_at_stop_minus_lead_once(self):
        log = Day(events=[]).run("14:00", "16:00")
        self.assertEqual(log, [("14:30:00", "shutdown_reminder:2026-10-13")])
        self.assertEqual(ids(due(at("14:29", sec=59), events=[])), [])

    def test_lead_comes_from_the_profile(self):
        prof = dict(PROFILE, shutdown_reminder_min=15)
        self.assertEqual(ids(due(at("14:44"), events=[], profile=prof)), [])
        self.assertEqual(ids(due(at("14:45"), events=[], profile=prof)), ["shutdown_reminder:2026-10-13"])

    def test_no_reminder_after_a_shutdown(self):
        self.assertEqual(due(at("14:40"), events=[], shutdown={"first_step": "x"}), [])

    def test_no_reminder_on_weekends(self):
        self.assertEqual(due(at("14:40", SAT), events=[]), [])

    def test_workdays_from_profile(self):
        prof = dict(PROFILE, workdays=["Sat"])
        self.assertEqual(ids(due(at("14:40", SAT), events=[], profile=prof)), ["shutdown_reminder:2026-10-17"])
        self.assertEqual(ids(due(at("14:40"), events=[], profile=prof)), [])

    def test_tonight_stop_at_until(self):
        shut = {"first_step": "x", "tonight": {"task": "t-0110", "until": "21:30"}}
        log = Day(events=[], shutdown=shut).run("21:00", "23:00")
        self.assertEqual(log, [("21:30:00", "tonight_stop:2026-10-13")])
        self.assertEqual(ids(due(at("22:31"), events=[], shutdown=shut)), [])
        self.assertEqual(due(at("21:40"), events=[], shutdown={"first_step": "x", "tonight": None}), [])


class BriefTests(unittest.TestCase):
    def test_no_brief_30_minutes_after_start_once(self):
        log = Day(events=[], brief=None).run("06:00", "08:00")
        self.assertEqual(log, [("07:00:00", "no_brief:2026-10-13")])
        n = due(at("07:00"), events=[], brief=None)[0]
        self.assertEqual(n["text"], "No morning brief yet. Run /morning-brief, or open the chat.")

    def test_not_when_a_brief_exists_or_on_weekends(self):
        self.assertEqual(due(at("07:10"), events=[], brief=BRIEF), [])
        self.assertEqual(due(at("07:10", SAT), events=[], brief=None), [])


class IdTests(unittest.TestCase):
    def test_ids_are_stable_and_fired_ids_are_skipped(self):
        a = ids(due(at("09:51")))
        b = ids(due(at("09:53")))
        self.assertEqual(a, b)
        self.assertEqual(due(at("09:53"), fired=a), [])

    def test_fired_set_is_not_mutated(self):
        fired = {"x"}
        nudges.due_nudges(at("09:51"), EVENTS, None, PROFILE, None, BRIEF, fired)
        self.assertEqual(fired, {"x"})


class NudgerTests(unittest.TestCase):
    def make(self, clock, inputs=None, toasts=True):
        self.toasts, self.delivered = [], []
        self.now = clock
        return nudges.Nudger(lambda: inputs or {"events": EVENTS, "profile": PROFILE, "brief_today": BRIEF},
                             deliver=self.delivered.append, toasts=toasts, clock=lambda: self.now,
                             toast=lambda t, x: self.toasts.append((t, x)))

    def test_tick_delivers_once_queues_and_dismisses(self):
        n = self.make(at("09:50"))
        self.assertEqual(ids(n.tick()), ["meeting_10:evt-queue"])
        self.assertEqual(n.tick(), [])
        self.assertEqual(ids(self.delivered), ["meeting_10:evt-queue"])
        self.assertEqual(self.toasts, [("Heads-up", "Support queue review starts in 10 minutes.")])
        self.assertEqual(ids(n.pending()), ["meeting_10:evt-queue"])
        self.assertTrue(n.dismiss("meeting_10:evt-queue"))
        self.assertEqual(n.pending(), [])
        self.assertFalse(n.dismiss("nope"))

    def test_toasts_off(self):
        n = self.make(at("09:50"), toasts=False)
        n.tick()
        self.assertEqual(self.toasts, [])
        self.assertEqual(len(self.delivered), 1)

    def test_fired_resets_each_day(self):
        n = self.make(at("09:50"))
        n.tick()
        self.now = at("09:50", TUE + dt.timedelta(days=1))
        self.assertEqual(ids(n.tick()), ["meeting_10:evt-queue"])

    def test_bad_inputs_do_not_raise(self):
        n = nudges.Nudger(lambda: 1 / 0, clock=lambda: at("09:50"), toast=lambda t, x: None)
        with self.assertLogs("daydesk.nudges", level="ERROR"):
            self.assertEqual(n.tick(), [])


class ToastTests(unittest.TestCase):
    def test_no_op_off_windows(self):
        with mock.patch.object(nudges.sys, "platform", "linux"), \
                mock.patch.object(nudges.subprocess, "run") as run:
            self.assertFalse(nudges.send_toast("a", "b"))
            run.assert_not_called()

    def test_windows_call_is_hidden_bounded_and_escaped(self):
        with mock.patch.object(nudges.sys, "platform", "win32"), \
                mock.patch.object(nudges.subprocess, "run") as run:
            self.assertTrue(nudges.send_toast("Heads-up", "Bob's <review> & more"))
        argv = run.call_args.args[0]
        kw = run.call_args.kwargs
        self.assertEqual(argv[0], "powershell.exe")
        self.assertIn("-NonInteractive", argv)
        self.assertEqual(argv[argv.index("-WindowStyle") + 1], "Hidden")
        self.assertLessEqual(kw["timeout"], 5)
        script = base64.b64decode(argv[argv.index("-EncodedCommand") + 1]).decode("utf-16-le")
        self.assertIn("Bob''s &lt;review&gt; &amp; more", script)
        self.assertIn("Windows.UI.Notifications", script)

    def test_errors_and_timeouts_are_swallowed(self):
        with mock.patch.object(nudges.sys, "platform", "win32"), \
                mock.patch.object(nudges.subprocess, "run",
                                  side_effect=nudges.subprocess.TimeoutExpired("powershell.exe", 5)):
            self.assertFalse(nudges.send_toast("a", "b"))
        with mock.patch.object(nudges.sys, "platform", "win32"), \
                mock.patch.object(nudges.subprocess, "run", side_effect=OSError("missing")):
            self.assertFalse(nudges.send_toast("a", "b"))


if __name__ == "__main__":
    unittest.main()
