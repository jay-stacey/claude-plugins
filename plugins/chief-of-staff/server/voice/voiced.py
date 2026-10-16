"""Chief of Staff voice daemon.

The app server starts it as  HOME\\venv\\Scripts\\python.exe server/voice/voiced.py  and stops it
on stop. It reads HOME\\run\\server.json for the port and token (contracts sections 2, 3, 9).

    voiced.py                                  run the daemon (mic, speakers, app server)
    voiced.py --simulate in.wav --out DIR      no mic or speakers: wake, VAD and STT over a WAV,
                                               the spoken reply goes to WAV files in DIR
    voiced.py --synth "text" --out file.wav    speak text into a WAV file
    voiced.py --self-check [--device cuda|cpu] load every model, speak and transcribe a phrase
    voiced.py --prefetch [--device ...]        download models that are not cached yet
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

from cosvoice import config, logs  # noqa: E402

LOG = logs.LOG


def make_config(args) -> config.VoiceConfig:
    over = {}
    if getattr(args, "device", None):
        over["device"] = args.device
    if getattr(args, "device", None) == "cpu" and not getattr(args, "tts", None):
        over["tts"], over["fallback_tts"] = "kokoro", "chatterbox"
    if getattr(args, "tts", None):
        over["tts"] = args.tts
        over["fallback_tts"] = "kokoro" if args.tts == "chatterbox" else "chatterbox"
    if getattr(args, "stt_model", None):
        if args.device == "cpu":
            over["stt_cpu_model"] = args.stt_model
        else:
            over["stt_model"] = args.stt_model
    return config.load(**over)


# ------------------------------------------------------------------------- daemon
def run(args) -> int:
    from cosvoice.client import ServerLink
    from cosvoice.daemon import Daemon, load_models

    logs.setup()
    cfg = make_config(args)
    LOG.info("voice daemon starting (pid %d, home %s, device %s)", os.getpid(), config.home(), cfg.device)
    stop = threading.Event()

    def on_signal(signum, frame):  # noqa: ANN001
        LOG.info("signal %s: stopping", signum)
        stop.set()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)

    link = ServerLink(level_max_hz=cfg.level_max_hz, gone_after_s=cfg.server_gone_s)
    health = link.wait_for_server(stop)
    if health is None:
        LOG.error("no app server answered within %.0f s; exiting", cfg.server_gone_s)
        return 1
    voice = health.get("voice") if isinstance(health.get("voice"), dict) else {}
    listen = voice.get("listen") if voice.get("listen") in ("wake", "ptt", "off") else "wake"
    speak = voice.get("speak") if isinstance(voice.get("speak"), bool) else True
    link.start_sender()

    def starting(detail: str) -> None:
        link.post({"type": "status", "status": {"state": "starting", "listen": listen, "speak": speak,
                                                "device": None, "stt": None, "tts": None,
                                                "wakeWord": None, "detail": detail}})

    starting("Loading the voice models.")
    t0 = time.perf_counter()
    try:
        models = load_models(cfg, on_progress=starting)
    except Exception as e:
        LOG.exception("loading the voice models failed")
        link.post({"type": "status", "status": {"state": "error", "listen": listen, "speak": speak,
                                                "device": None, "stt": None, "tts": None, "wakeWord": None,
                                                "detail": f"The voice models did not load ({e.__class__.__name__}). See logs\\voice.log."}})
        link.flush()
        link.close()
        return 2
    LOG.info("models loaded in %.1fs: stt=%s tts=%s wake=%s device=%s", time.perf_counter() - t0,
             models.stt.label, models.tts.name, getattr(models.wake, "label", None), models.device)
    from cosvoice import gpu

    LOG.info("GPU memory used now: %s MiB", gpu.used_vram_mib())
    daemon = Daemon(cfg, link, models)
    daemon.stop_event = stop
    if stop.is_set():
        link.close()
        return 0
    daemon.start(listen, speak)
    try:
        daemon.wait()
    finally:
        daemon.shutdown()
        status = daemon.status()
        status.update(state="off", detail="The voice daemon stopped.")
        link.post({"type": "status", "status": status})
        link.flush(2)
        link.close()
    return 0


# ----------------------------------------------------------------------- simulate
class RecordingLink:
    """Stands in for the app server in --simulate: keeps the events instead of posting them."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.levels = 0
        self.pos_s = 0.0  # where in the input WAV the simulation is
        self.lock = threading.Lock()

    def post(self, event: dict) -> None:
        with self.lock:
            if event.get("type") == "level":
                self.levels += 1
                return
            self.events.append(dict(event, at_s=round(self.pos_s, 2)))

    def run_jobs(self, handle, stop) -> None:
        stop.wait()


