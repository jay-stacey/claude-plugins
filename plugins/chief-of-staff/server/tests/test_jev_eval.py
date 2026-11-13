"""Jev's 50-request labeled eval set and the jev_eval runner."""
import importlib.util
import io
import unittest
from collections import Counter
from contextlib import redirect_stdout

import helpers  # noqa: F401 - puts server/ on sys.path

import jev_eval
from cos.jev.decision import Decision

HAS_RULES = importlib.util.find_spec("cos.jev.rules") is not None


class EvalSet(unittest.TestCase):
    def test_loads_with_valid_labels(self):
        items = jev_eval.load_set()
        self.assertEqual(len(items), 50)
        self.assertEqual(len({i["text"] for i in items}), 50)
        for item in items:
            want = item["want"]
            self.assertEqual(want["background"], want["route"] == "new_session", item["text"])
            self.assertTrue(item["sessions"])
        mix = Counter((i["want"]["route"], i["want"]["model"]) for i in items)
        self.assertEqual(mix[("chief", "haiku")], 30)
        self.assertEqual(sum(v for (route, _), v in mix.items() if route == "new_session"), 20)
        for model in ("haiku", "sonnet", "opus"):
            self.assertGreaterEqual(mix[("new_session", model)], 5, model)

    def test_runner_scores_and_counts_failures(self):
        items = jev_eval.load_set()[:4]

        def decide(request):
            if "Archive" in request.text:
                raise RuntimeError("stub failure")
            return Decision("haiku", "chief", False, 10)
        result = jev_eval.run(decide, items)
        self.assertEqual(result["total"], 4)
        self.assertEqual(result["agreement"]["route"], 1.0)
        self.assertTrue(result["passed"])
        result = jev_eval.run(lambda r: Decision("opus", "new_session", True, 10), items)
        self.assertEqual(result["agreement"]["route"], 0.0)
        self.assertFalse(result["passed"])
        self.assertEqual(len(result["misses"]), 4)

    def test_targets_match_issue_33(self):
        self.assertEqual(jev_eval.TARGETS, {"route": 0.85, "background": 0.85, "model": 0.75})

    @unittest.skipUnless(HAS_RULES, "cos.jev.rules is not built yet")
    def test_rules_meet_targets(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = jev_eval.main(["--provider", "rules", "--verbose"])
        self.assertEqual(code, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
