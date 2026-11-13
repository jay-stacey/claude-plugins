import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

from fakes import FakeSink, FakeTTS, wait_for
from cosvoice.playback import Speaker, WavSink
from cosvoice.tts import EngineError, TTSManager


class SpeakerTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.lock = threading.Lock()

    def on_event(self, kind, payload):
        with self.lock:
            self.events.append((kind, payload))

    def spoken(self):
        with self.lock:
            return [p for k, p in self.events if k == "spoken"]

    def test_clauses_in_order_and_spoken_ok(self):
        tts, sink = FakeTTS(), FakeSink()
        s = Speaker(tts.synthesize, sink, self.on_event, tail_ms=0)
        s.start()
        s.submit("spk_1", "First sentence here. Second one, see https://x.example/y for more.")
        self.assertTrue(wait_for(lambda: self.spoken()))
        self.assertEqual(self.spoken(), [{"id": "spk_1", "ok": True}])
        self.assertEqual(tts.texts[0], "First sentence here.")
        self.assertTrue(all("http" not in t for t in tts.texts))
        self.assertEqual(len(sink.played), len(tts.texts))
        self.assertIsNotNone(s.last_metrics["ttfa_s"])
        s.close()

    def test_stop_cancels_current_and_queue(self):
        tts, sink = FakeTTS(), FakeSink(block_s=0.5)
        s = Speaker(tts.synthesize, sink, self.on_event, tail_ms=0)
        s.start()
        s.submit("spk_1", "One. Two. Three.")
        s.submit("spk_2", "Never spoken.")
        self.assertTrue(wait_for(lambda: s.is_speaking))
        t0 = time.monotonic()
        s.stop("barge-in")
        self.assertTrue(wait_for(lambda: len(self.spoken()) == 2))
        self.assertLess(time.monotonic() - t0, 0.3)  # fast cancel
        by_id = {p["id"]: p["ok"] for p in self.spoken()}
        self.assertEqual(by_id, {"spk_1": False, "spk_2": False})
        time.sleep(0.6)
        self.assertEqual(len(sink.played), 0)  # spk_2 may be synthesized ahead, never played
        self.assertFalse(s.is_busy)
        s.close()

    def test_empty_text_is_ok(self):
        s = Speaker(FakeTTS().synthesize, FakeSink(), self.on_event, tail_ms=0)
        s.start()
        s.submit("spk_e", "")
        self.assertTrue(wait_for(lambda: self.spoken()))
        self.assertEqual(self.spoken()[0]["ok"], True)
        s.close()

    def test_wav_sink_writes_files(self):
        with tempfile.TemporaryDirectory() as d:
            sink = WavSink(d)
            s = Speaker(FakeTTS().synthesize, sink, self.on_event, tail_ms=0)
            s.start()
            s.submit("spk_w", "Hello there. This is a test.")
            self.assertTrue(wait_for(lambda: self.spoken()))
            self.assertTrue(wait_for(lambda: (Path(d) / "spk_w.wav").exists()))
            self.assertTrue((Path(d) / "spk_w-01.wav").exists())
            s.close()


class Engine:
    def __init__(self, name, fail_load=False, fail_synth=False):
        self.name = name
        self.fail_load = fail_load
        self.fail_synth = fail_synth
        self.loaded = False

    def load(self):
        if self.fail_load:
            raise EngineError("only 2000 MiB of video memory is free")
        self.loaded = True

    def synthesize(self, text):
        if self.fail_synth:
            raise RuntimeError("CUDA out of memory")
        return np.zeros(10, np.float32), 24000

    def unload(self):
        self.loaded = False


class ManagerTest(unittest.TestCase):
    def test_main_voice_first(self):
        m = TTSManager([Engine("chatterbox"), Engine("kokoro")])
        self.assertEqual(m.load(), "chatterbox")

    def test_low_vram_falls_back_to_kokoro(self):
        changes = []
        m = TTSManager([Engine("chatterbox", fail_load=True), Engine("kokoro")], on_change=changes.append)
        self.assertEqual(m.load(), "kokoro")
        self.assertEqual(changes, ["kokoro"])
        self.assertIn("video memory", m.reasons[0])

    def test_synth_failure_falls_back(self):
        m = TTSManager([Engine("chatterbox", fail_synth=True), Engine("kokoro")])
        m.load()
        audio, sr = m.synthesize("hi")
        self.assertEqual(m.name, "kokoro")
        self.assertEqual(sr, 24000)

    def test_nothing_works(self):
        m = TTSManager([Engine("chatterbox", fail_load=True), Engine("kokoro", fail_load=True)])
        with self.assertRaises(EngineError):
            m.load()


if __name__ == "__main__":
    unittest.main()
