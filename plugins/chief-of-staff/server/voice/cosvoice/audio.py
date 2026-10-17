"""Audio helpers: microphone capture, re-chunking, levels, resampling and WAV files.

MicCapture is ported from Pepper audio_in.py (sounddevice, 16 kHz mono float32 chunks).
"""

from __future__ import annotations

import logging
import math
import queue
import threading
import time
from pathlib import Path

import numpy as np

from .config import CHUNK, SAMPLE_RATE

LOG = logging.getLogger("cosvoice")


class MicCapture:
    """The PC's own microphone through sounddevice. start() opens it, stop() closes it."""

    def __init__(self, samplerate: int = SAMPLE_RATE, chunk_samples: int = 160, device=None) -> None:
        self.samplerate = samplerate
        self.chunk_samples = chunk_samples
        self.device = device
        self._q: queue.Queue = queue.Queue(maxsize=1024)
        self.dropped = 0
        self._stream = None
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        with self._lock:
            self._start()

    def _start(self) -> None:
        if self._stream is not None:
            return
        import sounddevice as sd

        def callback(indata, frames, time_info, status):  # noqa: ANN001
            try:
                self._q.put_nowait(indata[:, 0].copy())
            except queue.Full:
                self.dropped += 1
                if self.dropped == 1 or self.dropped % 200 == 0:
                    LOG.warning("microphone queue overflow (%d chunks dropped)", self.dropped)

        self._stream = sd.InputStream(samplerate=self.samplerate, blocksize=self.chunk_samples, channels=1,
                                      dtype="float32", device=self.device, callback=callback)
        self._stream.start()
        LOG.info("microphone open (device=%s)", self.device)

    def read(self, timeout: float = 0.2) -> np.ndarray | None:
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def stop(self) -> None:
        with self._lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                LOG.exception("closing the microphone failed")
            LOG.info("microphone closed")
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break


class Rechunker:
    """Turns a stream of any-size float32 blocks into fixed-size chunks."""

    def __init__(self, size: int) -> None:
        self.size = size
        self._buf = np.zeros(0, dtype=np.float32)

    def push(self, block: np.ndarray) -> list[np.ndarray]:
        self._buf = np.concatenate([self._buf, np.asarray(block, dtype=np.float32).reshape(-1)])
        out = []
        while self._buf.size >= self.size:
            out.append(self._buf[: self.size].copy())
            self._buf = self._buf[self.size:]
        return out

    def clear(self) -> None:
        self._buf = np.zeros(0, dtype=np.float32)


def level(chunk: np.ndarray) -> float:
    """0..1 loudness for the console orb: -60 dBFS -> 0, -10 dBFS -> 1."""
    x = np.asarray(chunk, dtype=np.float32)
    if x.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(x * x)))
    db = 20.0 * math.log10(rms + 1e-9)
    return max(0.0, min(1.0, (db + 60.0) / 50.0))


def resample(audio: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    audio = np.ascontiguousarray(audio, dtype=np.float32).reshape(-1)
    if sr_from == sr_to or audio.size == 0:
        return audio
    try:
        import soxr

        return soxr.resample(audio, sr_from, sr_to).astype(np.float32)
    except Exception:
        n = max(1, int(round(audio.size * sr_to / sr_from)))
        pos = np.arange(n, dtype=np.float64) * sr_from / sr_to
        return np.interp(pos, np.arange(audio.size, dtype=np.float64), audio).astype(np.float32)


def read_wav(path: str | Path, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Any WAV (or FLAC) -> mono float32 at sr."""
    import soundfile as sf

    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    return resample(data.mean(axis=1), int(file_sr), sr)


def write_wav(path: str | Path, audio: np.ndarray, sr: int) -> None:
    import soundfile as sf

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(np.asarray(audio, dtype=np.float32), -1, 1), int(sr), subtype="PCM_16")


def chunks(audio: np.ndarray, size: int = CHUNK):
    for i in range(0, len(audio) - size + 1, size):
        yield audio[i:i + size]


def now_ms() -> int:
    return int(time.time() * 1000)
