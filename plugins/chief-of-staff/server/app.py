#!/usr/bin/env python3
"""Chief of Staff app server.

    python app.py start [--port N] [--open]   start detached (or report the running one)
    python app.py status
    python app.py stop
    python app.py restart [--port N] [--open]
    python app.py open                         open the console of the running server
    python app.py serve [--port N]             foreground; the token comes from COS_TOKEN

Binds 127.0.0.1 only. Standard library only. Python 3.10 or later.
Every command prints one JSON line.
"""
import argparse
import html
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cos import APP, paths  # noqa: E402
from cos.voice import rotate  # noqa: E402

DEFAULT_PORT = 47870
START_WAIT_S = 5.0
LOCK_WAIT_S = 10.0
STALE_LOCK_S = 30.0
APP_PY = Path(__file__).resolve()
DETACHED = 0x00000008 | 0x00000200          # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
BREAKAWAY = 0x01000000                      # CREATE_BREAKAWAY_FROM_JOB: outlive the terminal that started it


def read_info():
    try:
        return json.loads(paths.server_json().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def health(port, timeout=1.0):
    """The server's health answer (sent with no token), or None."""
    if not isinstance(port, int):
        return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            body = json.loads(r.read())
        return body if isinstance(body, dict) and body.get("app") == APP else None
    except Exception:
        return None


def healthy(port, timeout=1.0):
    return health(port, timeout) is not None


def open_url(url):
    """Opens the console. The browser gets the path of a small local page that
    forwards to the console, so the token is never on the browser's command
    line; the page sits in HOME\\run beside server.json, which holds the token too."""
    try:
        page = paths.run_dir() / "open.html"
        page.parent.mkdir(parents=True, exist_ok=True)
        safe = html.escape(url, quote=True)
        page.write_text(
            "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">"
            f"<meta http-equiv=\"refresh\" content=\"0; url={safe}\"><title>Chief of Staff</title>"
            "<p>Opening the Chief of Staff console.</p>", encoding="utf-8")
        target = page.resolve().as_uri()
        if os.name == "nt":
            os.startfile(target)
        else:
            import webbrowser
            webbrowser.open(target)
        return True
    except OSError:
        return False


def command_line(pid):
    """The process's command line, or None when it cannot be read."""
    try:
        if os.name == "nt":
            out = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                                  f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine"],
                                 capture_output=True, text=True, timeout=15,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return out.stdout.strip() if out.returncode == 0 else None
        return Path(f"/proc/{int(pid)}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except Exception:
        return None


def is_ours(pid, script=None, word="serve"):
    """True only when pid runs this plugin's own script (full path) with `word`,
    so a reused pid, or another copy's server, is never killed."""
    line = command_line(pid)
    if not line:
        return False
    script = str(script or APP_PY)
    norm = line.replace("\\", "/")
    want = script.replace("\\", "/")
    found = want.lower() in norm.lower() if os.name == "nt" else want in norm
    return found and (not word or f" {word}" in line)


def kill(pid):
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"], capture_output=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.kill(int(pid), 15)
    except Exception:
        pass


def alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH", "/FO", "CSV"],
                                 capture_output=True, text=True, timeout=10,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            return f'"{int(pid)}"' in out
        except Exception:
            return False
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def public(info, already):
    return {"url": info.get("url"), "port": info.get("port"), "pid": info.get("pid"),
            "chiefSessionId": info.get("chiefSessionId"), "already_running": already,
            "version": info.get("version")}


def running_public(info, args):
    """The answer for a server that already runs. It is never restarted here: an older one
    is only reported as stale, and the mod restarts it on an explicit /chief."""
    if args.open:
        open_url(info["url"])
    out = public(info, True)
    version = (health(info.get("port")) or {}).get("version")
    out["version"] = version
    if version != paths.plugin_version():
        out["stale"] = True             # every server up to 0.2.2 sends no version
    return out


class StartLock:
    """An exclusive lock file in HOME\\run, so two starts at once spawn one server.
    A lock older than STALE_LOCK_S is left over from a start that died."""

    def __init__(self):
        self.path = paths.run_dir() / "start.lock"
        self.held = False

    def acquire(self, wait_s=LOCK_WAIT_S):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                self.held = True
                return True
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > STALE_LOCK_S:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    continue
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    def release(self):
        if self.held:
            self.path.unlink(missing_ok=True)
            self.held = False


def running_info():
    info = read_info()
    return info if info and healthy(info.get("port")) else None


def cmd_start(args):
    info = running_info()
    if info:
        return running_public(info, args)
    lock = StartLock()
    if not lock.acquire():
        # Another start holds the lock: answer with the server it started.
        info = running_info()
        if info:
            return running_public(info, args)
        raise SystemExit("Another start is still running. Try again in a few seconds.")
    try:
        info = running_info()       # the start that held the lock may have finished
        if info:
            return running_public(info, args)
        return spawn(args)
    finally:
        lock.release()


def spawn(args, popen=subprocess.Popen, nt=None):
    port = args.port or DEFAULT_PORT
    token = secrets.token_urlsafe(24)
    logs = paths.logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / "server.log"
    rotate(log_path)
    cmd = [sys.executable, str(APP_PY), "serve", "--port", str(port)]
    nt = (os.name == "nt") if nt is None else nt
    env = dict(os.environ, COS_TOKEN=token, PYTHONUNBUFFERED="1")
    with open(log_path, "ab") as log:
        def start(**kwargs):
            return popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, close_fds=True, **kwargs)
        how = "detached"
        if nt:
            try:
                proc = start(creationflags=DETACHED | BREAKAWAY)
                how = "breakaway"
            except OSError as e:
                if getattr(e, "winerror", None) != 5:
                    raise
                # The terminal's job does not allow it: the server then ends with that terminal.
                proc = start(creationflags=DETACHED)
        else:
            proc = start(start_new_session=True)
        log.write((json.dumps({"spawn": how, "pid": proc.pid}) + "\n").encode())
        log.flush()
    deadline = time.monotonic() + START_WAIT_S
    while time.monotonic() < deadline:
        info = read_info()
        if info and info.get("pid") == proc.pid and healthy(info.get("port"), timeout=0.3):
            if args.open:
                open_url(info["url"])
            return public(info, False)
        if proc.poll() is not None:
            raise SystemExit(f"The server stopped while starting. See {log_path}.")
        time.sleep(0.1)
    raise SystemExit(f"The server did not start within 5 seconds. See {log_path}.")


def server_desktop(info):
    """The running server's desktop folder {source, files, root}, or None."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{int(info.get('port'))}/api/sessions",
                                     headers={"X-COS-Token": info.get("token") or ""})
        with urllib.request.urlopen(req, timeout=5) as r:
            desktop = json.loads(r.read()).get("desktop")
        return desktop if isinstance(desktop, dict) else None
    except Exception:
        return None


def local_desktop():
    """The desktop folder as this machine resolves it now, without a server."""
    from cos.sessions import DesktopSource
    source = DesktopSource()
    source.scan()
    return dict(source.info(with_root=True), desktopLocal=True)


def cmd_status(args):
    info = read_info()
    if not info:
        return {"running": False, "version": paths.plugin_version(), "desktop": local_desktop()}
    running = healthy(info.get("port"))
    desktop = server_desktop(info) if running else None
    return {"running": running, "url": info.get("url"), "port": info.get("port"),
            "pid": info.get("pid"), "chiefSessionId": info.get("chiefSessionId"),
            "voicePid": info.get("voicePid"), "startedAt": info.get("startedAt"),
            "version": info.get("version") or paths.plugin_version(),
            "desktop": desktop or local_desktop()}


def cmd_stop(args):
    info = read_info()
    if not info:
        return {"stopped": False, "note": "The server is not running."}
    pid, port = info.get("pid"), info.get("port")
    if healthy(port):
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}", method="POST",
                                         headers={"X-COS-Token": info.get("token") or "",
                                                  "Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=3).read()
        except Exception:
            pass
        for _ in range(50):
            if not healthy(port, timeout=0.3) and not alive(pid):
                break
            time.sleep(0.1)
    if pid and alive(pid):
        if not is_ours(pid):
            return {"stopped": False, "note": f"Process {pid} is still running, and it is not this plugin's "
                                              "server, or its command line could not be read. "
                                              "server.json is kept."}
        kill(pid)
        for _ in range(30):
            if not alive(pid):
                break
            time.sleep(0.1)
        if alive(pid):
            return {"stopped": False, "note": f"The server (process {pid}) did not stop. server.json is kept."}
    voice_pid = info.get("voicePid")
    if voice_pid and alive(voice_pid) and is_ours(voice_pid, script=paths.VOICED, word=""):
        kill(voice_pid)
    paths.server_json().unlink(missing_ok=True)
    return {"stopped": True}


def cmd_open(args):
    info = read_info()
    if not info or not healthy(info.get("port")):
        return {"opened": False, "note": "The server is not running. Run start first."}
    return {"opened": open_url(info["url"]), "port": info.get("port")}


def main(argv=None):
    p = argparse.ArgumentParser(prog="app.py", description="Chief of Staff app server.")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("start", "restart", "serve"):
        sp = sub.add_parser(name)
        sp.add_argument("--port", type=int, default=0)
        if name != "serve":
            sp.add_argument("--open", action="store_true", help="open the console in the browser")
    sub.add_parser("status")
    sub.add_parser("stop")
    sub.add_parser("open")
    args = p.parse_args(argv)
    if args.cmd == "serve":
        token = os.environ.pop("COS_TOKEN", None) or secrets.token_urlsafe(24)
        from cos.server import serve
        return serve(args.port or DEFAULT_PORT, token)
    try:
        if args.cmd == "restart":
            cmd_stop(args)
            out = cmd_start(args)
        else:
            out = {"start": cmd_start, "status": cmd_status, "stop": cmd_stop, "open": cmd_open}[args.cmd](args)
    except SystemExit as e:
        print(json.dumps({"error": str(e)}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
