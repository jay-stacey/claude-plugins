"""Paths and settings for the voice daemon.

HOME is %USERPROFILE%\\.claude\\chief-of-staff (COS_HOME moves it, for tests).
setup.ps1 writes HOME\\voice.json with the device and model choices; every key is optional.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field, fields
from pathlib import Path

SAMPLE_RATE = 16000
CHUNK = 512  # Silero VAD frame at 16 kHz (32 ms)
CHUNK_MS = CHUNK * 1000 / SAMPLE_RATE
WAKE_PHRASE = "hey chief"
KWS_DIRNAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"


def home() -> Path:
    override = os.environ.get("COS_HOME")
    return Path(override) if override else Path.home() / ".claude" / "chief-of-staff"


def server_json() -> Path:
    return home() / "run" / "server.json"


def logs_dir() -> Path:
    return home() / "logs"


def models_dir() -> Path:
    return home() / "models"


@dataclass
class VoiceConfig:
    # Devices and models
    device: str = "auto"                 # auto | cuda | cpu
    tts: str = "chatterbox"              # main voice
    fallback_tts: str = "kokoro"
    stt_model: str = "large-v3-turbo"
    stt_compute: str = "int8_float16"
    stt_cpu_model: str = "small.en"      # used when CUDA is not there or fails
    stt_cpu_compute: str = "int8"
    kokoro_dir: str = ""
    kokoro_voice: str = "af_heart"
    chatterbox_ref_wav: str = ""         # optional voice to clone (over 5 s)
    min_free_vram_mib: int = 3584        # below this, Kokoro is the main voice
    # Wake word
    wake_model: str = ""                 # openWakeWord .onnx; default HOME\models\hey_chief.onnx
    wake_threshold: float = 0.5
    wake_speaking_threshold: float = 0.7  # half duplex: our own voice is on the mic
    kws_dir: str = ""
    kws_threshold: float = 0.25
    kws_score: float = 1.5
    # Listening
    preroll_ms: int = 1500
    trailing_silence_ms: int = 800
    wake_speech_timeout_ms: int = 5000
    max_utterance_ms: int = 30000
    vad_start: float = 0.5
    vad_end: float = 0.35
    echo_cancel: bool = True
    aec_delay_ms: int = 80
    speaking_tail_ms: int = 300
    input_device: str | int | None = None
    output_device: str | int | None = None
    # Server
    level_max_hz: float = 10.0
    server_gone_s: float = 120.0
    extra: dict = field(default_factory=dict)

    @property
    def wake_model_path(self) -> Path:
        return Path(self.wake_model) if self.wake_model else models_dir() / "hey_chief.onnx"

    @property
    def kws_path(self) -> Path:
        return Path(self.kws_dir) if self.kws_dir else models_dir() / "kws" / KWS_DIRNAME

    @property
    def kokoro_path(self) -> Path:
        return Path(self.kokoro_dir) if self.kokoro_dir else models_dir() / "kokoro"


# voice.json uses camelCase keys (written by PowerShell); map them to the fields.
_ALIASES = {
    "fallbackTts": "fallback_tts", "sttModel": "stt_model", "sttCompute": "stt_compute",
    "sttCpuModel": "stt_cpu_model", "sttCpuCompute": "stt_cpu_compute", "kokoroDir": "kokoro_dir",
    "kokoroVoice": "kokoro_voice", "chatterboxRefWav": "chatterbox_ref_wav",
    "minFreeVramMiB": "min_free_vram_mib", "wakeModel": "wake_model", "wakeThreshold": "wake_threshold",
    "wakeSpeakingThreshold": "wake_speaking_threshold", "kwsDir": "kws_dir",
    "kwsThreshold": "kws_threshold", "kwsScore": "kws_score", "echoCancel": "echo_cancel",
    "inputDevice": "input_device", "outputDevice": "output_device",
    "trailingSilenceMs": "trailing_silence_ms", "prerollMs": "preroll_ms",
}


def load(path: Path | None = None, **overrides) -> VoiceConfig:
    """Read HOME\\voice.json (missing or bad file means defaults), then apply overrides."""
    cfg = VoiceConfig()
    path = path or home() / "voice.json"
    data: dict = {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            data = {}
    except OSError:
        data = {}
    except ValueError as e:
        logging.getLogger("cosvoice").warning("%s is not valid JSON (%s); using defaults", path, e)
        data = {}
    names = {f.name: f for f in fields(VoiceConfig)}
    for key, value in data.items():
        name = _ALIASES.get(key, key)
        if name in names and name != "extra" and value is not None:
            default = getattr(cfg, name)
            try:
                if isinstance(default, bool):
                    value = bool(value)
                elif isinstance(default, int) and not isinstance(default, bool):
                    value = int(value)
                elif isinstance(default, float):
                    value = float(value)
            except (TypeError, ValueError):
                continue
            setattr(cfg, name, value)
        else:
            cfg.extra[key] = value
    for key, value in overrides.items():
        if value is not None:
            setattr(cfg, key, value)
    if cfg.device == "cpu" and cfg.tts == "chatterbox" and "tts" not in data and "tts" not in overrides:
        cfg.tts, cfg.fallback_tts = "kokoro", "chatterbox"
    return cfg


def read_server_info() -> dict | None:
    """HOME\\run\\server.json as the app server wrote it, or None."""
    try:
        info = json.loads(server_json().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict) or not info.get("port") or not info.get("token"):
        return None
    return info
