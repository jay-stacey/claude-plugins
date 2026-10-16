"""Speaking replies: clause by clause, the next clause synthesized while one plays.

Adapted from Pepper playback.py (fast cancel, render reference for echo cancellation) and
speak_queue.py (synthesize ahead, play in order). Sinks: the PC speakers, or WAV files
(simulate mode and tests).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

import numpy as np

from .text import clauses, speakable

LOG = logging.getLogger("cosvoice")


class SpeakerSink:
    """The PC's default output device through sounddevice. One stream per reply."""

    def __init__(self, device=None, render_reference=None, block_s: float = 0.02) -> None:
        self.device = device
        self.render_reference = render_reference
        self.block_s = block_s
        self._stream = None
        self._sr = None

    def open(self, sr: int) -> None:
        if self._stream is not None and self._sr == sr:
            return
        self.close()
        import sounddevice as sd

        self._stream = sd.OutputStream(samplerate=sr, channels=1, dtype="float32", device=self.device)
        self._stream.start()
        self._sr = sr

    def play(self, audio: np.ndarray, sr: int, cancel: threading.Event, started: Callable[[], None]) -> bool:
        self.open(sr)
        audio = np.ascontiguousarray(audio, dtype=np.float32).reshape(-1)
        block = max(1, int(sr * self.block_s))
        first = True
        for i in range(0, len(audio), block):
            if cancel.is_set():
                try:
                    self._stream.abort()
                except Exception:
                    pass
                self.close()
                return False
            piece = audio[i:i + block]
            if self.render_reference is not None:
                self.render_reference.push(piece, sr)
            self._stream.write(piece)
            if first:
                first = False
                started()
        return not cancel.is_set()

    def finish(self) -> None:
        """End of a reply: let the device drain, then close."""
        self.close()

    def close(self) -> None:
        stream, self._stream = self._stream, None
        self._sr = None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass


class WavSink:
    """Writes each reply to <out>/<id>.wav (plus one file per clause) instead of playing it."""

    def __init__(self, out_dir: str | Path) -> None:
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.files: list[Path] = []
        self._parts: list[np.ndarray] = []
        self._sr = 24000
        self.job_id = "reply"

    def open(self, sr: int) -> None:
        self._sr = sr

    def play(self, audio, sr, cancel, started) -> bool:
        from .audio import resample, write_wav

        if cancel.is_set():
            return False
        started()
        n = len(self._parts)
        p = self.out / f"{self.job_id}-{n + 1:02d}.wav"
        write_wav(p, audio, sr)
        self._parts.append(resample(audio, sr, self._sr) if sr != self._sr else np.asarray(audio, np.float32))
        return True

    def finish(self) -> None:
        from .audio import write_wav

        if self._parts:
            p = self.out / f"{self.job_id}.wav"
            gap = np.zeros(int(self._sr * 0.12), dtype=np.float32)
            joined = np.concatenate([x for part in self._parts for x in (part, gap)])
            write_wav(p, joined, self._sr)
            self.files.append(p)
        self._parts = []

    def close(self) -> None:
        self._parts = []


class Speaker:
    """One reply at a time, in arrival order. stop() cancels the current one and the queue."""

    def __init__(self, synthesize: Callable[[str], tuple[np.ndarray, int]], sink, on_event: Callable[[str, dict], None],
                 tail_ms: int = 300) -> None:
        self._synth = synthesize
        self.sink = sink
        self._on_event = on_event
        self.tail_s = tail_ms / 1000
        self._jobs: queue.Queue = queue.Queue()
        self._cancel = threading.Event()
        self._busy = threading.Event()
        self._audio_until = 0.0
        self._playing = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts-synth")
        self.current: str | None = None
        self.last_metrics: dict = {}

    # ------------------------------------------------------------------ api
    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="speaker", daemon=True)
        self._thread.start()

    def submit(self, job_id: str, text: str) -> None:
        self._jobs.put((job_id, text))

    def stop(self, reason: str = "stop") -> None:
        """Stop now: the current reply and every queued one end with spoken ok:false."""
        dropped = []
        while True:
            try:
                dropped.append(self._jobs.get_nowait())
            except queue.Empty:
                break
        if self.current is not None:
            self._cancel.set()
        for job_id, _ in dropped:
            self._emit("spoken", {"id": job_id, "ok": False, "reason": reason})

    @property
    def is_speaking(self) -> bool:
        """Audio is on the speakers now, or ended less than tail_ms ago (room echo)."""
        return self._playing or time.monotonic() < self._audio_until

    @property
    def is_busy(self) -> bool:
        return self._busy.is_set() or not self._jobs.empty()

    def wait_idle(self, timeout: float = 60.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if not self.is_busy:
                return True
            time.sleep(0.02)
        return False

    def close(self) -> None:
        self._stop.set()
        self.stop("shutdown")
        self._jobs.put(None)
        if self._thread:
            self._thread.join(timeout=5)
        self._pool.shutdown(wait=False, cancel_futures=True)
        try:
            self.sink.close()
        except Exception:
            pass

    # ------------------------------------------------------------- internals
    def _emit(self, kind: str, payload: dict) -> None:
        try:
            self._on_event(kind, payload)
        except Exception:
            LOG.exception("speaker event callback failed")

    def _loop(self) -> None:
        while not self._stop.is_set():
            item = self._jobs.get()
            if item is None:
                break
            job_id, text = item
            self._busy.set()
            self.current = job_id
            self._cancel.clear()
            try:
                ok = self._speak(job_id, text)
            except Exception:
                LOG.exception("speaking %s failed", job_id)
                ok = False
            finally:
                self.current = None
                self._playing = False
                self._audio_until = time.monotonic() + self.tail_s
                self._busy.clear()
            self._emit("spoken", {"id": job_id, "ok": ok})

    def _speak(self, job_id: str, text: str) -> bool:
        parts = clauses(speakable(text))
        t0 = time.perf_counter()
        metrics = {"id": job_id, "clauses": len(parts), "ttfa_s": None, "synth_s": []}
        self.last_metrics = metrics
        if not parts:
            return True
        if hasattr(self.sink, "job_id"):
            self.sink.job_id = job_id

        def synth(i: int):
            s0 = time.perf_counter()
            audio, sr = self._synth(parts[i])
            metrics["synth_s"].append(round(time.perf_counter() - s0, 3))
            return audio, sr

        self._emit("speaking", {"id": job_id})
        future = self._pool.submit(synth, 0)
        ok = True
        try:
            for i in range(len(parts)):
                audio, sr = future.result()
                if i + 1 < len(parts):
                    future = self._pool.submit(synth, i + 1)
                if self._cancel.is_set():
                    ok = False
                    break

                def started():
                    if metrics["ttfa_s"] is None:
                        metrics["ttfa_s"] = round(time.perf_counter() - t0, 3)
                        LOG.info("first audio for %s after %.2fs", job_id, metrics["ttfa_s"])
                    self._playing = True

                if not self.sink.play(audio, sr, self._cancel, started):
                    ok = False
                    break
            return ok and not self._cancel.is_set()
        finally:
            self._playing = False
            try:
                self.sink.finish()
            except Exception:
                LOG.exception("closing the output failed")
