"""The fixes that made local Jev work on a small model: short answer keys, the Chief on haiku,
no thinking and no unload for the local provider, and a 4096-token context for Ollama."""

import subprocess
import unittest
from pathlib import Path

from helpers import Sandbox

import jev_setup
from cos.jev.decision import DECISION_SCHEMA, Request, parse
from cos.jev.providers import OpenAICompatProvider

REQ = Request("Fix the null reference in the order summary page.")


class ParseKeys(unittest.TestCase):
    def test_short_keys(self):
        d = parse('{"r":"new_session","m":"opus","e":3600}')
        self.assertEqual((d.route, d.model, d.estimate_s), ("new_session", "opus", 3600))
        self.assertTrue(d.background)  # background follows the route
        self.assertEqual(sorted(DECISION_SCHEMA["required"]), ["e", "m", "r"])

    def test_long_keys(self):
        d = parse({"model": "sonnet", "route": "new_session", "background": False, "estimate_s": 600})
        self.assertEqual((d.route, d.model, d.background, d.estimate_s), ("new_session", "sonnet", False, 600))

    def test_chief_forces_haiku(self):
        for model in ("haiku", "sonnet", "opus"):
            d = parse({"r": "chief", "m": model, "e": 10})
            self.assertEqual((d.route, d.model, d.background), ("chief", "haiku", False))

    def test_bad_values_still_fail(self):
        for raw in ({"r": "elsewhere", "m": "haiku", "e": 10}, {"r": "chief", "m": "gpt", "e": 10},
                    {"r": "chief", "m": "haiku", "e": -1}):
            with self.assertRaises(ValueError):
                parse(raw)


class LocalBody(unittest.TestCase):
    def test_local_turns_off_thinking_and_unload(self):
        body = OpenAICompatProvider("http://127.0.0.1:1/v1", "m", name="local").body(REQ)
        self.assertEqual(body["reasoning_effort"], "none")
        self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(body["keep_alive"], -1)

    def test_hosted_body_has_no_local_fields(self):
        body = OpenAICompatProvider("https://example.com/v1", "m", name="hosted").body(REQ)
        for key in ("reasoning_effort", "chat_template_kwargs", "keep_alive"):
            self.assertNotIn(key, body)


class OllamaModelfile(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().__enter__()
        self.addCleanup(self.box.__exit__, None, None, None)

    def test_modelfile_sets_num_ctx_and_reads_utf8(self):
        seen = {}

        def runner(cmd, **kw):
            seen.update(kw, cmd=cmd)
            return subprocess.CompletedProcess(cmd, 0, "success\n", "")

        gguf = Path(self.box.dir) / "model.gguf"
        name = jev_setup.ollama_import("ollama.exe", "qwen3.5-0.8b", gguf, runner=runner)
        self.assertEqual(name, "jev-qwen3.5-0.8b")
        text = jev_setup.modelfile_path("qwen3.5-0.8b").read_text(encoding="utf-8")
        self.assertIn("PARAMETER num_ctx 4096\n", text)
        self.assertIn("PARAMETER temperature 0\n", text)
        self.assertEqual((seen["encoding"], seen["errors"]), ("utf-8", "replace"))

    def test_llama_server_context_matches(self):
        cfg = jev_setup.runtime_config({"kind": "llama_server", "exe": "llama-server.exe"},
                                       "qwen3.5-0.8b", "model.gguf", "local-cpu")
        args = cfg["runtime"]["args"]
        self.assertEqual(args[args.index("-c") + 1], "4096")


if __name__ == "__main__":
    unittest.main()
