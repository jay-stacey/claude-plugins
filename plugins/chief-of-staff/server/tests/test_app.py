import json
import os
import socket
import subprocess
import sys
import unittest
import urllib.request

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


if __name__ == "__main__":
    unittest.main()
