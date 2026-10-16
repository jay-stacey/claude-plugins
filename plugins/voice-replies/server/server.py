"""Local Kokoro TTS server for the voice-replies mod.

Loads Kokoro-82M once (on the GPU or CPU that setup.ps1 chose) and speaks text sent to it, so replies start fast.
Listens on 127.0.0.1 only. Exits by itself after IDLE_EXIT_SECONDS with no requests.

Every Claude session shares this one server. Jobs play one at a time, in the order they
arrive, and a session can stop only its own jobs.

Endpoints:
  GET  /health        -> {"ok": true, "api": 3, "device": "cuda", "voices": [...]}
  POST /speak         {"text": str, "voice": str, "speed": float,
                       "session": str, "tag": str, "when": "idle" | "queue"}
                      -> {"ok": true, "id": int, "state": "queued"}
                      With "when": "idle" while any job is queued or playing, nothing is
                      queued: {"ok": true, "id": null, "state": "busy", "by": tag}.
                      Returns at once; the speech plays in the background. When a job
                      plays right after a different session's, the server says its tag first.
                      Each line of the text is spoken on its own, with a short pause between
                      lines, so "Jay,\\nThe tests pass." pauses after the name as a person would.
  GET  /status?id=N   -> {"ok": true, "state": "queued" | "speaking" | "done" | "stopped" | "error"}
  POST /stop          {"session": str} stops that session's jobs; {} stops every job. No body
                      (plugin 1.2 and older) stops only jobs sent with no session.
  POST /shutdown      -> the server exits (the plugin uses it to start a newer copy)
"""

