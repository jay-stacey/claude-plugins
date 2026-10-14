"""Tests for scripts/session_context.py. Run: python -m unittest discover -s plugins/executive-assistant/tests"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import session_context  # noqa: E402
import tasks  # noqa: E402

NOW = "2026-10-13T09:48"   # a Tuesday
TODAY = "2026-10-13"


class HookCase(unittest.TestCase):
    MEET = {"id": "e1", "start": "10:00", "end": "10:30", "title": "Support queue review", "kind": "meet"}

    def setUp(self):
        self.vault = Path(tempfile.mkdtemp(prefix="ea-session-"))
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for key in ("CLAUDE_PLUGIN_OPTION_SESSION_CONTEXT", "CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"):
            os.environ.pop(key, None)
        os.environ["EA_SETTINGS_FILE"] = str(self.vault / "no-settings.json")

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.vault, ignore_errors=True)

    def task(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = tasks.main(["--vault", str(self.vault), "--now", NOW, *argv])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, 0, out)
        return out

    def seed_tasks(self):
        # Filler first so the Now task and the parked task get distinct, non-trivial ids.
        self.task("add", "--title", "Filler one", "--list", "later")
        self.task("add", "--title", "Filler two", "--list", "later")
        now_task = self.task("add", "--title", "Review the CSV export PR", "--list", "now",
                             "--next-step", "open the PR and read the description")["task"]
        parked = self.task("add", "--title", "Fix the sort bug", "--list", "today")["task"]
        self.task("park", parked["id"], "--next", "rerun the sort test")
        return now_task, parked

    def seed_brief(self, events):
        folder = self.vault / ".assistant" / "brief"
        folder.mkdir(parents=True, exist_ok=True)
        brief = {"date": TODAY, "calendar": {"days": [{"date": TODAY, "events": events}]}}
        (folder / f"{TODAY}.json").write_text(json.dumps(brief), encoding="utf-8")

    def seed_focus(self, ends_at):
        state = self.vault / ".assistant"
        state.mkdir(parents=True, exist_ok=True)
        (state / "focus.json").write_text(json.dumps(
            {"task": "t-0003", "title": "Review", "started_at": "2026-10-13T09:50", "minutes": 25,
             "ends_at": ends_at}), encoding="utf-8")

    def run_hook(self, enabled="true"):
        argv = ["--now", NOW, "--vault", str(self.vault)]
        if enabled is not None:
            argv += ["--enabled", enabled]
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = session_context.main(argv)
        self.assertEqual(code, 0)
        text = buf.getvalue()
        if not text:
            return None
        return json.loads(text)["hookSpecificOutput"]


class OutputTests(HookCase):
    def test_disabled_prints_nothing(self):
        self.seed_tasks()
        self.assertIsNone(self.run_hook(enabled="false"))
        self.assertIsNone(self.run_hook(enabled=None))

    def test_enabled_prints_three_lines_under_400_chars(self):
        now_task, _ = self.seed_tasks()
        self.seed_brief([self.MEET])
        self.seed_focus("2026-10-13T10:15")
        out = self.run_hook()
        self.assertEqual(out["hookEventName"], "SessionStart")
        text = out["additionalContext"]
        lines = text.split("\n")
        self.assertEqual(len(lines), 4, text)  # three context lines plus the instruction
        self.assertTrue(lines[0].startswith("Day plan (executive-assistant): Now task is "), text)
        self.assertIn('"Review the CSV export PR" (%s)' % now_task["id"], lines[0])
        self.assertIn("Next step: open the PR and read the description", lines[0])
        self.assertEqual(lines[1], "Next meeting: Support queue review at 10:00, in 12 minutes.")
        self.assertEqual(lines[2], "Focus timer running until 10:15. 1 task parked.")
        self.assertEqual(lines[3], session_context.INSTRUCTION)
        self.assertLess(len(text), 400)

    def test_env_vars_work_when_args_are_unreplaced_placeholders(self):
        self.seed_tasks()
        os.environ["CLAUDE_PLUGIN_OPTION_SESSION_CONTEXT"] = "yes"
        os.environ["CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH"] = str(self.vault)
        buf = io.StringIO()
        with redirect_stdout(buf):
            session_context.main(["--now", NOW, "--vault", "${user_config.notes_vault_path}",
                                  "--enabled", "${user_config.session_context}"])
        self.assertIn("Now task is", buf.getvalue())

    def test_far_meeting_shows_only_the_time(self):
        self.seed_brief([dict(self.MEET, start="13:00")])
        first = self.run_hook()["additionalContext"].split("\n")[0]
        self.assertIn("Next meeting: Support queue review at 13:00.", first)


class SkipTests(HookCase):
    def test_past_meeting_is_skipped_and_next_one_wins(self):
        self.seed_brief([dict(self.MEET, id="e7", start="09:00", title="Old standup"),
                         dict(self.MEET, id="e8", start="11:30", title="Late sync"),
                         dict(self.MEET, id="e9", start="10:20", title="Mid sync")])
        text = self.run_hook()["additionalContext"]
        self.assertNotIn("Old standup", text)
        self.assertIn("Next meeting: Mid sync at 10:20, in 32 minutes.", text)

    def test_only_past_meeting_means_no_meeting_line(self):
        self.seed_tasks()
        self.seed_brief([dict(self.MEET, start="09:00")])
        self.assertNotIn("Next meeting", self.run_hook()["additionalContext"])

    def test_non_meet_events_are_skipped(self):
        self.seed_brief([dict(self.MEET, kind="focus", start="10:00")])
        self.assertIsNone(self.run_hook())

    def test_expired_focus_is_skipped(self):
        self.seed_tasks()
        self.seed_focus("2026-10-13T09:40")
        text = self.run_hook()["additionalContext"]
        self.assertNotIn("Focus timer", text)
        self.assertIn("1 task parked.", text)


class FailSafeTests(HookCase):
    def test_broken_brief_still_prints_task_line(self):
        now_task, _ = self.seed_tasks()
        folder = self.vault / ".assistant" / "brief"
        folder.mkdir(parents=True)
        (folder / f"{TODAY}.json").write_text("{not json", encoding="utf-8")
        text = self.run_hook()["additionalContext"]
        self.assertIn(now_task["id"], text)
        self.assertNotIn("Next meeting", text)

    def test_missing_vault_is_silent(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = session_context.main(["--now", NOW, "--enabled", "true",
                                         "--vault", str(self.vault / "does-not-exist")])
        self.assertEqual(code, 0)
        self.assertEqual(buf.getvalue(), "")

    def test_nothing_to_say_is_silent(self):
        self.assertIsNone(self.run_hook())

    def test_crash_inside_is_swallowed(self):
        with mock.patch.object(session_context, "build", side_effect=RuntimeError("boom")):
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = session_context.main(["--now", NOW, "--enabled", "true", "--vault", str(self.vault)])
        self.assertEqual(code, 0)
        self.assertEqual(buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
