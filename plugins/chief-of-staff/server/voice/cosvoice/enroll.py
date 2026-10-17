"""Wake word enrollment: voiced.py --enroll N.

Records N clips of the wake phrase and a few clips of other speech from the PC mic, then:
1. calibrates a per-user openWakeWord threshold from the clips' peak scores, and
2. trains an openWakeWord custom verifier (a small logistic regression on openWakeWord's own
   features, the library's train_verifier_model) that learns this speaker's voice.
The verifier is kept only when it still hears the enrollment clips at least as well as the
calibrated threshold alone. Results go to HOME\\models and HOME\\voice.json.

Built for the setup skill: plain prompts on stdout (flushed), a countdown before each clip,
no keyboard input, and a last line "ENROLL: {json}". Exit code 0 when voice.json was updated.
--clips DIR reuses recorded clips (DIR/pos*.wav, DIR/neg*.wav) instead of the mic.
"""

from __future__ import annotations

import json
import logging
import pickle
import sys
import time
from pathlib import Path

import numpy as np

from . import config
from .config import SAMPLE_RATE, VoiceConfig

LOG = logging.getLogger("cosvoice")
POS_SECONDS = 2.5
NEG_SECONDS = 3.0
NEGATIVE_PROMPTS = [
    "What needs me today?",
    "Hey, can you check this for me?",
    "The chief of staff is here.",
    "Hey chef, what is for lunch?",
    "Okay, close that session.",
    "Read me the last reply.",
    "Hey there, how is it going?",
    "Let me think about it.",
]


def say(text: str) -> None:
    print(text, flush=True)


# --------------------------------------------------------------------------- audio
def record(seconds: float) -> np.ndarray:
    import sounddevice as sd

    audio = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    return audio[:, 0].copy()


def beep() -> None:
    try:
        import sounddevice as sd

        from .playback import chime

        sd.play(chime(24000, 150, 0.15), 24000)
        sd.wait()
    except Exception:
        pass


def has_speech(audio: np.ndarray, vad) -> bool:
    probs = [vad(audio[i:i + 512]) for i in range(0, len(audio) - 511, 512)]
    return sum(p >= 0.5 for p in probs) >= 6  # about 0.2 s of speech


def collect(phrase: str, n: int, n_neg: int, out_dir: Path, vad) -> tuple[list[Path], list[Path]]:
    from .audio import write_wav

    out_dir.mkdir(parents=True, exist_ok=True)
    pos, neg = [], []
    say(f"Wake word enrollment for \"{phrase}\". Sit where you usually sit and talk at your normal volume.")
    say(f"I will ask for {n} clips of \"{phrase}\", then {n_neg} other short sentences. Speak after the chime.")
    time.sleep(2)

    def take(prompt: str, seconds: float, path: Path) -> bool:
        for attempt in range(3):
            say(prompt if attempt == 0 else "I did not hear that. Again, after the chime.")
            time.sleep(0.6)
            beep()
            audio = record(seconds)
            if has_speech(audio, vad):
                write_wav(path, audio, SAMPLE_RATE)
                return True
        return False

    for i in range(n):
        p = out_dir / f"pos_{i + 1:02d}.wav"
        if take(f"[{i + 1}/{n}] Say: \"{phrase}\"", POS_SECONDS, p):
            pos.append(p)
    for i in range(n_neg):
        text = NEGATIVE_PROMPTS[i % len(NEGATIVE_PROMPTS)]
        p = out_dir / f"neg_{i + 1:02d}.wav"
        if take(f"[other {i + 1}/{n_neg}] Say: \"{text}\"", NEG_SECONDS, p):
            neg.append(p)
    say("Thanks. Working it out now.")
    return pos, neg


def load_clip(path: Path) -> np.ndarray:
    from .audio import read_wav

    return read_wav(path, SAMPLE_RATE)


def pcm16(audio: np.ndarray, lead_s: float = 1.0, tail_s: float = 0.5) -> np.ndarray:
    pad = [np.zeros(int(SAMPLE_RATE * lead_s), np.float32), np.asarray(audio, np.float32),
           np.zeros(int(SAMPLE_RATE * tail_s), np.float32)]
    return (np.clip(np.concatenate(pad), -1, 1) * 32767).astype(np.int16)


# --------------------------------------------------------------------------- scoring
def peak_score(model, key: str, audio: np.ndarray) -> float:
    model.reset()
    x = pcm16(audio)
    best = 0.0
    for i in range(0, len(x) - 1279, 1280):
        best = max(best, float(model.predict(x[i:i + 1280])[key]))
    model.reset()
    return best


def base_model(model_path: Path, **kw):
    from openwakeword.model import Model

    from .vad import ensure_oww_base_models

    ensure_oww_base_models()
    m = Model(wakeword_models=[str(model_path)], inference_framework="onnx", **kw)
    return m, list(m.models.keys())[0]


def calibrate(pos: list[float], neg: list[float], default: float = 0.35) -> float:
    """A threshold this speaker clears on nearly every clip: 80% of the 20th-percentile peak,
    raised above the loudest non-wake clip when that leaves room. Kept within 0.1 to 0.6."""
    if not pos:
        return default
    p = sorted(pos)
    low = p[int(0.2 * (len(p) - 1))]
    thr = 0.8 * low
    if neg:
        top = max(neg)
        if thr <= top < low:
            thr = (top + low) / 2
    return round(min(0.6, max(0.1, thr)), 3)


