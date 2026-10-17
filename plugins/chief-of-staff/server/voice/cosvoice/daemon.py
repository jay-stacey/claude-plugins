"""The voice daemon: ties mic, echo control, pipeline, speaker and the app server together.

Threads: audio (mic -> echo control -> 512-sample chunks -> pipeline), speaker (synth and
playback), jobs (long poll), events (posts to the server), main (waits for stop).
"""

from __future__ import annotations

import logging
import random
import threading
import time

import numpy as np

from .audio import MicCapture, Rechunker, level
from .config import CHUNK, VoiceConfig
from .duplex import FRAME, EchoCanceller, RenderReference
from .pipeline import Pipeline
from .playback import Speaker, SpeakerSink, chime, trim_edges

LOG = logging.getLogger("cosvoice")


class Models:
    """What the daemon needs, loaded once. Tests pass fakes with the same shape."""

    def __init__(self, vad, wake, stt, tts, device: str | None, wake_reason: str | None = None) -> None:
        self.vad = vad
        self.wake = wake
        self.stt = stt
        self.tts = tts
        self.device = device
        self.wake_reason = wake_reason


def load_models(cfg: VoiceConfig, on_progress=lambda detail: None) -> Models:
    """Load order matters: torch, then faster-whisper (spike known problem 2), then the
    free video memory check and Chatterbox, then the small CPU models."""
    from . import gpu, stt, tts, vad, wake

    want = cfg.device
    on_progress("Loading speech to text.")
    cuda = gpu.prepare_cuda(want)
    t = stt.Transcriber(cfg.stt_model, cfg.stt_compute, cfg.stt_cpu_model, cfg.stt_cpu_compute,
                        device="cuda" if cuda else "cpu")
    t.load()
    device = "cuda" if (cuda and t.device == "cuda") else "cpu"
    on_progress("Loading the voice.")
    manager = tts.build(cfg, "cuda" if cuda else "cpu")
    manager.load()
    warm = manager.warmup("Ready.")
    LOG.info("tts %s warm in %.1fs", manager.name, warm)
    if manager.name == "chatterbox":
        device = "cuda"
    on_progress("Loading the wake word.")
    v = vad.SileroVAD()
    v.load()
    w, reason = wake.choose(cfg)
    return Models(v, w, t, manager, device, reason)


class Clips:
    """Short sounds cached in the current voice so they play with no delay: the "Yes?" wake
    acknowledgment and the filler acknowledgments. Rebuilt in the background at start and
    after the voice engine changes."""

    YES = "Yes?"

    def __init__(self, tts, fillers: list[str]) -> None:
        self.tts = tts
        self.fillers = [f for f in fillers if isinstance(f, str) and f.strip()]
        self._cache: dict[str, tuple] = {}
        self._engine = None
        self._gen = 0
        self._lock = threading.Lock()
        self._recent: list[str] = []

    def rebuild(self, fillers: list[str] | None = None, wait: bool = False) -> None:
        with self._lock:
            if fillers is not None:
                self.fillers = [f for f in fillers if isinstance(f, str) and f.strip()][:20]
            self._gen += 1
            gen = self._gen
            self._cache = {k: v for k, v in self._cache.items() if self._engine == getattr(self.tts, "name", None)
                           and (k == self.YES or k in self.fillers)}

        def run():
            engine = getattr(self.tts, "name", None)
            for text in [self.YES] + list(self.fillers):
                if gen != self._gen:
                    return
                if text in self._cache and self._engine == engine:
                    continue
                try:
                    audio, sr = self.tts.synthesize(text)
                except Exception:
                    LOG.exception("caching %r failed", text)
                    continue
                with self._lock:
                    if gen == self._gen:
                        self._cache[text] = (trim_edges(audio, sr), sr)
            self._engine = engine
            LOG.info("cached %d short clips in the %s voice", len(self._cache), engine)

        t = threading.Thread(target=run, name="clips", daemon=True)
        t.start()
        if wait:
            t.join(120)

    def engine_changed(self) -> None:
        if getattr(self.tts, "name", None) != self._engine:
            self.rebuild()

    def get(self, text: str):
        with self._lock:
            return self._cache.get(text)

    def pick_filler(self):
        """A cached filler that is not one of the last two played."""
        with self._lock:
            ready = [f for f in self.fillers if f in self._cache]
            fresh = [f for f in ready if f not in self._recent[-2:]] or ready
            if not fresh:
                return None, None
            text = random.choice(fresh)
            self._recent = (self._recent + [text])[-2:]
            return text, self._cache[text]


