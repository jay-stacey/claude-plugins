"""Tests for scripts/tasks.py. Run: python -m unittest discover -s plugins/executive-assistant/tests"""
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import tasks  # noqa: E402

NOW = "2026-10-13T09:48"   # a Tuesday


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp(prefix="ea-tasks-"))

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def run_cli(self, *argv, now=NOW, expect=0):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = tasks.main(["--vault", str(self.vault), "--now", now, *argv])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, expect, out)
        return out

    def add(self, title, *extra):
        return self.run_cli("add", "--title", title, *extra)["task"]


class FormatTests(StoreCase):
    def test_round_trip_keeps_unknown_keys_and_body(self):
        text = ('---\nid: t-0007\ntitle: "Fix: the colon case"\nlist: today\npriority: high\n'
                'tags:\n  - release\n  - "a, b"\ncustom_key: kept\n---\nNotes here.\n- [ ] sub\n')
        fields, body = tasks.split_doc(text)
        self.assertEqual(fields["title"], "Fix: the colon case")
        self.assertEqual(fields["tags"], ["release", "a, b"])
        self.assertEqual(fields["custom_key"], "kept")
        again, body2 = tasks.split_doc(tasks.join_doc(fields, body))
        self.assertEqual(again, fields)
        self.assertEqual(body2, body)

    def test_risky_values_are_quoted(self):
        out = tasks.join_doc({"id": "t-0001", "title": "- starts like a list item", "tags": ["x,y"],
                              "first_step": "yes"}, "")
        self.assertIn('title: "- starts like a list item"', out)
        self.assertIn('tags: ["x,y"]', out)
        self.assertIn('first_step: "yes"', out)

    def test_hand_written_file_without_id_gets_id_from_name(self):
        (self.vault / "tasks").mkdir()
        (self.vault / "tasks" / "t-0042-hand-made.md").write_text("---\ntitle: Hand made\n---\n", encoding="utf-8")
        out = self.run_cli("list", "--all")
        self.assertEqual(out["tasks"][0]["id"], "t-0042")
        self.assertEqual(out["tasks"][0]["list"], "later")


class ReviewFixTaskTests(StoreCase):
    def test_number_like_values_are_quoted(self):
        out = tasks.join_doc({"id": "t-0001", "title": "2026", "first_step": "3.42", "source": "1e5",
                              "next_step": "2026 budget", "tags": ["42", "ops"]}, "")
        self.assertIn('title: "2026"', out)
        self.assertIn('first_step: "3.42"', out)
        self.assertIn('source: "1e5"', out)
        self.assertIn("next_step: 2026 budget", out)
        self.assertIn('tags: ["42", ops]', out)
        self.assertEqual(tasks.split_doc(out)[0]["title"], "2026")

    def test_cache_sees_a_same_size_rewrite_in_the_same_tick(self):
        import os
        t = self.add("same size", "--list", "later")
        path = Path(t["path"])
        store = tasks.Store(str(self.vault))
        self.assertEqual(store.load(path)["fields"]["list"], "later")
        st = path.stat()
        text = path.read_text(encoding="utf-8").replace("list: later", "list: today")
        path.write_text(text, encoding="utf-8", newline="\n")
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(path.stat().st_size, st.st_size)
        self.assertEqual(store.load(path)["fields"]["list"], "today")

    def test_cached_tasks_are_copies(self):
        t = self.add("copy me", "--list", "week")
        store = tasks.Store(str(self.vault))
        first = store.load(Path(t["path"]))
        first["fields"]["title"] = "mutated in memory"
        self.assertEqual(store.load(Path(t["path"]))["fields"]["title"], "copy me")


