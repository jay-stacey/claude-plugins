"""Silero VAD on onnxruntime (CPU). Supports the v4 (h/c) and v5 (state) graphs.

Ported from Pepper vad.py. The model file ships with openWakeWord's base models.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

LOG = logging.getLogger("cosvoice")


def oww_models_dir() -> Path:
    import openwakeword

    return Path(openwakeword.__file__).parent / "resources" / "models"


def ensure_oww_base_models() -> Path:
    """melspectrogram, embedding and silero_vad .onnx; downloaded once into the venv."""
    d = oww_models_dir()
    need = ["melspectrogram.onnx", "embedding_model.onnx", "silero_vad.onnx"]
    if not all((d / n).exists() for n in need):
        from openwakeword.utils import download_models

        LOG.info("downloading openWakeWord base models to %s", d)
        download_models(model_names=["none"])
    return d


class SileroVAD:
    def __init__(self, model_path: str | None = None) -> None:
        self._model_path = model_path
        self._session = None
        self._v5 = False
        self._sr = np.array(16000, dtype=np.int64)
        self._state = self._h = self._c = self._context = None

    def load(self) -> None:
        if self._session is not None:
            return
        import onnxruntime as ort

        path = self._model_path or str(ensure_oww_base_models() / "silero_vad.onnx")
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self._session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self._v5 = "state" in {i.name for i in self._session.get_inputs()}
        self.reset()
        LOG.info("silero VAD loaded (%s, v5=%s)", path, self._v5)

    def reset(self) -> None:
        if self._v5:
            self._state = np.zeros((2, 1, 128), dtype=np.float32)
            self._context = np.zeros(64, dtype=np.float32)
        else:
            self._h = np.zeros((2, 1, 64), dtype=np.float32)
            self._c = np.zeros((2, 1, 64), dtype=np.float32)

    def __call__(self, chunk: np.ndarray) -> float:
        """Speech probability for one 512-sample float32 chunk at 16 kHz."""
        self.load()
        x = np.ascontiguousarray(chunk, dtype=np.float32).reshape(-1)
        if self._v5:
            inp = np.concatenate([self._context, x]).reshape(1, -1)
            out, self._state = self._session.run(None, {"input": inp, "state": self._state, "sr": self._sr})
            self._context = x[-64:]
            return float(out[0][0])
        out, self._h, self._c = self._session.run(
            None, {"input": x.reshape(1, -1), "sr": self._sr, "h": self._h, "c": self._c})
        return float(np.squeeze(out))
