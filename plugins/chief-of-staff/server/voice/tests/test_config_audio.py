import json
import os
import tempfile
import unittest
from pathlib import Path

import numpy as np

import fakes  # noqa: F401
from cosvoice import config
from cosvoice.audio import Rechunker, level
from cosvoice.duplex import EchoCanceller, RenderReference


class ConfigTest(unittest.TestCase):
    def test_voice_json_and_home(self):
        with tempfile.TemporaryDirectory() as d:
            old = os.environ.get("COS_HOME")
            os.environ["COS_HOME"] = d
            try:
                (Path(d) / "voice.json").write_text(json.dumps({
                    "device": "cpu", "tts": "kokoro", "fallbackTts": "chatterbox", "sttModel": "small.en",
                    "wakeThreshold": "0.4", "unknownKey": 1}), encoding="utf-8")
                cfg = config.load()
                self.assertEqual((cfg.device, cfg.tts, cfg.fallback_tts, cfg.stt_model), ("cpu", "kokoro", "chatterbox", "small.en"))
                self.assertEqual(cfg.wake_threshold, 0.4)
                self.assertEqual(cfg.extra, {"unknownKey": 1})
                # no HOME copy yet: the model shipped with the plugin; then the HOME copy wins
                self.assertEqual(cfg.wake_model_path, config.PLUGIN_MODELS / "hey_chief.onnx")
                (Path(d) / "models").mkdir()
                (Path(d) / "models" / "hey_chief.onnx").write_bytes(b"x")
                self.assertEqual(cfg.wake_model_path, Path(d) / "models" / "hey_chief.onnx")
                cfg.wake_word = "hey jarvis"
                self.assertEqual(cfg.wake_model_path, Path(d) / "models" / "hey_jarvis.onnx")
                (Path(d) / "run").mkdir()
                (Path(d) / "run" / "server.json").write_text('{"port": 47870, "token": "t"}', encoding="utf-8")
                self.assertEqual(config.read_server_info()["port"], 47870)
            finally:
                if old is None:
                    os.environ.pop("COS_HOME", None)
                else:
                    os.environ["COS_HOME"] = old

    def test_cpu_device_defaults_to_kokoro(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = config.load(Path(d) / "missing.json", device="cpu")
            self.assertEqual((cfg.tts, cfg.fallback_tts), ("kokoro", "chatterbox"))

    def test_bad_json_means_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "voice.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(config.load(p).tts, "chatterbox")


class AudioTest(unittest.TestCase):
    def test_rechunker(self):
        r = Rechunker(512)
        out = []
        for _ in range(10):
            out += r.push(np.ones(160, np.float32))
        self.assertEqual(len(out), 3)  # 1600 samples -> 3 chunks, 64 left
        self.assertTrue(all(c.size == 512 for c in out))

    def test_level(self):
        self.assertEqual(level(np.zeros(512, np.float32)), 0.0)
        self.assertGreater(level(np.full(512, 0.1, np.float32)), 0.5)
        self.assertLessEqual(level(np.ones(512, np.float32)), 1.0)

    def test_render_reference_resamples_and_drains(self):
        ref = RenderReference()
        ref.push(np.ones(2400, np.float32), 24000)  # 0.1 s -> 1600 samples at 16 kHz
        a = ref.pull(1000)
        b = ref.pull(1000)
        self.assertEqual(a.size, 1000)
        self.assertAlmostEqual(float(a.mean()), 1.0, places=2)
        self.assertEqual(int((b > 0.5).sum()), 600)

    def test_echo_falls_back_to_half_duplex(self):
        def broken(**kw):
            raise ImportError("no pywebrtc_audio")

        e = EchoCanceller(True, factory=broken)
        self.assertFalse(e.available)
        near = np.ones(160, np.float32)
        self.assertIs(e.process(near, near).dtype, np.dtype(np.float32))


if __name__ == "__main__":
    unittest.main()
