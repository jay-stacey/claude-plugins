"""Where things live. Every path can be moved with an environment variable,
so tests never touch the real desktop data or the real runtime home."""
import functools
import json
import os
import re
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
PLUGIN_ROOT = SERVER_DIR.parent
CONSOLE_DIR = PLUGIN_ROOT / "console"
VOICED = SERVER_DIR / "voice" / "voiced.py"


def home() -> Path:
    """HOME in the contract: %USERPROFILE%\\.claude\\chief-of-staff."""
    override = os.environ.get("COS_HOME")
    return Path(override) if override else Path.home() / ".claude" / "chief-of-staff"


def run_dir() -> Path:
    return home() / "run"


def server_json() -> Path:
    return run_dir() / "server.json"


def logs_dir() -> Path:
    return home() / "logs"


def venv_python() -> Path:
    return home() / "venv" / "Scripts" / "python.exe" if os.name == "nt" else home() / "venv" / "bin" / "python"


PACKAGE_RE = re.compile(r"^Claude_[A-Za-z0-9]{1,32}$", re.IGNORECASE)
SESSIONS_DIR = "claude-code-sessions"


def desktop_candidates(env=None, nt=None, home=None) -> list:
    """[(source, folder)] where the desktop app may keep its session files, in tie order.

    The exe install uses %APPDATA%\\Claude. The MSIX install keeps them in its package's
    LocalCache, and newer MSIX builds move them to %LOCALAPPDATA%\\Claude-Data\\claude_<id>
    (the old folder then holds only a .user-data-left marker). Both count as "msix"."""
    env = os.environ if env is None else env
    nt = (os.name == "nt") if nt is None else nt
    home = Path(home) if home else Path.home()
    darwin = sys.platform == "darwin" and not nt
    if darwin:
        return [("appdata", home / "Library" / "Application Support" / "Claude" / SESSIONS_DIR)]
    appdata = env.get("APPDATA") or str(home / "AppData" / "Roaming")
    out = [("appdata", Path(appdata) / "Claude" / SESSIONS_DIR)]
    if nt:
        local = Path(env.get("LOCALAPPDATA") or str(home / "AppData" / "Local"))
        for folder, tail in ((local / "Claude-Data", ()), (local / "Packages", ("LocalCache", "Roaming", "Claude"))):
            try:
                names = sorted(e.name for e in os.scandir(folder) if PACKAGE_RE.match(e.name) and e.is_dir())
            except OSError:
                names = []
            out += [("msix", folder.joinpath(name, *tail, SESSIONS_DIR)) for name in names]
    return out


def _activity(root):
    """The newest mtime of root/<account>/<org>/local_*.json, or None when there is none.
    Stats only; never opens a file."""
    newest = None
    try:
        accounts = [e for e in os.scandir(root) if e.is_dir()]
    except OSError:
        return None
    for acc in accounts:
        try:
            orgs = [e for e in os.scandir(acc.path) if e.is_dir()]
        except OSError:
            continue
        for org in orgs:
            try:
                files = list(os.scandir(org.path))
            except OSError:
                continue
            for f in files:
                if f.name.startswith("local_") and f.name.endswith(".json"):
                    try:
                        mtime = f.stat().st_mtime
                    except OSError:
                        continue
                    if newest is None or mtime > newest:
                        newest = mtime
    return newest


def resolve_desktop_root(env=None, nt=None, home=None):
    """(source, folder): COS_DESKTOP_DIR as "env", else the candidate with the newest
    session file (ties go to the earlier one), else ("none", None)."""
    env = os.environ if env is None else env
    override = env.get("COS_DESKTOP_DIR")
    if override:
        return "env", Path(override)
    best = ("none", None, None)
    for source, folder in desktop_candidates(env, nt, home):
        at = _activity(folder)
        if at is not None and (best[2] is None or at > best[2]):
            best = (source, folder, at)
    return best[0], best[1]


def desktop_root() -> Path:
    """The desktop app's session folder: the resolved one, else %APPDATA%\\Claude\\claude-code-sessions."""
    _, root = resolve_desktop_root()
    return root if root is not None else desktop_candidates()[0][1]


def registry_dir() -> Path:
    """Live sessions register here: ~/.claude/sessions/<pid>.json."""
    override = os.environ.get("COS_SESSIONS_DIR")
    if override:
        return Path(override)
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "sessions"


@functools.lru_cache(maxsize=1)
def plugin_version() -> str:
    try:
        data = json.loads((PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        version = data.get("version")
        return version if isinstance(version, str) and version else "unknown"
    except (OSError, ValueError, AttributeError):
        return "unknown"


def projects_root() -> Path:
    """CLI transcripts: %USERPROFILE%\\.claude\\projects."""
    override = os.environ.get("COS_PROJECTS_DIR")
    if override:
        return Path(override)
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "projects"


def settings_file() -> Path:
    override = os.environ.get("COS_SETTINGS_FILE")
    if override:
        return Path(override)
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "settings.json"
