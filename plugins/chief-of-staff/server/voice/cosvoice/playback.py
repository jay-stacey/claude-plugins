"""Speaking replies: chunk by chunk, synthesized ahead of playback (also across replies).

Adapted from Pepper playback.py (fast cancel, render reference for echo cancellation) and
speak_queue.py (synthesize ahead, play in order). Sinks: the PC speakers, or WAV files
(simulate mode and tests).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np

from .text import chunks, speakable

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
    """Replies in arrival order, synthesized ahead of playback, also across replies.

    A producer thread synthesizes chunk after chunk (and the next reply's chunks) while a
    player thread plays them, so the only silence between chunks is the pause it adds
    (pause_ms, 70 ms by default) plus what the synthesizer leaves at the edges, which is
    trimmed. The output stream stays open while chunks keep coming, so back-to-back replies
    (the Chief often sends one per paragraph) join with a short pause instead of a reopen
    and a full time-to-first-audio wait. stop() cancels everything queued; every reply ends
    with exactly one "spoken" event.
    """

    def __init__(self, synthesize: Callable[[str], tuple[np.ndarray, int]], sink, on_event: Callable[[str, dict], None],
                 tail_ms: int = 300, pause_ms: int = 70, trim: bool = True, ahead: int = 6) -> None:
        self._synth = synthesize
        self.sink = sink
        self._on_event = on_event
        self.tail_s = tail_ms / 1000
        self.pause_s = max(0, pause_ms) / 1000
        self.trim = trim
        self._jobs: queue.Queue = queue.Queue()
        self._play: queue.Queue = queue.Queue(maxsize=max(1, ahead))
        self._lock = threading.Lock()
        self._sink_lock = threading.Lock()
        self._gen = 0
        self._pending: dict[str, dict] = {}   # submitted, no "spoken" yet (insertion order)
        self._cancel = threading.Event()
        self._producing = False
        self._open = False                    # sink stream open and fed without a break
        self._playing = False
        self._clip = False
        self._audio_until = 0.0
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.current: str | None = None
        self.last_metrics: dict = {}
        self.max_prebuffer_s = 0.8

    # ------------------------------------------------------------------ api
    def start(self) -> None:
        self._threads = [threading.Thread(target=self._produce, name="tts-synth", daemon=True),
                         threading.Thread(target=self._consume, name="speaker", daemon=True)]
        for t in self._threads:
            t.start()

    def submit(self, job_id: str, text: str) -> None:
        with self._lock:
            self._pending[job_id] = {"t0": time.perf_counter(), "ttfa_s": None, "chunks": 0, "synth_s": []}
            gen = self._gen
        self._jobs.put((gen, job_id, text))

    def stop(self, reason: str = "stop") -> None:
        """Stop now: the reply playing and every queued one end with spoken ok:false."""
        with self._lock:
            self._gen += 1
            dropped = list(self._pending)
            self._pending.clear()
            if dropped or self._playing:
                self._cancel.set()
        while True:
            try:
                self._jobs.get_nowait()
            except queue.Empty:
                break
        for job_id in dropped:
            self._emit("spoken", {"id": job_id, "ok": False, "reason": reason})

    def play_clip(self, audio: np.ndarray, sr: int, wait: bool = False) -> bool:
        """A short sound right now (wake chime, "Yes?", a filler) through the same output, so
        echo cancellation sees it. Skipped while a reply is queued or playing."""
        if self.is_busy or self._clip:
            return False

        def run():
            with self._sink_lock:
                self._clip = True
                try:
                    self.sink.play(audio, sr, threading.Event(), lambda: None)
                    self.sink.finish()
                except Exception:
                    LOG.exception("playing a clip failed")
                finally:
                    self._clip = False
                    self._audio_until = time.monotonic() + self.tail_s

        t = threading.Thread(target=run, name="clip", daemon=True)
        t.start()
        if wait:
            t.join(10)
        return True

    @property
    def is_speaking(self) -> bool:
        """Audio is on the speakers now, or ended less than tail_ms ago (room echo)."""
        return self._playing or self._clip or time.monotonic() < self._audio_until

    @property
    def is_busy(self) -> bool:
        """A reply is queued, being synthesized or playing (clips do not count)."""
        with self._lock:
            return bool(self._pending)

    def wait_idle(self, timeout: float = 60.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if not self.is_busy and not self._clip:
                return True
            time.sleep(0.02)
        return False

    def close(self) -> None:
        self._stop.set()
        self.stop("shutdown")
        self._jobs.put(None)
        for t in self._threads:
            t.join(timeout=5)
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

    def _live(self, gen: int) -> bool:
        return gen == self._gen and not self._stop.is_set()

    def _put(self, item) -> bool:
        while True:
            if not self._live(item[0]):
                return False
            try:
                self._play.put(item, timeout=0.05)
                return True
            except queue.Full:
                continue

    def _produce(self) -> None:
        while not self._stop.is_set():
            item = self._jobs.get()
            if item is None:
                break
            gen, job_id, text = item
            if not self._live(gen):
                continue
            self._producing = True
            try:
                parts = chunks(speakable(text))
                with self._lock:
                    m = self._pending.get(job_id)
                    if m is not None:
                        m["chunks"] = len(parts)
                if not parts:
                    self._put((gen, job_id, 0, True, None, 0, 0.0))
                    continue
                for i, part in enumerate(parts):
                    if not self._live(gen):
                        break
                    s0 = time.perf_counter()
                    try:
                        audio, sr = self._synth(part)
                    except Exception:
                        LOG.exception("synthesis failed for %s", job_id)
                        self._put((gen, job_id, i, True, "error", 0, 0.0))
                        break
                    took = time.perf_counter() - s0
                    if m is not None:
                        m["synth_s"].append(round(took, 3))
                    if self.trim:
                        audio = trim_edges(audio, sr)
                    last = i == len(parts) - 1
                    # estimated synthesis time of the next chunk: this one's, scaled by text length
                    ahead = 0.0 if last else took * len(parts[i + 1]) / max(1, len(part))
                    if not self._put((gen, job_id, i, last, audio, sr, ahead)):
                        break
            finally:
                self._producing = False

    def _consume(self) -> None:
        while not self._stop.is_set():
            try:
                gen, job_id, i, last, audio, sr, ahead = self._play.get(timeout=0.05)
            except queue.Empty:
                if self._open and self._jobs.empty() and not self._producing and self._play.empty():
                    self._idle()
                continue
            if not self._live(gen):
                continue
            if self._cancel.is_set():
                self._cancel.clear()  # a stop() ended the previous generation; this is new work
            with self._lock:
                m = self._pending.get(job_id)
            if m is None:
                continue
            if i == 0:
                self.current = job_id
                if hasattr(self.sink, "job_id"):
                    self.sink.job_id = job_id
                self._emit("speaking", {"id": job_id})
            if audio is None or (isinstance(audio, str) and audio == "error"):
                self._finish_job(job_id, gen, ok=audio is None)
                continue
            if self._open and self.pause_s:
                audio = np.concatenate([np.zeros(int(sr * self.pause_s), np.float32), audio])
            elif not self._open and ahead > 0:
                self._prebuffer(len(audio) / sr, ahead, gen)

            def started(m=m, job_id=job_id):
                if m["ttfa_s"] is None:
                    m["ttfa_s"] = round(time.perf_counter() - m["t0"], 3)
                    LOG.info("first audio for %s after %.2fs", job_id, m["ttfa_s"])
                self._playing = True

            with self._sink_lock:
                try:
                    ok = self.sink.play(audio, sr, self._cancel, started)
                except Exception:
                    LOG.exception("playback failed")
                    ok = False
            self._open = ok
            if not ok:
                self._idle()
                if self._live(gen):        # the device failed, not a stop()
                    self._finish_job(job_id, gen, ok=False)
                continue
            if last:
                self._finish_job(job_id, gen, ok=True)

    def _prebuffer(self, dur: float, ahead: float, gen: int) -> None:
        """Fresh start: when the next chunk will take longer to synthesize (ahead, estimated
        from this chunk's own synthesis time) than this chunk lasts, wait a moment (at most
        max_prebuffer_s) so the first join is not a gap. A short wait before the first word is
        better than a pause in the middle."""
        need = ahead - dur
        if need <= 0:
            return
        end = time.perf_counter() + min(self.max_prebuffer_s, need + 0.05)
        while time.perf_counter() < end and self._play.empty() and self._live(gen):
            time.sleep(0.01)

    def _finish_job(self, job_id: str, gen: int, ok: bool) -> None:
        with self._lock:
            m = self._pending.pop(job_id, None) if gen == self._gen else None
        if m is None:
            return
        self.last_metrics = {"id": job_id, "chunks": m["chunks"], "ttfa_s": m["ttfa_s"], "synth_s": m["synth_s"]}
        if self.current == job_id:
            self.current = None
        self._emit("spoken", {"id": job_id, "ok": ok})

    def _idle(self) -> None:
        """Nothing more to play now: let the device drain and close it."""
        with self._sink_lock:
            try:
                self.sink.finish()
            except Exception:
                LOG.exception("closing the output failed")
        self._open = False
        self._playing = False
        self._audio_until = time.monotonic() + self.tail_s
        self._emit("idle", {})


def trim_edges(audio: np.ndarray, sr: int, keep_lead_s: float = 0.015, keep_trail_s: float = 0.04) -> np.ndarray:
    """Cut the silence a synthesizer leaves before and after the words (Chatterbox leaves
    up to half a second), keeping a few milliseconds so no word is clipped."""
    a = np.asarray(audio, dtype=np.float32).reshape(-1)
    if a.size == 0:
        return a
    peak = float(np.abs(a).max())
    if peak <= 0:
        return a[:0]
    floor = max(0.004, 0.02 * peak)
    n = max(1, int(sr * 0.01))
    env = np.array([np.abs(a[i:i + n]).max() for i in range(0, a.size, n)])
    loud = np.nonzero(env >= floor)[0]
    if loud.size == 0:
        return a
    start = max(0, loud[0] * n - int(sr * keep_lead_s))
    end = min(a.size, (loud[-1] + 1) * n + int(sr * keep_trail_s))
    return a[start:end]


def chime(sr: int = 24000, ms: int = 150, volume: float = 0.12) -> np.ndarray:
    """A soft two-note chime (E6 then B6) with smooth edges, for the wake acknowledgment."""
    n = int(sr * ms / 1000)
    t = np.arange(n, dtype=np.float32) / sr
    half = n // 2
    f = np.where(np.arange(n) < half, 1318.5, 1975.5).astype(np.float32)
    phase = 2 * np.pi * np.cumsum(f) / sr
    tone = np.sin(phase) * 0.8 + 0.2 * np.sin(2 * phase)
    env = np.minimum(1.0, t / 0.01) * np.exp(-3.0 * t / (ms / 1000))
    return (volume * tone * env).astype(np.float32)
