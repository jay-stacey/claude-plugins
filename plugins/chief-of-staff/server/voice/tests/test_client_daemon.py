import json
import secrets
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from fakes import SPEECH, WAKE, FakeLink, FakeMic, FakeSink, FakeSTT, FakeTTS, FakeVAD, FakeWake, chunk, config, wait_for
from cosvoice.client import ServerLink
from cosvoice.daemon import Daemon, Models


class Stub:
    """The two voice endpoints with the contract's token and Host rules."""

    def __init__(self):
        self.token = secrets.token_urlsafe(24)
        self.jobs = []
        self.events = []
        self.cond = threading.Condition()
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _deny(self):
                port = self.server.server_address[1]
                if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                    return 403
                if not secrets.compare_digest(self.headers.get("X-COS-Token", ""), stub.token):
                    return 401
                return 0

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path.startswith("/api/health"):
                    return self._send(200, {"ok": True, "api": 1, "voice": {"listen": "ptt", "speak": True}})
                code = self._deny()
                if code:
                    return self._send(code, {"error": "no"})
                with stub.cond:
                    stub.cond.wait_for(lambda: stub.jobs, timeout=1.0)
                    jobs, stub.jobs = stub.jobs, []
                self._send(200, {"jobs": jobs})

            def do_POST(self):
                code = self._deny()
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                if code:
                    return self._send(code, {"error": "no"})
                with stub.cond:
                    stub.events.append((time.monotonic(), body))
                self._send(200, {"ok": True})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def info(self):
        return {"port": self.port, "token": self.token}

    def add_job(self, job):
        with self.cond:
            self.jobs.append(job)
            self.cond.notify_all()

    def of(self, kind):
        with self.cond:
            return [b for _, b in self.events if b.get("type") == kind]

    def close(self):
        self.httpd.shutdown()


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.link = ServerLink(read_info=self.stub.info, level_max_hz=10)

    def tearDown(self):
        self.link.close()
        self.stub.close()

    def test_jobs_and_events_with_token(self):
        self.stub.add_job({"id": "spk_1", "kind": "speak", "text": "Hi."})
        self.assertEqual(self.link.poll_jobs(wait=1), [{"id": "spk_1", "kind": "speak", "text": "Hi."}])
        self.link.start_sender()
        self.link.post({"type": "final", "text": "what needs me"})
        self.assertTrue(wait_for(lambda: self.stub.of("final")))

    def test_wrong_token_rereads_server_json(self):
        good = self.stub.info()
        infos = [{"port": good["port"], "token": "stale"}, good]
        link = ServerLink(read_info=lambda: infos.pop(0) if len(infos) > 1 else infos[0])
        link.refresh()
        from cosvoice.client import Unauthorized

        with self.assertRaises(Unauthorized):
            link.poll_jobs(wait=0)
        self.assertIsNone(link.info)
        link.refresh()
        self.assertEqual(link.poll_jobs(wait=0), [])

    def test_levels_capped_at_10_per_second(self):
        self.link.start_sender()
        t_end = time.monotonic() + 1.0
        while time.monotonic() < t_end:
            self.link.post({"type": "level", "rms": 0.5})
            time.sleep(0.002)
        time.sleep(0.2)
        times = [t for t, b in self.stub.events if b.get("type") == "level"]
        self.assertGreaterEqual(len(times), 5)
        self.assertLessEqual(len(times), 12)
        gaps = np.diff(times)
        self.assertGreaterEqual(float(gaps.min()), 0.08)

    def test_gone_after_no_answer(self):
        link = ServerLink(read_info=lambda: {"port": 1, "token": "x"}, gone_after_s=0.3)
        stop = threading.Event()
        t0 = time.monotonic()
        link.run_jobs(lambda j: None, stop)  # returns once the server counts as gone
        self.assertLess(time.monotonic() - t0, 5)
        self.assertTrue(link.gone())


