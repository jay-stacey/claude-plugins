"""Wake word "hey chief". Two backends, picked at start:

1. openWakeWord with a trained model file (HOME\\models\\hey_chief.onnx). Ported from Pepper wake.py.
2. sherpa-onnx keyword spotting for the phrase "hey chief" (no training needed), used when
   no model file exists.

Each backend takes 512-sample float32 chunks at 16 kHz and returns (fired, score).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .config import WAKE_PHRASE, VoiceConfig

LOG = logging.getLogger("cosvoice")


class OpenWakeWord:
    name = "openwakeword"

    def __init__(self, model_path: str | Path, threshold: float = 0.5) -> None:
        self.model_path = str(model_path)
        self.threshold = threshold
        self._model = None
        self._key = None
        self._buf = np.zeros(0, dtype=np.int16)
        self._score = 0.0

    @property
    def label(self) -> str:
        return f"openWakeWord ({Path(self.model_path).name})"

    def load(self) -> None:
        if self._model is not None:
            return
        if not Path(self.model_path).exists():
            raise FileNotFoundError(f"wake model not found: {self.model_path}")
        from .vad import ensure_oww_base_models

        ensure_oww_base_models()
        from openwakeword.model import Model

        self._model = Model(wakeword_models=[self.model_path], inference_framework="onnx")
        self._key = list(self._model.models.keys())[0]
        LOG.info("wake model loaded: %s (key=%s, threshold=%.2f)", self.model_path, self._key, self.threshold)

    def reset(self) -> None:
        self._buf = np.zeros(0, dtype=np.int16)
        self._score = 0.0
        if self._model is not None:
            try:
                self._model.reset()
            except Exception:
                pass

    def __call__(self, chunk: np.ndarray, threshold: float | None = None) -> tuple[bool, float]:
        """openWakeWord wants 1280-sample (80 ms) int16 frames; buffer the 512-sample chunks."""
        self.load()
        pcm = (np.clip(np.asarray(chunk, dtype=np.float32), -1.0, 1.0) * 32767).astype(np.int16)
        self._buf = np.concatenate([self._buf, pcm])
        while self._buf.size >= 1280:
            frame, self._buf = self._buf[:1280], self._buf[1280:]
            self._score = float(self._model.predict(frame)[self._key])
        limit = self.threshold if threshold is None else max(self.threshold, threshold)
        return self._score >= limit, self._score


def keyword_line(phrase: str, bpe_model: Path, tokens_file: Path, score: float, threshold: float) -> str:
    """One sherpa-onnx keywords line: '<bpe tokens> :<boost> #<threshold> @<NAME>'."""
    text = phrase.upper()
    pieces = None
    try:
        import sentencepiece as spm

        sp = spm.SentencePieceProcessor(model_file=str(bpe_model))
        pieces = sp.encode(text, out_type=str)
    except Exception as e:
        LOG.warning("sentencepiece failed (%s); trying sherpa_onnx.text2token", e)
    if not pieces:
        import sherpa_onnx

        pieces = sherpa_onnx.text2token([text], tokens=str(tokens_file), tokens_type="bpe",
                                        bpe_model=str(bpe_model))[0]
    vocab = {line.split()[0] for line in tokens_file.read_text(encoding="utf-8").splitlines() if line.strip()}
    missing = [p for p in pieces if p not in vocab]
    if missing:
        raise ValueError(f"keyword tokens not in the model vocabulary: {missing}")
    return f"{' '.join(pieces)} :{score} #{threshold} @{text.replace(' ', '_')}"


class SherpaKws:
    name = "sherpa-onnx"

    def __init__(self, model_dir: str | Path, phrase: str = WAKE_PHRASE, score: float = 1.5,
                 threshold: float = 0.25) -> None:
        self.model_dir = Path(model_dir)
        self.phrase = phrase
        self.score_boost = score
        self.kws_threshold = threshold
        self.threshold = 0.5
        self._kws = None
        self._stream = None

    @property
    def label(self) -> str:
        return "sherpa-onnx keyword spotting"

    def _pick(self, prefix: str) -> Path:
        files = sorted(self.model_dir.glob(f"{prefix}*.onnx"))
        full = [f for f in files if ".int8." not in f.name]
        if not (full or files):
            raise FileNotFoundError(f"no {prefix}*.onnx in {self.model_dir}")
        return (full or files)[0]

    def load(self) -> None:
        if self._kws is not None:
            return
        import onnxruntime  # noqa: F401  (load the venv's onnxruntime DLL before sherpa's own)
        import sherpa_onnx

        tokens = self.model_dir / "tokens.txt"
        bpe = self.model_dir / "bpe.model"
        line = keyword_line(self.phrase, bpe, tokens, self.score_boost, self.kws_threshold)
        kw_file = self.model_dir / "keywords-hey-chief.txt"
        if not kw_file.exists() or kw_file.read_text(encoding="utf-8").strip() != line:
            kw_file.write_text(line + "\n", encoding="utf-8")
        self._kws = sherpa_onnx.KeywordSpotter(
            tokens=str(tokens), encoder=str(self._pick("encoder")), decoder=str(self._pick("decoder")),
            joiner=str(self._pick("joiner")), num_threads=1, max_active_paths=4,
            keywords_file=str(kw_file), keywords_score=self.score_boost,
            keywords_threshold=self.kws_threshold, num_trailing_blanks=1, provider="cpu")
        self._stream = self._kws.create_stream()
        LOG.info("sherpa-onnx keyword spotter loaded: %s (%s)", self.model_dir.name, line)

    def reset(self) -> None:
        if self._kws is not None:
            self._stream = self._kws.create_stream()

    def __call__(self, chunk: np.ndarray, threshold: float | None = None) -> tuple[bool, float]:
        self.load()
        self._stream.accept_waveform(16000, np.ascontiguousarray(chunk, dtype=np.float32))
        fired = False
        while self._kws.is_ready(self._stream):
            self._kws.decode_stream(self._stream)
            if self._kws.get_result(self._stream):
                fired = True
                try:
                    self._kws.reset_stream(self._stream)
                except AttributeError:
                    self._stream = self._kws.create_stream()
        return fired, 1.0 if fired else 0.0


def choose(cfg: VoiceConfig):
    """The best wake backend that loads, or (None, reason)."""
    reasons = []
    model = cfg.wake_model_path
    if model.exists():
        try:
            w = OpenWakeWord(model, cfg.wake_threshold)
            w.load()
            return w, None
        except Exception as e:
            LOG.exception("openWakeWord failed to load")
            reasons.append(f"openWakeWord failed ({e.__class__.__name__})")
    else:
        reasons.append(f"no wake model at {model}")
    kdir = cfg.kws_path
    if (kdir / "tokens.txt").exists():
        try:
            w = SherpaKws(kdir, WAKE_PHRASE, cfg.kws_score, cfg.kws_threshold)
            w.load()
            return w, None
        except Exception as e:
            LOG.exception("sherpa-onnx keyword spotting failed to load")
            reasons.append(f"sherpa-onnx failed ({e.__class__.__name__})")
    else:
        reasons.append(f"no keyword spotter at {kdir}")
    return None, "; ".join(reasons)
