"""Wake reliability, acknowledgments, barge-in, gaps, fillers, settings and natural reading."""

import json
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import numpy as np

from fakes import SPEECH, WAKE, FakeLink, FakeMic, FakeSink, FakeSTT, FakeTTS, FakeVAD, FakeWake, chunk, config, wait_for
from cosvoice import enroll, gaps
from cosvoice.daemon import Clips, Daemon, Models
from cosvoice.pipeline import Pipeline
from cosvoice.playback import Speaker, chime, trim_edges
from cosvoice.text import naturalize, say_number, speakable, strip_wake
from cosvoice.wake import CombinedWake


class ScoreWake:
    """Score = the chunk's mean value; fires at threshold 0.5. scored like openWakeWord."""
    name = "openwakeword"
    label = "score wake"
    scored = True
    threshold = 0.5

    def __call__(self, c, threshold=None):
        s = float(np.mean(c))
        return s >= max(self.threshold, threshold or 0), s

    def reset(self):
        pass


class YesNoWake:
    name = "sherpa-onnx"
    label = "kws"
    scored = False
    threshold = 0.5

    def __init__(self):
        self.fire_next = False

    def __call__(self, c, threshold=None):
        f, self.fire_next = self.fire_next, False
        return f, 1.0 if f else 0.0

    def reset(self):
        pass


class _NoEcho:
    def __init__(self, available=False):
        self.available = available

    def process(self, near, far):
        return near


# ----------------------------------------------------------------------------- wake
class CombinedWakeTest(unittest.TestCase):
    def test_either_detector_fires(self):
        a, b = ScoreWake(), YesNoWake()
        w = CombinedWake([a, b])
        self.assertEqual(w(chunk(0.3)), (False, 0.30000001192092896))
        b.fire_next = True
        fired, score = w(chunk(0.3))   # openWakeWord at 0.3 misses; the keyword spotter fires
        self.assertTrue(fired)
        self.assertEqual(w.source, "sherpa-onnx")
        fired, _ = w(chunk(0.6))
        self.assertTrue(fired)
        self.assertEqual(w.source, "openwakeword")
        self.assertTrue(w.scored)
        self.assertEqual(w.threshold, 0.5)

    def test_broken_detector_is_dropped(self):
        class Broken(YesNoWake):
            def __call__(self, c, threshold=None):
                raise RuntimeError("boom")

        w = CombinedWake([Broken(), ScoreWake()])
        self.assertEqual(w(chunk(0.9))[0], True)
        self.assertEqual(len(w.detectors), 1)


class NearMissTest(unittest.TestCase):
    def setUp(self):
        self.now = [100.0]
        self.events = []
        self.p = Pipeline(config(), FakeVAD(), CombinedWake([ScoreWake()]), FakeSTT(),
                          lambda k, p: self.events.append((k, p)), clock=lambda: self.now[0])
        self.p.set_mode("wake")

    def near(self):
        return [p for k, p in self.events if k == "nearMiss"]

    def test_peak_reported_once_per_2s(self):
        for v in (0.1, 0.32, 0.42, 0.36, 0.1):   # rises to 0.42 (>= 0.6 x 0.5), falls back
            self.p.process_chunk(chunk(v))
        self.assertEqual(self.near(), [{"score": 0.42, "threshold": 0.5}])
        self.now[0] += 1.0
        for v in (0.4, 0.1):
            self.p.process_chunk(chunk(v))
        self.assertEqual(len(self.near()), 1)     # within 2 s: not reported
        self.now[0] += 1.5
        for v in (0.45, 0.1):
            self.p.process_chunk(chunk(v))
        self.assertEqual(len(self.near()), 2)

    def test_below_ratio_and_real_wake_are_not_near_misses(self):
        for v in (0.25, 0.1, 0.9, 0.1):
            self.p.process_chunk(chunk(v))
        self.assertEqual(self.near(), [])
        wakes = [p for k, p in self.events if k == "wake"]
        self.assertEqual(len(wakes), 1)
        self.assertAlmostEqual(wakes[0]["score"], 0.9, places=3)
        self.assertEqual(wakes[0]["source"], "openwakeword")