class ParseTests(StoreCase):
    def test_quick_add_reads_day_estimate_priority_tags(self):
        p = self.run_cli("parse", "call the bank fri 15m !high #admin")
        self.assertEqual(p["title"], "call the bank")
        self.assertEqual(p["due"], "2026-10-16")
        self.assertEqual(p["estimate"], "15m")
        self.assertEqual(p["priority"], "high")
        self.assertEqual(p["tags"], ["admin"])
        self.assertEqual(p["list"], "week")

    def test_words_that_start_like_days_stay_in_the_title(self):
        p = self.run_cli("parse", "monitor the satellite feed")
        self.assertEqual(p["title"], "monitor the satellite feed")
        self.assertNotIn("due", p)

    def test_no_day_goes_to_week_and_next_week_goes_to_later(self):
        self.assertEqual(self.run_cli("parse", "think about pricing")["list"], "week")
        self.assertEqual(self.run_cli("parse", "plan offsite mon")["list"], "later")
        self.assertEqual(self.run_cli("parse", "send summary today")["list"], "today")


class LimitTests(StoreCase):
    def test_today_holds_five_including_now(self):
        self.add("now task", "--list", "now")
        for i in range(4):
            self.add(f"today {i}", "--list", "today")
        out = self.run_cli("add", "--title", "sixth", "--list", "today")
        self.assertEqual(out["task"]["list"], "week")
        self.assertIn("full", out["note"])
        listed = self.run_cli("list")
        self.assertEqual(listed["today_used"], 5)

    def test_refused_move_to_now_changes_no_file(self):
        first = self.add("current now", "--list", "now")
        for i in range(4):
            self.add(f"today {i}", "--list", "today")
        outside = self.add("from later", "--list", "later")
        before = {p.name: p.read_bytes() for p in (self.vault / "tasks").glob("*.md")}
        err = self.run_cli("move", outside["id"], "now", expect=4)
        self.assertIn("full", err["error"])
        after = {p.name: p.read_bytes() for p in (self.vault / "tasks").glob("*.md")}
        self.assertEqual(before, after)
        self.assertEqual(self.run_cli("show", first["id"])["task"]["list"], "now")

    def test_making_a_today_task_now_demotes_the_old_one(self):
        old = self.add("old now", "--list", "now")
        new = self.add("new now", "--list", "today")
        out = self.run_cli("move", new["id"], "now")
        self.assertEqual(out["demoted"], old["id"])
        self.assertEqual(self.run_cli("show", old["id"])["task"]["list"], "today")
        self.assertEqual(self.run_cli("list", "--list", "now")["counts"]["now"], 1)

    def test_park_limit_is_three(self):
        ids = [self.add(f"t{i}", "--list", "week")["id"] for i in range(4)]
        for tid in ids[:3]:
            self.run_cli("park", tid, "--next", "pick up here")
        err = self.run_cli("park", ids[3], expect=4)
        self.assertEqual(len(err["parked"]), 3)


