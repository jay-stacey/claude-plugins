import argparse
import json
import os
import socket
import subprocess
import sys
import unittest
import urllib.request
from unittest import mock

from helpers import SERVER, Sandbox

APP = SERVER / "app.py"


def run(*args):
    out = subprocess.run([sys.executable, str(APP), *args], capture_output=True, text=True, timeout=60)
    return json.loads(out.stdout.strip().splitlines()[-1])


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Lifecycle(unittest.TestCase):
    def test_start_status_stop_and_busy_port(self):
        with Sandbox() as box:
            port = free_port()
            blocker = socket.socket()
            blocker.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", socket.SO_REUSEADDR), 1)
            blocker.bind(("127.0.0.1", port))
            blocker.listen(1)
            try:
                started = run("start", "--port", str(port))
                self.assertNotIn("error", started, started)
                self.assertFalse(started["already_running"])
                self.assertNotEqual(started["port"], port)            # the busy port was skipped
                self.assertTrue(port < started["port"] <= port + 9)
                info = json.loads((box.dir / "home" / "run" / "server.json").read_text(encoding="utf-8"))
                self.assertEqual(info["api"], 1)
                self.assertEqual(info["url"], f"http://127.0.0.1:{info['port']}/#{info['token']}")
                self.assertIsNone(info["chiefSessionId"])
                again = run("start", "--port", str(port))
                self.assertTrue(again["already_running"])
                status = run("status")
                self.assertTrue(status["running"])
                self.assertEqual(started["version"], status["version"])
                self.assertNotIn("stale", again)
                self.assertEqual(status["desktop"], {"source": "env", "files": 7, "root": str(box.dir / "desktop")})
                req = urllib.request.Request(f"http://127.0.0.1:{info['port']}/api/sessions",
                                             headers={"X-COS-Token": info["token"]})
                with urllib.request.urlopen(req, timeout=10) as r:
                    body = json.loads(r.read())
                self.assertIn("sessions", body)
                self.assertTrue((box.dir / "home" / "logs" / "server.log").exists())
            finally:
                stopped = run("stop")
                blocker.close()
            self.assertTrue(stopped["stopped"])
            self.assertFalse((box.dir / "home" / "run" / "server.json").exists())
            down = run("status")
            self.assertFalse(down["running"])
            self.assertEqual(down["desktop"], {"source": "env", "files": 7, "root": str(box.dir / "desktop"),
                                               "desktopLocal": True})
            self.assertFalse(run("stop")["stopped"])


class OldServer:
    """A stand-in for a running server that answers health with `version` (None: no version)."""

    def __init__(self, version):
        import http.server
        import threading
        body = {"ok": True, "app": "chief-of-staff"}
        if version is not None:
            body["version"] = version
        data = json.dumps(body).encode()

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Start(unittest.TestCase):
    def start_against(self, version):
        import app
        with Sandbox() as box:
            old = OldServer(version)
            try:
                run_dir = box.dir / "home" / "run"
                run_dir.mkdir(parents=True)
                (run_dir / "server.json").write_text(json.dumps({
                    "api": 1, "port": old.port, "pid": 4242, "token": "t", "chiefSessionId": None,
                    "url": f"http://127.0.0.1:{old.port}/#t"}), encoding="utf-8")
                with mock.patch.object(app, "spawn", side_effect=AssertionError("restarted")), \
                        mock.patch.object(app, "cmd_stop", side_effect=AssertionError("stopped")):
                    out = app.cmd_start(argparse.Namespace(port=0, open=False))
                self.assertTrue(app.healthy(old.port))          # still the same server
            finally:
                old.close()
        return out

    def test_start_reports_version_and_stale_and_never_restarts_an_older_server(self):
        from cos import paths
        out = self.start_against("0.0.1")
        self.assertEqual((out["already_running"], out["version"], out["stale"]), (True, "0.0.1", True))
        same = self.start_against(paths.plugin_version())
        self.assertEqual(same["version"], paths.plugin_version())
        self.assertNotIn("stale", same)

    def test_a_server_without_a_version_counts_as_stale(self):
        out = self.start_against(None)
        self.assertEqual((out["already_running"], out["version"], out["stale"]), (True, None, True))

    def test_restart_accepts_open(self):
        import app
        seen = []
        with mock.patch.object(app, "cmd_stop", lambda args: seen.append(("stop", args.open)) or {}), \
                mock.patch.object(app, "cmd_start", lambda args: seen.append(("start", args.open)) or {"ok": True}), \
                mock.patch("builtins.print"):
            self.assertEqual(app.main(["restart", "--open"]), 0)
        self.assertEqual(seen, [("stop", True), ("start", True)])

    def test_spawn_retries_without_breakaway_when_refused(self):
        import app
        calls = []

        class Proc:
            pid = 999

            def poll(self):
                return 1                                        # stops at once: no wait

        def fake_popen(cmd, **kw):
            calls.append(kw.get("creationflags"))
            if kw.get("creationflags", 0) & app.BREAKAWAY:
                err = OSError("Access is denied")
                err.winerror = 5
                raise err
            return Proc()

        with Sandbox() as box:
            with self.assertRaises(SystemExit):
                app.spawn(argparse.Namespace(port=1, open=False), popen=fake_popen, nt=True)
            log = (box.dir / "home" / "logs" / "server.log").read_text(encoding="utf-8")
        self.assertEqual(calls, [app.DETACHED | app.BREAKAWAY, app.DETACHED])
        self.assertIn('{"spawn": "detached", "pid": 999}', log)

        def other_error(cmd, **kw):
            raise OSError("no such file")

        with Sandbox():
            with self.assertRaises(OSError):
                app.spawn(argparse.Namespace(port=1, open=False), popen=other_error, nt=True)


if __name__ == "__main__":
    unittest.main()
