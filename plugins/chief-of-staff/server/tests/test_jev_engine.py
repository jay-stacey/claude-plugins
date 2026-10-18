import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path

import helpers  # noqa: F401  (puts server/ on sys.path)

from cos.jev.decision import Request
from cos.jev.engine import Jev
from cos.jev.log import DecisionLog, text_hash
from cos.jev.settings import effective

LOCAL = {"jevProvider": "local", "jevModel": "tiny-test-model", "jevEndpoint": "http://127.0.0.1:9/v1",
         "jevTimeoutMs": 300}


class FakeProvider:
    name = "local"

    def __init__(self, answer=None, delay=0.0, error=None):
        self.answer = answer if answer is not None else {"model": "opus", "route": "new_session",
                                                         "background": True, "estimate_s": 900}
        self.delay, self.error, self.calls = delay, error, 0

    def decide(self, request, timeout_s):
        self.calls += 1
        if self.delay:
            time.sleep(self.delay)
        if self.error:
            raise self.error
        return self.answer


class Engine(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="cos-jev-"))
        self.built = []

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def jev(self, provider, settings=LOCAL, key=None):
        def factory(cfg, k):
            self.built.append((cfg, k))
            return provider
        return Jev(settings, self.home, key=key, provider_factory=factory)

    def lines(self):
        path = self.home / "jev-log.jsonl"
        return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_success_uses_the_model_answer(self):
        j = self.jev(FakeProvider())
        req = Request("Fix the login bug in the api repo")
        q = j.quick(req)
        self.assertEqual((q.source, q.model), ("rules", "sonnet"))
        d = j.advise(req, q)
        self.assertEqual((d.source, d.model, d.route, d.estimate_s, d.filler), ("local", "opus", "new_session", 900, "work"))
        self.assertGreaterEqual(d.ms, 0)
        self.assertEqual(j.health()["fallbacks"], 0)

    def test_timeout_falls_back_to_quick(self):
        j = self.jev(FakeProvider(delay=1.0))
        req = Request("Fix the login bug")
        q = j.quick(req)
        start = time.monotonic()
        d = j.advise(req, q)
        self.assertLess(time.monotonic() - start, 0.8)
        self.assertEqual(d.public(), q.public())
        self.assertEqual(j.health()["fallbacks"], 1)

    def test_bad_answers_and_errors_fall_back(self):
        for provider in (FakeProvider(answer="not json"), FakeProvider(answer={"model": "gpt", "route": "chief"}),
                         FakeProvider(error=RuntimeError("down")), FakeProvider(error=OSError("refused"))):
            j = self.jev(provider)
            req = Request("Fix the login bug")
            q = j.quick(req)
            with self.subTest(provider=provider.answer):
                self.assertEqual(j.advise(req, q).public(), q.public())
                self.assertEqual(j.health()["fallbacks"], 1)

    def test_user_overrides_are_kept(self):
        provider = FakeProvider({"model": "haiku", "route": "chief", "background": False, "estimate_s": 5})
        j = self.jev(provider)
        req = Request("Fix the login bug with opus")
        d = j.advise(req, j.quick(req))
        self.assertEqual((d.model, d.route, d.override, d.source), ("opus", "chief", True, "local"))
        req = Request("Fix the login bug in a new session")
        d = j.advise(req, j.quick(req))
        self.assertEqual((d.model, d.route, d.background, d.override), ("haiku", "new_session", True, True))
        calls = provider.calls
        req = Request("Fix the login bug with opus in a new session")       # both set: no model call
        q = j.quick(req)
        self.assertIs(j.advise(req, q), q)
        self.assertEqual(provider.calls, calls)

    def test_rules_provider_never_builds_a_model(self):
        j = self.jev(FakeProvider(), settings={"jevProvider": "rules"})
        self.assertEqual(self.built, [])
        req = Request("Fix it")
        q = j.quick(req)
        self.assertIs(j.advise(req, q), q)
        self.assertEqual(j.provider_name(), "rules")

    def test_update_rebuilds_only_on_change(self):
        j = self.jev(FakeProvider())
        self.assertEqual(len(self.built), 1)
        j.update(dict(LOCAL))
        self.assertEqual(len(self.built), 1)
        j.update(dict(LOCAL, jevModel="other-model"))
        self.assertEqual(len(self.built), 2)
        j.update(dict(LOCAL, jevModel="other-model"), "new-key")
        self.assertEqual(len(self.built), 2 + 1)
        self.assertEqual(self.built[-1][1], "new-key")

    def test_a_factory_error_means_rules(self):
        def broken(cfg, key):
            raise ValueError("bad endpoint")
        j = Jev(LOCAL, self.home, provider_factory=broken)
        self.assertEqual(j.provider_name(), "rules")

    def test_log_lines_hold_a_hash_and_a_short_head(self):
        j = self.jev(FakeProvider())
        text = "Fix the login bug\nin the api repo " + "x" * 200 + " SECRET-TAIL"
        req = Request(text, "voice")
        q = j.quick(req)
        d = j.advise(req, q)
        j.record("msg_1", req, d, q)
        j.outcome("msg_1", "new_session", "opus")
        rows = self.lines()
        self.assertEqual(len(rows), 2)
        first = rows[0]
        self.assertEqual(first["textHash"], text_hash(text))
        self.assertEqual(len(first["textHead"]), 80)
        self.assertNotIn("\n", first["textHead"])
        self.assertEqual((first["source"], first["quick"]["source"], first["final"]["source"], first["outcome"]),
                         ("voice", "rules", "local", None))
        self.assertEqual(rows[1]["outcome"], {"route": "new_session", "model": "opus"})
        raw = (self.home / "jev-log.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("SECRET-TAIL", raw)
        self.assertNotIn("x" * 100, raw)

    def test_log_rotates_to_one_backup(self):
        log = DecisionLog(self.home / "jev-log.jsonl", max_bytes=200)
        for i in range(20):
            log.outcome(f"msg_{i}", "chief", None)
        self.assertTrue((self.home / "jev-log.1.jsonl").exists())
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ["jev-log.1.jsonl", "jev-log.jsonl"])
        self.assertLessEqual((self.home / "jev-log.jsonl").stat().st_size, 300)

    def test_log_is_thread_safe_and_never_raises(self):
        log = DecisionLog(self.home / "jev-log.jsonl")
        threads = [threading.Thread(target=lambda n=n: [log.outcome(f"m{n}_{i}", "chief", None) for i in range(50)])
                   for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(self.lines()), 200)
        bad = DecisionLog(self.home / "jev-log.jsonl" / "nested.jsonl")     # a file stands where a folder must be
        self.assertFalse(bad.outcome("m", "chief", None))


