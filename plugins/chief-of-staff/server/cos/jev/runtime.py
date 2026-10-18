"""Starts Jev's local model runtime (Ollama or llama.cpp llama-server) when its endpoint
does not answer. It binds 127.0.0.1 only and never 0.0.0.0. Standard library only.

jev.json "runtime": {"kind": "ollama"|"llama_server", "exe": path, "args": [...],
"port": n, "apiKeyRef": "wincred:..."}. The llama-server key is never in args or in any
file: it is read from apiKeyRef and handed over in the LLAMA_API_KEY environment variable.
"""
import os
import subprocess
import threading
import time
import urllib.error
import json
import urllib.request
from pathlib import Path

from .. import paths

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
LOOPBACK = "127.0.0.1"
POLL_S = 0.25
_lock = threading.Lock()
_proc = None


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get_json(url, timeout, headers=None):
    """The JSON body of a GET that answered 200, or None."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with _opener().open(req, timeout=timeout) as r:
            return json.loads(r.read(1 << 16)) if r.status == 200 else None
    except Exception:
        return None


def _get(url, timeout, headers=None):
    """The HTTP status of a GET, or None when nothing answers."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with _opener().open(req, timeout=timeout) as r:
            r.read(4096)
            return r.status
    except urllib.error.HTTPError as err:
        return err.code
    except Exception:
        return None


def _key(runtime):
    ref = runtime.get("apiKeyRef") if isinstance(runtime, dict) else None
    if not ref:
        return None
    try:
        from . import keys
        return keys.resolve(ref)
    except Exception:
        return None


def answers(jev_json, timeout=1.0, key=None):
    """True when the configured local endpoint answers."""
    runtime = jev_json.get("runtime") if isinstance(jev_json.get("runtime"), dict) else {}
    kind = runtime.get("kind")
    port = runtime.get("port")
    if kind == "ollama":
        return _get(f"http://{LOOPBACK}:{port or 11434}/api/version", timeout) == 200
    if kind == "llama_server":
        # /health needs no key, so any program on the port passes it. Ours lists Jev's model
        # for Jev's key; nothing else gets the key or Jay's words.
        if not isinstance(port, int) or not key:
            return False
        body = _get_json(f"http://{LOOPBACK}:{port}/v1/models", timeout, {"Authorization": f"Bearer {key}"})
        data = body.get("data") if isinstance(body, dict) else None
        ids = [m.get("id") for m in data if isinstance(m, dict)] if isinstance(data, list) else []
        return bool(jev_json.get("model")) and jev_json.get("model") in ids
    endpoint = str(jev_json.get("endpoint") or "").rstrip("/")
    if not endpoint.startswith(("http://", "https://")):
        return False
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    return _get(f"{endpoint}/models", timeout, headers) == 200


def check_launch(runtime):
    """Problems with a runtime launch ([] when it may start)."""
    problems = []
    if not isinstance(runtime, dict):
        return ["no runtime is configured"]
    kind = runtime.get("kind")
    if kind not in ("ollama", "llama_server"):
        problems.append(f"unknown runtime kind {kind!r}")
    exe = runtime.get("exe")
    if not exe or not Path(str(exe)).is_file():
        problems.append("the runtime program is not an existing file")
    elif "rpc-server" in Path(str(exe)).name.lower():
        problems.append("rpc-server is never started")
    args = runtime.get("args") or []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return problems + ["runtime args must be a list of strings"]
    for i, arg in enumerate(args):
        low = arg.lower()
        if "0.0.0.0" in low or low in ("::", "[::]") or "[::]" in low:
            problems.append("the runtime may not listen on every network address")
        if low == "--host":
            host = args[i + 1] if i + 1 < len(args) else ""
            if host != LOOPBACK:
                problems.append(f"--host must be {LOOPBACK}")
        elif low.startswith("--host="):
            if arg.split("=", 1)[1] != LOOPBACK:
                problems.append(f"--host must be {LOOPBACK}")
        if low.startswith("--api-key"):
            problems.append("the API key may not be in the runtime args")
    port = runtime.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        problems.append("the runtime port is not a valid port number")
    return problems


def _log_file():
    try:
        d = paths.logs_dir()
        d.mkdir(parents=True, exist_ok=True)
        return open(d / "jev-runtime.log", "ab")
    except OSError:
        return None


def ensure_running(jev_json, timeout_s=10):
    """True when the local runtime answers, starting it first if needed. Never raises."""
    global _proc
    try:
        if not isinstance(jev_json, dict):
            return False
        runtime = jev_json.get("runtime")
        key = _key(runtime)
        if answers(jev_json, key=key):
            return True
        if check_launch(runtime):
            return False
        env = dict(os.environ)
        if runtime["kind"] == "ollama":
            env["OLLAMA_HOST"] = f"{LOOPBACK}:{runtime['port']}"
        else:
            if not key:
                return False  # llama-server always runs with a key
            env["LLAMA_API_KEY"] = key
        with _lock:
            if _proc is None or _proc.poll() is not None:
                log = _log_file()
                try:
                    _proc = subprocess.Popen([str(runtime["exe"]), *runtime.get("args", [])], env=env, shell=False,
                                             stdin=subprocess.DEVNULL, stdout=log or subprocess.DEVNULL,
                                             stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
                finally:
                    if log:
                        log.close()
        deadline = time.monotonic() + max(0.0, float(timeout_s))
        while time.monotonic() < deadline:
            if answers(jev_json, timeout=1.0, key=key):
                return True
            if _proc is not None and _proc.poll() is not None:
                return False
            time.sleep(POLL_S)
        return answers(jev_json, timeout=1.0, key=key)
    except Exception:
        return False


def stop():
    """Stops the runtime this process started, if any."""
    global _proc
    with _lock:
        proc, _proc = _proc, None
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