def simulate(args) -> int:
    import numpy as np

    from cosvoice import gpu
    from cosvoice.audio import read_wav
    from cosvoice.daemon import Daemon, load_models
    from cosvoice.playback import WavSink

    logs.setup(to_stderr=args.verbose)
    cfg = make_config(args)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    models = load_models(cfg)
    load_s = time.perf_counter() - t0
    link = RecordingLink()
    sink = WavSink(out)
    d = Daemon(cfg, link, models, mic=_NoMic(), sink=sink)
    d.speaker.start()
    d.listen = "wake" if models.wake is not None else "ptt"
    d.pipeline.set_mode(d.listen)
    audio = read_wav(args.simulate)
    audio = np.concatenate([np.zeros(8000, np.float32), audio, np.zeros(int(16000 * 2.0), np.float32)])
    if models.wake is None:
        d.apply_control(ptt=True)
    replies = 0
    feed_t0 = time.perf_counter()
    for i in range(0, len(audio), 160):
        link.pos_s = i / 16000
        d.feed(audio[i:i + 160])
        finals = [e for e in link.events if e["type"] == "final"]
        if len(finals) > replies:
            replies = len(finals)
            reply = args.reply or f"You asked: {finals[-1]['text']} Two sessions need you. The first one is waiting on a permission prompt."
            d.handle_job({"id": f"spk_sim{replies}", "kind": "speak", "text": reply})
    if models.wake is None:
        d.apply_control(ptt=False)
    d.pipeline.finish()
    finals = [e for e in link.events if e["type"] == "final"]
    if len(finals) > replies:
        reply = args.reply or f"You asked: {finals[-1]['text']} Two sessions need you. The first one is waiting on a permission prompt."
        d.handle_job({"id": f"spk_sim{len(finals)}", "kind": "speak", "text": reply})
    feed_s = time.perf_counter() - feed_t0
    d.speaker.wait_idle(120)
    finals = [e for e in link.events if e["type"] == "final"]
    result = {
        "input": str(args.simulate), "audio_s": round(len(audio) / 16000, 2),
        "device": models.device, "stt": models.stt.label, "tts": models.tts.name,
        "wake": getattr(models.wake, "label", None), "wake_reason": models.wake_reason,
        "wake_at_s": [e["at_s"] for e in link.events if e["type"] == "wake"],
        "final_at_s": [e["at_s"] for e in finals],
        "transcripts": [e["text"] for e in finals],
        "spoken": [e for e in link.events if e["type"] == "spoken"],
        "reply_files": [str(p) for p in sink.files],
        "tts_metrics": d.speaker.last_metrics,
        "level_events": link.levels, "load_s": round(load_s, 1), "feed_s": round(feed_s, 2),
        "gpu_used_mib": gpu.used_vram_mib(),
    }
    d.speaker.close()
    print(json.dumps(result, indent=2))
    return 0 if finals else 3


class _NoMic:
    is_open = False

    def start(self) -> None:
        raise RuntimeError("no microphone in simulate mode")

    def stop(self) -> None:
        pass

    def read(self, timeout: float = 0.2):
        return None


# ------------------------------------------------------------------- synth, check
def synth(args) -> int:
    from cosvoice import tts
    from cosvoice.audio import write_wav
    from cosvoice.text import clauses, speakable

    import numpy as np

    logs.setup(to_stderr=args.verbose)
    cfg = make_config(args)
    from cosvoice import gpu

    cuda = gpu.prepare_cuda(cfg.device)
    m = tts.build(cfg, "cuda" if cuda else "cpu")
    parts, sr = [], 24000
    for c in clauses(speakable(args.synth)):
        a, sr = m.synthesize(c)
        parts += [a, np.zeros(int(sr * 0.15), np.float32)]
    write_wav(args.out, np.concatenate(parts), sr)
    print(json.dumps({"out": args.out, "tts": m.name, "seconds": round(sum(len(p) for p in parts) / sr, 2)}))
    return 0


