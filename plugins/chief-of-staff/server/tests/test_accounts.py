import datetime as dt
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import FIXTURE_NOW, FIXTURES

from cos import config
from cos.notices import Notices
from cos.sessions import DesktopSource, build_sessions

ACC_NOW = "11111111-aaaa-4aaa-8aaa-111111111111"
ACC_OLD = "22222222-bbbb-4bbb-8bbb-222222222222"
ORG = "33333333-cccc-4ccc-8ccc-333333333333"
MINE = "local_aaaa0000-0000-4000-8000-0000000000a1"
THEIRS = "local_bbbb0000-0000-4000-8000-0000000000b2"
OLD_MS = FIXTURE_NOW - 2 * 24 * 3_600_000


def write_session(root, account, sid, title):
    folder = root / "claude-code-sessions" / account / ORG
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sid}.json").write_text(json.dumps({
        "sessionId": sid, "cliSessionId": "cli-" + sid[-4:], "title": title, "createdAt": OLD_MS,
        "lastActivityAt": OLD_MS, "isArchived": False}), encoding="utf-8")


class TwoAccounts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cos-accounts-"))
        write_session(self.tmp, ACC_NOW, MINE, "Mine")
        write_session(self.tmp, ACC_OLD, THEIRS, "Theirs")
        self.root = self.tmp / "claude-code-sessions"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sign_in(self, uuid):
        (self.tmp / "config.json").write_text(json.dumps({"lastKnownAccountUuid": uuid}), encoding="utf-8")

    def sessions(self, caps=None):
        desktop = DesktopSource(self.root).scan()
        built = build_sessions(desktop, [], config.defaults(), FIXTURE_NOW, None, {}, {}, caps=caps)
        return {s["id"]: s for s in built}

    def test_other_account_is_labelled_and_cannot_be_archived(self):
        self.sign_in(ACC_NOW)
        for caps in (None, {"desktopSessions": True}, {"desktopSessions": False}):
            s = self.sessions(caps)
            self.assertTrue(s[THEIRS]["otherAccount"])
            self.assertEqual(s[THEIRS]["actions"]["archive"], "no")
            self.assertIn("another Claude account", s[THEIRS]["actionNotes"]["archive"])

    def test_current_account_is_unchanged(self):
        self.sign_in(ACC_NOW)
        s = self.sessions({"desktopSessions": True})
        self.assertFalse(s[MINE]["otherAccount"])
        self.assertEqual(s[MINE]["actions"]["archive"], "yes")
        self.assertNotIn("archive", s[MINE]["actionNotes"])

    def test_account_match_ignores_case(self):
        self.sign_in(ACC_NOW.upper())
        self.assertTrue(self.sessions()[THEIRS]["otherAccount"])
        self.assertFalse(self.sessions()[MINE]["otherAccount"])

    def test_undetermined_account_changes_nothing(self):
        # no config.json, a bad one, no key, and an id that matches no folder
        for write in (None, "not json", json.dumps({}), json.dumps({"lastKnownAccountUuid": "44444444-dddd"})):
            cfg = self.tmp / "config.json"
            if cfg.exists():
                cfg.unlink()
            if write is not None:
                cfg.write_text(write, encoding="utf-8")
            s = self.sessions({"desktopSessions": True})
            for sid in (MINE, THEIRS):
                self.assertFalse(s[sid]["otherAccount"], write)
                self.assertEqual(s[sid]["actions"]["archive"], "yes", write)

    def test_one_account_folder_is_always_current(self):
        shutil.rmtree(self.root / ACC_OLD)
        self.sign_in(ACC_OLD)
        s = self.sessions({"desktopSessions": True})
        self.assertFalse(s[MINE]["otherAccount"])

    def test_stale_notice_leaves_out_other_account_sessions(self):
        self.sign_in(ACC_NOW)
        s = self.sessions({"desktopSessions": True})
        self.assertEqual({x["state"] for x in s.values()}, {"stale"})
        digest = Notices().stale_digest(list(s.values()), dt.datetime(2026, 10, 16, 9, 5))
        self.assertIn(MINE, digest["_prompt"])
        self.assertNotIn(THEIRS, digest["_prompt"])
        self.assertNotIn("Theirs", digest["text"])
        self.assertTrue(digest["text"].startswith("1 session looks stale"))

    def test_stale_notice_is_silent_when_only_other_account_sessions_are_stale(self):
        self.sign_in(ACC_NOW)
        s = self.sessions({"desktopSessions": True})
        del s[MINE]
        self.assertIsNone(Notices().stale_digest(list(s.values()), dt.datetime(2026, 10, 16, 9, 5)))

    def test_fixture_folder_has_one_account_and_no_label(self):
        desktop = DesktopSource(FIXTURES / "desktop").scan()
        self.assertFalse(any(r.get("otherAccount") for r in desktop.values()))


if __name__ == "__main__":
    unittest.main()