class Daemon:
    def __init__(self, cfg: VoiceConfig, link, models: Models, mic=None, sink=None, echo=None) -> None:
        self.cfg = cfg
        self.link = link
        self.m = models
        self.stop_event = threading.Event()
        self.ref = RenderReference()
        self.echo = echo if echo is not None else EchoCanceller(cfg.echo_cancel, cfg.aec_delay_ms)
        self.mic = mic if mic is not None else MicCapture(chunk_samples=FRAME, device=cfg.input_device)
        self.sink = sink if sink is not None else SpeakerSink(cfg.output_device, self.ref)
        self.speaker = Speaker(models.tts.synthesize, self.sink, self._on_speaker, cfg.speaking_tail_ms,
                               pause_ms=cfg.chunk_pause_ms)
        self.clips = Clips(models.tts, list(cfg.fillers))
        self.wake_ack = cfg.wake_ack if cfg.wake_ack in ("chime", "word", "off") else "chime"
        self.pipeline = Pipeline(cfg, models.vad, models.wake, models.stt, self._on_pipeline,
                                 is_speaking=lambda: self.speaker.is_speaking,
                                 full_duplex=lambda: self.echo.available, on_state=self.publish)
        self.listen = "off"
        self.speak = True
        self.error: str | None = None
        self.notice: str | None = None
        self._last_status: dict | None = None
        self._status_lock = threading.Lock()
        self._rechunk = Rechunker(CHUNK)
        self._threads: list[threading.Thread] = []
        if models.tts is not None and hasattr(models.tts, "on_change"):
            models.tts.on_change = self._engine_changed

    def _engine_changed(self, name=None) -> None:
        self.clips.engine_changed()
        self.publish()

    # --------------------------------------------------------------- status
    def ready_detail(self) -> str:
        parts = []
        if self.m.wake is not None:
            parts.append(f"Wake word by {self.m.wake.label}")
        else:
            parts.append("No wake word model, so use push-to-talk")
        parts.append("echo cancellation on" if self.echo.available else "half duplex (no echo cancellation)")
        tts = getattr(self.m.tts, "name", None)
        reasons = getattr(self.m.tts, "reasons", [])
        if tts and tts != self.cfg.tts and reasons:
            parts.append(f"{tts} voice because {reasons[-1].split(': ', 1)[-1]}")
        return ", ".join(parts) + "."

    def status(self) -> dict:
        if self.error:
            state = "error"
        elif self.pipeline.state == "capturing":
            state = "hearing"
        elif self.pipeline.state == "transcribing":
            state = "thinking"
        elif self.speaker.is_busy:
            state = "speaking"
        elif self.listen == "off":
            state = "off"
        else:
            state = "listening"
        return {
            "state": state, "listen": self.listen, "speak": self.speak, "device": self.m.device,
            "stt": getattr(self.m.stt, "label", None), "tts": getattr(self.m.tts, "name", None),
            "wakeWord": self.cfg.wake_word if self.m.wake is not None else None,
            "detail": self.error or self.notice or self.ready_detail(),
        }

    def publish(self) -> None:
        with self._status_lock:
            s = self.status()
            if s == self._last_status:
                return
            self._last_status = s
        LOG.info("status %s", {k: s[k] for k in ("state", "listen", "speak", "tts")})
        self.link.post({"type": "status", "status": s})

    # ----------------------------------------------------------------- jobs
    def apply_settings(self, job: dict) -> None:
        """wakeWord, wakeAck, fillers and chiefName from a control job (sent at first poll and
        after a change). A new wake word loads in the background; the old one works until then."""
        ack = job.get("wakeAck")
        if ack in ("chime", "word", "off"):
            self.wake_ack = ack
        fillers = job.get("fillers")
        if isinstance(fillers, list) and fillers != self.clips.fillers:
            self.clips.rebuild([str(f)[:80] for f in fillers if isinstance(f, str)])
        name = job.get("chiefName")
        if isinstance(name, str):
            self.cfg.chief_name = name.strip()[:40]
            self.pipeline.set_wake(self.pipeline._wake, None, self.cfg.chief_name)
        word = job.get("wakeWord")
        if isinstance(word, str) and word.strip():
            phrase = " ".join(word.lower().split())[:40]
            if phrase != " ".join(self.cfg.wake_word.lower().split()) or self.m.wake is None:
                threading.Thread(target=self._load_wake, args=(phrase,), name="wake-load", daemon=True).start()

    def _load_wake(self, phrase: str) -> None:
        from . import wake

        LOG.info("loading the wake word %r", phrase)
        w, reason = wake.choose(self.cfg, phrase)
        if w is None:
            self.notice = f"The wake word {phrase!r} did not load ({reason}). The old one still works."
            self.publish()
            return
        self.cfg.wake_word = phrase
        self.m.wake, self.m.wake_reason = w, reason
        self.pipeline.set_wake(w, phrase)
        self.notice = None
        self.publish()

    def apply_control(self, listen=None, speak=None, ptt=None) -> None:
        if listen in ("wake", "ptt", "off"):
            if listen == "wake" and self.m.wake is None:
                self.notice = "There is no wake word model, so the wake word cannot work. Use push-to-talk."
            else:
                self.notice = None
            self.listen = listen
            self.pipeline.set_mode(listen)
        if isinstance(speak, bool):
            self.speak = speak
            if not speak:
                self.speaker.stop("muted")
        if isinstance(ptt, bool):
            if ptt and self.speaker.is_busy:
                self.speaker.stop("push-to-talk")
            if ptt and self.listen == "ptt":
                self._open_mic()
            self.pipeline.set_ptt(ptt)
        self.publish()

    def handle_job(self, job: dict) -> None:
        kind = job.get("kind")
        if kind == "speak":
            text = job.get("text") or ""
            if not self.speak:
                self.link.post({"type": "spoken", "id": job.get("id"), "ok": False})
                return
            self.speaker.submit(str(job.get("id") or ""), str(text))
        elif kind == "stop":
            self.speaker.stop("stop")
        elif kind == "control":
            self.apply_settings(job)
            self.apply_control(job.get("listen"), job.get("speak"), job.get("pttDown"))
        elif kind == "ack":
            self.ack(job.get("id"))
        elif kind in ("quit", "shutdown"):
            LOG.info("quit job from the server")
            self.stop_event.set()
        else:
            LOG.warning("unknown job kind %r", kind)

    def ack(self, job_id=None) -> bool:
        """A short filler ("On it.") right away, unless something is already playing."""
        played = False
        if self.speak and not self.speaker.is_busy and not self.speaker.is_speaking:
            text, clip = self.clips.pick_filler()
            if clip is not None:
                played = self.speaker.play_clip(*clip)
                LOG.info("filler %r%s", text, "" if played else " skipped")
        if job_id:
            self.link.post({"type": "spoken", "id": job_id, "ok": played})
        return played

    def wake_acknowledge(self) -> None:
        if self.wake_ack == "off":
            return
        clip = self.clips.get(Clips.YES) if self.wake_ack == "word" else None
        audio, sr = clip if clip is not None else (chime(), 24000)
        self.speaker.play_clip(audio, sr)

    # --------------------------------------------------------------- events
    def _on_pipeline(self, kind: str, payload: dict) -> None:
        if kind == "wake":
            self.link.post({"type": "wake", "score": payload.get("score"), "source": payload.get("source")})
            if payload.get("barge") or self.speaker.is_busy:
                LOG.info("barge-in by the wake word: stopping speech")
                self.speaker.stop("barge-in")
            self.wake_acknowledge()
            self.publish()
        elif kind == "barge":
            LOG.info("barge-in by speech: stopping speech")
            self.speaker.stop("barge-in")
            self.link.post({"type": "barge"})
            self.publish()
        elif kind == "nearMiss":
            self.link.post({"type": "nearMiss", "score": payload.get("score")})
        elif kind == "final":
            LOG.info("final: %r", payload["text"])
            self.link.post({"type": "final", "text": payload["text"]})
        elif kind == "error":
            self.notice = payload.get("detail")
            self.publish()

    def _on_speaker(self, kind: str, payload: dict) -> None:
        if kind == "spoken":
            self.link.post({"type": "spoken", "id": payload["id"], "ok": bool(payload["ok"])})
        elif kind == "idle":
            self.ref.clear()
        self.publish()

    # ---------------------------------------------------------------- audio
    def _want_mic(self) -> bool:
        if self.listen == "wake":
            return self.m.wake is not None
        if self.listen == "ptt":
            return self.pipeline.ptt_down or self.pipeline.state == "capturing"
        return False

    def _open_mic(self) -> bool:
        if self.mic.is_open:
            return True
        try:
            self.mic.start()
            if self.error and self.error.startswith("The microphone"):
                self.error = None
            return True
        except Exception as e:
            LOG.exception("microphone failed to open")
            self.error = f"The microphone did not open ({e.__class__.__name__})."
            self.publish()
            return False

    def feed(self, block: np.ndarray) -> None:
        """One mic block (any size): echo control, then 512-sample chunks into the pipeline."""
        if self.speaker.is_speaking and self.echo.available:
            out = []
            for i in range(0, len(block) - FRAME + 1, FRAME):
                near = block[i:i + FRAME]
                out.append(self.echo.process(near, self.ref.pull(FRAME)))
            block = np.concatenate(out) if out else block
        for chunk in self._rechunk.push(block):
            self.link.post({"type": "level", "rms": level(chunk)})
            self.pipeline.process_chunk(chunk)

    def audio_loop(self) -> None:
        mic_retry_at = 0.0
        while not self.stop_event.is_set():
            want = self._want_mic()
            if want and not self.mic.is_open and time.monotonic() >= mic_retry_at:
                if not self._open_mic():
                    mic_retry_at = time.monotonic() + 10
            elif not want and self.mic.is_open:
                self.mic.stop()
                self._rechunk.clear()
                self.pipeline.reset()
                self.link.post({"type": "level", "rms": 0.0})
            if not self.mic.is_open:
                self.stop_event.wait(0.05)
                continue
            block = self.mic.read(0.2)
            if block is None:
                continue
            try:
                self.feed(block)
            except Exception:
                LOG.exception("audio processing failed")

    # ------------------------------------------------------------------ run
    def start(self, listen: str = "wake", speak: bool = True) -> None:
        self.speaker.start()
        self.clips.rebuild()
        self.listen = listen if listen in ("wake", "ptt", "off") else "wake"
        self.speak = bool(speak)
        self.pipeline.set_mode(self.listen)
        if self.listen == "wake" and self.m.wake is None:
            self.notice = "There is no wake word model, so the wake word cannot work. Use push-to-talk."
        self.publish()
        a = threading.Thread(target=self.audio_loop, name="audio", daemon=True)
        j = threading.Thread(target=self._jobs, name="jobs", daemon=True)
        self._threads = [a, j]
        a.start()
        j.start()

    def _jobs(self) -> None:
        self.link.run_jobs(self.handle_job, self.stop_event)
        if not self.stop_event.is_set():
            LOG.warning("app server went away; shutting down")
            self.stop_event.set()

    def wait(self) -> None:
        while not self.stop_event.wait(0.5):
            pass

    def shutdown(self) -> None:
        self.stop_event.set()
        try:
            self.speaker.close()
        except Exception:
            LOG.exception("speaker close failed")
        try:
            self.mic.stop()
        except Exception:
            LOG.exception("mic close failed")
        for t in self._threads:
            t.join(timeout=3)
        LOG.info("voice daemon stopped")
