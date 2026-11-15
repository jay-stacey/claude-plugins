#!/usr/bin/env python3
"""Sets up Jev, the Chief's small decision model. The chief-setup skill drives it.

    python jev_setup.py scan
    python jev_setup.py local --model ID [--runtime ollama|llama_server] [--yes] [--yes-runtime]
    python jev_setup.py hosted --adapter anthropic|openai_compat [--model M] [--endpoint URL]
    python jev_setup.py rules
    python jev_setup.py status

Each command prints "==> " progress lines, then one JSON line with the result.
"local" without --yes downloads nothing: it says what it would fetch, so the skill can ask
first. "hosted" reads the API key from stdin (hidden at a terminal), never from the command line.
Writes HOME\\jev.json; keys go to Windows Credential Manager, never to a file.
Standard library only. Python 3.10 or later.
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cos import paths  # noqa: E402
from cos.jev import bench, decision, keys, modelcheck, providers, runtime, tiers  # noqa: E402

SCAN_PS1 = HERE / "jev-scan.ps1"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Pinned llama.cpp release (GitHub ggml-org/llama.cpp, tag b11381, published 2026-10-03).
# SHA256 values are the "digest" fields from the GitHub release API for these assets.
LLAMA_TAG = "b11381"
LLAMA_BASE_URL = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/"
LLAMA_BUILDS = {
    "cpu": {"file": "llama-b11381-bin-win-cpu-x64.zip", "sizeBytes": 19367262,
            "sha256": "f5cb0430a9dd2174f392fdad17ed5d6417e5542c47efc993fa4917287a738a76"},
    # Vulkan runs on NVIDIA cards without a separate CUDA runtime download.
    "vulkan": {"file": "llama-b11381-bin-win-vulkan-x64.zip", "sizeBytes": 33287351,
               "sha256": "517032b9ab2e1c7991a1313fa8c39cbc1a9da6ebf82944cf34ccf6adf3d0a37a"},
}
PIN_ME = "PIN_ME"

OLLAMA_MIN = (0, 17, 1)  # CVE-2026-7482 is fixed from here on
OLLAMA_PORT = 11434
LLAMA_PORT = 11435
LOCAL_KEY_TARGET = "chief-of-staff/jev-local"
HOSTED_KEY_TARGET = "chief-of-staff/jev"
P95_LIMIT_MS = 800
START_TIMEOUT_S = 90
VOICE_CUDA_MIB = 4200
HOSTED_DEFAULT_MODEL = {"anthropic": "claude-haiku-5-5"}
CHUNK = 1 << 20


class SetupError(Exception):
    """A step failed. The message is plain and holds no secret."""


def step(what):
    print(f"==> {what}", flush=True)


def note(what):
    print(f"    {what}", flush=True)


def result(data, code=0):
    print(json.dumps(data, separators=(",", ":")), flush=True)
    return code


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def mb(n):
    return f"{n / 1_000_000:.0f} MB"


# --- jev.json ----------------------------------------------------------------------------

def jev_path():
    return paths.home() / "jev.json"


def read_jev():
    try:
        data = json.loads(jev_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_jev(data):
    """Atomic write. Refuses anything that looks like a raw key, as a last guard."""
    text = json.dumps(data, indent=2)
    for value in _strings(data):
        if keys.looks_like_key(value) and not _harmless(value):
            raise SetupError("refused to write jev.json: a value looks like an API key")
    p = jev_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name("jev.json.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


def _strings(value):
    if isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)
    elif isinstance(value, str):
        yield value


def _harmless(value):
    """Long strings in jev.json that are not keys: paths, file names, hashes, URLs."""
    return bool(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value)) or any(c in value for c in "\\:") \
        or value.lower().endswith((".gguf", ".zip", ".exe"))


# --- Scan --------------------------------------------------------------------------------

def run_scan(runner=subprocess.run):
    """jev-scan.ps1's JSON line as a dict."""
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCAN_PS1)]
    try:
        r = runner(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
                   creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as err:
        raise SetupError(f"the machine scan did not run: {err}") from None
    for line in reversed((r.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    raise SetupError("the machine scan gave no JSON")


def voice_vram_mib(home=None, runner=subprocess.run):
    """Video memory the CUDA voice uses or will use, in MiB. 0 for the CPU voice, and 0 when
    the voice is loaded now (its memory is then already out of the free figure)."""
    home = Path(home or paths.home())
    try:
        voice = json.loads((home / "voice.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    if not isinstance(voice, dict) or voice.get("device") != "cuda":
        return 0
    if _voice_on_gpu(home, runner):
        return 0
    gpu = voice.get("gpu")
    for value in (gpu.get("usedMib") if isinstance(gpu, dict) else None,
                  gpu.get("used") if isinstance(gpu, dict) else None, voice.get("gpuUsedMib")):
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            return int(value)
    try:
        check = json.loads((home / "run" / "selfcheck.json").read_text(encoding="utf-8"))
        used = check["gpu_used_after_mib"] - check["gpu_used_before_mib"]
        if isinstance(used, (int, float)) and used > 0:
            return int(used)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return VOICE_CUDA_MIB


def _voice_on_gpu(home, runner):
    """True when a program from HOME\\venv holds GPU memory now (the voice daemon)."""
    try:
        r = runner(["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader"],
                   capture_output=True, text=True, timeout=5, creationflags=NO_WINDOW)
    except Exception:
        return False
    venv = str(home / "venv").lower()
    return any(venv in line.lower() for line in (r.stdout or "").splitlines())


def cmd_scan(args, runner=subprocess.run):
    step("Checking this machine for Jev")
    scan = run_scan(runner)
    vram = voice_vram_mib(runner=runner)
    pick = tiers.pick(scan, vram)
    note(f"Tier: {pick['tier']}, model: {pick['model'] or 'none'}")
    return result({"ok": True, "scan": scan, "voiceVramMib": vram, "pick": pick})


# --- Downloads ---------------------------------------------------------------------------

class _HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise SetupError("a download redirect left HTTPS")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_open(url, timeout=60):
    """Opens an HTTPS URL. Tests replace this with a stub."""
    opener = urllib.request.build_opener(_HttpsOnlyRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "chief-of-staff-jev-setup"})
    return opener.open(req, timeout=timeout)


def fetch(url, folder, name, size, check, opener=None):
    """Downloads url into folder/name through name.part, then check(part) (raises on a bad
    file), then renames. folder must be new, or hold only this file. Returns the path."""
    if urllib.parse.urlsplit(url).scheme != "https":
        raise SetupError("downloads must use HTTPS")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise SetupError("the download file name is not safe")
    folder = Path(folder)
    final, part = folder / name, folder / (name + ".part")
    if folder.exists():
        other = [p.name for p in folder.iterdir() if p.name not in (name, part.name)]
        if other:
            raise SetupError(f"{folder} is not empty; move its files away and run again")
        if part.exists():
            part.unlink()
        if final.exists():
            try:
                check(final)
                note(f"{name} is already here and checks out")
                return final
            except ValueError:
                final.unlink()
    folder.mkdir(parents=True, exist_ok=True)
    try:
        free = shutil.disk_usage(folder).free
        if size and free < size + 200_000_000:
            raise SetupError(f"not enough free disk for {name}: needs {mb(size)}, {mb(free)} free")
    except OSError:
        pass
    open_url = opener or https_open
    got, shown = 0, 0
    try:
        with open_url(url) as resp, open(part, "wb") as out:
            while True:
                block = resp.read(CHUNK)
                if not block:
                    break
                out.write(block)
                got += len(block)
                if size and got > size:
                    raise SetupError(f"{name} is larger than its pinned size")
                if size and got * 10 // size > shown:
                    shown = got * 10 // size
                    note(f"{shown * 10}% of {mb(size)}")
        check(part)
    except ValueError as err:
        part.unlink(missing_ok=True)
        raise SetupError(f"{name} failed its check and was deleted: {err}") from None
    except SetupError:
        part.unlink(missing_ok=True)
        raise
    except Exception as err:
        part.unlink(missing_ok=True)
        raise SetupError(f"downloading {name} failed: {type(err).__name__}") from None
    os.replace(part, final)
    return final


def sha256_check(sha256, size):
    def check(path):
        p = Path(path)
        if size and p.stat().st_size != size:
            raise ValueError(f"{p.name} is not the pinned size")
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for block in iter(lambda: f.read(CHUNK), b""):
                h.update(block)
        if h.hexdigest() != sha256:
            raise ValueError(f"{p.name} SHA256 does not match the pinned value")
    return check


def model_entry(model_id):
    entry = modelcheck.find(model_id)
    if not entry:
        known = ", ".join(e.get("id", "?") for e in modelcheck.MANIFEST)
        raise SetupError(f"unknown model {model_id}; pinned models: {known}")
    problems = modelcheck.check_entry(entry)
    if problems:
        raise SetupError(f"model {model_id} fails its checks: {'; '.join(problems)}")
    return entry


def model_folder(model_id):
    return paths.home() / "models" / "jev" / model_id


def model_ready(entry):
    """The verified model file when it is already downloaded, else None."""
    p = model_folder(entry["id"]) / entry["file"]
    try:
        modelcheck.verify_file(p, entry)
        return p
    except ValueError:
        return None


def download_model(entry, opener=None):
    step(f"Downloading {entry['file']} ({mb(entry['sizeBytes'])}) from Hugging Face")
    return fetch(modelcheck.download_url(entry), model_folder(entry["id"]), entry["file"], entry["sizeBytes"],
                 lambda p: modelcheck.verify_file(p, entry), opener)


def llama_build(build):
    pin = LLAMA_BUILDS[build]
    if PIN_ME in (LLAMA_TAG, pin["sha256"]) or not re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]):
        raise SetupError("the llama.cpp release is not pinned yet (PIN_ME); use Ollama or set the pin")
    return {"tag": LLAMA_TAG, "file": pin["file"], "sizeBytes": pin["sizeBytes"],
            "url": LLAMA_BASE_URL + pin["file"], "sha256": pin["sha256"]}


def llama_dir():
    return paths.home() / "tools" / "llama.cpp" / LLAMA_TAG


DONE_MARK = ".unpacked"


def installed_llama(build):
    """The unpacked llama-server, only when a whole unpack finished (its marker file is there)."""
    dest = llama_dir() / build
    if not (dest / DONE_MARK).is_file():
        return None
    found = list(dest.rglob("llama-server.exe"))
    return found[0] if found else None


def install_llama(build, opener=None):
    """Downloads and unpacks the pinned llama.cpp build. Returns the llama-server path."""
    exe = installed_llama(build)
    if exe:
        return exe
    pin = llama_build(build)
    step(f"Downloading llama.cpp {pin['tag']} ({pin['file']}, {mb(pin['sizeBytes'])}) from GitHub")
    zpath = fetch(pin["url"], llama_dir() / "zip", pin["file"], pin["sizeBytes"],
                  sha256_check(pin["sha256"], pin["sizeBytes"]), opener)
    step("Unpacking llama.cpp")
    dest = llama_dir() / build
    # A half-finished unpack from an earlier run is thrown away, never reused.
    if dest.exists():
        shutil.rmtree(dest)
    with zipfile.ZipFile(zpath) as z:
        for member in z.namelist():
            parts = Path(member).parts
            if Path(member).is_absolute() or ".." in parts or (parts and ":" in parts[0]):
                raise SetupError("the llama.cpp zip holds an unsafe path")
        z.extractall(dest)
    (dest / DONE_MARK).write_text(pin["sha256"], encoding="utf-8")
    exe = installed_llama(build)
    if not exe:
        raise SetupError("llama-server.exe is not in the llama.cpp zip")
    return exe


# --- Local -------------------------------------------------------------------------------

def _version(text):
    nums = re.findall(r"\d+", str(text or "").split("-")[0])
    return tuple(int(n) for n in nums[:3]) if nums else None


def ollama_problems(scan):
    """Why the existing Ollama cannot be used ([] when it can)."""
    o = scan.get("ollama") if isinstance(scan.get("ollama"), dict) else {}
    if not o.get("found"):
        return ["Ollama is not installed"]
    problems = []
    v = _version(o.get("version"))
    if not o.get("listening"):
        problems.append("Ollama is not running, so its version and address cannot be checked")
    elif v is None or v < OLLAMA_MIN:
        problems.append(f"Ollama {o.get('version') or 'of unknown version'} is older than 0.17.1")
    if o.get("listening") and o.get("loopbackOnly") is not True:
        problems.append("Ollama listens on more than 127.0.0.1")
    if not o.get("path"):
        problems.append("the Ollama program was not found on PATH")
    return problems


def plan_runtime(scan, pick, wanted=None):
    """{"kind", "exe"|None, "build"|None, "download"|None, "why"}."""
    o_problems = ollama_problems(scan)
    if wanted == "ollama" and o_problems:
        raise SetupError("Ollama cannot be used: " + "; ".join(o_problems))
    if wanted in (None, "ollama") and not o_problems:
        return {"kind": "ollama", "exe": scan["ollama"]["path"], "build": None, "download": None,
                "why": f"Ollama {scan['ollama']['version']} is running on 127.0.0.1 only"}
    why = "; ".join(o_problems) if wanted is None else "llama-server was asked for"
    ls = scan.get("llamaServer") if isinstance(scan.get("llamaServer"), dict) else {}
    if ls.get("found") and ls.get("path"):
        return {"kind": "llama_server", "exe": ls["path"], "build": None, "download": None, "why": why}
    build = "vulkan" if pick.get("tier") == "local-gpu" else "cpu"
    exe = installed_llama(build)
    if exe:
        return {"kind": "llama_server", "exe": str(exe), "build": build, "download": None, "why": why}
    pin = llama_build(build)
    return {"kind": "llama_server", "exe": None, "build": build, "why": why,
            "download": {k: pin[k] for k in ("tag", "file", "sizeBytes", "url", "sha256")}}


def modelfile_path(model_id):
    return paths.run_dir() / f"jev-{model_id}.Modelfile"


def ollama_import(exe, model_id, gguf, runner=subprocess.run):
    """ollama create jev-<id> from the verified GGUF. Returns the Ollama model name."""
    name = f"jev-{model_id}"
    mf = modelfile_path(model_id)
    mf.parent.mkdir(parents=True, exist_ok=True)
    # num_ctx matches llama-server's -c 4096: the prompt with its examples is about 1,300 tokens
    # and 20 sessions add up to 900. Ollama's default is the model's full window (5 GB here).
    mf.write_text(f"FROM {Path(gguf).resolve()}\nPARAMETER temperature 0\nPARAMETER num_ctx 4096\n",
                  encoding="utf-8")
    step(f"Importing the model into Ollama as {name}")
    env = dict(os.environ, OLLAMA_HOST=f"127.0.0.1:{OLLAMA_PORT}")
    try:
        r = runner([str(exe), "create", name, "-f", str(mf)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
                   env=env, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as err:
        raise SetupError(f"ollama create did not run: {type(err).__name__}") from None
    if r.returncode != 0:
        tail = " ".join((r.stderr or r.stdout or "").strip().splitlines()[-1:])[:200]
        raise SetupError(f"ollama create failed: {tail}")
    return name


def local_key():
    """The llama-server key: the stored one, or a new one stored now."""
    try:
        key = keys.resolve("wincred:" + LOCAL_KEY_TARGET)
    except Exception:
        key = None
    if not key:
        key = secrets.token_urlsafe(32)
        keys.store_wincred(LOCAL_KEY_TARGET, key)
    return key


def runtime_config(plan, model_id, gguf, tier):
    """The jev.json fields for a runtime: endpoint, model name and runtime block."""
    if plan["kind"] == "ollama":
        return {"endpoint": f"http://127.0.0.1:{OLLAMA_PORT}/v1", "model": f"jev-{model_id}",
                "runtime": {"kind": "ollama", "exe": plan["exe"], "args": ["serve"], "port": OLLAMA_PORT,
                            "apiKeyRef": None}}
    args = ["-m", str(Path(gguf).resolve()), "--host", "127.0.0.1", "--port", str(LLAMA_PORT),
            "-c", "4096", "--jinja", "--alias", model_id, "--no-webui"]
    if tier == "local-gpu":
        args += ["-ngl", "99"]
    return {"endpoint": f"http://127.0.0.1:{LLAMA_PORT}/v1", "model": model_id,
            "runtime": {"kind": "llama_server", "exe": plan["exe"], "args": args, "port": LLAMA_PORT,
                        "apiKeyRef": "wincred:" + LOCAL_KEY_TARGET}}


def serves_model(cfg, key):
    """True when the llama-server on the port serves this model with this key."""
    req = urllib.request.Request(f"{cfg['endpoint']}/models", headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5) as r:
            body = json.loads(r.read(1 << 16))
    except Exception:
        return False
    ids = [m.get("id") for m in body.get("data", []) if isinstance(m, dict)] if isinstance(body, dict) else []
    return cfg["model"] in ids


def live_test(cfg, key, samples=None):
    """Starts the runtime if needed and benches the model. Returns the bench result."""
    step(f"Starting {cfg['runtime']['kind']} on 127.0.0.1:{cfg['runtime']['port']}")
    if not runtime.ensure_running(cfg, timeout_s=START_TIMEOUT_S):
        raise SetupError(f"{cfg['runtime']['kind']} did not answer on 127.0.0.1; see HOME\\logs\\jev-runtime.log")
    if cfg["runtime"]["kind"] == "llama_server" and not serves_model(cfg, key):
        raise SetupError(f"something else answers on 127.0.0.1:{cfg['runtime']['port']} (another llama-server "
                         "or an old key); close it and run again")
    # 30 calls, so p95 is not just the single slowest call (with 10 it is the maximum).
    samples = samples or list(bench.SAMPLES) * 3
    step(f"Live test: two warm-ups, then {len(samples)} decisions")
    provider = providers.OpenAICompatProvider(cfg["endpoint"], cfg["model"], key, name="local")
    return bench.run(provider, samples, warmups=2)


def _dry_run(entry, plan, pick, have_model):
    model = None if have_model else {"file": entry["file"], "sizeBytes": entry["sizeBytes"],
                                     "url": modelcheck.download_url(entry), "sha256": entry["sha256"],
                                     "license": entry["license"], "publisher": entry["publisher"]}
    if model:
        note(f"Would download {entry['file']} ({mb(entry['sizeBytes'])}) from {model['url']}")
    else:
        note(f"{entry['file']} is already downloaded and checks out")
    if plan["download"]:
        d = plan["download"]
        note(f"Would also download llama.cpp {d['tag']} ({d['file']}, {mb(d['sizeBytes'])}) from {d['url']}"
             " (needs --yes-runtime)")
    note(f"Runtime: {plan['kind']} ({plan['why']})")
    return result({"ok": True, "dryRun": True, "tier": pick["tier"], "model": entry["id"], "download": model,
                   "runtime": {"kind": plan["kind"], "exe": plan["exe"], "download": plan["download"]},
                   "warnings": pick["warnings"]})


def cmd_local(args, runner=subprocess.run, opener=None):
    entry = model_entry(args.model)
    step("Checking this machine for Jev")
    scan = run_scan(runner)
    pick = tiers.pick(scan, voice_vram_mib(runner=runner))
    if pick["tier"] == "hosted":
        note("The scan says this machine is below the local baseline; the live test decides.")
    plan = plan_runtime(scan, pick, args.runtime)
    have = model_ready(entry)
    if not args.yes:
        return _dry_run(entry, plan, pick, have is not None)
    if plan["download"] and not args.yes_runtime:
        d = plan["download"]
        note(f"llama-server is needed: llama.cpp {d['tag']} ({d['file']}, {mb(d['sizeBytes'])}) from {d['url']}")
        return result({"ok": False, "needs": "runtime", "error": "run again with --yes-runtime to download llama.cpp",
                       "runtime": {"kind": plan["kind"], "download": d}}, 2)
    gguf = have or download_model(entry, opener)
    if plan["download"]:
        plan["exe"] = str(install_llama(plan["build"], opener))
    key = None
    if plan["kind"] == "ollama":
        ollama_import(plan["exe"], entry["id"], gguf, runner)
    else:
        key = local_key()
    cfg = runtime_config(plan, entry["id"], gguf, pick["tier"])
    try:
        res = live_test(cfg, key)
    except BaseException:
        runtime.stop()
        raise
    note(f"p50 {res['p50']} ms, p95 {res['p95']} ms, {res['valid']} of {res['total']} answers valid")
    passed = res["p95"] is not None and res["p95"] <= P95_LIMIT_MS and res["valid"] == res["total"]
    local_llm = {"tier": pick["tier"], "model": entry["id"], "runtime": plan["kind"], "p50": res["p50"],
                 "p95": res["p95"], "valid": res["valid"], "total": res["total"], "passed": passed,
                 "checked": now_iso()}
    data = read_jev()
    data["scan"] = scan
    data["localLlm"] = local_llm
    if passed:
        data.update(provider="local", adapter="openai_compat", model=cfg["model"], endpoint=cfg["endpoint"],
                    runtime=cfg["runtime"])
        data.pop("keyRef", None)  # the hosted key never goes to the local runtime
        write_jev(data)
        step(f"DONE: Jev runs {entry['id']} locally on {plan['kind']}")
        return result({"ok": True, "provider": "local", "tier": pick["tier"], "model": entry["id"],
                       "runtime": plan["kind"], **{k: res[k] for k in ("p50", "p95", "valid", "total")},
                       "warnings": pick["warnings"]})
    write_jev(data)
    runtime.stop()  # a runtime this run started; one that was already running stays
    smaller = tiers.SMALLER.get(entry["id"])
    if res["p95"] is not None and res["p95"] > P95_LIMIT_MS and smaller:
        note(f"p95 is over {P95_LIMIT_MS} ms, so the next try is the smaller {smaller}")
        return result({"ok": False, "stepDown": smaller, "error": f"too slow; try --model {smaller}",
                       **{k: res[k] for k in ("p50", "p95", "valid", "total")}}, 3)
    why = (f"p95 {res['p95']} ms is over {P95_LIMIT_MS} ms" if res["valid"] == res["total"]
           else f"only {res['valid']} of {res['total']} answers were valid JSON")
    return result({"ok": False, "error": f"the local model did not pass: {why}; use hosted or rules",
                   **{k: res[k] for k in ("p50", "p95", "valid", "total")}}, 3)


# --- Hosted ------------------------------------------------------------------------------

def hosted_endpoint(adapter, endpoint):
    """The checked endpoint ("" for the default Anthropic API). Raises SetupError. Blocked
    hosts (Gemini, Mistral, OpenRouter, Cerebras, GitHub Models) come from providers, so
    setup and the engine refuse the same ones."""
    if adapter == "openai_compat" and not endpoint:
        raise SetupError("openai_compat needs --endpoint, for example https://api.groq.com/openai/v1")
    if not endpoint:
        return ""
    try:
        return providers.check_endpoint(endpoint, hosted=True)
    except ValueError as err:
        raise SetupError(str(err)) from None


def read_key(stream=None):
    """The API key from stdin, hidden when stdin is a terminal."""
    stream = stream or sys.stdin
    try:
        tty = stream.isatty()
    except Exception:
        tty = False
    if tty:
        key = getpass.getpass("Paste the API key and press Enter (it will not show): ")
    else:
        key = stream.readline()
    key = (key or "").strip()
    # A key is printable ASCII. Anything else would end up in an HTTP header error message.
    if key and not all(33 <= ord(c) <= 126 for c in key):
        raise SetupError("that key has spaces or characters a key never has; paste it again")
    return key


def test_call(adapter, model, endpoint, key):
    if adapter == "anthropic":
        provider = providers.AnthropicProvider(model, key, base_url=endpoint or providers.ANTHROPIC_URL)
    else:
        provider = providers.OpenAICompatProvider(endpoint, model, key, name="hosted")
    t0 = time.perf_counter()
    try:
        raw = provider.decide(bench.SAMPLES[0], 15.0)
        decision.parse(raw, source="hosted")
    except Exception as err:
        raise SetupError(f"the test call failed: {err}") from None
    return round((time.perf_counter() - t0) * 1000)


def cmd_hosted(args, stream=None):
    adapter = args.adapter
    model = args.model or HOSTED_DEFAULT_MODEL.get(adapter)
    if not model:
        raise SetupError("--model is required for openai_compat")
    endpoint = hosted_endpoint(adapter, args.endpoint or "")
    step("Reading the API key from the terminal")
    key = read_key(stream)
    if not key:
        raise SetupError("no API key was given")
    step(f"Test call to {adapter} {model}")
    ms = test_call(adapter, model, endpoint, key)
    step("Saving the key in Windows Credential Manager")
    try:
        keys.store_wincred(HOSTED_KEY_TARGET, key)
    except Exception as err:
        raise SetupError(f"the key could not be saved: {type(err).__name__}") from None
    key = None
    ref = "wincred:" + HOSTED_KEY_TARGET
    data = read_jev()
    data["hosted"] = {"adapter": adapter, "model": model, "endpoint": endpoint, "keyRef": ref}
    data.update(provider="hosted", adapter=adapter, model=model, endpoint=endpoint, keyRef=ref)
    write_jev(data)
    step(f"DONE: Jev uses {adapter} {model}")
    return result({"ok": True, "provider": "hosted", "adapter": adapter, "model": model, "endpoint": endpoint,
                   "keyRef": ref, "testMs": ms})


# --- Rules and status --------------------------------------------------------------------

def cmd_rules(args):
    data = read_jev()
    data["provider"] = "rules"
    write_jev(data)
    step("DONE: Jev uses rules only")
    return result({"ok": True, "provider": "rules"})


def redact(value, name=""):
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, name) for v in value]
    if isinstance(value, str) and "key" in name.lower() and value and not value.startswith(("env:", "wincred:")):
        return "[hidden]"
    return value


def cmd_status(args):
    data = read_jev()
    if not data:
        return result({"ok": True, "configured": False, "provider": "rules"})
    out = redact(data)
    if data.get("provider") == "local" and isinstance(data.get("runtime"), dict):
        out["runtimeAnswers"] = runtime.answers(data)
    return result({"ok": True, "configured": True, "jev": out})


def parser():
    p = argparse.ArgumentParser(prog="jev_setup.py", description="Sets up Jev, the Chief's decision model.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan", help="check the machine and pick a tier")
    lo = sub.add_parser("local", help="download, check and test a local model")
    lo.add_argument("--model", required=True)
    lo.add_argument("--runtime", choices=("ollama", "llama_server"))
    lo.add_argument("--yes", action="store_true", help="download the model")
    lo.add_argument("--yes-runtime", action="store_true", help="also download the pinned llama.cpp")
    ho = sub.add_parser("hosted", help="use a hosted model; the key is read from stdin")
    ho.add_argument("--adapter", required=True, choices=("anthropic", "openai_compat"))
    ho.add_argument("--model")
    ho.add_argument("--endpoint")
    sub.add_parser("rules", help="use rules only")
    sub.add_parser("status", help="show jev.json without secrets")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.cmd == "scan":
            return cmd_scan(args)
        if args.cmd == "local":
            return cmd_local(args)
        if args.cmd == "hosted":
            return cmd_hosted(args)
        if args.cmd == "rules":
            return cmd_rules(args)
        return cmd_status(args)
    except SetupError as err:
        return result({"ok": False, "error": str(err)}, 1)


if __name__ == "__main__":
    sys.exit(main())