# ---------------------------------------------------------------------------- barge
class BargeTest(unittest.TestCase):
    def make(self, duplex):
        self.events = []
        self.speaking = True
        self.p = Pipeline(config(), FakeVAD(), FakeWake(), FakeSTT("Stop. What about the dp1 session?"),
                          lambda k, p: self.events.append((k, p)), is_speaking=lambda: self.speaking,
                          full_duplex=lambda: duplex)
        self.p.set_mode("wake")

    def feed(self, v, n):
        for _ in range(n):
            self.p.process_chunk(chunk(v))

    def test_sustained_speech_barges_in_full_duplex(self):
        self.make(duplex=True)
        self.feed(SPEECH, 10)   # 320 ms: not yet
        self.assertEqual(self.events, [])
        self.feed(SPEECH, 1)    # 352 ms >= 350 ms
        self.assertEqual([k for k, _ in self.events], ["barge"])
        self.assertEqual(self.p.state, "capturing")
        self.speaking = False   # the daemon stopped the speech
        self.feed(SPEECH, 10)
        self.feed(0, 11)
        self.assertEqual([k for k, _ in self.events], ["barge", "final"])
        self.assertEqual(self.events[-1][1]["text"], "Stop. What about the dp1 session?")
        self.assertEqual(self.events[-1][1]["source"], "barge")

    def test_short_bursts_do_not_barge(self):
        self.make(duplex=True)
        for _ in range(5):
            self.feed(SPEECH, 8)  # 256 ms, then a gap
            self.feed(0, 2)
        self.assertEqual(self.events, [])

    def test_half_duplex_is_wake_only(self):
        self.make(duplex=False)
        self.feed(SPEECH, 40)
        self.assertEqual(self.events, [])
        self.feed(WAKE, 1)
        self.assertEqual([k for k, _ in self.events], ["wake"])


