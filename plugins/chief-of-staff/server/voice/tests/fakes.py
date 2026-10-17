"""Fake models and devices for the unit tests. No real model, mic or speaker is used.

Audio convention: a chunk filled with WAKE is the wake word, SPEECH is speech, 0 is silence.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cosvoice.config import CHUNK, VoiceConfig  # noqa: E402

logging.getLogger("cosvoice").addHandler(logging.NullHandler())
logging.getLogger("cosvoice").propagate = False

WAKE = 0.9
SPEECH = 0.3


def chunk(value: float, n: int = 1) -> np.ndarray:
    return np.full(CHUNK * n, value, dtype=np.float32)


def seconds(value: float, s: float) -> np.ndarray:
    return np.full(int(16000 * s), value, dtype=np.float32)


class FakeVAD:
    def __init__(self) -> None:
        self.resets = 0

    def __call__(self, c):
        return 1.0 if float(np.mean(np.abs(c))) >= 0.2 else 0.0

    def reset(self):
        self.resets += 1

    def load(self):
        pass


class FakeWake:
    name = "fake"
    label = "fake wake"

    def __init__(self) -> None:
        self.limits = []
        self.resets = 0

    def __call__(self, c, threshold=None):
        self.limits.append(threshold)
        score = 0.95 if float(np.mean(c)) >= 0.8 else 0.0
        limit = 0.5 if threshold is None else threshold
        return score >= limit, score

    def reset(self):
        self.resets += 1


class FakeSTT:
    label = "faster-whisper fake"
    device = "cpu"

    def __init__(self, text: str = "Hey Chief, what needs me?") -> None:
        self.text = text
        self.calls = []

    def __call__(self, audio):
        self.calls.append(len(audio))
        return self.text


class FakeTTS:
    name = "kokoro"
    reasons: list = []

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.texts = []
        self.on_change = None

    def synthesize(self, text):
        self.texts.append(text)
        if self.delay:
            time.sleep(self.delay)
        return np.zeros(2400, dtype=np.float32), 24000


class FakeSink:
    """Plays instantly unless block_s is set; then each clause takes block_s and can be cancelled."""

    def __init__(self, block_s: float = 0.0) -> None:
        self.block_s = block_s
        self.played = []
        self.finished = 0

    def open(self, sr):
        pass

    def play(self, audio, sr, cancel, started):
        started()
        end = time.monotonic() + self.block_s
        while time.monotonic() < end:
            if cancel.is_set():
                return False
            time.sleep(0.005)
        if cancel.is_set():
            return False
        self.played.append(len(audio))
        return True

    def finish(self):
        self.finished += 1

    def close(self):
        pass


class FakeMic:
    def __init__(self) -> None:
        self.is_open = False
        self.opened = 0

    def start(self):
        self.is_open = True
        self.opened += 1

    def stop(self):
        self.is_open = False

    def read(self, timeout=0.2):
        time.sleep(0.01)
        return None


class FakeLink:
    def __init__(self) -> None:
        self.events = []
        self.lock = threading.Lock()

    def post(self, event):
        with self.lock:
            self.events.append(event)

    def of(self, kind):
        with self.lock:
            return [e for e in self.events if e.get("type") == kind]

    def run_jobs(self, handle, stop):
        stop.wait()


def config(**kw) -> VoiceConfig:
    cfg = VoiceConfig()
    cfg.preroll_ms = 320
    cfg.trailing_silence_ms = 320
    cfg.wake_speech_timeout_ms = 1000
    cfg.max_utterance_ms = 3000
    cfg.speaking_tail_ms = 0
    for k, v in kw.items():
        setattr(cfg, k, v)
    return cfg


def wait_for(cond, timeout: float = 3.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False
