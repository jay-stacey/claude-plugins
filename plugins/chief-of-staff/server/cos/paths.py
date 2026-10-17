"""Where things live. Every path can be moved with an environment variable,
so tests never touch the real desktop data or the real runtime home."""
import os
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


def desktop_root() -> Path:
    """The desktop app's session files: %APPDATA%\\Claude\\claude-code-sessions."""
    override = os.environ.get("COS_DESKTOP_DIR")
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "Claude" / "claude-code-sessions"


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