def train_verifier(model_path: Path, pos: list[np.ndarray], neg: list[np.ndarray], gate: float, out: Path) -> bool:
    """openWakeWord custom verifier from this speaker's clips. Features are taken where the
    base model scores at least `gate` on the wake clips, and everywhere on the other clips."""
    from openwakeword.custom_verifier_model import get_reference_clip_features, train_verifier_model

    m, key = base_model(model_path)
    pf = [get_reference_clip_features(pcm16(a), m, key, threshold=gate, N=3) for a in pos]
    pf = np.vstack([f for f in pf if len(f)]) if any(len(f) for f in pf) else np.empty((0,))
    nf = [get_reference_clip_features(pcm16(a), m, key, threshold=0.0, N=1) for a in neg]
    nf = np.vstack([f for f in nf if len(f)]) if any(len(f) for f in nf) else np.empty((0,))
    if pf.shape[0] < 3 or nf.shape[0] < 3:
        LOG.warning("verifier: too few feature windows (positive %d, negative %d)", pf.shape[0], nf.shape[0])
        return False
    clf = train_verifier_model(np.vstack((pf, nf)), np.array([1] * pf.shape[0] + [0] * nf.shape[0]))
    with open(out, "wb") as f:
        pickle.dump(clf, f)
    return True


def detect_rate(model_path: Path, clips: list[np.ndarray], threshold: float, verifier: Path | None = None,
                gate: float = 0.1) -> float:
    if not clips:
        return 0.0
    kw = {}
    if verifier:
        kw = {"custom_verifier_models": {model_path.stem: str(verifier)}, "custom_verifier_threshold": gate}
    m, key = base_model(model_path, **kw)
    return sum(peak_score(m, key, a) >= threshold for a in clips) / len(clips)


# --------------------------------------------------------------------------- voice.json
def update_voice_json(changes: dict, path: Path | None = None) -> Path:
    path = path or config.home() / "voice.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    for k, v in changes.items():
        if v is None:
            data.pop(k, None)
        else:
            data[k] = v
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=4), encoding="utf-8")  # no byte order mark
    return path


# --------------------------------------------------------------------------- main
def run(cfg: VoiceConfig, n: int, clips_dir: str | None = None, n_neg: int | None = None) -> int:
    from .vad import SileroVAD

    phrase = cfg.wake_word
    model_path = cfg.wake_model_path
    result: dict = {"phrase": phrase, "model": str(model_path)}
    if not model_path.exists():
        result.update(ok=False, error=f"no openWakeWord model for {phrase!r}; the keyword spotter needs no enrollment")
        say("ENROLL: " + json.dumps(result))
        return 1
    config.models_dir().mkdir(parents=True, exist_ok=True)
    n = max(3, int(n))
    n_neg = max(3, n // 2) if n_neg is None else max(2, n_neg)
    out_dir = config.models_dir() / "enroll" / cfg.wake_slug
    if clips_dir:
        d = Path(clips_dir)
        pos_files, neg_files = sorted(d.glob("pos*.wav")), sorted(d.glob("neg*.wav"))
    else:
        vad = SileroVAD()
        vad.load()
        pos_files, neg_files = collect(phrase, n, n_neg, out_dir, vad)
    pos = [load_clip(p) for p in pos_files]
    neg = [load_clip(p) for p in neg_files]
    result.update(positive_clips=len(pos), other_clips=len(neg))
    if len(pos) < 3:
        result.update(ok=False, error="fewer than 3 usable wake word clips")
        say("ENROLL: " + json.dumps(result))
        return 1
    m, key = base_model(model_path)
    pos_peaks = [peak_score(m, key, a) for a in pos]
    neg_peaks = [peak_score(m, key, a) for a in neg]
    thr = calibrate(pos_peaks, neg_peaks, cfg.wake_threshold)
    result.update(positive_peaks=[round(x, 3) for x in pos_peaks], other_peaks=[round(x, 3) for x in neg_peaks],
                  old_threshold=cfg.wake_threshold, threshold=thr,
                  recall_old=round(sum(x >= cfg.wake_threshold for x in pos_peaks) / len(pos), 3),
                  recall_new=round(sum(x >= thr for x in pos_peaks) / len(pos), 3),
                  false_accepts_new=round(sum(x >= thr for x in neg_peaks) / max(1, len(neg)), 3))
    changes = {"wakeThreshold": thr, "wakeVerifier": None, "wakeVerifierGate": None}
    verifier = config.models_dir() / f"{cfg.wake_slug}.verifier.pkl"
    gate = round(max(0.05, 0.6 * thr), 3)
    try:
        trained = len(neg) >= 2 and train_verifier(model_path, pos, neg, gate, verifier)
    except Exception as e:
        LOG.exception("verifier training failed")
        trained = False
        result["verifier_error"] = str(e)[:200]
    if trained:
        v_recall = detect_rate(model_path, pos, 0.5, verifier, gate)
        v_false = detect_rate(model_path, neg, 0.5, verifier, gate)
        result.update(verifier_recall=round(v_recall, 3), verifier_false_accepts=round(v_false, 3))
        if v_recall >= result["recall_new"] and v_false <= result["false_accepts_new"]:
            # With a verifier, a wake needs base score >= gate and verifier probability >= 0.5.
            changes = {"wakeThreshold": 0.5, "wakeVerifier": str(verifier), "wakeVerifierGate": gate}
            result.update(verifier=str(verifier), gate=gate)
        else:
            result["verifier"] = None
            result["verifier_note"] = "the verifier heard the clips worse than the threshold alone; not used"
    path = update_voice_json(changes)
    (config.models_dir() / f"{cfg.wake_slug}.enroll.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    result.update(ok=True, voice_json=str(path), applies="when the voice daemon starts next")
    say(f"Done. Wake word threshold {thr}" + (f", plus a voice verifier (gate {gate})." if result.get("verifier") else "."))
    say("ENROLL: " + json.dumps(result))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run(config.load(), int(sys.argv[1]) if len(sys.argv) > 1 else 8))
