"""The voice daemon's status as the server reports it, and its process.

The daemon (server/voice/voiced.py) runs in HOME\\venv. It reads server.json
for the port and token itself, so nothing secret is on its command line.
"""
import os
import subprocess
import threading

from . import paths

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
STATES = {"not-installed", "starting", "off", "listening", "hearing", "thinking", "speaking", "error"}
LOG_LIMIT = 5 * 1024 * 1024


def rotate(path, limit=LOG_LIMIT, keep=2):
    """path -> path.1 -> path.2 once it passes `limit` bytes."""
    try:
        if os.path.getsize(path) < limit:
            return
    except OSError:
        return
    for i in range(keep, 0, -1):
        src = f"{path}.{i - 1}" if i > 1 else str(path)
        dst = f"{path}.{i}"
        try:
            if os.path.exists(dst):
                os.remove(dst)
            if os.path.exists(src):
                os.replace(src, dst)
        except OSError:
            pass


class Voice:
    def __init__(self, settings, enabled=True):
        installed = paths.venv_python().exists() and paths.VOICED.exists()
        self.lock = threading.Lock()
        self.proc = None
        self.installed = installed
        self.enabled = enabled
        self.tts = settings.get("voice") if settings.get("voice") in ("chatterbox", "kokoro") else None
        self.status = {
            "state": "starting" if installed else "not-installed",
            "listen": settings.get("listen", "wake"),
            "speak": bool(settings.get("speakReplies", True)),
            "device": None, "stt": None, "tts": None,
            "wakeWord": settings.get("wakeWord") or None,
            "detail": None if installed else "The voice is not set up. Run server/setup.ps1 to install it.",
        }

    def wanted(self):
        return self.status["listen"] != "off" or self.status["speak"]

    def start(self):
        if not (self.installed and self.enabled and self.wanted()):
            if self.installed and not self.wanted():
                self.status["state"] = "off"
            return None
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return self.proc.pid
            log_dir = paths.logs_dir()
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / "voiced.log"
            rotate(log_path)
            env = {k: v for k, v in os.environ.items() if k != "COS_TOKEN"}
            try:
                with open(log_path, "ab") as log:
                    self.proc = subprocess.Popen(
                        [str(paths.venv_python()), str(paths.VOICED)] + (["--tts", self.tts] if self.tts else []),
                        cwd=str(paths.VOICED.parent), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        env=env, close_fds=True, creationflags=NO_WINDOW)
            except OSError as e:
                self.status.update(state="error", detail=f"The voice daemon did not start ({e.__class__.__name__}).")
                return None
            self.status["state"] = "starting"
            return self.proc.pid

    def stop(self, ask_quit=None):
        """Ask the daemon to quit (it releases the mic and the GPU), wait up to
        3 s, then end it. On Windows terminate() kills at once, with no shutdown
        handler, so the quit job comes first."""
        with self.lock:
            proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            if ask_quit:
                try:
                    ask_quit()
                    proc.wait(timeout=3)
                    return
                except Exception:
                    pass
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def pid(self):
        with self.lock:
            return self.proc.pid if self.proc and self.proc.poll() is None else None

    def report(self, status):
        """A status from the daemon. listen and speak stay the server's, since
        the console sets them."""
        if not isinstance(status, dict):
            return self.snapshot()
        with self.lock:
            for key in ("state", "device", "stt", "tts", "wakeWord", "detail"):
                if key in status:
                    value = status[key]
                    if key == "state" and value not in STATES:
                        continue
                    self.status[key] = value
            self.installed = True
        return self.snapshot()

    def control(self, listen=None, speak=None):
        with self.lock:
            if listen in ("wake", "ptt", "off"):
                self.status["listen"] = listen
            if isinstance(speak, bool):
                self.status["speak"] = speak
        return self.snapshot()

    def snapshot(self, busy=False):
        with self.lock:
            out = dict(self.status)
        out["installed"] = self.installed
        if busy and out["state"] in ("listening", "off", "not-installed", "starting"):
            out["state"] = "thinking"
        return out
