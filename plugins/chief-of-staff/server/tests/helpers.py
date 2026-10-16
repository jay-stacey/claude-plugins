"""Test helpers: a private copy of the fixtures with times moved to now, and
environment variables that keep every test away from the real desktop data."""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))

FIXTURES = HERE / "fixtures"
FIXTURE_NOW = 1792160000000
TIME_KEYS = ("createdAt", "lastActivityAt", "startedAt")


def shift(value, delta):
    if isinstance(value, dict):
        return {k: (v + delta if k in TIME_KEYS and isinstance(v, int) else shift(v, delta)) for k, v in value.items()}
    if isinstance(value, list):
        return [shift(v, delta) for v in value]
    return value


class Sandbox:
    """A temp folder holding desktop/, projects/, home/ and agents.json, and the
    COS_* variables pointing at it. Use as a context manager."""

    def __init__(self, now_ms=None):
        self.now = now_ms or int(time.time() * 1000)
        self.delta = self.now - FIXTURE_NOW
        self.saved_env = {}

    def __enter__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cos-test-"))
        shutil.copytree(FIXTURES / "projects", self.dir / "projects")
        for src in (FIXTURES / "desktop").rglob("*"):
            dst = self.dir / "desktop" / src.relative_to(FIXTURES / "desktop")
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                data = json.loads(src.read_text(encoding="utf-8"))
                dst.write_text(json.dumps(shift(data, self.delta)), encoding="utf-8")
            except ValueError:
                shutil.copy(src, dst)
        self.agents_rows = shift(json.loads((FIXTURES / "agents.json").read_text(encoding="utf-8")), self.delta)
        self.write_agents(self.agents_rows)
        (self.dir / "home").mkdir()
        self.env(COS_HOME=str(self.dir / "home"), COS_DESKTOP_DIR=str(self.dir / "desktop"),
                 COS_PROJECTS_DIR=str(self.dir / "projects"), COS_SETTINGS_FILE=str(self.dir / "settings.json"),
                 COS_CLAUDE_CMD=json.dumps([sys.executable, str(HERE / "fake_agents.py"), str(self.dir / "agents.json")]))
        return self

    def write_agents(self, rows):
        (self.dir / "agents.json").write_text(json.dumps(rows), encoding="utf-8")

    def env(self, **values):
        for k, v in values.items():
            self.saved_env.setdefault(k, os.environ.get(k))
            os.environ[k] = v

    def __exit__(self, *exc):
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.dir, ignore_errors=True)
        return False


def snapshot_tree(root):
    """{relative path: (size, mtime_ns, bytes)} so a test can prove nothing changed."""
    out = {}
    for p in Path(root).rglob("*"):
        if p.is_file():
            st = p.stat()
            out[str(p.relative_to(root))] = (st.st_size, st.st_mtime_ns, p.read_bytes())
    return out