import json
import os
import queue
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Under pythonw.exe (no console) stdout and stderr are None, and any library that
# logs a warning crashes. Send them to a log file instead.
if sys.stdout is None or sys.stderr is None:
    _log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    os.makedirs(_log_dir, exist_ok=True)
    _log = open(os.path.join(_log_dir, "server.log"), "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

import numpy as np
import sounddevice as sd
import torch
from kokoro import KModel, KPipeline

PORT = 47861
# The plugin restarts a server that reports an older API.
API_VERSION = 3
MAX_TEXT = 20000
SAMPLE_RATE = 24000
IDLE_EXIT_SECONDS = 2 * 60 * 60
# The silence between two lines of a script: after the person's name, and between topics.
PAUSE_SECONDS = 0.3
REPO = "hexgrad/Kokoro-82M"

VOICES = [
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
    "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

HERE = os.path.dirname(os.path.abspath(__file__))


def pick_device() -> str:
    """The device setup.ps1 chose and tested (config.json), unless `--check <device>` names one.

    Falls back to the CPU when CUDA was chosen but is not there now, for example after a
    driver change.
    """
    wanted = None
    if len(sys.argv) >= 3 and sys.argv[1] == "--check":
        wanted = sys.argv[2]
    else:
        try:
            with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
                wanted = json.load(f).get("device")
        except (OSError, ValueError):
            pass
    if wanted == "cuda" and torch.cuda.is_available():
        return "cuda"
    if wanted == "cuda":
        print("CUDA was chosen but is not available; using the CPU", file=sys.stderr)
    if wanted is None and torch.cuda.is_available():
        return "cuda"
    return "cpu"


device = pick_device()
if device == "cpu":
    # Leave a few cores for the rest of the machine while a reply is generated.
    torch.set_num_threads(max(1, min(8, (os.cpu_count() or 2) - 2)))
model = KModel(repo_id=REPO).to(device).eval()
# "a" = American English, "b" = British English. Both share the one model.
pipelines = {code: KPipeline(lang_code=code, repo_id=REPO, model=model) for code in ("a", "b")}

# Jobs are numbered. One worker thread plays them oldest first. /stop marks a session's
# jobs "stopped", and the player checks for that between 100 ms blocks of audio.
jobs_cond = threading.Condition()
jobs: dict[int, dict] = {}
pending: "deque[int]" = deque()
latest_job = 0
last_session: str | None = None
last_request = time.monotonic()
ACTIVE = ("queued", "speaking")


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def should_stop(job: int) -> bool:
    entry = jobs.get(job)
    return entry is None or entry["state"] == "stopped"


def is_busy() -> bool:
    return any(entry["state"] in ACTIVE for entry in jobs.values())


def forget_old_jobs() -> None:
    """Keeps the newest 50 finished jobs, so /status can still answer for them."""
    finished = sorted(j for j, entry in jobs.items() if entry["state"] not in ACTIVE)
    for old in finished[:-50]:
        del jobs[old]


def lines_of(text: str) -> list[str]:
    """The lines of a script that hold words, trimmed. Each is spoken on its own."""
    return [line.strip() for line in text.splitlines() if line.strip()]


def speak(job: int, text: str, voice: str, speed: float) -> str:
    """Generates and plays `text`, line by line with a pause between lines.

    Returns 'done' or 'stopped'.
    """
    pipeline = pipelines["b" if voice.startswith("b") else "a"]
    chunks: "queue.Queue[np.ndarray | None]" = queue.Queue()
    # Speed shortens the pause too, so a fast voice does not sound halting.
    pause = int(SAMPLE_RATE * PAUSE_SECONDS / max(speed, 0.5))

    def generate() -> None:
        try:
            for index, line in enumerate(lines_of(text)):
                if should_stop(job):
                    return
                if index > 0:
                    chunks.put(np.zeros(pause, dtype=np.float32))
                for result in pipeline(line, voice=voice, speed=speed):
                    if should_stop(job):
                        return
                    if result.audio is not None:
                        chunks.put(result.audio.detach().cpu().numpy().astype(np.float32))
        finally:
            chunks.put(None)

    threading.Thread(target=generate, daemon=True).start()
    block = SAMPLE_RATE // 10  # 100 ms, so Stop takes effect fast
    with sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32") as stream:
        while True:
            audio = chunks.get()
            if audio is None:
                return "stopped" if should_stop(job) else "done"
            for start in range(0, len(audio), block):
                if should_stop(job):
                    return "stopped"
                stream.write(audio[start:start + block])


def worker() -> None:
    """Plays queued jobs one at a time, oldest first."""
    global last_session
    while True:
        with jobs_cond:
            while not pending:
                jobs_cond.wait()
            job = pending.popleft()
            entry = jobs.get(job)
            if entry is None or entry["state"] != "queued":
                continue
            entry["state"] = "speaking"
            text = entry["text"]
            # Say which session this is when the voice moves from one session to another.
            if entry["tag"] and last_session is not None and entry["session"] != last_session:
                text = f"{entry['tag']}. {text}"
            last_session = entry["session"]
        try:
            result = speak(job, text, entry["voice"], entry["speed"])
        except Exception as err:  # noqa: BLE001 - report any audio/model failure
            log(f"job {job} failed: {err}")
            result = "error"
        with jobs_cond:
            if entry["state"] == "speaking":
                entry["state"] = result
            log(f"job {job} {entry['state']}")
            forget_old_jobs()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(body, dict):
            raise ValueError("the body is not a JSON object")
        return body

    def do_GET(self) -> None:
        global last_request
        last_request = time.monotonic()
        url = urlparse(self.path)
        if url.path == "/health":
            self.reply(200, {"ok": True, "api": API_VERSION, "device": device, "voices": VOICES})
        elif url.path == "/status":
            try:
                job = int(parse_qs(url.query).get("id", ["0"])[0])
            except ValueError:
                job = 0
            with jobs_cond:
                entry = jobs.get(job)
                state = entry["state"] if entry is not None else "done"
            self.reply(200, {"ok": True, "state": state})
        else:
            self.reply(404, {"ok": False})

    def do_POST(self) -> None:
        global last_request, latest_job
        last_request = time.monotonic()
        if self.path == "/shutdown":
            log("shutdown asked for")
            self.reply(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path == "/stop":
            # {"session": s} stops that session; {} stops every session. No body at all comes
            # from plugin 1.2 and older, which name no session: stop only their jobs (session
            # ""), so an old session cannot silence new ones. A broken body stops nothing.
            if int(self.headers.get("Content-Length", "0") or 0) == 0:
                session = ""
            else:
                try:
                    session = self.read_json().get("session")
                except (ValueError, TypeError):
                    self.reply(400, {"ok": False, "error": "bad request"})
                    return
            if session is not None and not isinstance(session, str):
                self.reply(400, {"ok": False, "error": "session must be a string"})
                return
            with jobs_cond:
                for entry in jobs.values():
                    if entry["state"] in ACTIVE and (session is None or entry["session"] == session):
                        entry["state"] = "stopped"
            log("stop every session" if session is None else "stop one session" if session else "stop old sessions")
            self.reply(200, {"ok": True})
            return
        if self.path != "/speak":
            self.reply(404, {"ok": False})
            return
        try:
            body = self.read_json()
            text = str(body.get("text", "")).strip()[:MAX_TEXT]
            voice = str(body.get("voice", "af_heart"))
            speed = min(2.0, max(0.5, float(body.get("speed", 1.0))))
            session = str(body.get("session", ""))[:100]
            tag = str(body.get("tag", "")).strip()[:60]
            when = str(body.get("when", "queue"))
        except (ValueError, TypeError):
            self.reply(400, {"ok": False, "error": "bad request"})
            return
        if voice not in VOICES:
            self.reply(400, {"ok": False, "error": f"unknown voice {voice}"})
            return
        if when not in ("idle", "queue"):
            self.reply(400, {"ok": False, "error": "when must be idle or queue"})
            return
        with jobs_cond:
            if when == "idle" and is_busy():
                by = next((e["tag"] for e in jobs.values() if e["state"] in ACTIVE), "")
                body_out = {"ok": True, "id": None, "state": "busy", "by": by}
                job = None
            else:
                latest_job += 1
                job = latest_job
                state = "queued" if text else "done"
                jobs[job] = {
                    "state": state,
                    "session": session,
                    "tag": tag,
                    "text": text,
                    "voice": voice,
                    "speed": speed,
                }
                if text:
                    pending.append(job)
                    jobs_cond.notify()
                body_out = {"ok": True, "id": job, "state": state}
        if job is not None:
            log(f"job {job} queued ({len(text)} chars, {voice}, {speed}x)")
        self.reply(200, body_out)


def exit_when_idle(server: ThreadingHTTPServer) -> None:
    while True:
        time.sleep(60)
        with jobs_cond:
            busy = is_busy()
        if time.monotonic() - last_request > IDLE_EXIT_SECONDS and not busy:
            server.shutdown()
            return


def check() -> None:
    """`server.py --check <cuda|cpu>`: setup.ps1's test. Speaks into memory, plays nothing."""
    if sys.argv[2] == "cuda" and device != "cuda":
        sys.exit(1)
    for code, voice in (("a", "af_heart"), ("b", "bf_emma")):
        for _ in pipelines[code]("Ready.", voice=voice):
            pass
    started = time.perf_counter()
    samples = 0
    for result in pipelines["a"]("Voice replies are ready. This sentence checks how fast it speaks.", voice="af_heart"):
        if result.audio is not None:
            samples += len(result.audio)
    took = time.perf_counter() - started
    seconds = samples / SAMPLE_RATE
    if seconds == 0:
        print("Kokoro made no audio", file=sys.stderr)
        sys.exit(1)
    name = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    print(f"Kokoro on {name}: {seconds:.1f} s of speech in {took:.2f} s ({seconds / took:.0f}x real time)")


if __name__ == "__main__" and len(sys.argv) >= 3 and sys.argv[1] == "--check":
    check()
elif __name__ == "__main__":
    # Warm up so the first real reply does not pay for loading voices and kernels.
    for code, voice in (("a", "af_heart"), ("b", "bf_emma")):
        for _ in pipelines[code]("Ready.", voice=voice):
            pass
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        sys.exit(0)  # Another copy already owns the port.
    threading.Thread(target=exit_when_idle, args=(server,), daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()
    log(f"kokoro server ready on {PORT} ({device})")
    server.serve_forever()
