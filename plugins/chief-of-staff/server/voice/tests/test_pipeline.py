import unittest

from fakes import SPEECH, WAKE, FakeSTT, FakeVAD, FakeWake, chunk, config
from cosvoice.config import CHUNK
from cosvoice.pipeline import Pipeline


class Harness:
    def __init__(self, speaking=False, duplex=False, text="Hey Chief, what needs me?", **cfg):
        self.events = []
        self.speaking = speaking
        self.vad, self.wake, self.stt = FakeVAD(), FakeWake(), FakeSTT(text)
        self.p = Pipeline(config(**cfg), self.vad, self.wake, self.stt, lambda k, p: self.events.append((k, p)),
                          is_speaking=lambda: self.speaking, full_duplex=lambda: duplex)

    def feed(self, value, n=1):
        for _ in range(n):
            self.p.process_chunk(chunk(value))

    def kinds(self):
        return [k for k, _ in self.events]


class WakeModeTest(unittest.TestCase):
    def test_wake_then_speech_then_silence_gives_final(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(0, 5)
        h.feed(WAKE)
        self.assertEqual(h.kinds(), ["wake"])
        self.assertEqual(h.p.state, "capturing")
        h.feed(0, 4)        # pause after the wake word (inside the 400 ms tail)
        h.feed(SPEECH, 20)  # "what needs me"
        h.feed(0, 11)       # 352 ms of silence > 320 ms trailing silence
        self.assertEqual(h.kinds(), ["wake", "final"])
        final = h.events[-1][1]
        self.assertEqual(final["text"], "What needs me?")
        self.assertEqual(final["raw"], "Hey Chief, what needs me?")
        self.assertEqual(h.p.state, "idle")
        # the captured audio holds pre-roll (the wake word) plus the speech
        self.assertGreater(h.stt.calls[0], 20 * CHUNK)
        self.assertGreaterEqual(h.wake.resets, 1)

    def test_no_speech_after_wake_is_dropped(self):
        h = Harness(text="Hey Chief.")
        h.p.set_mode("wake")
        h.feed(0, 5)
        h.feed(WAKE)
        h.feed(0, 11)       # wake word then silence: transcribed, only the wake word
        self.assertEqual(h.kinds(), ["wake", "empty"])
        self.assertEqual(h.p.state, "capturing")  # waiting for the question
        h.feed(0, 32)       # 1.02 s > 1 s follow-up timeout
        self.assertEqual(h.kinds(), ["wake", "empty"])
        self.assertEqual(len(h.stt.calls), 1)
        self.assertEqual(h.p.state, "idle")

    def test_wake_fires_late_while_still_talking(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(SPEECH, 10)  # "hey chief what" (wake fires late, mid-sentence)
        h.feed(WAKE)
        h.feed(SPEECH, 3)
        h.feed(0, 11)
        self.assertEqual(h.kinds(), ["wake", "final"])

    def test_wake_on_silence_waits_for_speech(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(0, 5)
        h.p._wake = lambda c, t=None: (True, 0.9)  # wake fires on a silent chunk
        h.feed(0)
        h.p._wake = h.wake
        self.assertEqual(h.p.state, "capturing")
        self.assertFalse(h.p._vad_started)
        h.feed(0, 32)
        self.assertEqual(h.p.state, "idle")
        self.assertEqual(h.stt.calls, [])

    def test_max_utterance(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(WAKE)
        h.feed(SPEECH, 120)  # 3.84 s > 3 s limit
        self.assertIn("final", h.kinds())
        self.assertEqual(h.events[-1][1]["reason"], "limit")

    def test_pause_after_wake_word_then_question(self):
        h = Harness()
        texts = iter(["Hey Chief.", "What needs me?"])
        h.p._transcribe = lambda audio: next(texts)
        h.p.set_mode("wake")
        h.feed(WAKE)
        h.feed(0, 11)       # pause: "Hey Chief." alone
        h.feed(0, 10)
        h.feed(SPEECH, 10)  # the question, no second wake word
        h.feed(0, 11)
        self.assertEqual(h.kinds(), ["wake", "empty", "final"])
        self.assertEqual(h.events[-1][1]["text"], "What needs me?")

    def test_speech_without_wake_word_does_nothing(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(SPEECH, 50)
        h.feed(0, 20)
        self.assertEqual(h.events, [])

    def test_off_mode_ignores_everything(self):
        h = Harness()
        h.p.set_mode("off")
        h.feed(WAKE, 3)
        h.feed(SPEECH, 10)
        self.assertEqual(h.events, [])

    def test_mode_off_aborts_capture(self):
        h = Harness()
        h.p.set_mode("wake")
        h.feed(WAKE)
        h.feed(SPEECH, 5)
        h.p.set_mode("off")
        self.assertEqual(h.p.state, "idle")
        h.feed(0, 20)
        self.assertEqual(h.kinds(), ["wake"])


class SpeakingTest(unittest.TestCase):
    def test_half_duplex_raises_wake_threshold_and_flags_barge(self):
        h = Harness(speaking=True, duplex=False)
        h.p.set_mode("wake")
        h.feed(SPEECH, 5)    # our own voice on the mic: not speech to us
        self.assertEqual(h.events, [])
        h.feed(WAKE)
        self.assertEqual(h.kinds(), ["wake"])
        self.assertTrue(h.events[0][1]["barge"])
        self.assertEqual(h.wake.limits[-1], 0.7)

    def test_full_duplex_keeps_normal_threshold(self):
        h = Harness(speaking=True, duplex=True)
        h.p.set_mode("wake")
        h.feed(WAKE)
        self.assertEqual(h.wake.limits[-1], None)
        self.assertTrue(h.events[0][1]["barge"])


class PushToTalkTest(unittest.TestCase):
    def test_hold_and_release(self):
        h = Harness(text="close the dp1 session")
        h.p.set_mode("ptt")
        h.feed(WAKE)          # the wake word does nothing in ptt mode
        self.assertEqual(h.events, [])
        h.p.set_ptt(True)
        self.assertEqual(h.p.state, "capturing")
        h.feed(SPEECH, 20)
        h.p.set_ptt(False)
        self.assertEqual(h.kinds(), ["final"])
        self.assertEqual(h.events[0][1]["text"], "close the dp1 session")  # no wake strip in ptt

    def test_tap_too_short(self):
        h = Harness()
        h.p.set_mode("ptt")
        h.p.reset()
        h.p.set_ptt(True)
        h.feed(SPEECH, 2)
        h.p.set_ptt(False)
        self.assertEqual(h.events, [])
        self.assertEqual(h.p.state, "idle")

    def test_ptt_ignored_in_wake_mode(self):
        h = Harness()
        h.p.set_mode("wake")
        h.p.set_ptt(True)
        self.assertEqual(h.p.state, "idle")
        self.assertFalse(h.p.ptt_down)


class TranscribeErrorTest(unittest.TestCase):
    def test_error_event(self):
        h = Harness()

        def boom(audio):
            raise RuntimeError("cuda died")

        h.p._transcribe = boom
        h.p.set_mode("wake")
        h.feed(WAKE)
        h.feed(SPEECH, 5)
        h.feed(0, 11)
        self.assertEqual(h.kinds(), ["wake", "error"])
        self.assertEqual(h.p.state, "idle")


if __name__ == "__main__":
    unittest.main()
