"""faster-whisper speech to text: CUDA first, CPU fallback. Ported from Pepper stt.py.

Spike defaults: large-v3-turbo int8_float16 on CUDA (1.1 GB, 0.24 s for 3.4 s of audio);
small.en int8 on the CPU (1.8 s). torch must be imported before this loads (gpu.prepare_cuda).
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np

from . import gpu

LOG = logging.getLogger("cosvoice")
# No hotwords: with hotwords="Hey Chief", whisper dropped the first word of
# "Chief of Staff voice check." (tested 2026-10-16, large-v3-turbo).
HOTWORDS = None


class Transcriber:
    def __init__(self, model: str = "large-v3-turbo", compute: str = "int8_float16",
                 cpu_model: str = "small.en", cpu_compute: str = "int8", device: str = "auto") -> None:
        self.model_name = model
        self.compute = compute
        self.cpu_model = cpu_model
        self.cpu_compute = cpu_compute
        self.want = device
        self.device: str | None = None
        self.loaded_name: str | None = None
        self._model = None
        self._lock = threading.Lock()

    @property
    def label(self) -> str:
        return f"faster-whisper {self.loaded_name or self.model_name}"

    def _load(self, name: str, device: str, compute: str):
        from faster_whisper import WhisperModel

        t0 = time.perf_counter()
        model = WhisperModel(name, device=device, compute_type=compute)
        # Warm up so CUDA or cuDNN failures show here, not on the first real utterance.
        segs, _ = model.transcribe(np.zeros(1600, dtype=np.float32), language="en", beam_size=1)
        for _ in segs:
            pass
        LOG.info("whisper %s %s loaded on %s in %.1fs", name, compute, device, time.perf_counter() - t0)
        return model

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            if self.want != "cpu" and gpu.prepare_cuda(self.want):
                try:
                    self._model = self._load(self.model_name, "cuda", self.compute)
                    self.device, self.loaded_name = "cuda", self.model_name
                    return
                except Exception as e:
                    LOG.warning("CUDA whisper failed (%s); using %s on the CPU", e, self.cpu_model)
            self._model = self._load(self.cpu_model, "cpu", self.cpu_compute)
            self.device, self.loaded_name = "cpu", self.cpu_model

    def __call__(self, audio: np.ndarray) -> str:
        self.load()
        t0 = time.perf_counter()
        segments, _ = self._model.transcribe(np.ascontiguousarray(audio, dtype=np.float32), language="en",
                                             beam_size=1, hotwords=HOTWORDS, vad_filter=False,
                                             condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segments).strip()
        LOG.info("transcribed %.1fs of audio in %.2fs", len(audio) / 16000, time.perf_counter() - t0)
        return text
