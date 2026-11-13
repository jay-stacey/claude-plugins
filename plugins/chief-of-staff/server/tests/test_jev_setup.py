"""jev_setup.py and cos/jev/runtime.py with fakes: no network, no download, no model runtime.
All hardware below is made up."""
import contextlib
import hashlib
import http.server
import io
import json
import os
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

from helpers import Sandbox

import jev_setup
from cos.jev import runtime

SCAN = {"os": "windows", "arch": "x64",
        "cpu": {"name": "Example 8-core CPU", "cores": 8, "threads": 16, "avx2": True, "avx512": False},
        "ramTotalMb": 16000, "ramFreeMb": 8000, "gpus": [], "npu": False, "diskFreeMb": 50000,
        "onBattery": False,
        "ollama": {"found": False, "path": None, "version": None, "listening": False, "loopbackOnly": None},
        "llamaServer": {"found": False, "path": None}}

BYTES = b"GGUF fake model bytes for the download test" * 100
ENTRY = {"id": "qwen3.5-0.8b", "publisher": "unsloth", "repo": "unsloth/Example-GGUF",
         "commit": "a" * 40, "file": "Example-Q4_K_M.gguf", "sha256": hashlib.sha256(BYTES).hexdigest(),
         "license": "Apache-2.0", "sizeBytes": len(BYTES), "params": "0.8B"}
FAKE_KEY = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz"


def fake_runner(scan=SCAN, smi=""):
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        if cmd[0] == "powershell":
            return subprocess.CompletedProcess(cmd, 0, "WARNING: noise\n" + json.dumps(scan) + "\n", "")
        if cmd[0] == "nvidia-smi":
            return subprocess.CompletedProcess(cmd, 0, smi, "")
        raise AssertionError(f"unexpected command {cmd[0]}")
    run.calls = calls
    return run


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def opener_for(data):
    seen = []

    def open_url(url, timeout=60):
        seen.append(url)
        return FakeResponse(data)
    open_url.seen = seen
    return open_url


def no_network(*a, **k):
    raise AssertionError("no download may happen here")


def capture(fn, *args, **kwargs):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = fn(*args, **kwargs)
    text = out.getvalue()
    return code, text, json.loads(text.strip().splitlines()[-1])


