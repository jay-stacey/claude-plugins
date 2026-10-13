"""Day Desk server tests, through real HTTP on a free port."""
import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
sys.path.insert(0, str(ROOT / "scripts"))
import server  # noqa: E402

NOW = "2026-10-13T09:48"
TOKEN = "test-token-7f3a"


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp(prefix="ea-desk-"))
        self.app = server.App(self.vault, TOKEN, toast=False, fixed_now=NOW)
        self.srv = server.make_server(self.app, 0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.vault, ignore_errors=True)

    def call(self, method, path, body=None, token=TOKEN, host=None, origin=None, expect=200):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if token:
            headers["X-Day-Desk-Token"] = token
        if origin:
            headers["Origin"] = origin
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        self.assertEqual(resp.status, expect, raw[:300])
        ctype = resp.getheader("Content-Type") or ""
        return json.loads(raw) if "json" in ctype else raw

    def write(self, rel, text, newline="\n"):
        p = self.vault / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.replace("\n", newline).encode("utf-8"))
        return p


class SecurityTests(ServerCase):
    def test_health_needs_no_token(self):
        self.assertEqual(self.call("GET", "/api/health", token=None)["app"], "day-desk")

    def test_api_refuses_missing_and_wrong_token(self):
        self.call("GET", "/api/state", token=None, expect=403)
        err = self.call("GET", "/api/state", token="wrong-token", expect=403)
        self.assertIn("key", err["error"])

    def test_foreign_host_and_origin_are_refused(self):
        self.call("GET", "/api/state", host="evil.example:80", expect=403)
        self.call("GET", "/api/health", host="attacker.test", token=None, expect=403)
        self.call("POST", "/api/tasks", {"title": "x"}, origin="http://evil.example", expect=403)
        self.assertEqual(list((self.vault).glob("tasks/*.md")), [])

    def test_same_origin_and_localhost_are_allowed(self):
        self.call("GET", "/api/state", host=f"localhost:{self.port}", origin=f"http://localhost:{self.port}")

    def test_unknown_static_paths_404(self):
        self.call("GET", "/static/../server.py", token=None, expect=404)
        self.call("GET", "/etc/passwd", token=None, expect=404)


class TaskApiTests(ServerCase):
    def test_add_list_move_and_today_limit(self):
        first = self.call("POST", "/api/tasks", {"title": "Now thing", "list": "now"})["task"]
        for i in range(4):
            self.call("POST", "/api/tasks", {"title": f"today {i}", "list": "today"})
        later = self.call("POST", "/api/tasks", {"parse": "plan offsite mon 1h #ops"})["task"]
        self.assertEqual((later["list"], later["estimate"], later["tags"]), ("later", "1h", ["ops"]))
        err = self.call("POST", f"/api/tasks/{later['id']}/move", {"list": "today"}, expect=422)
        self.assertIn("full", err["error"])
        listed = self.call("GET", "/api/tasks")
        self.assertEqual(listed["today_used"], 5)
        self.assertEqual(listed["tasks"][0]["id"], first["id"])

    def test_patch_with_stale_sha_is_409_and_keeps_disk(self):
        t = self.call("POST", "/api/tasks", {"title": "Edit me", "list": "week"})["task"]
        self.call("PATCH", f"/api/tasks/{t['id']}", {"title": "Changed elsewhere"})
        err = self.call("PATCH", f"/api/tasks/{t['id']}", {"title": "Mine", "if_sha": t["sha"]}, expect=409)
        self.assertTrue(err["sha"])
        self.assertEqual(self.call("GET", f"/api/tasks/{t['id']}")["task"]["title"], "Changed elsewhere")

    def test_patch_body_and_done_with_points(self):
        t = self.call("POST", "/api/tasks", {"title": "Ship", "list": "today", "priority": "high"})["task"]
        self.call("PATCH", f"/api/tasks/{t['id']}", {"body": "- [ ] step one\n"})
        self.assertEqual(self.call("GET", f"/api/tasks/{t['id']}")["task"]["body"], "- [ ] step one\n")
        out = self.call("POST", f"/api/tasks/{t['id']}/done", {"actual": "40m"})
        self.assertEqual(out["points"], 3)
        state = self.call("GET", "/api/state")
        self.assertEqual(state["context"]["stats"]["points_today"], 3)

    def test_focus_start_and_end(self):
        t = self.call("POST", "/api/tasks", {"title": "Deep", "list": "today"})["task"]
        s = self.call("POST", "/api/focus/start", {"id": t["id"], "minutes": 25})["session"]
        self.assertEqual(s["ends_at"], "2026-10-13T10:13")
        self.call("POST", "/api/focus/start", {"id": t["id"], "minutes": 25}, expect=422)
        self.assertTrue(self.call("GET", "/api/state")["focus"]["running"])
        out = self.call("POST", "/api/focus/end", {"result": "stopped", "minutes": 20})
        self.assertEqual(out["spent_min"], 20)

    def test_parse_preview_and_unknown_task(self):
        self.assertEqual(self.call("GET", "/api/parse?text=call%20bank%20fri%2015m")["due"], "2026-10-16")
        self.call("GET", "/api/tasks/t-0999", expect=404)
        self.call("GET", "/api/nothing", expect=404)


