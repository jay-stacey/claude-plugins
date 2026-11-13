"""Jev model providers against a stub HTTP server on 127.0.0.1, plus key references.
No real network."""
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import helpers  # noqa: F401 - puts server/ on sys.path

from cos.jev import keys
from cos.jev.decision import DECISION_SCHEMA, Request, parse
from cos.jev.providers import (AnthropicProvider, OpenAICompatProvider, ProviderError, check_endpoint,
                               make_provider)

GOOD = {"model": "sonnet", "route": "new_session", "background": True, "estimate_s": 600}
FAKE_KEY = "sk-test-not-a-real-key-0000000000"
REQ = Request("Fix the null reference in the order summary page.",
              sessions=[{"title": "Fix flaky checkout test", "repo": "shop-web", "state": "working", "model": "sonnet"}])


class Stub:
    """A tiny HTTP server. self.reply(handler) decides each answer; requests are recorded."""

    def __init__(self):
        self.calls = []
        self.mode = "openai"
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                stub.calls.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                                   "body": body})
                status, payload, delay = stub.answer()
                if delay:
                    time.sleep(delay)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.answer = lambda: (200, openai_reply(GOOD), 0)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def openai_reply(obj):
    return {"choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps(obj)}}]}


def anthropic_reply(obj, thinking=True):
    content = [{"type": "thinking", "thinking": "", "signature": "x"}] if thinking else []
    content.append({"type": "text", "text": json.dumps(obj)})
    return {"type": "message", "role": "assistant", "content": content, "stop_reason": "end_turn"}


class OpenAICompat(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)

    def test_success_and_request_shape(self):
        p = OpenAICompatProvider(self.stub.url + "/v1", "qwen3.5-0.8b")
        raw = p.decide(REQ, 2)
        self.assertEqual(raw, GOOD)
        self.assertEqual(parse(raw, source=p.name).route, "new_session")
        call = self.stub.calls[0]
        self.assertEqual(call["path"], "/v1/chat/completions")
        body = call["body"]
        self.assertEqual(body["model"], "qwen3.5-0.8b")
        self.assertEqual(body["temperature"], 0)
        self.assertEqual(body["max_tokens"], 60)
        self.assertEqual(body["response_format"], {"type": "json_schema", "json_schema": {
            "name": "jev", "schema": DECISION_SCHEMA, "strict": True}})
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertEqual(call["headers"]["user-agent"], "chief-of-staff-jev")

    def test_bearer_only_with_a_key(self):
        OpenAICompatProvider(self.stub.url, "m").decide(REQ, 2)
        self.assertNotIn("authorization", self.stub.calls[0]["headers"])
        OpenAICompatProvider(self.stub.url, "m", api_key=FAKE_KEY).decide(REQ, 2)
        self.assertEqual(self.stub.calls[1]["headers"]["authorization"], f"Bearer {FAKE_KEY}")

    def test_timeout(self):
        self.stub.answer = lambda: (200, openai_reply(GOOD), 0.6)
        p = OpenAICompatProvider(self.stub.url, "m")
        start = time.perf_counter()
        with self.assertRaises(ProviderError) as ctx:
            p.decide(REQ, 0.15)
        self.assertLess(time.perf_counter() - start, 0.55)
        self.assertIn("timed out", str(ctx.exception))

    def test_http_500_has_no_secret(self):
        self.stub.answer = lambda: (500, {"error": "boom"}, 0)
        with self.assertRaises(ProviderError) as ctx:
            OpenAICompatProvider(self.stub.url, "m", api_key=FAKE_KEY).decide(REQ, 2)
        msg = str(ctx.exception)
        self.assertIn("500", msg)
        self.assertNotIn(FAKE_KEY, msg)
        self.assertNotIn("order summary", msg)

    def test_bad_json(self):
        self.stub.answer = lambda: (200, b"not json at all", 0)
        with self.assertRaises(ProviderError):
            OpenAICompatProvider(self.stub.url, "m").decide(REQ, 2)
        self.stub.answer = lambda: (200, {"choices": [{"message": {"content": "{not json"}}]}, 0)
        with self.assertRaises(ProviderError):
            OpenAICompatProvider(self.stub.url, "m").decide(REQ, 2)
        self.stub.answer = lambda: (200, {"choices": []}, 0)
        with self.assertRaises(ProviderError):
            OpenAICompatProvider(self.stub.url, "m").decide(REQ, 2)

    def test_connection_refused(self):
        url = self.stub.url
        self.stub.close()
        with self.assertRaises(ProviderError):
            OpenAICompatProvider(url, "m").decide(REQ, 1)


class Anthropic(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)
        self.stub.answer = lambda: (200, anthropic_reply(GOOD), 0)

    def test_shape(self):
        p = AnthropicProvider("claude-haiku-5-5", FAKE_KEY, base_url=self.stub.url)
        self.assertEqual(p.decide(REQ, 2), GOOD)
        call = self.stub.calls[0]
        self.assertEqual(call["path"], "/v1/messages")
        h = call["headers"]
        self.assertEqual(h["anthropic-version"], "2023-06-01")
        self.assertEqual(h["x-api-key"], FAKE_KEY)
        self.assertNotIn("authorization", h)
        body = call["body"]
        self.assertEqual(body["model"], "claude-haiku-5-5")
        self.assertEqual(body["output_config"]["effort"], "low")
        fmt = body["output_config"]["format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertEqual(fmt["schema"]["required"], DECISION_SCHEMA["required"])
        self.assertFalse(fmt["schema"]["additionalProperties"])
        self.assertNotIn("minimum", json.dumps(fmt["schema"]))  # the Claude API rejects numeric limits
        self.assertNotIn("temperature", body)  # Haiku 5.5 rejects non-default sampling
        self.assertIsInstance(body["system"], str)
        self.assertEqual([m["role"] for m in body["messages"]], ["user"])

    def test_text_block_after_thinking(self):
        p = AnthropicProvider("claude-haiku-5-5", FAKE_KEY, base_url=self.stub.url)
        self.assertEqual(p.decide(REQ, 2), GOOD)
        self.stub.answer = lambda: (200, anthropic_reply(GOOD, thinking=False), 0)
        self.assertEqual(p.decide(REQ, 2), GOOD)

    def test_no_text_refusal_and_no_key(self):
        p = AnthropicProvider("claude-haiku-5-5", FAKE_KEY, base_url=self.stub.url)
        self.stub.answer = lambda: (200, {"content": [{"type": "thinking", "thinking": ""}], "stop_reason": "max_tokens"}, 0)
        with self.assertRaises(ProviderError):
            p.decide(REQ, 2)
        self.stub.answer = lambda: (200, {"content": [], "stop_reason": "refusal"}, 0)
        with self.assertRaises(ProviderError):
            p.decide(REQ, 2)
        with self.assertRaises(ProviderError):
            AnthropicProvider("claude-haiku-5-5", None, base_url=self.stub.url).decide(REQ, 2)

    def test_401_has_no_secret(self):
        self.stub.answer = lambda: (401, {"error": {"type": "authentication_error"}}, 0)
        with self.assertRaises(ProviderError) as ctx:
            AnthropicProvider("claude-haiku-5-5", FAKE_KEY, base_url=self.stub.url).decide(REQ, 2)
        self.assertNotIn(FAKE_KEY, str(ctx.exception))
        self.assertNotIn(FAKE_KEY, repr(AnthropicProvider("m", FAKE_KEY)))


class MakeProvider(unittest.TestCase):
    def test_rules_is_none(self):
        self.assertIsNone(make_provider({"provider": "rules"}, None))
        self.assertIsNone(make_provider({}, None))

    def test_kinds(self):
        p = make_provider({"provider": "local", "adapter": "openai_compat", "model": "qwen3.5-0.8b",
                           "endpoint": "http://127.0.0.1:11435/v1/"}, None)
        self.assertIsInstance(p, OpenAICompatProvider)
        self.assertEqual((p.name, p.base_url), ("local", "http://127.0.0.1:11435/v1"))
        h = make_provider({"provider": "hosted", "adapter": "anthropic", "model": "claude-haiku-5-5", "endpoint": ""}, FAKE_KEY)
        self.assertIsInstance(h, AnthropicProvider)
        self.assertEqual(h.name, "hosted")
        g = make_provider({"provider": "hosted", "adapter": "openai_compat", "model": "llama",
                           "endpoint": "https://api.groq.com/openai/v1"}, FAKE_KEY)
        self.assertEqual((type(g), g.name), (OpenAICompatProvider, "hosted"))
        for ok in ("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1", "https://llm.example.internal/v1",
                   "http://localhost:8080/v1", "http://[::1]:8080/v1"):
            make_provider({"provider": "hosted", "adapter": "openai_compat", "model": "m", "endpoint": ok}, None)

    def test_refusals(self):
        bad = [
            {"provider": "local", "adapter": "openai_compat", "model": "m", "endpoint": "http://192.168.1.20:11434/v1"},
            {"provider": "local", "adapter": "openai_compat", "model": "m", "endpoint": "https://box.example.com/v1"},
            {"provider": "local", "adapter": "openai_compat", "model": "m", "endpoint": "ftp://127.0.0.1/v1"},
            {"provider": "local", "adapter": "anthropic", "model": "m", "endpoint": "http://127.0.0.1:1/v1"},
            {"provider": "hosted", "adapter": "openai_compat", "model": "m", "endpoint": "http://llm.example.com/v1"},
            {"provider": "hosted", "adapter": "openai_compat", "model": "m", "endpoint": ""},
            {"provider": "hosted", "adapter": "openai_compat", "model": "m", "endpoint": "https://user:pw@llm.example.com/v1"},
            {"provider": "hosted", "adapter": "other", "model": "m", "endpoint": "https://llm.example.com"},
            {"provider": "hosted", "adapter": "anthropic", "model": "", "endpoint": ""},
            {"provider": "cloud", "model": "m"},
        ]
        for cfg in bad:
            with self.assertRaises(ValueError, msg=str(cfg)):
                make_provider(cfg, None)

    def test_blocked_hosts_name_the_reason(self):
        for host, word in (("generativelanguage.googleapis.com", "Gemini"), ("api.mistral.ai", "train"),
                           ("openrouter.ai", "OpenRouter"), ("api.cerebras.ai", "Cerebras")):
            with self.assertRaises(ValueError) as ctx:
                make_provider({"provider": "hosted", "adapter": "openai_compat", "model": "m",
                               "endpoint": f"https://{host}/v1"}, None)
            self.assertIn("blocked", str(ctx.exception))
            self.assertIn(word, str(ctx.exception))
        with self.assertRaises(ValueError):
            check_endpoint("https://eu.openrouter.ai/api/v1", hosted=True)


class Keys(unittest.TestCase):
    def test_looks_like_key(self):
        for k in ("sk-abcdefghijklmnop", "sk-ant-api03-abcdefghijkl", "gsk_abcdefghijklmnop",
                  "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"):
            self.assertTrue(keys.looks_like_key(k), k)
        for k in ("", "env:JEV_KEY", "wincred:chief-of-staff/jev", "qwen3.5-0.8b", "hello world this is long text ok",
                  "http://127.0.0.1:11435/v1", None, 42):
            self.assertFalse(keys.looks_like_key(k), k)

    def test_resolve(self):
        self.assertEqual(keys.resolve("env:NOPE", "raw-wins"), "raw-wins")
        self.assertIsNone(keys.resolve(None))
        self.assertIsNone(keys.resolve(""))
        os.environ["COS_TEST_JEV_KEY"] = "from-env"
        self.addCleanup(os.environ.pop, "COS_TEST_JEV_KEY", None)
        self.assertEqual(keys.resolve("env:COS_TEST_JEV_KEY"), "from-env")
        self.assertIsNone(keys.resolve("env:COS_TEST_JEV_MISSING_9"))
        for bad in ("keyring:x", "sk-raw", "env:", "wincred:"):
            with self.assertRaises(ValueError):
                keys.resolve(bad)

    @unittest.skipIf(sys.platform == "win32", "only off Windows")
    def test_wincred_off_windows(self):
        with self.assertRaises(ValueError) as ctx:
            keys.resolve("wincred:chief-of-staff/jev-test")
        self.assertIn("only on Windows", str(ctx.exception))

    @unittest.skipUnless(sys.platform == "win32", "Windows Credential Manager")
    def test_wincred_round_trip(self):
        target = f"chief-of-staff/jev-unittest-{os.getpid()}"
        self.addCleanup(keys.delete_wincred, target)
        self.assertIsNone(keys.resolve("wincred:" + target))
        keys.store_wincred(target, "unit-test-secret")
        self.assertEqual(keys.resolve("wincred:" + target), "unit-test-secret")
        self.assertTrue(keys.delete_wincred(target))
        self.assertFalse(keys.delete_wincred(target))


if __name__ == "__main__":
    unittest.main()


class NoLeaks(unittest.TestCase):
    """The key never follows a redirect, and a local call never goes through a proxy."""

    def test_a_redirect_is_refused_and_the_key_stays_put(self):
        stub = Stub()
        self.addCleanup(stub.close)
        seen = []

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(302)
                self.send_header("Location", stub.url + "/steal")
                self.send_header("Content-Length", "0")
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        p = OpenAICompatProvider(f"http://127.0.0.1:{server.server_address[1]}/v1", "m", api_key=FAKE_KEY)
        with self.assertRaises(ProviderError) as ctx:
            p.decide(REQ, 2)
        self.assertIn("302", str(ctx.exception))
        self.assertNotIn(FAKE_KEY, str(ctx.exception))
        self.assertEqual(len(seen), 1)
        self.assertEqual(stub.calls, [])          # nothing reached the redirect target

    def test_a_local_call_skips_the_proxy(self):
        stub = Stub()
        self.addCleanup(stub.close)
        old = {k: os.environ.get(k) for k in ("HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")}
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
                                 for k, v in old.items()])
        for k in ("NO_PROXY", "no_proxy"):
            os.environ.pop(k, None)
        os.environ["HTTP_PROXY"] = os.environ["http_proxy"] = "http://127.0.0.1:9"   # nothing listens there
        p = OpenAICompatProvider(stub.url + "/v1", "m", api_key=FAKE_KEY)
        self.assertEqual(parse(p.decide(REQ, 2)).route, "new_session")
        self.assertEqual(len(stub.calls), 1)

    def test_a_bad_header_value_never_shows_the_key(self):
        p = OpenAICompatProvider("http://127.0.0.1:9/v1", "m", api_key="sk-bad\r\nkey-value-000000")
        with self.assertRaises(ProviderError) as ctx:
            p.decide(REQ, 0.5)
        self.assertNotIn("key-value", str(ctx.exception))