class FlowTests(StoreCase):
    def test_done_logs_points_and_suggests_next(self):
        now_task = self.add("ship it", "--list", "now", "--priority", "high", "--estimate", "30m")
        self.add("low thing", "--list", "today", "--priority", "low")
        nxt = self.add("high thing", "--list", "today", "--priority", "high")
        out = self.run_cli("done", now_task["id"], "--actual", "50m")
        self.assertEqual(out["points"], 3)
        self.assertEqual(out["task"]["done_at"], NOW)
        self.assertEqual(out["suggest_now"]["id"], nxt["id"])
        stats = self.run_cli("stats")
        self.assertEqual(stats["points_today"], 3)
        self.assertEqual(stats["done_today"], 1)

    def test_park_then_resume_keeps_next_step(self):
        t = self.add("deep task", "--list", "now")
        self.run_cli("park", t["id"], "--next", "rerun the purge test")
        shown = self.run_cli("show", t["id"])["task"]
        self.assertEqual(shown["list"], "today")
        self.assertEqual(shown["next_step"], "rerun the purge test")
        self.assertIn("parked_at", shown)
        back = self.run_cli("resume", t["id"])["task"]
        self.assertEqual(back["list"], "now")
        self.assertNotIn("parked_at", back)

    def test_update_refuses_stale_sha(self):
        t = self.add("edit me", "--list", "week")
        self.run_cli("update", t["id"], "--title", "edited elsewhere")
        err = self.run_cli("update", t["id"], "--title", "my edit", "--if-sha", t["sha"], expect=3)
        self.assertIn("changed on disk", err["error"])
        self.assertEqual(self.run_cli("show", t["id"])["task"]["title"], "edited elsewhere")

    def test_pushing_due_later_counts_slips(self):
        t = self.add("slippy", "--due", "2026-10-13", "--list", "today")
        self.run_cli("update", t["id"], "--due", "2026-10-14")
        self.run_cli("update", t["id"], "--title", "renamed only")
        out = self.run_cli("update", t["id"], "--due", "2026-10-16")
        self.assertEqual(out["task"]["slipped"], "2")
        self.assertNotIn("slipped", self.run_cli("update", self.add("x", "--due", "2026-10-15")["id"],
                                                 "--due", "2026-10-14")["task"])

    def test_update_can_clear_a_field_and_set_body(self):
        t = self.add("x", "--due", "2026-10-15", "--list", "week")
        out = self.run_cli("update", t["id"], "--due", "", "--notes", "line one\\nline two")
        self.assertNotIn("due", out["task"])
        self.assertEqual(self.run_cli("show", t["id"])["task"]["body"], "line one\nline two\n")

    def test_archive_moves_old_done_only(self):
        old = self.add("old", "--list", "today")
        self.run_cli("done", old["id"], now="2026-10-01T10:00")
        fresh = self.add("fresh", "--list", "today")
        self.run_cli("done", fresh["id"])
        out = self.run_cli("archive", "--days", "7")
        self.assertEqual(out["archived"], [old["id"]])
        self.assertTrue(any((self.vault / "tasks" / "archive" / "2026-10").glob(f"{old['id']}-*.md")))
        self.assertEqual(self.run_cli("show", old["id"])["task"]["list"], "done")

    def test_ids_never_reuse_archived_numbers(self):
        a = self.add("a", "--list", "today")
        self.run_cli("done", a["id"], now="2026-10-01T10:00")
        self.run_cli("archive")
        b = self.add("b")
        self.assertNotEqual(a["id"], b["id"])


class StatsTests(StoreCase):
    def day(self, date, *events):
        for e in events:
            self.run_cli("log", e, "--date", date)

    def test_streak_skips_weekends_and_off_days(self):
        self.day("2026-10-07", "brief", "shutdown")    # Wed
        self.day("2026-10-08", "off")                  # Thu, day away
        self.day("2026-10-09", "brief", "shutdown")    # Fri
        self.day("2026-10-12", "brief", "shutdown")    # Mon
        self.day("2026-10-13", "brief")                # Tue, no shutdown yet
        stats = self.run_cli("stats")
        self.assertEqual(stats["streak"], 3)
        self.assertTrue(stats["brief_done"])
        self.assertFalse(stats["shutdown_done"])
        self.day("2026-10-13", "shutdown")
        self.assertEqual(self.run_cli("stats")["streak"], 4)

    def test_missed_workday_breaks_streak(self):
        self.day("2026-10-08", "brief", "shutdown")    # Thu
        self.day("2026-10-12", "brief", "shutdown")    # Mon; Fri was missed
        self.assertEqual(self.run_cli("stats", "--date", "2026-10-12")["streak"], 1)

    def test_speed_is_median_of_actual_over_estimate(self):
        for est, act in (("30m", "60m"), ("20m", "30m"), ("10m", "40m")):
            t = self.add("t", "--estimate", est, "--list", "week")
            self.run_cli("done", t["id"], "--actual", act)
        self.assertEqual(self.run_cli("stats")["speed"], 2.0)

    def test_speed_defaults_to_one_with_few_samples(self):
        t = self.add("t", "--estimate", "30m", "--list", "week")
        self.run_cli("done", t["id"], "--actual", "90m")
        self.assertEqual(self.run_cli("stats")["speed"], 1.0)


