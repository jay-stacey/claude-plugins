import builtins
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from helpers import FIXTURES, Sandbox

from cos import paths
from cos.server import App
from cos.sessions import DesktopSource

AAA = "local_aaaa1111-0000-4000-8000-000000000001"
BBB = "local_bbbb2222-0000-4000-8000-000000000002"
REAL_RESOLVE = paths.resolve_desktop_root
FIXTURE_ORG = FIXTURES / "desktop" / "acct-1" / "org-1"


def session_file(root, name, at, acct="acct-1", org="org-1", data=None):
    """Writes root/<acct>/<org>/<name>.json with its mtime set to `at` (seconds)."""
    path = Path(root) / acct / org / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data or {"sessionId": name, "title": name}), encoding="utf-8")
    os.utime(path, (at, at))
    return path


class Tmp(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="cos-paths-"))
        self.home = self.dir / "home"
        self.appdata = self.dir / "Roaming"
        self.local = self.dir / "Local"
        self.env = {"APPDATA": str(self.appdata), "LOCALAPPDATA": str(self.local)}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def appdata_root(self):
        return self.appdata / "Claude" / "claude-code-sessions"

    def msix_root(self, pkg="Claude_pzs8sxrjxfjjc"):
        return self.local / "Packages" / pkg / "LocalCache" / "Roaming" / "Claude" / "claude-code-sessions"

    def data_root(self, name="claude_pzs8sxrjxfjjc"):
        return self.local / "Claude-Data" / name / "claude-code-sessions"

    def resolve(self, **env):
        return REAL_RESOLVE(dict(self.env, **env), nt=True, home=self.home)