class SetupCase(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().__enter__()
        self.home = Path(self.box.dir) / "home"
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def tearDown(self):
        runtime.stop()
        self.box.__exit__(None, None, None)

    def jev_json_text(self):
        return (self.home / "jev.json").read_text(encoding="utf-8")


class ScanTests(SetupCase):
    def test_scan_prints_scan_and_pick(self):
        run = fake_runner()
        args = jev_setup.parser().parse_args(["scan"])
        code, text, res = capture(jev_setup.cmd_scan, args, runner=run)
        self.assertEqual(code, 0)
        self.assertIn("==> Checking this machine", text)
        self.assertTrue(res["ok"])
        self.assertEqual(res["scan"]["cpu"]["cores"], 8)
        self.assertEqual(res["pick"]["tier"], "local-cpu")
        self.assertEqual(res["voiceVramMib"], 0)
        self.assertEqual(run.calls[0][:2], ["powershell", "-NoProfile"])

    def test_scan_without_json_is_an_error(self):
        def run(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 1, "not json", "")
        with self.assertRaises(jev_setup.SetupError):
            jev_setup.run_scan(run)

    def test_voice_vram(self):
        self.assertEqual(jev_setup.voice_vram_mib(self.home, fake_runner()), 0)
        (self.home / "voice.json").write_text(json.dumps({"device": "cpu"}), encoding="utf-8")
        self.assertEqual(jev_setup.voice_vram_mib(self.home, fake_runner()), 0)
        (self.home / "voice.json").write_text(json.dumps({"device": "cuda", "gpu": "Example RTX"}), encoding="utf-8")
        self.assertEqual(jev_setup.voice_vram_mib(self.home, fake_runner()), 4200)
        (self.home / "run").mkdir(exist_ok=True)
        (self.home / "run" / "selfcheck.json").write_text(
            json.dumps({"gpu_used_before_mib": 900, "gpu_used_after_mib": 4900}), encoding="utf-8")
        self.assertEqual(jev_setup.voice_vram_mib(self.home, fake_runner()), 4000)
        smi = f"1234, {self.home / 'venv' / 'Scripts' / 'python.exe'}\n"
        self.assertEqual(jev_setup.voice_vram_mib(self.home, fake_runner(smi=smi)), 0)


class LocalTests(SetupCase):
    def test_local_without_yes_downloads_nothing(self):
        args = jev_setup.parser().parse_args(["local", "--model", "qwen3.5-0.8b"])
        with mock.patch.object(jev_setup, "https_open", no_network), \
                mock.patch.object(runtime, "ensure_running", no_network):
            code, text, res = capture(jev_setup.cmd_local, args, runner=fake_runner())
        self.assertEqual(code, 0)
        self.assertTrue(res["dryRun"])
        self.assertTrue(res["download"]["url"].startswith("https://huggingface.co/"))
        self.assertGreater(res["download"]["sizeBytes"], 0)
        self.assertEqual(res["runtime"]["kind"], "llama_server")
        self.assertTrue(res["runtime"]["download"]["url"].startswith("https://github.com/ggml-org/llama.cpp/"))
        self.assertIn("Would download", text)
        self.assertFalse((self.home / "models").exists())
        self.assertFalse((self.home / "tools").exists())
        self.assertFalse((self.home / "jev.json").exists())

    def test_yes_without_yes_runtime_stops_before_any_download(self):
        args = jev_setup.parser().parse_args(["local", "--model", "qwen3.5-0.8b", "--yes"])
        with mock.patch.object(jev_setup, "https_open", no_network):
            code, _text, res = capture(jev_setup.cmd_local, args, runner=fake_runner())
        self.assertEqual(code, 2)
        self.assertEqual(res["needs"], "runtime")
        self.assertFalse((self.home / "models").exists())

    def test_download_verifies_hash(self):
        opener = opener_for(BYTES)
        path = jev_setup.download_model(ENTRY, opener)
        self.assertEqual(path.read_bytes(), BYTES)
        self.assertEqual(path.parent, self.home / "models" / "jev" / "qwen3.5-0.8b")
        self.assertEqual(opener.seen[0], f"https://huggingface.co/unsloth/Example-GGUF/resolve/{'a' * 40}/Example-Q4_K_M.gguf")
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["Example-Q4_K_M.gguf"])
        # A second run finds the verified file and does not download again.
        self.assertEqual(jev_setup.download_model(ENTRY, no_network), path)

    def test_download_rejects_bad_hash(self):
        bad = BYTES[:-1] + b"X"
        with self.assertRaises(jev_setup.SetupError) as ctx:
            jev_setup.download_model(ENTRY, opener_for(bad))
        self.assertIn("SHA256", str(ctx.exception))
        folder = self.home / "models" / "jev" / "qwen3.5-0.8b"
        self.assertEqual(list(folder.iterdir()), [])

    def test_download_rejects_wrong_size_and_full_folder(self):
        with self.assertRaises(jev_setup.SetupError):
            jev_setup.download_model(ENTRY, opener_for(BYTES + b"more"))
        folder = self.home / "models" / "jev" / "qwen3.5-0.8b"
        (folder / "run-me.exe").write_bytes(b"MZ")
        with self.assertRaises(jev_setup.SetupError) as ctx:
            jev_setup.download_model(ENTRY, opener_for(BYTES))
        self.assertIn("not empty", str(ctx.exception))

    def test_download_needs_https(self):
        with self.assertRaises(jev_setup.SetupError):
            jev_setup.fetch("http://example.com/x.gguf", self.home / "x", "x.gguf", 1, lambda p: None,
                            opener_for(b"x"))

    def test_manifest_problems_refuse(self):
        bad = dict(ENTRY, license="GPL-3.0")
        with mock.patch.object(jev_setup.modelcheck, "find", lambda _id: bad):
            with self.assertRaises(jev_setup.SetupError) as ctx:
                jev_setup.model_entry("qwen3.5-0.8b")
        self.assertIn("license", str(ctx.exception))
        with self.assertRaises(jev_setup.SetupError):
            jev_setup.model_entry("not-a-model")

    def test_llama_pins_are_real(self):
        for build in jev_setup.LLAMA_BUILDS:
            pin = jev_setup.llama_build(build)
            self.assertRegex(pin["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(pin["url"].startswith("https://github.com/ggml-org/llama.cpp/releases/download/"))
        with mock.patch.dict(jev_setup.LLAMA_BUILDS, {"cpu": dict(jev_setup.LLAMA_BUILDS["cpu"], sha256="PIN_ME")}):
            with self.assertRaises(jev_setup.SetupError):
                jev_setup.llama_build("cpu")

    def test_ollama_is_used_only_when_new_and_loopback(self):
        pick = {"tier": "local-cpu"}
        good = dict(SCAN, ollama={"found": True, "path": "C:/Example/ollama.exe", "version": "0.17.1",
                                  "listening": True, "loopbackOnly": True})
        self.assertEqual(jev_setup.plan_runtime(good, pick)["kind"], "ollama")
        for change in ({"version": "0.17.0"}, {"loopbackOnly": False}, {"listening": False}):
            s = dict(good, ollama=dict(good["ollama"], **change))
            self.assertEqual(jev_setup.plan_runtime(s, pick)["kind"], "llama_server", change)
            with self.assertRaises(jev_setup.SetupError):
                jev_setup.plan_runtime(s, pick, "ollama")

    def run_local(self, model_id, bench_res, kind="llama_server"):
        exe = self.home / "fake-llama-server.exe"
        exe.write_bytes(b"")
        entry = dict(ENTRY, id=model_id)
        scan = dict(SCAN, llamaServer={"found": True, "path": str(exe)})
        args = jev_setup.parser().parse_args(["local", "--model", model_id, "--yes"])
        stored = {}
        with mock.patch.object(jev_setup, "model_entry", lambda _id: entry), \
                mock.patch.object(jev_setup, "https_open", opener_for(BYTES)), \
                mock.patch.object(jev_setup.keys, "resolve", lambda ref: None), \
                mock.patch.object(jev_setup.keys, "store_wincred", lambda t, s: stored.update({t: s})), \
                mock.patch.object(jev_setup, "live_test", lambda cfg, key: dict(bench_res)):
            code, text, res = capture(jev_setup.cmd_local, args, runner=fake_runner(scan))
        return code, text, res, stored

    def test_local_writes_jev_json_without_key(self):
        code, text, res, stored = self.run_local("qwen3.5-0.8b", {"p50": 300, "p95": 600, "valid": 10, "total": 10})
        self.assertEqual(code, 0, text)
        self.assertEqual(res["provider"], "local")
        data = json.loads(self.jev_json_text())
        self.assertEqual(data["provider"], "local")
        self.assertEqual(data["endpoint"], "http://127.0.0.1:11435/v1")
        self.assertEqual(data["runtime"]["apiKeyRef"], "wincred:chief-of-staff/jev-local")
        self.assertIn("--host", data["runtime"]["args"])
        self.assertEqual(data["runtime"]["args"][data["runtime"]["args"].index("--host") + 1], "127.0.0.1")
        self.assertEqual(data["localLlm"]["p95"], 600)
        secret = stored["chief-of-staff/jev-local"]
        self.assertNotIn(secret, self.jev_json_text())
        self.assertNotIn(secret, text)
        self.assertEqual(runtime.check_launch(data["runtime"]), [])

    def test_slow_large_model_steps_down(self):
        code, _text, res, _stored = self.run_local("qwen3.5-2b", {"p50": 500, "p95": 900, "valid": 10, "total": 10})
        self.assertEqual(code, 3)
        self.assertEqual(res["stepDown"], "qwen3.5-0.8b")
        data = json.loads(self.jev_json_text())
        self.assertNotEqual(data.get("provider"), "local")
        self.assertFalse(data["localLlm"]["passed"])


class RuntimeTests(SetupCase):
    def runtime_block(self, **changes):
        exe = self.home / "fake-runtime.exe"
        exe.write_bytes(b"")
        block = {"kind": "llama_server", "exe": str(exe), "args": ["-m", "x.gguf", "--host", "127.0.0.1"],
                 "port": 1, "apiKeyRef": "env:COS_TEST_JEV_KEY"}
        block.update(changes)
        return {"endpoint": "http://127.0.0.1:1/v1", "runtime": block}

    def test_refuses_every_address(self):
        for args in (["--host", "0.0.0.0"], ["--host=0.0.0.0"], ["--host", "192.168.1.5"], ["--host"],
                     ["--api-key", "x"]):
            cfg = self.runtime_block(args=args)
            self.assertTrue(runtime.check_launch(cfg["runtime"]), args)
            with mock.patch.object(runtime.subprocess, "Popen", no_network),                     mock.patch.object(runtime, "answers", lambda *a, **k: False):
                self.assertFalse(runtime.ensure_running(cfg, timeout_s=0.1))

    def test_refuses_missing_exe(self):
        cfg = self.runtime_block(exe=str(self.home / "nope.exe"))
        self.assertIn("the runtime program is not an existing file", runtime.check_launch(cfg["runtime"]))
        with mock.patch.object(runtime.subprocess, "Popen", no_network),                 mock.patch.object(runtime, "answers", lambda *a, **k: False):
            self.assertFalse(runtime.ensure_running(cfg, timeout_s=0.1))

    def test_never_raises(self):
        self.assertFalse(runtime.ensure_running(None))
        self.assertFalse(runtime.ensure_running({"runtime": "nonsense"}, timeout_s=0.1))

    def test_starts_with_key_in_env_and_polls(self):
        cfg = self.runtime_block()
        seen = {}
        answers = iter([False, False, True])

        class FakeProc:
            def poll(self):
                return None

            def terminate(self):
                seen["stopped"] = True

            def wait(self, timeout=None):
                return 0

        def popen(cmd, **kw):
            seen.update(cmd=cmd, env=kw["env"], shell=kw["shell"])
            return FakeProc()

        self.box.env(COS_TEST_JEV_KEY="local-test-key")
        with mock.patch.object(runtime.subprocess, "Popen", popen), \
                mock.patch.object(runtime, "answers", lambda *a, **k: next(answers)), \
                mock.patch.object(runtime, "POLL_S", 0):
            self.assertTrue(runtime.ensure_running(cfg, timeout_s=5))
        self.assertEqual(seen["env"]["LLAMA_API_KEY"], "local-test-key")
        self.assertNotIn("local-test-key", seen["cmd"])
        self.assertFalse(seen["shell"])
        self.assertTrue((self.home / "logs" / "jev-runtime.log").exists())
        runtime.stop()
        self.assertTrue(seen.get("stopped"))

    def test_ollama_gets_loopback_host(self):
        cfg = self.runtime_block(kind="ollama", args=["serve"], apiKeyRef=None, port=11500)
        seen = {}
        answers = iter([False, True])

        def popen(cmd, **kw):
            seen.update(env=kw["env"])
            return mock.Mock(poll=lambda: None)

        with mock.patch.object(runtime.subprocess, "Popen", popen), \
                mock.patch.object(runtime, "answers", lambda *a, **k: next(answers)), \
                mock.patch.object(runtime, "POLL_S", 0):
            self.assertTrue(runtime.ensure_running(cfg, timeout_s=5))
        self.assertEqual(seen["env"]["OLLAMA_HOST"], "127.0.0.1:11500")

    def stub(self, key):
        """A llama-server stand-in: /health for anyone, /v1/models for Jev's key only."""
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    body, code = b"{}", 200
                elif self.path == "/v1/models" and key and self.headers.get("Authorization") == f"Bearer {key}":
                    body, code = json.dumps({"data": [{"id": "qwen3.5-0.8b"}]}).encode(), 200
                else:
                    body, code = b"{}", 401
                self.send_response(code)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        port = srv.server_address[1]
        cfg = self.runtime_block(port=port)
        cfg["endpoint"] = f"http://127.0.0.1:{port}/v1"
        cfg["model"] = "qwen3.5-0.8b"
        return cfg

    def test_answers_from_a_local_stub(self):
        cfg = self.stub("local-key-123")
        with mock.patch.dict(os.environ, {"COS_TEST_JEV_KEY": "local-key-123"}),                 mock.patch.object(runtime.subprocess, "Popen", no_network):
            self.assertTrue(runtime.ensure_running(cfg, timeout_s=1))

    def test_another_program_on_the_port_is_not_trusted(self):
        # It answers /health, but it does not serve Jev's model for Jev's key.
        cfg = self.stub("someone-elses-key")
        with mock.patch.dict(os.environ, {"COS_TEST_JEV_KEY": "local-key-123"}),                 mock.patch.object(runtime.subprocess, "Popen", no_network),                 mock.patch.object(runtime, "POLL_S", 0):
            self.assertFalse(runtime.answers(cfg, key="local-key-123"))


class HostedTests(SetupCase):
    def run_hosted(self, argv, key=FAKE_KEY):
        args = jev_setup.parser().parse_args(["hosted", *argv])
        stored = {}
        with mock.patch.object(jev_setup.keys, "store_wincred", lambda t, s: stored.update({t: s})), \
                mock.patch.object(jev_setup, "test_call", lambda *a: 123):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                try:
                    code = jev_setup.cmd_hosted(args, stream=io.StringIO(key + "\n"))
                except jev_setup.SetupError as err:
                    return None, out.getvalue(), str(err), stored
        text = out.getvalue()
        return code, text, json.loads(text.strip().splitlines()[-1]), stored

    def test_reads_key_from_stdin_and_stores_it(self):
        code, text, res, stored = self.run_hosted(["--adapter", "anthropic"])
        self.assertEqual(code, 0)
        self.assertEqual(stored, {"chief-of-staff/jev": FAKE_KEY})
        self.assertEqual(res["keyRef"], "wincred:chief-of-staff/jev")
        self.assertEqual(res["model"], "claude-haiku-5-5")
        self.assertNotIn(FAKE_KEY, text)
        data = json.loads(self.jev_json_text())
        self.assertEqual(data["provider"], "hosted")
        self.assertEqual(data["hosted"]["keyRef"], "wincred:chief-of-staff/jev")
        self.assertNotIn(FAKE_KEY, self.jev_json_text())

    def test_key_is_never_an_argument(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            jev_setup.parser().parse_args(["hosted", "--adapter", "anthropic", "--key", FAKE_KEY])

    def test_empty_key_refused(self):
        code, _text, err, stored = self.run_hosted(["--adapter", "anthropic"], key="")
        self.assertIsNone(code)
        self.assertIn("no API key", err)
        self.assertEqual(stored, {})

    def test_blocked_hosts(self):
        for host in ("api.mistral.ai", "openrouter.ai", "api.cerebras.ai"):
            code, _text, err, stored = self.run_hosted(["--adapter", "openai_compat", "--model", "m",
                                                        "--endpoint", f"https://{host}/v1"])
            self.assertIsNone(code, host)
            self.assertIn(host, err)
            self.assertEqual(stored, {})
        gemini = ["--adapter", "openai_compat", "--model", "m",
                  "--endpoint", "https://generativelanguage.googleapis.com/v1beta/openai"]
        # Gemini is refused like the others: the engine would refuse it too.
        code, _text, err, stored = self.run_hosted(gemini)
        self.assertIsNone(code)
        self.assertIn("generativelanguage.googleapis.com", err)
        self.assertEqual(stored, {})

    def test_plain_http_remote_refused(self):
        code, _text, err, _stored = self.run_hosted(["--adapter", "openai_compat", "--model", "m",
                                                     "--endpoint", "http://example.com/v1"])
        self.assertIsNone(code)
        self.assertIn("https", err)

    def test_rules_and_status(self):
        self.run_hosted(["--adapter", "anthropic"])
        code, _text, res = capture(jev_setup.cmd_rules, None)
        self.assertEqual((code, res["provider"]), (0, "rules"))
        data = json.loads(self.jev_json_text())
        self.assertEqual(data["provider"], "rules")
        self.assertEqual(data["hosted"]["model"], "claude-haiku-5-5")
        code, text, res = capture(jev_setup.cmd_status, None)
        self.assertTrue(res["configured"])
        self.assertNotIn(FAKE_KEY, text)

    def test_write_guard_refuses_a_raw_key(self):
        with self.assertRaises(jev_setup.SetupError):
            jev_setup.write_jev({"provider": "hosted", "keyRef": FAKE_KEY})
        self.assertFalse((self.home / "jev.json").exists())


if __name__ == "__main__":
    unittest.main()


class KeyInput(unittest.TestCase):
    def test_a_key_with_control_characters_or_spaces_is_refused(self):
        self.assertEqual(jev_setup.read_key(io.StringIO("sk-good-key-000\n")), "sk-good-key-000")
        for bad in ("sk-bad\rkey\n", "sk bad key\n", "sk-bäd-key\n"):
            with self.assertRaises(jev_setup.SetupError):
                jev_setup.read_key(io.StringIO(bad))
