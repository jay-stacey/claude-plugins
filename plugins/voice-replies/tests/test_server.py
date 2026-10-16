"""Tests for server/server.py, the local Kokoro TTS server of the voice-replies plugin.

No model and no audio device are needed. torch, kokoro and sounddevice are replaced by
stubs before server.py is imported (numpy is stubbed only when it is not installed).
The real HTTP handler and the real worker thread run against those stubs.

Run from the repo root:
    python -m unittest discover -s plugins/voice-replies/tests -p "test_server.py" -v
"""

import importlib.util
import json
import os
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

SERVER_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "server", "server.py"
)

CHUNK_SAMPLES = 2400  # 100 ms at 24 kHz: exactly one block per chunk
CHUNKS_PER_JOB = 3
GATE_TIMEOUT = 5.0


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------

try:
    import numpy as _real_numpy  # noqa: F401
    HAVE_NUMPY = True
except ImportError:  # pragma: no cover - depends on the machine
    HAVE_NUMPY = False


class Fakes:
    """Shared, resettable state that the stubs write to and the tests read."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.calls: list[tuple] = []      # (text, voice, speed) per pipeline call
            self.codes: dict[str, int] = {}   # text -> number written into the audio
            self.writes: list[int] = []       # code of each audio block that was "played"
            self.gates: dict[str, threading.Event] = {}  # text -> event to release
            self.streams_open = 0
            self.in_flight = 0                # speak() calls that have not returned

    def code_for(self, text: str) -> int:
        with self.lock:
            return self.codes.setdefault(text, len(self.codes) + 1)

    def text_for(self, code: int) -> str:
        with self.lock:
            return next(t for t, c in self.codes.items() if c == code)

    def played(self) -> list[str]:
        """Texts that reached the sounddevice stub, in order, repeats collapsed."""
        with self.lock:
            codes = list(self.writes)
        out: list[int] = []
        for code in codes:
            if code == 0:  # a pause between lines: silence, not a text
                continue
            if not out or out[-1] != code:
                out.append(code)
        return [self.text_for(c) for c in out]

    def pipeline_texts(self) -> list[str]:
        with self.lock:
            return [c[0] for c in self.calls]


FAKES = Fakes()


def _make_array(value: float):
    if HAVE_NUMPY:
        import numpy
        return numpy.full(CHUNK_SAMPLES, value, dtype="float32")
    return [float(value)] * CHUNK_SAMPLES


class _FakeAudio:
    """Mimics a torch tensor: .detach().cpu().numpy().astype(dtype)."""

    def __init__(self, value: float) -> None:
        self.value = value

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self

    def astype(self, _dtype):
        return _make_array(self.value)


class _FakePipeline:
    def __init__(self, lang_code=None, repo_id=None, model=None) -> None:
        self.lang_code = lang_code

    def __call__(self, text, voice=None, speed=1.0):
        code = FAKES.code_for(text)
        with FAKES.lock:
            FAKES.calls.append((text, voice, speed))
            gate = FAKES.gates.get(text)
        return self._generate(code, gate)

    @staticmethod
    def _generate(code, gate):
        if gate is not None:
            gate.wait(GATE_TIMEOUT)
        for _ in range(CHUNKS_PER_JOB):
            yield SimpleNamespace(audio=_FakeAudio(code))
            time.sleep(0.002)


class _FakeModel:
    def to(self, _device):
        return self

    def eval(self):
        return self


class _FakeOutputStream:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs

    def __enter__(self):
        with FAKES.lock:
            FAKES.streams_open += 1
        return self

    def __exit__(self, *exc):
        with FAKES.lock:
            FAKES.streams_open -= 1
        return False

    def write(self, data) -> None:
        with FAKES.lock:
            FAKES.writes.append(int(data[0]))
        time.sleep(0.01)


def _build_stubs() -> dict:
    torch = types.ModuleType("torch")
    torch.cuda = SimpleNamespace(
        is_available=lambda: False,
        get_device_name=lambda _i: "stub",
    )
    torch.set_num_threads = lambda _n: None

    kokoro = types.ModuleType("kokoro")
    kokoro.KModel = lambda repo_id=None: _FakeModel()
    kokoro.KPipeline = _FakePipeline

    sounddevice = types.ModuleType("sounddevice")
    sounddevice.OutputStream = _FakeOutputStream

    stubs = {"torch": torch, "kokoro": kokoro, "sounddevice": sounddevice}
    if not HAVE_NUMPY:  # pragma: no cover - depends on the machine
        numpy = types.ModuleType("numpy")
        numpy.float32 = "float32"
        numpy.ndarray = list
        numpy.zeros = lambda n, dtype=None: [0.0] * n
        stubs["numpy"] = numpy
    return stubs


# ---------------------------------------------------------------------------
# Module-level setup: import server with stubs, start the HTTP server and worker
# ---------------------------------------------------------------------------

server = None
httpd = None
BASE = ""
_saved_modules: dict = {}
_saved_argv: list = []


def setUpModule() -> None:
    global server, httpd, BASE, _saved_argv
    stubs = _build_stubs()
    _saved_modules.update({name: sys.modules.get(name) for name in stubs})
    _saved_argv = list(sys.argv)
    sys.modules.update(stubs)
    sys.argv = ["server.py"]
    try:
        spec = importlib.util.spec_from_file_location(
            "voice_replies_server", os.path.abspath(SERVER_PATH)
        )
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
    finally:
        sys.argv = _saved_argv
        for name, original in _saved_modules.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original

    # Track speak() calls so tearDown can tell when the worker is really idle.
    real_speak = server.speak

    def counting_speak(*args, **kwargs):
        with FAKES.lock:
            FAKES.in_flight += 1
        try:
            return real_speak(*args, **kwargs)
        finally:
            with FAKES.lock:
                FAKES.in_flight -= 1

    server.speak = counting_speak
    server.log = lambda _message: None  # keep the test output quiet

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    BASE = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=server.worker, daemon=True).start()


def tearDownModule() -> None:
    if httpd is not None:
        httpd.shutdown()
        httpd.server_close()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def request(method: str, path: str, body=None, raw: bytes | None = None):
    """Returns (status, parsed JSON). 4xx and 5xx do not raise."""
    data = raw
    if data is None and body is not None:
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def speak(text, session="A", tag="", when="queue", **extra):
    payload = {"text": text, "session": session, "tag": tag, "when": when, **extra}
    return request("POST", "/speak", payload)


def state_of(job_id: int) -> str:
    _, body = request("GET", f"/status?id={job_id}")
    return body["state"]


def wait_for(predicate, timeout: float = 5.0, what: str = "condition") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def wait_state(job_id: int, wanted: str, timeout: float = 5.0) -> None:
    wait_for(lambda: state_of(job_id) == wanted, timeout, f"job {job_id} to be {wanted}")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class ServerTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._idle()
        with server.jobs_cond:
            server.jobs.clear()
            server.pending.clear()
            server.latest_job = 0
            server.last_session = None
        FAKES.reset()

    def tearDown(self) -> None:
        self._idle()

    def _idle(self) -> None:
        """Stops every job, releases every gate, waits for the worker to go quiet."""
        with FAKES.lock:
            gates = list(FAKES.gates.values())
        for gate in gates:
            gate.set()
        if server is not None:
            request("POST", "/stop", {})
            wait_for(
                lambda: not server.is_busy() and FAKES.in_flight == 0 and FAKES.streams_open == 0,
                what="the worker to go idle",
            )
            time.sleep(0.03)  # the worker's last bookkeeping step after speak() returns

    def gate(self, text: str) -> threading.Event:
        """Makes the fake pipeline hold `text` until the test sets the returned event."""
        event = threading.Event()
        with FAKES.lock:
            FAKES.gates[text] = event
        return event


class QueueTests(ServerTestCase):
    def test_two_sessions_play_in_order_and_neither_is_stopped(self) -> None:
        gate_a = self.gate("first from A")

        status, a = speak("first from A", session="A", tag="Alpha")
        self.assertEqual((status, a["state"]), (200, "queued"))
        wait_state(a["id"], "speaking")

        status, b = speak("second from B", session="B", tag="Beta")
        self.assertEqual((status, b["state"]), (200, "queued"))
        self.assertNotEqual(a["id"], b["id"])

        # B arriving must not stop A, and B waits for its turn.
        time.sleep(0.1)
        self.assertEqual(state_of(a["id"]), "speaking")
        self.assertEqual(state_of(b["id"]), "queued")
        self.assertEqual(FAKES.played(), [])

        gate_a.set()
        wait_state(a["id"], "done")
        wait_state(b["id"], "done")

        self.assertEqual(state_of(a["id"]), "done")
        self.assertEqual(state_of(b["id"]), "done")
        # A played all of its audio before B started: A then B, no interleaving.
        played_codes = list(FAKES.writes)
        code_a = FAKES.codes["first from A"]
        code_b = FAKES.codes["Beta. second from B"]
        self.assertEqual(played_codes, [code_a] * CHUNKS_PER_JOB + [code_b] * CHUNKS_PER_JOB)
        self.assertEqual(FAKES.played(), ["first from A", "Beta. second from B"])


class IdleTests(ServerTestCase):
    def test_idle_request_while_speaking_returns_busy_and_queues_nothing(self) -> None:
        gate_a = self.gate("speaking now")
        _, a = speak("speaking now", session="A", tag="Alpha")
        wait_state(a["id"], "speaking")

        with server.jobs_cond:
            jobs_before = dict(server.jobs)

        status, body = speak("please wait", session="B", tag="Beta", when="idle")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "busy")
        self.assertIsNone(body["id"])
        self.assertEqual(body["by"], "Alpha")

        with server.jobs_cond:
            self.assertEqual(set(server.jobs), set(jobs_before))
            self.assertEqual(list(server.pending), [])
            self.assertEqual(server.latest_job, a["id"])

        gate_a.set()
        wait_state(a["id"], "done")
        self.assertNotIn("please wait", FAKES.pipeline_texts())

    def test_idle_request_is_accepted_when_nothing_is_active(self) -> None:
        # Control for the test above: "busy" must depend on an active job.
        status, body = speak("nobody is talking", when="idle")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "queued")
        self.assertIsInstance(body["id"], int)
        wait_state(body["id"], "done")


class StopTests(ServerTestCase):
    def test_stop_with_session_stops_only_that_session(self) -> None:
        gate_a = self.gate("A one")
        _, a1 = speak("A one", session="A", tag="Alpha")
        wait_state(a1["id"], "speaking")
        _, a2 = speak("A two", session="A", tag="Alpha")
        _, b = speak("B one", session="B", tag="Beta")

        # A session with no jobs changes nothing.
        status, _ = request("POST", "/stop", {"session": "Z"})
        self.assertEqual(status, 200)
        self.assertEqual(state_of(a1["id"]), "speaking")
        self.assertEqual(state_of(a2["id"]), "queued")
        self.assertEqual(state_of(b["id"]), "queued")

        status, body = request("POST", "/stop", {"session": "A"})
        self.assertEqual((status, body), (200, {"ok": True}))
        self.assertEqual(state_of(a1["id"]), "stopped")
        self.assertEqual(state_of(a2["id"]), "stopped")
        self.assertEqual(state_of(b["id"]), "queued")

        gate_a.set()
        wait_state(b["id"], "done")

        self.assertEqual(state_of(a1["id"]), "stopped")
        self.assertEqual(state_of(a2["id"]), "stopped")
        self.assertEqual(state_of(b["id"]), "done")
        # A's second job never reached the pipeline, and only B's audio was played.
        self.assertEqual(FAKES.played(), ["Beta. B one"])
        self.assertNotIn("A two", FAKES.pipeline_texts())

    def test_stop_without_a_body_stops_only_jobs_with_no_session(self) -> None:
        # Plugin 1.2 and older send /speak with no session and /stop with no body.
        self.gate("old one")
        _, old = speak("old one", session="")
        wait_state(old["id"], "speaking")
        _, new = speak("new one", session="B", tag="Beta")

        status, body = request("POST", "/stop")  # no body at all
        self.assertEqual((status, body), (200, {"ok": True}))
        self.assertEqual(state_of(old["id"]), "stopped")
        self.assertEqual(state_of(new["id"]), "queued")

        with FAKES.lock:
            FAKES.gates["old one"].set()
        wait_state(new["id"], "done")
        self.assertIn("Beta. new one", FAKES.pipeline_texts())

    def test_stop_with_an_empty_object_stops_every_active_job(self) -> None:
        self.gate("A one")
        _, a = speak("A one", session="A", tag="Alpha")
        wait_state(a["id"], "speaking")
        _, b = speak("B one", session="B", tag="Beta")
        _, c = speak("C one", session="C", tag="Gamma")

        status, body = request("POST", "/stop", {})
        self.assertEqual((status, body), (200, {"ok": True}))

        for job in (a, b, c):
            self.assertEqual(state_of(job["id"]), "stopped")

        # Release A's held pipeline so the worker can unwind, then check nothing else ran.
        with FAKES.lock:
            FAKES.gates["A one"].set()
        wait_for(
            lambda: not server.is_busy() and FAKES.in_flight == 0,
            what="the worker to go idle",
        )
        time.sleep(0.05)
        for job in (a, b, c):
            self.assertEqual(state_of(job["id"]), "stopped")
        self.assertEqual(FAKES.played(), [])
        self.assertEqual(FAKES.pipeline_texts(), ["A one"])

        # The server still works after a global stop.
        _, d = speak("after the stop", session="D")
        wait_state(d["id"], "done")

    def test_a_broken_stop_body_is_400_and_stops_nothing(self) -> None:
        self.gate("A one")
        _, a = speak("A one", session="A", tag="Alpha")
        wait_state(a["id"], "speaking")

        for raw in (b"{not json", b"[]", b'{"session": 7}'):
            with self.subTest(body=raw):
                status, _ = request("POST", "/stop", raw=raw)
                self.assertEqual(status, 400)
                self.assertEqual(state_of(a["id"]), "speaking")

        with FAKES.lock:
            FAKES.gates["A one"].set()
        wait_state(a["id"], "done")


class TagTests(ServerTestCase):
    def _speak_and_wait(self, text: str, session: str, tag: str) -> None:
        _, job = speak(text, session=session, tag=tag)
        wait_state(job["id"], "done")

    def test_tag_is_spoken_only_when_the_session_changes(self) -> None:
        self._speak_and_wait("one from A", "A", "Alpha")      # very first job ever
        self._speak_and_wait("two from B", "B", "Beta")       # session changed
        self._speak_and_wait("three from B", "B", "Beta")     # same session as the last job
        self._speak_and_wait("four from A", "A", "Alpha")     # session changed back

        self.assertEqual(
            FAKES.pipeline_texts(),
            ["one from A", "Beta. two from B", "three from B", "Alpha. four from A"],
        )

    def test_no_tag_is_spoken_when_the_job_has_no_tag(self) -> None:
        self._speak_and_wait("one from A", "A", "Alpha")
        self._speak_and_wait("two from B", "B", "")
        self.assertEqual(FAKES.pipeline_texts(), ["one from A", "two from B"])


class PauseTests(ServerTestCase):
    def test_each_line_is_spoken_on_its_own_with_silence_between(self) -> None:
        _, job = speak("Jay,\nThe tests pass.\n\nNext, commit.")
        wait_state(job["id"], "done")

        self.assertEqual(FAKES.pipeline_texts(), ["Jay,", "The tests pass.", "Next, commit."])
        self.assertEqual(FAKES.played(), ["Jay,", "The tests pass.", "Next, commit."])
        with FAKES.lock:
            writes = list(FAKES.writes)
        # Silence (0) sits after the name and between the two sentences, never at the start.
        runs = [code for i, code in enumerate(writes) if i == 0 or writes[i - 1] != code]
        name, first, second = (FAKES.code_for(t) for t in ("Jay,", "The tests pass.", "Next, commit."))
        self.assertEqual(runs, [name, 0, first, 0, second])


class HealthTests(ServerTestCase):
    def test_health_reports_api_3(self) -> None:
        status, body = request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertIs(body["ok"], True)
        self.assertEqual(body["api"], 3)
        self.assertEqual(body["device"], "cpu")
        self.assertIn("af_heart", body["voices"])


class BadInputTests(ServerTestCase):
    def assert_rejected(self, status: int, body: dict) -> None:
        self.assertEqual(status, 400)
        self.assertIs(body["ok"], False)
        self.assertIn("error", body)
        # A rejected request creates no job and starts no speech.
        with server.jobs_cond:
            self.assertEqual(server.jobs, {})
            self.assertEqual(list(server.pending), [])
        self.assertEqual(FAKES.calls, [])

    def test_unknown_when_is_400(self) -> None:
        self.assert_rejected(*speak("hello", when="later"))

    def test_unknown_voice_is_400(self) -> None:
        self.assert_rejected(*speak("hello", voice="not_a_voice"))

    def test_non_object_json_body_is_400(self) -> None:
        for raw in (b"[1, 2]", b'"text"', b"42", b"null"):
            with self.subTest(body=raw):
                self.assert_rejected(*request("POST", "/speak", raw=raw))

    def test_malformed_json_body_is_400(self) -> None:
        self.assert_rejected(*request("POST", "/speak", raw=b"{not json"))

    def test_non_numeric_speed_is_400(self) -> None:
        self.assert_rejected(*speak("hello", speed="fast"))

    def test_valid_request_still_works_after_bad_ones(self) -> None:
        # Control: the checks above reject bad input, not everything.
        status, body = speak("hello", voice="bf_emma", when="queue")
        self.assertEqual((status, body["state"]), (200, "queued"))
        wait_state(body["id"], "done")
        self.assertEqual(FAKES.calls[0][1], "bf_emma")


if __name__ == "__main__":
    unittest.main()