class Settings(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="cos-jev-"))

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def write(self, data):
        (self.home / "jev.json").write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def test_auto_without_jev_json_is_rules(self):
        self.assertEqual(effective({"jevProvider": "auto"}, self.home)["provider"], "rules")
        self.write("{not json")
        self.assertEqual(effective({"jevProvider": "auto"}, self.home)["provider"], "rules")
        self.write({"provider": "cloud-thing"})
        self.assertEqual(effective({}, self.home)["provider"], "rules")

    def test_auto_reads_jev_json_and_user_config_wins(self):
        self.write({"provider": "local", "adapter": "openai_compat", "model": "tiny-a", "endpoint": "http://127.0.0.1:11435/v1",
                    "runtime": {"apiKeyRef": "wincred:chief-of-staff/jev-local"},
                    "hosted": {"adapter": "anthropic", "model": "hosted-b", "keyRef": "env:JEV_KEY"}})
        eff = effective({"jevProvider": "auto", "jevTimeoutMs": 800}, self.home)
        self.assertEqual(eff, {"provider": "local", "adapter": "openai_compat", "model": "tiny-a",
                               "endpoint": "http://127.0.0.1:11435/v1", "timeoutMs": 800,
                               "keyRef": "wincred:chief-of-staff/jev-local"})
        eff = effective({"jevProvider": "hosted"}, self.home)
        self.assertEqual((eff["adapter"], eff["model"], eff["keyRef"]), ("anthropic", "hosted-b", "env:JEV_KEY"))
        eff = effective({"jevProvider": "local", "jevModel": "mine", "jevKeyRef": "sk-raw-key", "jevTimeoutMs": 9999},
                        self.home)
        self.assertEqual((eff["model"], eff["keyRef"], eff["timeoutMs"]), ("mine", "wincred:chief-of-staff/jev-local", 800))


if __name__ == "__main__":
    unittest.main()
