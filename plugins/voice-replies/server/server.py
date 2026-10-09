"""Local Kokoro TTS server for the voice-replies mod.

Loads Kokoro-82M on the GPU once and speaks text sent to it, so replies start fast.
Listens on 127.0.0.1 only. Exits by itself after IDLE_EXIT_SECONDS with no requests.

Endpoints:
  GET  /health        -> {"ok": true, "device": "cuda", "voices": [...]}
  POST /speak         {"text": str, "voice": str, "speed": float} -> {"ok": true, "id": int}
                      Returns at once; the speech plays in the background.
  GET  /status?id=N   -> {"ok": true, "state": "queued" | "speaking" | "done" | "stopped" | "error"}
  POST /stop          -> stops what is playing and anything queued
"""

import json
import os
import queue
import sys
import threading
import time
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
SAMPLE_RATE = 24000
IDLE_EXIT_SECONDS = 2 * 60 * 60
REPO = "hexgrad/Kokoro-82M"

VOICES = [
    "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
    "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]

device = "cuda" if torch.cuda.is_available() else "cpu"
model = KModel(repo_id=REPO).to(device).eval()
# "a" = American English, "b" = British English. Both share the one model.
pipelines = {code: KPipeline(lang_code=code, repo_id=REPO, model=model) for code in ("a", "b")}

# Jobs are numbered. A newer job, or a /stop, ends every older one.
state_lock = threading.Lock()
play_lock = threading.Lock()
latest_job = 0
stopped_upto = 0
job_states: dict[int, str] = {}
last_request = time.monotonic()


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def should_stop(job: int) -> bool:
    return job < latest_job or job <= stopped_upto


def set_state(job: int, state: str) -> None:
    with state_lock:
        job_states[job] = state
        for old in [j for j in job_states if j < job - 50]:
            del job_states[old]


def speak(job: int, text: str, voice: str, speed: float) -> str:
    """Generates and plays `text`, sentence by sentence. Returns 'done' or 'stopped'."""
    pipeline = pipelines["b" if voice.startswith("b") else "a"]
    chunks: "queue.Queue[np.ndarray | None]" = queue.Queue()

    def generate() -> None:
        try:
            for result in pipeline(text, voice=voice, speed=speed):
                if should_stop(job):
                    break
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


def run_job(job: int, text: str, voice: str, speed: float) -> None:
    # One voice at a time: wait for the older job to notice it was replaced.
    with play_lock:
        if should_stop(job):
            set_state(job, "stopped")
            return
        set_state(job, "speaking")
        try:
            result = speak(job, text, voice, speed)
        except Exception as err:  # noqa: BLE001 - report any audio/model failure
            log(f"job {job} failed: {err}")
            result = "error"
        set_state(job, result)
        log(f"job {job} {result}")


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

    def do_GET(self) -> None:
        global last_request
        last_request = time.monotonic()
        url = urlparse(self.path)
        if url.path == "/health":
            self.reply(200, {"ok": True, "device": device, "voices": VOICES})
        elif url.path == "/status":
            try:
                job = int(parse_qs(url.query).get("id", ["0"])[0])
            except ValueError:
                job = 0
            with state_lock:
                state = job_states.get(job, "done")
            self.reply(200, {"ok": True, "state": state})
        else:
            self.reply(404, {"ok": False})

    def do_POST(self) -> None:
        global last_request, latest_job, stopped_upto
        last_request = time.monotonic()
        if self.path == "/stop":
            with state_lock:
                stopped_upto = latest_job
            log(f"stop up to job {stopped_upto}")
            self.reply(200, {"ok": True})
            return
        if self.path != "/speak":
            self.reply(404, {"ok": False})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("text", "")).strip()[:4000]
            voice = str(body.get("voice", "af_heart"))
            speed = min(2.0, max(0.5, float(body.get("speed", 1.0))))
        except (ValueError, TypeError):
            self.reply(400, {"ok": False, "error": "bad request"})
            return
        if voice not in VOICES:
            self.reply(400, {"ok": False, "error": f"unknown voice {voice}"})
            return
        with state_lock:
            latest_job += 1
            job = latest_job
            job_states[job] = "queued" if text else "done"
        log(f"job {job} queued ({len(text)} chars, {voice}, {speed}x)")
        if text:
            threading.Thread(target=run_job, args=(job, text, voice, speed), daemon=True).start()
        self.reply(200, {"ok": True, "id": job})


def exit_when_idle(server: ThreadingHTTPServer) -> None:
    while True:
        time.sleep(60)
        if time.monotonic() - last_request > IDLE_EXIT_SECONDS and not play_lock.locked():
            server.shutdown()
            return


if __name__ == "__main__":
    # Warm up so the first real reply does not pay for loading voices and kernels.
    for code, voice in (("a", "af_heart"), ("b", "bf_emma")):
        for _ in pipelines[code]("Ready.", voice=voice):
            pass
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        sys.exit(0)  # Another copy already owns the port.
    threading.Thread(target=exit_when_idle, args=(server,), daemon=True).start()
    log(f"kokoro server ready on {PORT} ({device})")
    server.serve_forever()