def self_check(args) -> int:
    from cosvoice import gpu
    from cosvoice.audio import resample
    from cosvoice.daemon import load_models
    from cosvoice.duplex import EchoCanceller

    logs.setup(to_stderr=True)
    cfg = make_config(args)
    phrase = "Chief of Staff voice check."
    res: dict = {"device_asked": cfg.device, "gpu_used_before_mib": gpu.used_vram_mib()}
    t0 = time.perf_counter()
    models = load_models(cfg)
    res.update(load_s=round(time.perf_counter() - t0, 1), device=models.device, stt=models.stt.label,
               stt_device=models.stt.device, tts=models.tts.name,
               wake=getattr(models.wake, "label", None), wake_reason=models.wake_reason)
    voices = {}
    main_audio = None
    for engine in models.tts.engines:
        try:
            engine.load()
            t1 = time.perf_counter()
            audio, sr = engine.synthesize(phrase)
            voices[engine.name] = {"ok": True, "synth_s": round(time.perf_counter() - t1, 2),
                                   "audio_s": round(len(audio) / sr, 2)}
            if engine.name == models.tts.name:
                import numpy as np

                pad = np.zeros(4800, np.float32)  # 0.3 s of silence so whisper hears the first word
                main_audio = np.concatenate([pad, resample(audio, sr, 16000), pad])
        except Exception as e:
            voices[engine.name] = {"ok": False, "error": str(e)[:200]}
    res["voices"] = voices
    text = models.stt(main_audio) if main_audio is not None else ""
    res["transcript"] = text
    res["echo_cancel"] = EchoCanceller(True).available
    res["vad_speech"] = round(max(models.vad(c) for c in _chunks(main_audio)), 3) if main_audio is not None else None
    res["gpu_used_after_mib"] = gpu.used_vram_mib()
    ok = main_audio is not None and "voice check" in text.lower().replace(",", "")
    res["ok"] = ok
    res["tts_reasons"] = list(getattr(models.tts, "reasons", []))
    try:  # setup.ps1 reads this for its DONE line
        out = config.home() / "run" / "selfcheck.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(res, indent=2), encoding="utf-8")
    except OSError:
        pass
    print(json.dumps(res, indent=2))
    return 0 if ok else 1


def _chunks(audio):
    for i in range(0, len(audio) - 511, 512):
        yield audio[i:i + 512]


def prefetch(args) -> int:
    logs.setup(to_stderr=True)
    cfg = make_config(args)
    from cosvoice.vad import ensure_oww_base_models

    print(f"openWakeWord base models: {ensure_oww_base_models()}")
    from faster_whisper.utils import download_model

    names = [cfg.stt_cpu_model] if cfg.device == "cpu" else [cfg.stt_model, cfg.stt_cpu_model]
    for name in dict.fromkeys(names):
        print(f"faster-whisper {name}: {download_model(name)}")
    if cfg.device != "cpu" or cfg.tts == "chatterbox":
        from huggingface_hub import snapshot_download
        from chatterbox.tts_turbo import REPO_ID

        path = snapshot_download(repo_id=REPO_ID, token=os.getenv("HF_TOKEN") or None,
                                 allow_patterns=["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"])
        print(f"chatterbox turbo: {path}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Chief of Staff voice daemon")
    ap.add_argument("--simulate", metavar="IN_WAV")
    ap.add_argument("--out", metavar="PATH")
    ap.add_argument("--reply", help="simulate: the reply to speak (default: an echo of the transcript)")
    ap.add_argument("--synth", metavar="TEXT")
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--prefetch", action="store_true")
    ap.add_argument("--device", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--tts", choices=["chatterbox", "kokoro"])
    ap.add_argument("--stt-model")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    if args.simulate:
        if not args.out:
            ap.error("--simulate needs --out DIR")
        return simulate(args)
    if args.synth:
        if not args.out:
            ap.error("--synth needs --out FILE")
        return synth(args)
    if args.self_check:
        return self_check(args)
    if args.prefetch:
        return prefetch(args)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
