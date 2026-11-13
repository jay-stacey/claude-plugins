"""Echo control. Ported from Pepper duplex.py.

The daemon owns the speech samples it sends to the speakers, so those samples are the far-end
reference for WebRTC AEC3 (pywebrtc-audio). If the binding cannot load or fails, the daemon
falls back to half duplex: while it speaks, only the wake word counts (at a higher threshold).
"""

from __future__ import annotations

import logging
import threading
from collections import deque

import numpy as np

from .audio import resample

LOG = logging.getLogger("cosvoice")
FRAME = 160  # 10 ms at 16 kHz, what AEC3 processes


class RenderReference:
    """Thread-safe queue of rendered speech, resampled to 16 kHz."""

    def __init__(self, sample_rate: int = 16000, max_seconds: float = 2.0) -> None:
        self.sample_rate = sample_rate
        self._max = max(1, int(sample_rate * max_seconds))
        self._chunks: deque = deque()
        self._samples = 0
        self._offset = 0
        self._lock = threading.Lock()

    def push(self, audio: np.ndarray, sample_rate: int) -> None:
        src = resample(audio, sample_rate, self.sample_rate)
        if src.size == 0:
            return
        with self._lock:
            self._chunks.append(src.copy())
            self._samples += src.size
            while self._samples > self._max and self._chunks:
                head = self._chunks.popleft()
                self._samples -= head.size - self._offset
                self._offset = 0

    def pull(self, samples: int) -> np.ndarray:
        out = np.zeros(max(0, samples), dtype=np.float32)
        written = 0
        with self._lock:
            while written < samples and self._chunks:
                head = self._chunks[0]
                take = min(samples - written, head.size - self._offset)
                out[written:written + take] = head[self._offset:self._offset + take]
                written += take
                self._offset += take
                self._samples -= take
                if self._offset >= head.size:
                    self._chunks.popleft()
                    self._offset = 0
        return out

    def clear(self) -> None:
        with self._lock:
            self._chunks.clear()
            self._samples = 0
            self._offset = 0


class EchoCanceller:
    provider = "webrtc-aec3"

    def __init__(self, enabled: bool = True, delay_ms: int = 80, factory=None) -> None:
        self._p = None
        self.error = ""
        if not enabled:
            self.error = "echo cancellation is off in voice.json"
            return
        try:
            if factory is None:
                from pywebrtc_audio import AudioProcessor as factory
            self._p = factory(sample_rate=16000, num_channels=1, echo_cancellation=True,
                              noise_suppression=True, high_pass_filter=True, auto_gain_control=False,
                              ns_level=2, stream_delay_ms=delay_ms)
        except Exception as e:
            self.error = str(e) or type(e).__name__
            LOG.warning("echo cancellation unavailable, half duplex: %s", self.error)

    @property
    def available(self) -> bool:
        return self._p is not None

    def process(self, near: np.ndarray, far: np.ndarray) -> np.ndarray:
        """One 160-sample frame of mic audio against the matching speaker frame."""
        near = np.ascontiguousarray(near, dtype=np.float32).reshape(-1)
        if self._p is None:
            return near
        try:
            out = self._p.process(near, np.ascontiguousarray(far, dtype=np.float32).reshape(-1))
            return np.ascontiguousarray(out, dtype=np.float32).reshape(-1)
        except Exception as e:
            self.error = str(e) or type(e).__name__
            self._p = None
            LOG.exception("echo cancellation failed; half duplex from now on")
            return near