# ----------------------------------------------------------------------------- speaker
class SpeakerGapTest(unittest.TestCase):
    def test_synth_runs_ahead_across_replies_and_pause_is_added(self):
        order = []

        class SlowTTS:
            def synthesize(self, text):
                order.append(("synth", text, time.monotonic()))
                time.sleep(0.05)
                return np.full(2400, 0.5, np.float32), 24000

        class Sink(FakeSink):
            def play(self, audio, sr, cancel, started):
                order.append(("play", len(audio), time.monotonic()))
                return super().play(audio, sr, cancel, started)

        events = []
        s = Speaker(SlowTTS().synthesize, Sink(block_s=0.3), lambda k, p: events.append((k, p)), tail_ms=0, pause_ms=100)
        s.start()
        s.submit("a", "First reply.")
        s.submit("b", "Second reply.")
        self.assertTrue(wait_for(lambda: len([e for e in events if e[0] == "spoken"]) == 2, 5))
        synth_b = next(t for k, x, t in order if k == "synth" and x == "Second reply.")
        play_a = next(t for k, x, t in order if k == "play")
        self.assertLess(synth_b, play_a + 0.3)       # job b synthesized while job a played
        plays = [x for k, x, t in order if k == "play"]
        self.assertGreater(plays[1], plays[0])        # 100 ms pause added before the second chunk
        self.assertEqual(plays[1] - plays[0], 2400)
        s.close()

    def test_trim_edges(self):
        sr = 24000
        a = np.concatenate([np.zeros(sr // 2), np.full(sr // 10, 0.5), np.zeros(sr)]).astype(np.float32)
        t = trim_edges(a, sr)
        self.assertLess(len(t), int(sr * 0.2))
        self.assertGreater(len(t), int(sr * 0.1))

    def test_gap_report(self):
        sink = gaps.RealtimeSink()
        sink.plays = [{"start": 0.0, "dur": 1.0, "lead": 0.0, "trail": 0.05},
                      {"start": 1.5, "dur": 1.0, "lead": 0.02, "trail": 0.0}]
        r = gaps.report(sink)
        self.assertEqual(r["gaps"][0], {"wait_s": 0.5, "silence_s": 0.57})

    def test_chime(self):
        c = chime(24000, 150)
        self.assertEqual(len(c), 3600)
        self.assertLess(float(np.abs(c).max()), 0.2)

    def test_play_clip_skipped_while_busy(self):
        sink = FakeSink(block_s=0.3)
        s = Speaker(FakeTTS().synthesize, sink, lambda k, p: None, tail_ms=0)
        s.start()
        self.assertTrue(s.play_clip(chime(), 24000, wait=True))
        s.submit("x", "Something long.")
        self.assertTrue(wait_for(lambda: s.is_speaking))
        self.assertFalse(s.play_clip(chime(), 24000))
        s.close()


# ------------------------------------------------------------------------------ daemon
class DaemonRound2Test(unittest.TestCase):
    def make(self, ack="chime", duplex=False, block_s=0.0):
        self.link = FakeLink()
        self.sink = FakeSink(block_s)
        self.tts = FakeTTS()
        models = Models(FakeVAD(), FakeWake(), FakeSTT(), self.tts, "cuda")
        cfg = config(wake_ack=ack, fillers=["On it.", "One sec.", "Let me check.", "Checking now."])
        d = Daemon(cfg, self.link, models, mic=FakeMic(), sink=self.sink, echo=_NoEcho(duplex))
        d.speaker.start()
        d.clips.rebuild(wait=True)
        d.listen = "wake"
        d.pipeline.set_mode("wake")
        return d

    def test_wake_plays_chime_and_reports_score(self):
        d = self.make("chime")
        d.feed(chunk(WAKE))
        self.assertTrue(wait_for(lambda: self.sink.played))
        self.assertEqual(self.sink.played[0], 3600)        # 150 ms at 24 kHz
        wake = self.link.of("wake")[0]
        self.assertAlmostEqual(wake["score"], 0.95)
        self.assertEqual(d.status()["state"], "hearing")
        d.shutdown()

    def test_wake_word_ack_and_off(self):
        d = self.make("word")
        d.feed(chunk(WAKE))
        self.assertTrue(wait_for(lambda: self.sink.played))
        self.assertIn("Yes?", self.tts.texts)
        d.shutdown()
        d = self.make("off")
        d.feed(chunk(WAKE))
        time.sleep(0.2)
        self.assertEqual(self.sink.played, [])
        d.shutdown()

    def test_ack_fillers_rotate_and_skip_when_speaking(self):
        d = self.make()
        said = []
        for i in range(6):
            d.handle_job({"id": f"ack{i}", "kind": "ack"})
            self.assertTrue(d.speaker.wait_idle(2))
            time.sleep(0.05)
            said.append(d.clips._recent[-1])
        for a, b, c in zip(said, said[1:], said[2:]):
            self.assertNotIn(c, (a, b))                    # never the same as the last two
        d.handle_job({"id": "spk", "kind": "speak", "text": "A long reply."})
        d.speaker._playing = True
        d.handle_job({"id": "ack9", "kind": "ack"})
        self.assertEqual(self.link.of("spoken")[-1], {"type": "spoken", "id": "ack9", "ok": False})
        d.shutdown()

    def test_ack_filler_fits_the_kind_of_request(self):
        d = self.make()
        for i, kind in enumerate(["lookup", "work", "lookup", "work", "chat", "bogus"]):
            d.handle_job({"id": f"ack{i}", "kind": "ack", "filler": kind})
            self.assertTrue(d.speaker.wait_idle(2))
            time.sleep(0.05)
            said = d.clips._recent[-1]
            if kind in d.clips.KINDS and any(f in d.clips._cache for f in d.clips.KINDS[kind]):
                self.assertIn(said, d.clips.KINDS[kind])
            else:
                self.assertIn(said, d.clips.fillers)
        d.shutdown()

    def test_barge_event(self):
        d = self.make(duplex=True, block_s=1.0)
        d.handle_job({"id": "spk_1", "kind": "speak", "text": "One. Two. Three."})
        self.assertTrue(wait_for(lambda: d.speaker.is_speaking))
        for _ in range(12):
            d.feed(chunk(SPEECH))
        self.assertEqual(len(self.link.of("barge")), 1)
        self.assertTrue(wait_for(lambda: self.link.of("spoken")))
        self.assertEqual(self.link.of("spoken")[0], {"type": "spoken", "id": "spk_1", "ok": False})
        self.assertEqual(d.status()["state"], "hearing")
        d.shutdown()

    def test_settings_from_control_job(self):
        d = self.make()
        fake_wake = CombinedWake([ScoreWake()], "hey jarvis")
        with mock.patch("cosvoice.wake.choose", return_value=(fake_wake, None)) as choose:
            d.handle_job({"id": "c", "kind": "control", "wakeWord": "Hey Jarvis", "wakeAck": "off",
                          "fillers": ["Sure."], "chiefName": "Jarvis"})
            self.assertTrue(wait_for(lambda: d.pipeline._wake is fake_wake))
            self.assertEqual(choose.call_args[0][1], "hey jarvis")
        self.assertEqual(d.status()["wakeWord"], "hey jarvis")
        self.assertEqual(d.wake_ack, "off")
        self.assertTrue(wait_for(lambda: d.clips.get("Sure.") is not None))
        self.assertEqual(d.pipeline.wake_phrase, "hey jarvis")
        self.assertEqual(d.pipeline.chief_name, "Jarvis")
        d.shutdown()

    def test_clips_rebuild_after_engine_change(self):
        tts = FakeTTS()
        c = Clips(tts, ["On it."])
        c.rebuild(wait=True)
        n = len(tts.texts)
        c.engine_changed()        # same engine: nothing to do
        time.sleep(0.1)
        self.assertEqual(len(tts.texts), n)
        tts.name = "chatterbox"
        c.engine_changed()
        self.assertTrue(wait_for(lambda: len(tts.texts) == 2 * n))


# ---------------------------------------------------------------------------- client
class ClientRefusedTest(unittest.TestCase):
    def test_4xx_is_not_retried(self):
        from cosvoice.client import ServerLink

        link = ServerLink(read_info=lambda: {"port": 1, "token": "t"})
        calls = []

        def refuse(*a, **k):
            calls.append(1)
            raise urllib.error.HTTPError("u", 400, "Unknown voice event type.", {}, None)

        link.request = refuse
        t0 = time.monotonic()
        link._send({"type": "nearMiss", "score": 0.3})
        self.assertEqual(len(calls), 1)
        self.assertLess(time.monotonic() - t0, 0.2)


# ---------------------------------------------------------------------------- enroll
class EnrollTest(unittest.TestCase):
    def test_calibrate(self):
        # Jay's real scores against 0.35: 0.353, 0.369, 0.433 (and misses)
        thr = enroll.calibrate([0.30, 0.353, 0.369, 0.433, 0.41, 0.38], [0.05, 0.1])
        self.assertLess(thr, 0.30)
        self.assertGreater(thr, 0.1)
        self.assertEqual(enroll.calibrate([0.9, 0.95, 0.92], []), 0.6)            # capped
        self.assertEqual(enroll.calibrate([], [], 0.35), 0.35)
        # the loudest non-wake clip pushes the threshold up when there is room
        self.assertGreater(enroll.calibrate([0.5, 0.5, 0.5], [0.42]), 0.42)

    def test_update_voice_json_keeps_other_keys(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "voice.json"
            p.write_text('﻿{"device": "cuda", "wakeThreshold": 0.35, "wakeVerifier": "x"}', encoding="utf-8")
            enroll.update_voice_json({"wakeThreshold": 0.24, "wakeVerifier": None}, p)
            data = json.loads(p.read_text(encoding="utf-8"))
            self.assertEqual(data, {"device": "cuda", "wakeThreshold": 0.24})
            self.assertFalse(p.read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_no_model_for_phrase(self):
        cfg = config(wake_word="hey nobody")
        out = []
        with mock.patch.object(enroll, "say", out.append):
            self.assertEqual(enroll.run(cfg, 5), 1)
        self.assertIn("keyword spotter", out[-1])


# ---------------------------------------------------------------------------- text
class NaturalTextTest(unittest.TestCase):
    def test_ticket_keys(self):
        self.assertEqual(naturalize("DP1-676 is merged"), "D P one six seven six is merged")
        self.assertEqual(naturalize("see NEO-123."), "see N E O one two three.")

    def test_pull_requests(self):
        self.assertEqual(naturalize("PR 1737 is open"), "pull request seventeen thirty seven is open")
        self.assertEqual(naturalize("PR #24"), "pull request twenty four")
        self.assertEqual(naturalize("two PRs"), "two pull requests")
        self.assertEqual(say_number(1205), "twelve oh five")
        self.assertEqual(say_number(216), "two sixteen")
        self.assertEqual(say_number(2000), "two thousand")
        self.assertEqual(say_number(1200), "twelve hundred")

    def test_times(self):
        self.assertEqual(naturalize("at 9:30 AM"), "at nine thirty A M")
        self.assertEqual(naturalize("at 9:00"), "at nine o'clock")
        self.assertEqual(naturalize("at 14:05"), "at fourteen oh five")
        self.assertEqual(naturalize("ratio 3:2"), "ratio 3:2")       # not a time

    def test_symbols(self):
        self.assertEqual(naturalize("R&D & ops"), "R and D and ops")
        self.assertEqual(naturalize("90% done"), "90 percent done")
        self.assertEqual(naturalize("build -> test"), "build to test")
        self.assertEqual(naturalize("PRs/issues"), "pull requests or issues")
        self.assertEqual(naturalize("~5 min"), "about 5 min")
        self.assertEqual(naturalize("e.g. this"), "for example this")
        self.assertEqual(naturalize("client_server"), "client server")

    def test_conservative(self):
        for t in ("Two sessions need you.", "Version 1.7.0 shipped.", "It is 2026.", "COVID testing"):
            self.assertEqual(naturalize(t), t)

    def test_speakable_end_to_end(self):
        out = speakable("**DP1-676** -> merged & PR 1737 open (90%) at 9:30.")
        self.assertEqual(out, "D P one six seven six to merged and pull request seventeen thirty seven open "
                              "(90 percent) at nine thirty.")

    def test_strip_wake_custom(self):
        self.assertEqual(strip_wake("Hey Jarvis, what needs me?", "hey jarvis"), "What needs me?")
        self.assertEqual(strip_wake("Jarvis, archive it.", "hey jarvis", "Jarvis"), "Archive it.")


if __name__ == "__main__":
    unittest.main()