class NotesApiTests(ServerCase):
    def test_list_skips_tasks_and_hidden_and_searches(self):
        self.write("projects/auth.md", "---\ntitle: Auth0 migration\ntags: [auth0]\n---\nCutover window\n")
        self.write("daily/2026-10-13.md", "# Tuesday\nNothing yet\n")
        self.write(".obsidian/x.md", "hidden")
        self.call("POST", "/api/tasks", {"title": "a task", "list": "week"})
        paths = [n["path"] for n in self.call("GET", "/api/notes")["notes"]]
        self.assertEqual(sorted(paths), ["daily/2026-10-13.md", "projects/auth.md"])
        hits = self.call("GET", "/api/notes?q=cutover")["notes"]
        self.assertEqual([(h["path"], h["title"], h["tags"]) for h in hits],
                         [("projects/auth.md", "Auth0 migration", ["auth0"])])

    def test_bad_paths_are_refused(self):
        for bad in ("../outside.md", "C:/Windows/x.md", "/etc/x.md", ".assistant/brief.md",
                    "tasks/t-0001-x.md", "notes/x.txt", "a/../../b.md"):
            self.call("PUT", "/api/notes/file", {"path": bad, "content": "x", "base_sha": None}, expect=400)
        self.assertFalse((self.vault.parent / "outside.md").exists())

    def test_write_checks_sha_and_keeps_crlf(self):
        p = self.write("projects/crlf.md", "line one\nline two\n", newline="\r\n")
        got = self.call("GET", "/api/notes/file?path=projects/crlf.md")
        self.assertEqual(got["content"], "line one\nline two\n")
        saved = self.call("PUT", "/api/notes/file", {"path": "projects/crlf.md", "content": "line one\nedited\n",
                                                     "base_sha": got["sha"]})
        self.assertEqual(p.read_bytes(), b"line one\r\nedited\r\n")
        err = self.call("PUT", "/api/notes/file", {"path": "projects/crlf.md", "content": "stale",
                                                   "base_sha": got["sha"]}, expect=409)
        self.assertEqual(err["sha"], saved["sha"])
        self.assertEqual(p.read_bytes(), b"line one\r\nedited\r\n")

    def test_create_refuses_existing_note(self):
        self.write("inbox/idea.md", "already here\n")
        self.call("PUT", "/api/notes/file", {"path": "inbox/idea.md", "content": "new", "base_sha": None}, expect=409)
        out = self.call("PUT", "/api/notes/file", {"path": "inbox/new idea.md", "content": "# New\n", "base_sha": None})
        self.assertTrue((self.vault / "inbox" / "new idea.md").exists())
        self.assertEqual(len(out["sha"]), 64)


