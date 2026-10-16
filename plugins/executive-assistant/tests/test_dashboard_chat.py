"""Tests for dashboard/chat.py. Run: python -m unittest discover -s plugins/executive-assistant/tests"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN / "dashboard"))
import chat  # noqa: E402

FAKE = Path(__file__).resolve().parent / "fixtures" / "fake_claude.py"
ROOT = "C:/Plugins/executive-assistant"

SECRET = "please call the bank about account 7731 & say \"hi\""


class ChatCase(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp(prefix="ea-chat-"))
        self.args = self.vault / "fake-args.jsonl"
        self.env = mock.patch.dict(os.environ, {"FAKE_CLAUDE_ARGS": str(self.args)})
        self.env.start()
        for key in ("FAKE_CLAUDE_EXIT", "FAKE_CLAUDE_IS_ERROR", "FAKE_CLAUDE_SLOW", "FAKE_CLAUDE_CHILD",
                    "FAKE_CLAUDE_RESULT", "FAKE_CLAUDE_TOOLS", "FAKE_CLAUDE_SESSION", "FAKE_CLAUDE_ERROR_RESULT"):
            os.environ.pop(key, None)
        self.seed_tools()

    def seed_tools(self, tools=None):
        state = self.vault / ".assistant"
        state.mkdir(parents=True, exist_ok=True)
        tools = tools or ["Agent", "Bash", "Read", "Glob", "Grep", "Skill", "ToolSearch", "WebFetch",
                          "mcp__google-workspace__get_events", "mcp__google-workspace__send_gmail_message"]
        (state / "chat-tools.json").write_text(json.dumps({"probed_at": time.time(), "tools": tools}),
                                               encoding="utf-8")

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.vault, ignore_errors=True)

    def runner(self, **kw):
        return chat.ChatRunner(self.vault, PLUGIN, claude_cmd=[sys.executable, str(FAKE)], **kw)

    def calls(self):
        if not self.args.exists():
            return []
        return [json.loads(line) for line in self.args.read_text(encoding="utf-8").splitlines()]

    def chat_calls(self):
        return [c for c in self.calls() if "--include-partial-messages" in c["argv"]]


class EventMappingTests(ChatCase):
    def test_stream_maps_init_text_tool_and_done(self):
        events = list(self.runner().stream("what next?"))
        kinds = [e["type"] for e in events]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(events[0]["session_id"], "sess-new-1")
        self.assertEqual(kinds[-1], "done")
        self.assertEqual(events[-1], {"type": "done", "session_id": "sess-new-1", "is_error": False})
        text = "".join(e["delta"] for e in events if e["type"] == "text")
        self.assertEqual(text, "Your Now task is X.")   # deltas only, the full message is not doubled
        tools = [e for e in events if e["type"] == "tool"]
        self.assertEqual(tools, [{"type": "tool", "name": "mcp__google-workspace__get_events",
                                  "label": "Reading your calendar"}])

    def test_is_error_result_gives_error_then_done(self):
        os.environ["FAKE_CLAUDE_IS_ERROR"] = "1"
        events = list(self.runner().stream("hi"))
        self.assertEqual([e["type"] for e in events][-2:], ["error", "done"])
        self.assertTrue(events[-1]["is_error"])
        self.assertNotIn("Traceback", events[-2]["text"])

    def test_signed_out_result_says_how_to_sign_in(self):
        os.environ["FAKE_CLAUDE_IS_ERROR"] = "1"
        os.environ["FAKE_CLAUDE_ERROR_RESULT"] = "Failed to authenticate: OAuth session expired and could not be refreshed"
        events = list(self.runner().stream("hi"))
        self.assertEqual(events[-2], {"type": "error", "text": chat.SIGNED_OUT})
        self.assertNotIn("Failed to authenticate", json.dumps(events))
        self.assertTrue(events[-1]["is_error"])

    def test_non_zero_exit_is_a_plain_error(self):
        os.environ["FAKE_CLAUDE_EXIT"] = "3"
        events = list(self.runner().stream("hi"))
        self.assertEqual(events[-1], {"type": "error", "text": "The assistant stopped with an error (exit code 3)."})
        self.assertNotIn("done", [e["type"] for e in events])

    def test_missing_claude_is_a_plain_error(self):
        with mock.patch.object(chat.shutil, "which", return_value=None):
            r = chat.ChatRunner(self.vault, PLUGIN)
        events = list(r.stream("hi"))
        self.assertEqual(events, [{"type": "error", "text": "Claude Code was not found. Install it or add it to PATH."}])


class FlagTests(ChatCase):
    def test_flags_and_message_only_on_stdin(self):
        list(self.runner().stream(SECRET))
        call = self.chat_calls()[-1]
        argv = call["argv"]
        self.assertTrue(call["stdin"].startswith("[Local time: "), call["stdin"][:40])
        self.assertEqual(call["stdin"].split("\n", 1)[1], SECRET)
        self.assertFalse(any(SECRET in a or "7731" in a for a in argv))
        for flag in ("-p", "--verbose", "--include-partial-messages", "--append-system-prompt", "--allowedTools"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertEqual(argv[argv.index("--agent") + 1], "executive-assistant:assistant")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--plugin-dir", argv)
        self.assertNotIn("--resume", argv)
        allowed = argv[argv.index("--allowedTools") + 1:]
        self.assertIn("mcp__google-workspace__get_events", allowed)
        self.assertNotIn("mcp__google-workspace__send_gmail_message", allowed)
        self.assertNotIn("WebFetch", allowed)
        prompt = argv[argv.index("--append-system-prompt") + 1]
        root = str(PLUGIN.resolve()).replace("\\", "/")
        self.assertIn(f'python "{root}/scripts/tasks.py" --vault "', prompt)
        self.assertNotIn("$", prompt)

    def test_dev_adds_plugin_dir(self):
        list(self.runner(dev=True).stream("hi"))
        argv = self.chat_calls()[-1]["argv"]
        self.assertEqual(argv[argv.index("--plugin-dir") + 1], str(PLUGIN.resolve()))

    def test_resume_on_second_message_and_not_after_reset(self):
        r = self.runner()
        list(r.stream("one"))
        list(r.stream("two"))
        list(r.stream("three", new=True))
        os.environ["FAKE_CLAUDE_SESSION"] = "sess-new-2"
        r.reset()
        list(r.stream("four"))
        calls = self.chat_calls()
        self.assertNotIn("--resume", calls[0]["argv"])
        self.assertEqual(calls[1]["argv"][calls[1]["argv"].index("--resume") + 1], "sess-new-1")
        self.assertNotIn("--resume", calls[2]["argv"])
        self.assertNotIn("--resume", calls[3]["argv"])
        self.assertEqual(r.session_id, "sess-new-2")

    def test_failed_resume_starts_fresh_next_time(self):
        r = self.runner()
        list(r.stream("one"))
        os.environ["FAKE_CLAUDE_EXIT"] = "1"
        def fake_run(self, argv, stdin):
            yield "fail", "x"
        with mock.patch.object(chat.ChatRunner, "_run", fake_run):
            events = list(r.stream("two"))
        self.assertIn("start a new one", events[-1]["text"])
        self.assertIsNone(r.session_id)


class HistoryTests(ChatCase):
    def test_history_persisted_with_session(self):
        r = self.runner()
        list(r.stream("what next?"))
        saved = json.loads((self.vault / ".assistant" / "chat.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["session_id"], "sess-new-1")
        self.assertEqual([(m["role"], m["text"]) for m in saved["messages"]],
                         [("user", "what next?"), ("assistant", "Your Now task is X.")])
        again = self.runner().history()
        self.assertEqual(again["session_id"], "sess-new-1")
        self.assertEqual(len(again["messages"]), 2)
        self.assertRegex(again["messages"][0]["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d")

    def test_history_capped_at_50(self):
        r = self.runner()
        for i in range(30):
            r._remember("user", f"m{i}")
            r._remember("assistant", f"a{i}")
        h = r.history()["messages"]
        self.assertEqual(len(h), 50)
        self.assertEqual(h[0]["text"], "m5")
        self.assertEqual(h[-1]["text"], "a29")
        saved = json.loads((self.vault / ".assistant" / "chat.json").read_text(encoding="utf-8"))
        self.assertEqual(len(saved["messages"]), 50)

    def test_reset_clears(self):
        r = self.runner()
        list(r.stream("x"))
        r.reset()
        self.assertEqual(r.history(), {"session_id": None, "messages": []})


class LockAndTimeoutTests(ChatCase):
    def test_second_stream_raises_busy_until_first_ends(self):
        r = self.runner()
        first = r.stream("one")
        next(first)
        self.assertTrue(r.busy)
        with self.assertRaises(chat.Busy):
            r.stream("two")
        list(first)
        self.assertFalse(r.busy)
        list(r.stream("three"))

    def test_closing_the_stream_kills_the_process_and_frees_the_lock(self):
        os.environ["FAKE_CLAUDE_SLOW"] = "30"
        pidfile = self.vault / "pid"
        os.environ["FAKE_CLAUDE_PIDFILE"] = str(pidfile)
        r = self.runner()
        s = r.stream("one")
        self.assertEqual(next(s)["type"], "start")
        t0 = time.time()
        s.close()
        self.assertLess(time.time() - t0, 15)
        self.assertFalse(r.busy)
        self.assertFalse(_alive(int(pidfile.read_text())))
        os.environ.pop("FAKE_CLAUDE_PIDFILE")

    def test_timeout_kills_process_tree(self):
        os.environ["FAKE_CLAUDE_SLOW"] = "30"
        os.environ["FAKE_CLAUDE_CHILD"] = "1"
        r = self.runner(timeout=2)
        t0 = time.time()
        events = list(r.stream("one"))
        self.assertLess(time.time() - t0, 20)
        self.assertEqual(events[-1], {"type": "error",
                                      "text": "The assistant took longer than 10 minutes, so I stopped it."})
        child = int(Path(str(self.args) + ".child").read_text())
        deadline = time.time() + 5
        while _alive(child) and time.time() < deadline:
            time.sleep(0.2)
        self.assertFalse(_alive(child), "the child process survived the timeout")
        self.assertFalse(r.busy)

    def test_refresh_waits_for_lock_then_gives_up(self):
        r = self.runner()
        r._lock.acquire()
        try:
            out = r.refresh_schedule("2026-10-13", wait=0.2)
        finally:
            r._lock.release()
        self.assertFalse(out["ok"])
        self.assertIn("busy", out["error"])


class RefreshTests(ChatCase):
    def test_refresh_saves_today_with_tasks_py(self):
        report = {"range": {"start": "2026-10-13", "end": "2026-10-13"},
                  "days": [{"date": "2026-10-13", "events": [
                      {"id": "evt-41", "start": "10:00", "end": "10:30", "title": "Queue review",
                       "kind": "meet", "attendees": 3, "ours": False}]}],
                  "flags": [], "week_summary": "Light day."}
        os.environ["FAKE_CLAUDE_RESULT"] = "One meeting today.\n\n```json\n" + json.dumps(report) + "\n```\n"
        r = self.runner()
        out = r.refresh_schedule("2026-10-13")
        self.assertEqual(out, {"ok": True, "error": None})
        saved = json.loads((self.vault / ".assistant" / "schedule" / "2026-10-13.json").read_text(encoding="utf-8"))
        self.assertEqual([e["id"] for e in saved["events"]], ["evt-41"])
        self.assertEqual(saved["date"], "2026-10-13")
        self.assertEqual(list((self.vault / ".assistant" / "tmp").iterdir()), [])
        call = [c for c in self.calls() if "--include-partial-messages" not in c["argv"]
                and "--max-turns" not in c["argv"]][-1]
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--agent") + 1], "executive-assistant:calendar-assistant")
        self.assertIn("--no-session-persistence", argv)
        self.assertNotIn("--resume", argv)
        self.assertIn("2026-10-13", call["stdin"])
        self.assertEqual(r.history()["messages"], [])

    def test_refresh_without_report_fails_plainly(self):
        os.environ["FAKE_CLAUDE_RESULT"] = "I could not reach Google."
        out = self.runner().refresh_schedule("2026-10-13")
        self.assertEqual(out, {"ok": False, "error": "The calendar check returned no schedule."})

    def test_refresh_when_signed_out_says_how_to_sign_in(self):
        os.environ["FAKE_CLAUDE_IS_ERROR"] = "1"
        os.environ["FAKE_CLAUDE_ERROR_RESULT"] = "Failed to authenticate: OAuth session expired and could not be refreshed"
        out = self.runner().refresh_schedule("2026-10-13")
        self.assertEqual(out, {"ok": False, "error": chat.SIGNED_OUT})


class ChildEnvTests(unittest.TestCase):
    def test_drops_a_parent_sessions_variables_and_keeps_the_rest(self):
        env = chat.child_env({
            "PATH": "/bin", "ANTHROPIC_API_KEY": "k", "CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH": "v",
            "CLAUDECODE": "1", "CLAUDE_PID": "9", "CLAUDE_EFFORT": "high",
            "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH": "1", "CLAUDE_CODE_ENTRYPOINT": "claude-desktop",
            "CLAUDE_AGENT_SDK_VERSION": "1", "CLAUDE_CODE_GIT_BASH_PATH": "C:/git/bash.exe",
            "CLAUDE_CODE_OAUTH_TOKEN": "t"})
        self.assertEqual(sorted(env), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CODE_OAUTH_TOKEN",
                                       "CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH", "PATH"])

    def test_needs_login(self):
        self.assertTrue(chat.needs_login("Failed to authenticate: OAuth session expired"))
        self.assertTrue(chat.needs_login("Not logged in · Please run /login"))
        self.assertFalse(chat.needs_login("The calendar had no events."))
        self.assertFalse(chat.needs_login(None))


class ToolCacheTests(ChatCase):
    def test_probe_once_then_cache(self):
        (self.vault / ".assistant" / "chat-tools.json").unlink()
        os.environ["FAKE_CLAUDE_TOOLS"] = "Read,mcp__x__list_things"
        r = self.runner()
        self.assertEqual(r.discover_tools(), ["Read", "mcp__x__list_things"])
        self.assertEqual(r.discover_tools(), ["Read", "mcp__x__list_things"])
        probes = [c for c in self.calls() if "--max-turns" in c["argv"]]
        self.assertEqual(len(probes), 1)
        argv = probes[0]["argv"]
        self.assertEqual(argv[argv.index("--max-turns") + 1], "1")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        cache = json.loads((self.vault / ".assistant" / "chat-tools.json").read_text(encoding="utf-8"))
        cache["probed_at"] -= 25 * 3600
        (self.vault / ".assistant" / "chat-tools.json").write_text(json.dumps(cache), encoding="utf-8")
        r.discover_tools()
        self.assertEqual(len([c for c in self.calls() if "--max-turns" in c["argv"]]), 2)


class SelectAllowedTests(unittest.TestCase):
    KEEP = [
        "mcp__google-workspace__get_events",
        "mcp__google-workspace__list_calendars",
        "mcp__google-workspace__search_gmail_messages",
        "mcp__google-workspace__get_gmail_thread_content",
        "mcp__google-workspace__query_freebusy",
        "mcp__google-workspace__read_sheet_values",
        "mcp__google-workspace__draft_gmail_message",
        "mcp__google-workspace__manage_event",
        "mcp__google-workspace__manage_focus_time",
        "mcp__0b5e66b0-f707__create_draft",
        "mcp__0b5e66b0-f707__search_threads",
        "mcp__0b5e66b0-f707__get_thread",
        "mcp__f827bc1d-486a__list_issues",
        "mcp__f827bc1d-486a__get_issue",
        "mcp__4d271699-92fd__getJiraIssue",
        "mcp__4d271699-92fd__searchJiraIssuesUsingJql",
        "mcp__4d271699-92fd__lookupJiraAccountId",
        "mcp__4d271699-92fd__fetch",
        "mcp__639a6ff4-78af__slack_read_channel",
        "mcp__639a6ff4-78af__slack_search_public",
        "mcp__launchdarkly__list-flags",
        "mcp__plugin_executive-assistant_google-workspace__view_thing",
        "mcp__claude_ai_Linear__find_user",
        "mcp__x__describe_table",
    ]
    DROP = [
        "mcp__0b5e66b0-f707__send_message",
        "mcp__google-workspace__send_gmail_message",
        "mcp__google-workspace__send_message",
        "mcp__0b5e66b0-f707__trash_message",
        "mcp__0b5e66b0-f707__trash_thread",
        "mcp__0b5e66b0-f707__untrash_thread",
        "mcp__0b5e66b0-f707__delete_draft",
        "mcp__32385326-064a__delete_event",
        "mcp__0b5e66b0-f707__reply",
        "mcp__0b5e66b0-f707__forward",
        "mcp__0b5e66b0-f707__mark_message_spam",
        "mcp__0b5e66b0-f707__unmark_thread_spam",
        "mcp__be476e0c-11b2__archive_article",
        "mcp__be476e0c-11b2__list_archived_articles",
        "mcp__f827bc1d-486a__delete_comment",
        "mcp__google-workspace__modify_gmail_message_labels",
        "mcp__google-workspace__batch_modify_gmail_message_labels",
        "mcp__google-workspace__get_drive_shareable_link",
        "mcp__9ab8e77b-7f39__share_file",
        "mcp__be476e0c-11b2__publish_working_copy",
        "mcp__4d271699-92fd__transitionJiraIssue",
        "mcp__4d271699-92fd__getTransitionsForJiraIssue",
        "mcp__f827bc1d-486a__save_comment",
        "mcp__0b5e66b0-f707__update_message_labels",
        "mcp__639a6ff4-78af__slack_send_message",
        "mcp__639a6ff4-78af__slack_send_message_draft",
        "mcp__gtasks__remove_task",
        "mcp__f827bc1d-486a__save_issue",
        "mcp__4d271699-92fd__createJiraIssue",
        "mcp__4d271699-92fd__editJiraIssue",
        "mcp__google-workspace__manage_gmail_filter",
        "mcp__google-workspace__create_calendar",
        "mcp__google-workspace__run_script_function",
        "mcp__ebefcc3c-d52f__exec",
        "mcp__launchdarkly__toggle-flag",
        "mcp__launchdarkly__get-keys",
        "mcp__x__get_api_token",
        "mcp__x__getaway_car",          # 'get' must be a whole word
        "mcp__x__listen",
        "mcp__x__readme_write",
        "mcp__google-workspace__",      # no tool segment
        "WebFetch",
        "Bash",
    ]

    def test_keeps_read_tools_and_safe_writes(self):
        rules = chat.select_allowed(self.KEEP, ROOT)
        for name in self.KEEP:
            self.assertIn(name, rules)

    def test_drops_every_forbidden_or_unknown_tool(self):
        rules = chat.select_allowed(self.DROP + self.KEEP, ROOT)
        for name in self.DROP:
            self.assertNotIn(name, rules)

    def test_no_writes_mode_drops_the_safe_writes(self):
        rules = chat.select_allowed(self.KEEP, ROOT, writes=False)
        for name in chat.SAFE_WRITES:
            self.assertFalse(any(r.endswith("__" + name) for r in rules), name)
        self.assertIn("mcp__google-workspace__get_events", rules)

    def test_builtins(self):
        rules = chat.select_allowed(["TodoWrite", "Read"], ROOT)
        for name in ("Read", "Glob", "Grep", "Skill", "Agent", "ToolSearch", "TodoWrite", "Write", "Edit"):
            self.assertIn(name, rules)
        self.assertNotIn("TodoWrite", chat.select_allowed(["Read"], ROOT))
        for bad in ("Bash", "WebFetch", "WebSearch", "PowerShell", "NotebookEdit"):
            self.assertNotIn(bad, rules)

    def test_deny_list_names_every_dangerous_tool_and_no_read_tool(self):
        denied = chat.select_denied(self.DROP + self.KEEP)
        for name in ("mcp__google-workspace__send_gmail_message", "mcp__0b5e66b0-f707__send_message",
                     "mcp__0b5e66b0-f707__trash_thread", "mcp__launchdarkly__get-keys"):
            self.assertIn(name, denied)
        for name in self.KEEP:
            self.assertNotIn(name, denied)
        for name in chat.DENIED_BUILTINS:
            self.assertIn(name, denied)

    def test_bash_rules_cover_only_the_plugin_scripts(self):
        rules = chat.select_allowed([], ROOT)
        bash = [r for r in rules if r.startswith("Bash(")]
        for script in ("tasks.py", "email_rules.py"):
            fwd = f"C:/Plugins/executive-assistant/scripts/{script}"
            back = fwd.replace("/", "\\")
            for p in (f'"{fwd}"', fwd, f'"{back}"', back):
                self.assertIn(f"Bash(python {p} *)", bash)
        self.assertEqual(len(bash), 8)
        for r in bash:
            self.assertRegex(r, r"^Bash\(python \"?C:[/\\]Plugins[/\\]executive-assistant[/\\]scripts[/\\]"
                                r"(tasks|email_rules)\.py\"? \*\)$")

    def test_powershell_rules_only_when_the_tool_exists(self):
        self.assertFalse(any(r.startswith("PowerShell(") for r in chat.select_allowed([], ROOT)))
        ps = [r for r in chat.select_allowed(["PowerShell"], ROOT) if r.startswith("PowerShell(")]
        self.assertIn('PowerShell(python "C:/Plugins/executive-assistant/scripts/tasks.py" *)', ps)
        self.assertEqual(len(ps), 8)


class LabelTests(unittest.TestCase):
    def test_labels(self):
        cases = {
            ("mcp__google-workspace__get_events", None): "Reading your calendar",
            ("mcp__google-workspace__search_gmail_messages", None): "Searching email",
            ("mcp__0b5e66b0-f707__get_thread", None): "Searching email",
            ("mcp__f827bc1d-486a__list_issues", None): "Looking at Linear",
            ("mcp__claude_ai_Linear__get_user", None): "Looking at Linear",
            ("Agent", None): "Asking a helper agent",
            ("Task", None): "Asking a helper agent",
            ("Bash", (('command', 'python "C:/p/scripts/tasks.py" --vault "V" context'),)): "Checking your tasks",
            ("mcp__weird__frobnicate", None): "Working",
            ("Mystery", None): "Working",
        }
        for (name, inp), label in cases.items():
            self.assertEqual(chat.tool_label(name, dict(inp) if inp else None), label, name)


class ExtractTests(unittest.TestCase):
    def test_extract_report_takes_last_json_block(self):
        text = 'x\n```json\n{"a": 1}\n```\nthen\n```json\n{"days": [], "flags": []}\n```\n'
        self.assertEqual(chat.extract_report(text), {"days": [], "flags": []})
        self.assertEqual(chat.extract_report('Here: {"events": [1]} done'), {"events": [1]})
        self.assertIsNone(chat.extract_report("nothing here"))


def _alive(pid):
    if os.name == "nt":
        import subprocess
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        return wpid == 0
    except ChildProcessError:
        return True


if __name__ == "__main__":
    unittest.main()