class Resolve(Tmp):
    def test_env_override_wins_and_is_not_probed(self):
        with mock.patch.object(paths, "_activity", side_effect=AssertionError("probed")):
            self.assertEqual(self.resolve(COS_DESKTOP_DIR=str(self.dir / "x")), ("env", self.dir / "x"))

    def test_empty_appdata_falls_back_to_the_msix_folder(self):
        self.appdata_root().mkdir(parents=True)          # it exists but holds no session
        session_file(self.msix_root(), "local_a", 1000)
        self.assertEqual(self.resolve(), ("msix", self.msix_root()))

    def test_the_moved_claude_data_folder_is_found(self):
        # Newer MSIX builds move the data out and leave a marker in the package folder.
        marker = self.msix_root().parent / ".user-data-left.claude_pzs8sxrjxfjjc"
        marker.parent.mkdir(parents=True)
        marker.write_text("", encoding="utf-8")
        session_file(self.data_root(), "local_a", 1000)
        self.assertEqual(self.resolve(), ("msix", self.data_root()))

    def test_newer_file_beats_newer_folder(self):
        session_file(self.appdata_root(), "local_old", 1000)
        session_file(self.msix_root(), "local_new", 5000)
        # The old root's folder was touched last, but its files are older.
        os.utime(self.appdata_root() / "acct-1" / "org-1", (9000, 9000))
        os.utime(self.msix_root() / "acct-1" / "org-1", (2000, 2000))
        self.assertEqual(self.resolve(), ("msix", self.msix_root()))

    def test_appdata_with_sessions_wins_a_tie_over_msix(self):
        session_file(self.appdata_root(), "local_a", 1000)
        session_file(self.msix_root(), "local_b", 1000)
        self.assertEqual(self.resolve(), ("appdata", self.appdata_root()))

    def test_newest_of_two_msix_packages_wins(self):
        session_file(self.msix_root("Claude_aaaa"), "local_a", 1000)
        session_file(self.msix_root("Claude_bbbb"), "local_b", 3000)
        self.assertEqual(self.resolve(), ("msix", self.msix_root("Claude_bbbb")))

    def test_package_names_are_filtered(self):
        for name in ("Claude_ok1", "Claude_", "ClaudeX_bad", "Claude_bad name", "Claude_" + "x" * 33, "Other_1"):
            (self.local / "Packages" / name).mkdir(parents=True)
        (self.local / "Packages" / "Claude_file").write_text("", encoding="utf-8")
        got = paths.desktop_candidates(self.env, nt=True, home=self.home)
        self.assertEqual(got, [("appdata", self.appdata_root()), ("msix", self.msix_root("Claude_ok1"))])
        # Not on Windows: no package folders are looked for.
        self.assertEqual(paths.desktop_candidates(self.env, nt=False, home=self.home)[1:], [])

    def test_no_candidate_gives_none_and_an_empty_scan(self):
        self.assertEqual(self.resolve(), ("none", None))
        with mock.patch.object(paths, "resolve_desktop_root", return_value=("none", None)):
            src = DesktopSource()
            self.assertEqual(src.scan(), {})
            self.assertEqual(src.info(), {"source": "none", "files": 0})
            self.assertEqual(src.info(with_root=True), {"source": "none", "files": 0, "root": None})

    def test_registry_dir_follows_overrides(self):
        with mock.patch.dict(os.environ, {"COS_SESSIONS_DIR": str(self.dir / "reg")}):
            self.assertEqual(paths.registry_dir(), self.dir / "reg")
        env = {k: v for k, v in os.environ.items() if k != "COS_SESSIONS_DIR"}
        env["CLAUDE_CONFIG_DIR"] = str(self.dir / "cfg")
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(paths.registry_dir(), self.dir / "cfg" / "sessions")

    def test_plugin_version_reads_the_manifest(self):
        manifest = json.loads((paths.PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(paths.plugin_version(), manifest["version"])
        paths.plugin_version.cache_clear()
        try:
            with mock.patch.object(paths, "PLUGIN_ROOT", self.dir):
                self.assertEqual(paths.plugin_version(), "unknown")
        finally:
            paths.plugin_version.cache_clear()


class Source(Tmp):
    def source(self):
        clock = [100.0]
        src = DesktopSource(clock=lambda: clock[0])
        return src, clock

    def test_none_is_resolved_again_on_the_next_scan(self):
        src, clock = self.source()
        with mock.patch.object(paths, "resolve_desktop_root", side_effect=lambda: self.resolve()):
            self.assertEqual(src.scan(), {})
            self.assertEqual(src.info()["source"], "none")
            session_file(self.msix_root(), AAA, 1000, data={"sessionId": AAA, "title": "A"})
            clock[0] += 10                              # the next 10 s scan, not a minute later
            self.assertIn(AAA, src.scan())
            self.assertEqual(src.info(), {"source": "msix", "files": 1})

    def test_desktop_source_rescans_after_the_root_changes(self):
        src, clock = self.source()
        session_file(self.msix_root(), AAA, 1000, data={"sessionId": AAA, "title": "A"})
        with mock.patch.object(paths, "resolve_desktop_root", side_effect=lambda: self.resolve()):
            self.assertEqual(set(src.scan()), {AAA})
            session_file(self.appdata_root(), BBB, 9000, data={"sessionId": BBB, "title": "B"})
            clock[0] += 30
            self.assertEqual(set(src.scan()), {AAA})    # held for a minute
            clock[0] += 31
            self.assertEqual(set(src.scan()), {BBB})
            self.assertEqual(src.info(with_root=True), {"source": "appdata", "files": 1,
                                                        "root": str(self.appdata_root())})

    def test_archived_files_in_the_idx_are_not_opened(self):
        root = self.dir / "desk"
        org = root / "acct-1" / "org-1"
        shutil.copytree(FIXTURE_ORG, org)
        idx = org / "archived-sessions.idx"
        idx.write_text(json.dumps({"v": 1, "archived": [AAA, "../bad", 7]}), encoding="utf-8")
        opened = []
        real_open = builtins.open

        def spy(file, *a, **kw):
            opened.append(Path(str(file)).name)
            return real_open(file, *a, **kw)

        src = DesktopSource(root)
        with mock.patch("builtins.open", spy):
            got = src.scan()
        self.assertNotIn(AAA, got)
        self.assertIn(BBB, got)
        self.assertNotIn(f"{AAA}.json", opened)
        self.assertIn(f"{BBB}.json", opened)
        # A bad idx means nothing is skipped.
        idx.write_text("{ not json", encoding="utf-8")
        os.utime(idx, (5, 5))
        self.assertIn(AAA, src.scan())
        # Unarchived: the id leaves the idx, and the next scan parses the file.
        idx.write_text(json.dumps({"v": 1, "archived": [AAA]}), encoding="utf-8")
        os.utime(idx, (6, 6))
        self.assertNotIn(AAA, src.scan())
        idx.write_text(json.dumps({"v": 1, "archived": []}), encoding="utf-8")
        os.utime(idx, (7, 7))
        opened.clear()
        with mock.patch("builtins.open", spy):
            self.assertIn(AAA, src.scan())
        self.assertIn(f"{AAA}.json", opened)
        self.assertNotIn(f"{BBB}.json", opened)          # unchanged files stay cached

    def test_a_root_switch_to_the_same_files_parses_nothing_again(self):
        real = self.dir / "real"
        shutil.copytree(FIXTURE_ORG, real / "acct-1" / "org-1")
        link = self.dir / "link"
        try:
            if os.name == "nt":
                import _winapi
                _winapi.CreateJunction(str(real), str(link))
            else:
                os.symlink(real, link, target_is_directory=True)
        except (OSError, ImportError, AttributeError):
            self.skipTest("this OS cannot make a folder link here")
        src = DesktopSource(real)
        first = src.scan()
        src.root = link
        opened = []
        real_open = builtins.open

        def spy(file, *a, **kw):
            opened.append(str(file))
            return real_open(file, *a, **kw)

        with mock.patch("builtins.open", spy):
            again = src.scan()
        self.assertEqual(set(first), set(again))
        self.assertEqual([p for p in opened if p.endswith(".json")], [])


class Hello(unittest.TestCase):
    def test_hello_never_waits_for_a_full_scan(self):
        with Sandbox():
            app = App("tok", 1, voice_enabled=False, write_state=False)
            app.reader.refresh_files()
            app.reader.files_at = 0                     # long ago, so a miss may read again
            with app.reader.files_lock:                 # the 10 s loop is mid-scan
                done = {}
                t = threading.Thread(target=lambda: done.update(out=app.mod_hello({"cliId": "cli-term"})))
                start = time.monotonic()
                t.start()
                t.join(5)
                self.assertLess(time.monotonic() - start, 2)
            self.assertIsNone(done["out"]["sessionId"])
            self.assertEqual(app.chief["cliId"], "cli-term")


if __name__ == "__main__":
    unittest.main()