class ScheduleAndShutdownTests(ServerCase):
    def save(self, kind, data):
        p = self.vault / ".assistant" / kind / "2026-10-13.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data), encoding="utf-8")

    def test_schedule_prefers_the_newer_source(self):
        self.save("brief", {"date": "2026-10-13", "generated_at": "2026-10-13T06:04", "email": {}, "plan": {},
                            "calendar": {"days": [{"date": "2026-10-13", "events": [
                                {"id": "e2", "start": "12:30", "end": "13:30", "title": "Strategy", "kind": "meet"},
                                {"id": "e1", "start": "10:00", "end": "10:30", "title": "Support", "kind": "meet"}]}],
                                "week_summary": "Wednesday is heavy."}})
        s = self.call("GET", "/api/schedule")
        self.assertEqual((s["source"], [e["id"] for e in s["events"]]), ("brief", ["e1", "e2"]))
        self.assertEqual(s["week_summary"], "Wednesday is heavy.")
        self.save("schedule", {"date": "2026-10-13", "generated_at": "2026-10-13T09:30",
                               "events": [{"id": "e9", "start": "11:00", "end": "11:15", "title": "New", "kind": "meet"}]})
        s = self.call("GET", "/api/schedule")
        self.assertEqual((s["source"], s["as_of"], [e["id"] for e in s["events"]]),
                         ("refresh", "2026-10-13T09:30", ["e9"]))
        self.assertEqual(s["days"][0]["date"], "2026-10-13")

    def test_shutdown_marks_done_moves_saves_and_writes_daily_note(self):
        a = self.call("POST", "/api/tasks", {"title": "Finished thing", "list": "today"})["task"]
        b = self.call("POST", "/api/tasks", {"title": "Slipping thing", "list": "today", "due": "2026-10-13"})["task"]
        self.write("daily/2026-10-13.md", "# Tuesday\n\n## Brief\nall good\n\n## Notes\nkeep me\n")
        out = self.call("POST", "/api/shutdown", {"done": [a["id"]], "moved": [{"id": b["id"], "to": "2026-10-20"}],
                                                  "first_step": "Open the release notes", "tonight": None})
        self.assertEqual(out["points"], 3)
        self.assertEqual(self.call("GET", f"/api/tasks/{a['id']}")["task"]["list"], "done")
        moved = self.call("GET", f"/api/tasks/{b['id']}")["task"]
        self.assertEqual((moved["due"], moved["list"], moved["slipped"]), ("2026-10-20", "later", "1"))
        note = (self.vault / "daily" / "2026-10-13.md").read_text(encoding="utf-8")
        self.assertIn("## Notes\nkeep me", note)
        self.assertIn("## Shutdown", note)
        self.assertIn("Finished thing", note)
        self.assertIn("Tomorrow starts with: Open the release notes", note)
        ctx = self.call("GET", "/api/state")["context"]
        self.assertTrue(ctx["stats"]["shutdown_done"])

    def test_shutdown_needs_first_step(self):
        self.call("POST", "/api/shutdown", {"done": []}, expect=400)


class ProfileTests(unittest.TestCase):
    def test_reads_profile_lines_and_defaults(self):
        prof = server.parse_profile("- Start: 6:45\n- Stop: 15:30\n- Deep work window: 07:00 to 11:00\n"
                                    "- Admin and catch-up: after 14:00\n- Shutdown reminder: 20 minutes before stop\n",
                                    env={})
        self.assertEqual(prof, {"start": "06:45", "stop": "15:30", "deep": ["07:00", "11:00"],
                                "admin_after": "14:00", "shutdown_reminder_min": 20})
        self.assertEqual(server.parse_profile("", env={})["deep"], ["06:30", "11:30"])


class StaticTests(ServerCase):
    def test_editor_bundle_is_served(self):
        js = self.call("GET", "/static/editor.bundle.js", token=None)
        self.assertIn(b"NotesEditor", js[:2000] + js[-4000:])


if __name__ == "__main__":
    unittest.main()