class DaemonTest(unittest.TestCase):
    def make(self, block_s=0.0, wake=True):
        self.link = FakeLink()
        self.mic = FakeMic()
        self.sink = FakeSink(block_s)
        self.stt = FakeSTT()
        models = Models(FakeVAD(), FakeWake() if wake else None, self.stt, FakeTTS(), "cuda")
        d = Daemon(config(), self.link, models, mic=self.mic, sink=self.sink, echo=_NoEcho())
        d.speaker.start()
        return d

    def feed(self, d, value, n=1):
        for _ in range(n):
            d.feed(chunk(value))

    def test_status_events_and_control(self):
        d = self.make()
        d.start("wake", True)
        self.assertTrue(wait_for(lambda: self.mic.is_open))
        s = self.link.of("status")[-1]["status"]
        self.assertEqual((s["state"], s["listen"], s["speak"], s["wakeWord"], s["device"]),
                         ("listening", "wake", True, "hey chief", "cuda"))
        d.handle_job({"id": "ctl_1", "kind": "control", "listen": "off"})
        self.assertEqual(self.link.of("status")[-1]["status"]["state"], "off")
        self.assertTrue(wait_for(lambda: not self.mic.is_open))  # mic closed when listening is off
        d.shutdown()

    def test_wake_to_final(self):
        d = self.make()
        d.listen = "wake"
        d.pipeline.set_mode("wake")
        self.feed(d, WAKE)
        self.feed(d, SPEECH, 10)
        self.feed(d, 0, 11)
        self.assertEqual(len(self.link.of("wake")), 1)
        self.assertEqual(self.link.of("final"), [{"type": "final", "text": "What needs me?"}])
        states = [e["status"]["state"] for e in self.link.of("status")]
        self.assertIn("hearing", states)
        self.assertIn("thinking", states)
        self.assertGreater(len(self.link.of("level")), 0)
        d.shutdown()

    def test_speak_job_and_barge_in(self):
        d = self.make(block_s=0.4)
        d.listen = "wake"
        d.pipeline.set_mode("wake")
        d.handle_job({"id": "spk_9", "kind": "speak", "text": "One. Two. Three. Four."})
        self.assertTrue(wait_for(lambda: d.speaker.is_speaking))
        self.assertIn("speaking", [e["status"]["state"] for e in self.link.of("status")])
        self.feed(d, SPEECH, 10)  # our own voice: ignored
        self.assertEqual(self.link.of("wake"), [])
        self.feed(d, WAKE)        # "hey chief" while speaking: barge-in
        self.assertTrue(wait_for(lambda: self.link.of("spoken")))
        self.assertEqual(self.link.of("spoken"), [{"type": "spoken", "id": "spk_9", "ok": False}])
        self.assertEqual(d.pipeline.state, "capturing")
        d.shutdown()

    def test_speak_off_and_stop(self):
        d = self.make()
        d.handle_job({"id": "ctl", "kind": "control", "speak": False})
        d.handle_job({"id": "spk_x", "kind": "speak", "text": "Muted."})
        self.assertEqual(self.link.of("spoken"), [{"type": "spoken", "id": "spk_x", "ok": False}])
        d.handle_job({"id": "ctl", "kind": "control", "speak": True})
        d.handle_job({"id": "spk_y", "kind": "speak", "text": "Fine."})
        self.assertTrue(wait_for(lambda: len(self.link.of("spoken")) == 2))
        self.assertTrue(self.link.of("spoken")[1]["ok"])
        d.handle_job({"id": "spk_z", "kind": "stop", "text": ""})
        d.shutdown()

    def test_ptt_opens_mic_only_while_held(self):
        d = self.make()
        d.start("ptt", True)
        time.sleep(0.1)
        self.assertFalse(self.mic.is_open)
        d.handle_job({"id": "c1", "kind": "control", "pttDown": True})
        self.assertTrue(self.mic.is_open)
        self.feed(d, SPEECH, 20)
        d.handle_job({"id": "c2", "kind": "control", "pttDown": False})
        self.assertEqual(len(self.link.of("final")), 1)
        self.assertTrue(wait_for(lambda: not self.mic.is_open))
        d.shutdown()

    def test_no_wake_model_reports_it(self):
        d = self.make(wake=False)
        d.start("wake", True)
        s = self.link.of("status")[-1]["status"]
        self.assertIsNone(s["wakeWord"])
        self.assertIn("push-to-talk", s["detail"])
        self.assertFalse(self.mic.is_open)
        d.shutdown()

    def test_quit_job(self):
        d = self.make()
        d.handle_job({"id": "q", "kind": "quit"})
        self.assertTrue(d.stop_event.is_set())
        d.shutdown()


class _NoEcho:
    available = False

    def process(self, near, far):
        return near


if __name__ == "__main__":
    unittest.main()