class BriefTests(StoreCase):
    def write(self, name, data):
        p = self.vault / name
        p.write_text(json.dumps(data), encoding="utf-8")
        return str(p)

    def brief(self, date, **extra):
        return self.write(f"b-{date}.json", {"date": date, "email": {}, "calendar": {}, "plan": {}, **extra})

    def test_brief_save_logs_points_once_per_day(self):
        first = self.run_cli("brief-save", self.brief("2026-10-13"))
        again = self.run_cli("brief-save", self.brief("2026-10-13", mode="refresh"))
        self.assertEqual((first["points"], again["points"]), (3, 0))
        self.assertEqual(self.run_cli("stats")["points_today"], 3)
        self.assertEqual(self.run_cli("brief-get")["mode"], "refresh")

    def test_brief_save_rejects_missing_sections(self):
        err = self.run_cli("brief-save", self.write("bad.json", {"date": "2026-10-13", "email": {}}), expect=2)
        self.assertIn("calendar", err["error"])
        self.assertFalse((self.vault / ".assistant" / "brief" / "2026-10-13.json").exists())

    def test_context_flags_catch_up_after_two_missed_workdays(self):
        self.run_cli("brief-save", self.brief("2026-10-08"))      # Thu
        ctx = self.run_cli("context")                               # Tue 13: Fri and Mon missed
        self.assertEqual(ctx["last_brief"], "2026-10-08")
        self.assertEqual(ctx["workdays_missed"], 2)
        self.assertTrue(ctx["catch_up"])
        self.assertFalse(ctx["brief_today"])

    def test_context_no_catch_up_over_a_weekend_or_off_day(self):
        self.run_cli("brief-save", self.brief("2026-10-09"))      # Fri
        self.run_cli("log", "off", "--date", "2026-10-12")         # Mon off
        ctx = self.run_cli("context")
        self.assertEqual(ctx["workdays_missed"], 0)
        self.assertFalse(ctx["catch_up"])

    def test_context_reads_last_shutdown_and_due_tasks(self):
        self.run_cli("shutdown-save", self.write("s.json", {"date": "2026-10-12",
                                                            "first_step": "Open the release notes draft"}))
        late = self.add("late thing", "--due", "2026-10-10", "--list", "week")
        soon = self.add("soon thing", "--due", "2026-10-15", "--list", "week")
        self.add("now thing", "--list", "now")
        ctx = self.run_cli("context")
        self.assertEqual(ctx["last_shutdown"]["first_step"], "Open the release notes draft")
        self.assertEqual([t["id"] for t in ctx["overdue"]], [late["id"]])
        self.assertEqual([t["id"] for t in ctx["due_this_week"]], [soon["id"]])
        self.assertEqual(ctx["now"]["title"], "now thing")
        self.assertTrue(ctx["first_use"])

    def test_schedule_save_needs_events_and_logs_nothing(self):
        ok = self.run_cli("schedule-save", self.write("sc.json", {"date": "2026-10-13", "events": []}))
        self.assertTrue(ok["saved"].endswith("schedule/2026-10-13.json"))
        self.assertEqual(self.run_cli("stats")["points_today"], 0)
        self.run_cli("schedule-save", self.write("bad.json", {"date": "2026-10-14"}), expect=2)
        self.assertFalse((self.vault / ".assistant" / "schedule" / "2026-10-14.json").exists())

    def test_shutdown_requires_first_step(self):
        err = self.run_cli("shutdown-save", self.write("s.json", {"date": "2026-10-13"}), expect=2)
        self.assertIn("first_step", err["error"])


