"""Listening state machine. Adapted from Pepper pipeline.py.

Chunk flow: pre-roll ring -> wake gate (mode "wake") or push-to-talk (mode "ptt") ->
capture until Silero VAD end of speech (max 30 s) -> faster-whisper -> "final" event.
While the daemon speaks, the wake word is a barge-in. With echo cancellation active, sustained
speech (VAD >= barge_vad for barge_ms) is a barge-in too, and that speech becomes the utterance.
Wake scores at or above near_miss_ratio x threshold that do not fire are reported as near misses.

VAD, wake, transcriber and the is_speaking probe are injected, so tests drive it with fakes.
States: idle -> capturing -> transcribing -> idle.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any, Callable

import numpy as np

from .config import CHUNK_MS, VoiceConfig
from .text import is_noise, strip_wake

LOG = logging.getLogger("cosvoice")
MODES = ("wake", "ptt", "off")
RECENT_CHUNKS = 3  # VAD chunks before the wake that count as "still talking"


class Pipeline:
    def __init__(self, cfg: VoiceConfig, vad: Callable[[np.ndarray], float],
                 wake: Callable[..., tuple[bool, float]] | None, transcribe: Callable[[np.ndarray], str],
                 on_event: Callable[[str, dict], None], is_speaking: Callable[[], bool] = lambda: False,
                 full_duplex: Callable[[], bool] = lambda: False,
                 on_state: Callable[[], None] | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.cfg = cfg
        self._clock = clock
        self.wake_phrase = cfg.wake_word
        self.chief_name = cfg.chief_name
        self._vad = vad
        self._wake = wake
        self._transcribe = transcribe
        self._on_event = on_event
        self._is_speaking = is_speaking
        self._full_duplex = full_duplex
        self._on_state = on_state
        self._lock = threading.RLock()
        self.mode = "off"
        self.state = "idle"
        self.ptt_down = False
        self._ring: deque = deque(maxlen=max(1, int(cfg.preroll_ms / CHUNK_MS)))
        self._recent: deque = deque(maxlen=RECENT_CHUNKS)
        self._barge_ms = 0.0
        self._near_peak = 0.0
        self._near_at = -1e9
        self._reset_capture()

    # ------------------------------------------------------------------ api
    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            LOG.warning("ignoring unknown listen mode %r", mode)
            return
        with self._lock:
            if mode == self.mode:
                return
            LOG.info("listen mode %s -> %s", self.mode, mode)
            self.mode = mode
            if self.state == "capturing" and (mode == "off" or (mode == "wake" and self._source == "ptt")):
                self._abort("mode changed")
            if mode != "ptt":
                self.ptt_down = False
            self._changed()

    def set_ptt(self, down: bool) -> None:
        with self._lock:
            self.ptt_down = bool(down) and self.mode == "ptt"
            if self.mode != "ptt":
                return
            if down and self.state == "idle":
                self._begin("ptt", keep_ms=200)
            elif not down and self.state == "capturing" and self._source == "ptt":
                if self._captured_ms >= 300:
                    self._end("release")
                else:
                    self._abort("push-to-talk too short")

    def set_wake(self, wake, phrase: str | None = None, name: str | None = None) -> None:
        """Swap the wake detector (a new wake word) without stopping the audio."""
        with self._lock:
            self._wake = wake
            if phrase:
                self.wake_phrase = phrase
            if name is not None:
                self.chief_name = name
            self._near_peak = 0.0

    def process_chunk(self, chunk: np.ndarray) -> None:
        with self._lock:
            self._process(chunk)

    def finish(self, reason: str = "end of input") -> None:
        """End a capture now (simulate mode at the end of the WAV)."""
        with self._lock:
            if self.state == "capturing":
                self._end(reason)

    def reset(self) -> None:
        with self._lock:
            if self.state == "capturing":
                self._abort("reset")
            self._ring.clear()
            self._reset_detectors()

    # ------------------------------------------------------------- internals
    def _process(self, chunk: np.ndarray) -> None:
        cfg = self.cfg
        self._ring.append(chunk)
        if self.mode == "off":
            return
        if self.state == "idle":
            if self.mode == "wake" and self._wake is not None:
                # VAD runs all the time in wake mode, so its state stays valid and the capture
                # knows whether the user was still talking when the wake word fired.
                prob = self._vad(chunk)
                self._recent.append(prob)
                speaking = self._is_speaking()
                duplex = self._full_duplex()
                limit = cfg.wake_speaking_threshold if speaking and not duplex else None
                fired, score = self._wake(chunk, limit)
                if fired:
                    LOG.info("wake word heard (score %.3f, by %s, while speaking: %s)", score,
                             getattr(self._wake, "source", None), speaking)
                    self._near_peak = 0.0
                    self._emit("wake", {"score": round(float(score), 3), "barge": speaking,
                                        "source": getattr(self._wake, "source", None)})
                    self._begin("wake")
                    self._vad_started = max(self._recent, default=0.0) >= cfg.vad_start
                    return
                self._near_miss(score, limit)
                if speaking and duplex:
                    self._barge_check(prob)
                else:
                    self._barge_ms = 0.0
            return
        if self.state != "capturing":
            return
        self._buffer.append(chunk)
        self._captured_ms += CHUNK_MS
        if self._source == "ptt":
            if self._captured_ms >= cfg.max_utterance_ms:
                self._end("limit")
            return
        prob = self._vad(chunk)
        self._since_wake_ms += CHUNK_MS
        if not self._vad_started:
            if prob >= cfg.vad_start:
                self._vad_started = True
                self._silence_ms = 0.0
            elif self._since_wake_ms >= cfg.wake_speech_timeout_ms:
                self._abort("no speech after the wake word")
                return
        else:
            if prob < cfg.vad_end:
                self._silence_ms += CHUNK_MS
            else:
                self._silence_ms = 0.0
            if self._silence_ms >= cfg.trailing_silence_ms:
                self._end("silence")
                return
        if self._since_wake_ms >= cfg.max_utterance_ms:
            self._end("limit")

    def _near_miss(self, score: float, limit: float | None) -> None:
        """A wake score that rose to near_miss_ratio x threshold but did not fire: report its
        peak once the score falls back, at most once every 2 s."""
        if not getattr(self._wake, "scored", True):
            return
        thr = max(getattr(self._wake, "threshold", 0.5), limit or 0.0)
        floor = self.cfg.near_miss_ratio * thr
        if score >= floor:
            self._near_peak = max(self._near_peak, score)
            return
        if self._near_peak:
            peak, self._near_peak = self._near_peak, 0.0
            now = self._clock()
            if now - self._near_at >= 2.0:
                self._near_at = now
                LOG.info("wake near miss: score %.3f (threshold %.2f)", peak, thr)
                self._emit("nearMiss", {"score": round(peak, 3), "threshold": round(thr, 3)})

    def _barge_check(self, prob: float) -> None:
        """Full duplex only: speech held over the echo-cancelled mic stops the reply."""
        cfg = self.cfg
        if prob >= cfg.barge_vad:
            self._barge_ms += CHUNK_MS
        else:
            self._barge_ms = 0.0
        if self._barge_ms >= cfg.barge_ms:
            LOG.info("barge-in: %.0f ms of speech while speaking", self._barge_ms)
            held = int(self._barge_ms / CHUNK_MS)
            self._barge_ms = 0.0
            self._emit("barge", {})
            self._begin("barge", keep_ms=int((held + 6) * CHUNK_MS))
            self._vad_started = True

    def _emit(self, kind: str, payload: dict[str, Any]) -> None:
        try:
            self._on_event(kind, payload)
        except Exception:
            LOG.exception("pipeline event callback failed")

    def _changed(self) -> None:
        if self._on_state:
            try:
                self._on_state()
            except Exception:
                LOG.exception("pipeline state callback failed")

    def _reset_capture(self) -> None:
        self._buffer: list[np.ndarray] = []
        self._source = ""
        self._vad_started = False
        self._silence_ms = 0.0
        self._captured_ms = 0.0
        self._since_wake_ms = 0.0

    def _begin(self, source: str, keep_ms: int | None = None) -> None:
        self._reset_capture()
        self._source = source
        pre = list(self._ring)
        if keep_ms is not None:
            pre = pre[-max(0, int(keep_ms / CHUNK_MS)):] if keep_ms else []
        self._buffer = pre
        self._captured_ms = len(pre) * CHUNK_MS
        if source == "ptt":
            reset = getattr(self._vad, "reset", None)
            if callable(reset):
                reset()
        self.state = "capturing"
        self._changed()

    def _abort(self, reason: str) -> None:
        LOG.info("capture dropped: %s", reason)
        self._reset_capture()
        self.state = "idle"
        self._reset_detectors()
        self._changed()

    def _end(self, reason: str) -> None:
        source = self._source
        audio = np.concatenate(self._buffer) if self._buffer else np.zeros(0, dtype=np.float32)
        self._reset_capture()
        self.state = "transcribing"
        self._changed()
        LOG.info("capture ended (%s, %.1fs of audio)", reason, len(audio) / 16000)
        try:
            text = self._transcribe(audio) if audio.size else ""
            raw = text
            if source in ("wake", "followup", "barge"):
                text = strip_wake(text, self.wake_phrase, self.chief_name)
            if text and not is_noise(text):
                self._emit("final", {"text": text, "raw": raw, "reason": reason, "source": source})
            else:
                LOG.info("empty transcript (%r); nothing sent", raw)
                self._emit("empty", {"raw": raw, "source": source})
                if source == "wake" and reason == "silence" and self.mode == "wake":
                    # Only "Hey Chief" so far: the user paused. Keep listening for the
                    # question without a second wake word, up to wake_speech_timeout_ms.
                    self._begin_followup()
                    return
        except Exception as e:
            LOG.exception("transcription failed")
            self._emit("error", {"detail": f"Speech to text failed ({e.__class__.__name__})."})
        self.state = "idle"
        self._ring.clear()
        self._recent.clear()
        self._reset_detectors()
        self._changed()

    def _begin_followup(self) -> None:
        self._reset_capture()
        self._source = "followup"
        self.state = "capturing"
        self._changed()

    def _reset_detectors(self) -> None:
        for det in (self._wake, self._vad):
            reset = getattr(det, "reset", None)
            if callable(reset):
                try:
                    reset()
                except Exception:
                    LOG.exception("detector reset failed")
