"""Wake word. Two detectors run side by side, and either one fires the wake:

1. openWakeWord with a trained model file (HOME\\models\\<phrase>.onnx, or the hey_chief.onnx
   shipped in server/voice/models). Optional per-user custom verifier from voiced.py --enroll.
   Ported from Pepper wake.py.
2. sherpa-onnx keyword spotting for the phrase itself (no training needed), so any wake word
   works and a quiet "hey chief" that openWakeWord scores just under its threshold still counts.

Each detector takes 512-sample float32 chunks at 16 kHz and returns (fired, score).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .config import WAKE_PHRASE, VoiceConfig, slug

LOG = logging.getLogger("cosvoice")


class OpenWakeWord:
    name = "openwakeword"
    scored = True  # gives a continuous score (sherpa-onnx only says yes or no)

    def __init__(self, model_path: str | Path, threshold: float = 0.5, verifier: str | Path | None = None,
                 verifier_gate: float = 0.1) -> None:
        self.model_path = str(model_path)
        self.threshold = threshold
        self.verifier = str(verifier) if verifier and Path(verifier).exists() else None
        self.verifier_gate = verifier_gate
        self._model = None
        self._key = None
        self._buf = np.zeros(0, dtype=np.int16)
        self._score = 0.0

    @property
    def label(self) -> str:
        return f"openWakeWord ({Path(self.model_path).name}{', your voice' if self.verifier else ''})"

    def load(self) -> None:
        if self._model is not None:
            return
        if not Path(self.model_path).exists():
            raise FileNotFoundError(f"wake model not found: {self.model_path}")
        from .vad import ensure_oww_base_models

        ensure_oww_base_models()
        from openwakeword.model import Model

        key = Path(self.model_path).stem
        kwargs = {}
        if self.verifier:
            kwargs = {"custom_verifier_models": {key: self.verifier},
                      "custom_verifier_threshold": self.verifier_gate}
        self._model = Model(wakeword_models=[self.model_path], inference_framework="onnx", **kwargs)
        self._key = list(self._model.models.keys())[0]
        LOG.info("wake model loaded: %s (key=%s, threshold=%.2f, verifier=%s)",
                 self.model_path, self._key, self.threshold, self.verifier)

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
    text = " ".join(phrase.upper().split())
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
    scored = False

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
        kw_file = self.model_dir / f"keywords-{slug(self.phrase).replace('_', '-')}.txt"
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


class CombinedWake:
    """Runs every detector on every chunk; any one of them fires the wake.

    score is the best continuous score (openWakeWord), for near-miss logging; source says
    which detector fired last."""

    def __init__(self, detectors: list, phrase: str = WAKE_PHRASE) -> None:
        self.detectors = list(detectors)
        self.phrase = phrase
        self.source: str | None = None
        self.score = 0.0

    @property
    def label(self) -> str:
        return " + ".join(d.label for d in self.detectors)

    @property
    def threshold(self) -> float:
        scored = [d.threshold for d in self.detectors if getattr(d, "scored", False)]
        return scored[0] if scored else 0.5

    @property
    def scored(self) -> bool:
        return any(getattr(d, "scored", False) for d in self.detectors)

    def reset(self) -> None:
        for d in self.detectors:
            try:
                d.reset()
            except Exception:
                LOG.exception("wake reset failed (%s)", getattr(d, "name", d))

    def __call__(self, chunk: np.ndarray, threshold: float | None = None) -> tuple[bool, float]:
        fired_by = None
        best = 0.0
        for d in list(self.detectors):
            try:
                fired, score = d(chunk, threshold)
            except Exception:
                LOG.exception("wake detector %s failed; dropping it", getattr(d, "name", d))
                self.detectors.remove(d)
                continue
            if getattr(d, "scored", False):
                best = max(best, score)
            if fired and fired_by is None:
                fired_by = d.name
        self.score = best
        if fired_by:
            self.source = fired_by
            return True, best if best else 1.0
        return False, best


def choose(cfg: VoiceConfig, phrase: str | None = None):
    """Every detector that loads for the phrase, combined; or (None, reason)."""
    from .config import PLUGIN_MODELS, models_dir

    phrase = " ".join((phrase or cfg.wake_word or WAKE_PHRASE).lower().split())
    detectors, reasons = [], []
    key = slug(phrase)
    if key == cfg.wake_slug:
        model = cfg.wake_model_path
    else:
        cands = [models_dir() / f"{key}.onnx", PLUGIN_MODELS / f"{key}.onnx"]
        model = next((c for c in cands if c.exists()), cands[0])
    if model.exists():
        try:
            verifier = cfg.wake_verifier if cfg.wake_verifier and Path(cfg.wake_verifier).name.startswith(key) else None
            w = OpenWakeWord(model, cfg.wake_threshold, verifier, cfg.wake_verifier_gate)
            w.load()
            detectors.append(w)
        except Exception as e:
            LOG.exception("openWakeWord failed to load")
            reasons.append(f"openWakeWord failed ({e.__class__.__name__})")
    else:
        reasons.append(f"no openWakeWord model for {phrase!r}")
    kdir = cfg.kws_path
    if (kdir / "tokens.txt").exists():
        try:
            w = SherpaKws(kdir, phrase, cfg.kws_score, cfg.kws_threshold)
            w.load()
            detectors.append(w)
        except Exception as e:
            LOG.exception("sherpa-onnx keyword spotting failed to load")
            reasons.append(f"sherpa-onnx failed ({e.__class__.__name__})")
    else:
        reasons.append(f"no keyword spotter at {kdir}")
    if not detectors:
        return None, "; ".join(reasons)
    return CombinedWake(detectors, phrase), ("; ".join(reasons) or None)