class FocusTests(StoreCase):
    def test_start_makes_task_now_and_blocks_a_second_session(self):
        old = self.add("old now", "--list", "now")
        t = self.add("focus me", "--list", "today", "--estimate", "30m")
        out = self.run_cli("focus-start", t["id"], "--minutes", "25m")
        self.assertEqual(out["session"]["ends_at"], "2026-10-13T10:13")
        self.assertEqual(out["demoted"], old["id"])
        self.assertEqual(self.run_cli("show", t["id"])["task"]["list"], "now")
        err = self.run_cli("focus-start", old["id"], expect=4)
        self.assertIn("runs until 10:13", err["error"])
        status = self.run_cli("focus-status", now="2026-10-13T10:00")
        self.assertEqual(status["session"]["remaining_min"], 13)

    def test_end_adds_time_to_actual_and_logs_points(self):
        t = self.add("work", "--list", "today", "--estimate", "30m", "--actual", "10m")
        self.run_cli("focus-start", t["id"])
        out = self.run_cli("focus-end", "--result", "stopped", now="2026-10-13T10:10")
        self.assertEqual(out["spent_min"], 22)
        self.assertEqual(out["points"], 2)
        self.assertEqual(self.run_cli("show", t["id"])["task"]["actual"], "32m")
        self.assertFalse(self.run_cli("focus-status")["running"])

    def test_forgotten_timer_is_capped(self):
        t = self.add("work", "--list", "today")
        self.run_cli("focus-start", t["id"], "--minutes", "25m")
        out = self.run_cli("focus-end", now="2026-10-13T16:00")
        self.assertEqual(out["spent_min"], 55)

    def test_short_session_earns_no_points(self):
        t = self.add("work", "--list", "today")
        self.run_cli("focus-start", t["id"])
        self.assertEqual(self.run_cli("focus-end", "--minutes", "5m")["points"], 0)

    def test_done_result_finishes_task_with_both_point_kinds(self):
        t = self.add("ship", "--list", "today", "--priority", "high", "--estimate", "20m")
        self.run_cli("focus-start", t["id"])
        out = self.run_cli("focus-end", "--result", "done", now="2026-10-13T10:18")
        self.assertEqual(out["task"]["list"], "done")
        self.assertEqual(out["points"], 5)
        self.assertEqual(self.run_cli("stats", now="2026-10-13T10:18")["points_today"], 5)

    def test_more_starts_a_fresh_short_session(self):
        t = self.add("long one", "--list", "today")
        self.run_cli("focus-start", t["id"])
        out = self.run_cli("focus-end", "--result", "more", now="2026-10-13T10:13")
        self.assertEqual(out["session"]["ends_at"], "2026-10-13T10:28")
        self.assertTrue(self.run_cli("focus-status", now="2026-10-13T10:14")["running"])

    def test_end_without_session_is_not_found(self):
        self.run_cli("focus-end", expect=5)


class InitAndCliTests(StoreCase):
    def test_init_copies_templates_once(self):
        out = self.run_cli("init")
        rules = self.vault / "assistant" / "email-rules.md"
        self.assertTrue(rules.exists())
        rules.write_text("my edits", encoding="utf-8")
        again = self.run_cli("init")
        self.assertEqual(again["created"], [])
        self.assertEqual(rules.read_text(encoding="utf-8"), "my edits")
        self.assertTrue(any(p.endswith("profile.md") for p in out["created"]))

    def test_missing_vault_is_a_clear_error(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = tasks.main(["--vault", str(self.vault / "nope"), "list"])
        self.assertEqual(code, 2)
        self.assertIn("does not exist", json.loads(buf.getvalue())["error"])

    def test_bad_task_id_is_rejected(self):
        err = self.run_cli("show", "../etc", expect=2)
        self.assertIn("not a task id", err["error"])

    def test_real_process_prints_utf8_json(self):
        proc = subprocess.run([sys.executable, str(SCRIPTS / "tasks.py"), "--vault", str(self.vault),
                               "--now", NOW, "add", "--title", "Café résumé", "--list", "week"],
                              capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout.decode("utf-8"))["task"]["title"], "Café résumé")


if __name__ == "__main__":
    unittest.main()
