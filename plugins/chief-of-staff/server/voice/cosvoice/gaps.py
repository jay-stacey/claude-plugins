"""Measure the silence between speech chunks of a reply (voiced.py --gaps).

A RealtimeSink stands in for the speakers: it takes as long as the audio lasts, like a real
device, and records when each chunk started. The silence a listener hears between chunk n
and chunk n+1 is: the wait for chunk n+1 to be synthesized (starvation), plus the silence at
the end of chunk n and at the start of chunk n+1 (inside the synthesized audio).
No mic and no speakers are used.
"""

from __future__ import annotations

import threading
import time

import numpy as np

SAMPLE_REPLY = (
    "Two sessions need you. The plan for PRO-921 is waiting on your vendor name decision.\n\n"
    "DP1-676 finished its last turn. PR 1737 is open and the checks passed, so it is ready for review.\n\n"
    "The inventory feed session is still working. It started twenty minutes ago and has not asked for anything. "
    "Nothing else is blocked. Do you want me to archive the merged sessions?"
)


SAMPLE_PARAGRAPHS = SAMPLE_REPLY.split("\n\n")


def edge_silence(audio: np.ndarray, sr: int, floor: float = 0.01, frame_ms: int = 10) -> tuple[float, float]:
    """Seconds of near-silence at the start and at the end of a chunk."""
    a = np.abs(np.asarray(audio, dtype=np.float32).reshape(-1))
    n = max(1, int(sr * frame_ms / 1000))
    frames = [float(a[i:i + n].max()) for i in range(0, len(a), n)] or [0.0]
    loud = [i for i, v in enumerate(frames) if v >= floor]
    if not loud:
        return len(a) / sr, 0.0
    return loud[0] * n / sr, (len(frames) - 1 - loud[-1]) * n / sr


class RealtimeSink:
    def __init__(self) -> None:
        self.plays: list[dict] = []
        self.finished = 0

    def open(self, sr: int) -> None:
        pass

    def play(self, audio, sr, cancel, started) -> bool:
        started()
        t = time.perf_counter()
        lead, trail = edge_silence(audio, sr)
        dur = len(audio) / sr
        self.plays.append({"start": t, "dur": dur, "lead": lead, "trail": trail})
        end = t + dur
        while time.perf_counter() < end:
            if cancel.is_set():
                return False
            time.sleep(min(0.01, max(0.0, end - time.perf_counter())))
        return True

    def finish(self) -> None:
        self.finished += 1

    def close(self) -> None:
        pass


def report(sink: RealtimeSink) -> dict:
    """Merge back-to-back plays (a chunk and the pause written after it) and measure joins."""
    plays = sink.plays
    gaps = []
    for a, b in zip(plays, plays[1:]):
        wait = max(0.0, b["start"] - (a["start"] + a["dur"]))
        gaps.append({"wait_s": round(wait, 3), "silence_s": round(wait + a["trail"] + b["lead"], 3)})
    sil = [g["silence_s"] for g in gaps]
    return {"chunks": len(plays), "gaps": gaps,
            "max_silence_s": round(max(sil), 3) if sil else 0.0,
            "mean_silence_s": round(sum(sil) / len(sil), 3) if sil else 0.0,
            "lead_s": round(plays[0]["lead"], 3) if plays else None}


def measure(speaker_cls, synthesize, text=SAMPLE_REPLY, **kw) -> dict:
    """text: one reply, or a list of replies sent as back-to-back speak jobs (the Chief's
    reply often arrives as one job per paragraph)."""
    texts = [text] if isinstance(text, str) else list(text)
    sink = RealtimeSink()
    done = threading.Event()
    spoken = []

    def on_event(kind, payload):
        if kind == "spoken":
            spoken.append(payload)
            if len(spoken) >= len(texts):
                done.set()

    sp = speaker_cls(synthesize, sink, on_event, tail_ms=0, **kw)
    sp.start()
    t0 = time.perf_counter()
    for i, t in enumerate(texts):
        sp.submit(f"spk_gaps{i + 1}", t)
    done.wait(600)
    total = time.perf_counter() - t0
    out = report(sink)
    out["ttfa_s"] = round(sink.plays[0]["start"] - t0, 3) if sink.plays else None
    out["total_s"] = round(total, 2)
    sp.close()
    return out
