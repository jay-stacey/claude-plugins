"""Text to speech: Chatterbox Turbo on CUDA (main), Kokoro on the CPU (fallback).

Ported from Pepper tts/manager.py, tts/chatterbox_engine.py and tts/kokoro_engine.py.
Spike rules (RECIPE.md): check free video memory before Chatterbox loads and use Kokoro
when less than about 3.5 GB is free; Chatterbox does not stream, so the caller splits
replies into clauses; warm Chatterbox up at start (the first call takes 3 to 14 s).
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

import numpy as np

from . import gpu

LOG = logging.getLogger("cosvoice")
KOKORO_VOICES = {"af_heart", "af_alloy", "af_bella", "af_nicole", "af_sarah", "af_sky",
                 "am_adam", "am_michael", "bf_emma", "bf_isabella", "bm_george", "bm_lewis"}


class EngineError(RuntimeError):
    pass


class ChatterboxEngine:
    name = "chatterbox"

    def __init__(self, device: str = "auto", ref_wav: str = "", min_free_vram_mib: int = 3584) -> None:
        self.want = device
        self.ref_wav = ref_wav
        self.min_free = min_free_vram_mib
        self.device: str | None = None
        self.variant = "standard"
        self._model = None
        self._prepared = False

    def load(self) -> None:
        if self._model is not None:
            return
        cuda = gpu.prepare_cuda(self.want)
        if self.want == "cpu" or not cuda:
            raise EngineError("Chatterbox needs CUDA here; it is 2.5 times slower than real time on the CPU")
        free = gpu.free_vram_mib()
        if free is not None and free < self.min_free:
            raise EngineError(f"only {free} MiB of video memory is free (Chatterbox needs about {self.min_free})")
        try:
            try:
                from chatterbox.tts_turbo import ChatterboxTurboTTS as Model

                self.variant = "turbo"
            except ImportError:
                from chatterbox.tts import ChatterboxTTS as Model
        except ImportError as e:
            raise EngineError(f"chatterbox-tts is not installed: {e}") from e
        try:
            t0 = time.perf_counter()
            self._model = Model.from_pretrained(device="cuda")
            if self.ref_wav and Path(self.ref_wav).exists():
                self._model.prepare_conditionals(self.ref_wav)
                self._prepared = True
            LOG.info("chatterbox %s loaded on cuda in %.1fs (free VRAM before: %s MiB)",
                     self.variant, time.perf_counter() - t0, free)
        except Exception as e:
            self._model = None
            self.unload()
            raise EngineError(f"Chatterbox failed to load: {e}") from e
        self.device = "cuda"

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        self.load()
        wav = self._model.generate(text)
        audio = wav.squeeze(0).detach().cpu().numpy().astype(np.float32)
        return audio, int(self._model.sr)

    def unload(self) -> None:
        self._model = None
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


class KokoroEngine:
    name = "kokoro"

    def __init__(self, model_dir: str | Path, voice: str = "af_heart") -> None:
        self.model_dir = Path(model_dir)
        self.voice = voice if voice in KOKORO_VOICES else "af_heart"
        self.device = "cpu"
        self._k = None

    def load(self) -> None:
        if self._k is not None:
            return
        onnx = self.model_dir / "kokoro-v1.0.onnx"
        voices = self.model_dir / "voices-v1.0.bin"
        if not onnx.exists() or not voices.exists():
            raise EngineError(f"Kokoro model files are missing in {self.model_dir}")
        try:
            from kokoro_onnx import Kokoro
        except ImportError as e:
            raise EngineError(f"kokoro-onnx is not installed: {e}") from e
        t0 = time.perf_counter()
        self._k = Kokoro(str(onnx), str(voices))
        LOG.info("kokoro loaded in %.1fs", time.perf_counter() - t0)

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        self.load()
        samples, sr = self._k.create(text, voice=self.voice, speed=1.0, lang="en-us")
        return np.asarray(samples, dtype=np.float32), int(sr)

    def unload(self) -> None:
        self._k = None


class TTSManager:
    """Main voice with a fallback. A load or synth failure moves to the fallback for good
    (until reset()), and on_change reports the new engine."""

    def __init__(self, engines: list, on_change=None) -> None:
        self.engines = [e for e in engines if e is not None]
        self.on_change = on_change
        self.active = None
        self.reasons: list[str] = []
        self._failed: set[str] = set()
        self._lock = threading.Lock()

    @property
    def name(self) -> str | None:
        return self.active.name if self.active else None

    def _ensure(self):
        if self.active is not None and self.active.name not in self._failed:
            return self.active
        for engine in self.engines:
            if engine.name in self._failed:
                continue
            try:
                engine.load()
            except Exception as e:
                LOG.warning("tts %s unavailable: %s", engine.name, e)
                self.reasons.append(f"{engine.name}: {e}")
                self._failed.add(engine.name)
                continue
            if self.active is not engine:
                self.active = engine
                LOG.info("tts active engine: %s", engine.name)
                if self.on_change:
                    try:
                        self.on_change(engine.name)
                    except Exception:
                        LOG.exception("tts on_change failed")
            return engine
        raise EngineError("no voice engine is available: " + "; ".join(self.reasons[-3:]))

    def load(self) -> str:
        with self._lock:
            return self._ensure().name

    def synthesize(self, text: str) -> tuple[np.ndarray, int]:
        with self._lock:
            for _ in range(len(self.engines) + 1):
                engine = self._ensure()
                try:
                    return engine.synthesize(text)
                except Exception as e:
                    LOG.error("tts %s failed (%s); falling back", engine.name, e)
                    self.reasons.append(f"{engine.name}: {e}")
                    self._failed.add(engine.name)
                    try:
                        engine.unload()
                    except Exception:
                        pass
                    self.active = None
            raise EngineError("every voice engine failed")

    def warmup(self, text: str = "Ready.") -> float:
        """Load and prime the main voice. Returns seconds taken."""
        t0 = time.perf_counter()
        try:
            self.synthesize(text)
        except Exception as e:
            LOG.warning("tts warm-up failed: %s", e)
        return time.perf_counter() - t0


def build(cfg, device: str) -> TTSManager:
    """Engines in the order the config asks for: main voice first, then the fallback."""
    makers = {
        "chatterbox": lambda: ChatterboxEngine(device, cfg.chatterbox_ref_wav, cfg.min_free_vram_mib),
        "kokoro": lambda: KokoroEngine(cfg.kokoro_path, cfg.kokoro_voice),
    }
    order = []
    for name in (cfg.tts, cfg.fallback_tts, "kokoro"):
        if name in makers and name not in order:
            order.append(name)
    if device == "cpu" and "chatterbox" in order and cfg.tts != "chatterbox":
        order.remove("chatterbox")  # opt-in only on the CPU; too slow as a silent fallback
    return TTSManager([makers[n]() for n in order])
