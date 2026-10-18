import json
import sys
import unittest

from helpers import FIXTURE_NOW, FIXTURES, Sandbox, snapshot_tree

from cos import config
from cos.sessions import (AgentsSource, DesktopSource, SessionReader, TranscriptIndex, build_sessions,
                          classify, counts_of)

AAA = "local_aaaa1111-0000-4000-8000-000000000001"
BBB = "local_bbbb2222-0000-4000-8000-000000000002"
CCC = "local_cccc3333-0000-4000-8000-000000000003"
DDD = "local_dddd4444-0000-4000-8000-000000000004"
EEE = "local_eeee5555-0000-4000-8000-000000000005"
FFF = "local_ffff6666-0000-4000-8000-000000000006"
CHIEF = "local_9999aaaa-0000-4000-8000-000000000007"
NOID = "local_noid0000-0000-4000-8000-000000000009"
H = 3_600_000


def fixture_sessions(now=FIXTURE_NOW, chief=None, grew=None, settings=None):
    desktop = DesktopSource(FIXTURES / "desktop").scan()
    rows = json.loads((FIXTURES / "agents.json").read_text(encoding="utf-8"))
    return {s["id"]: s for s in build_sessions(desktop, rows, settings or config.defaults(), now, chief,
                                                {}, grew or {})}


class StateRules(unittest.TestCase):
    def test_states_follow_the_contract(self):
        s = fixture_sessions()
        self.assertEqual(s[AAA]["state"], "active")                  # live and busy
        self.assertEqual(s[AAA]["stateReason"], "Working now")
        self.assertEqual(s[EEE]["state"], "you")                     # live and waiting
        self.assertEqual(s[EEE]["stateReason"], "Waiting for a permission prompt")
        self.assertEqual(s[BBB]["state"], "you")                     # needs_action, not busy
        self.assertTrue(s[BBB]["stateReason"].startswith("Needs your decision: Jay's decision"))
        self.assertEqual(s[CCC]["state"], "stale")                   # merged PR, not live
        self.assertEqual(s[CCC]["stateReason"], "PR 1608 merged")
        self.assertEqual(s[FFF]["state"], "stale")                   # 100 hours idle
        self.assertEqual(s[FFF]["stateReason"], "No activity for 4 days")
        self.assertEqual(s[CHIEF]["state"], "wait")
        self.assertEqual(s["bg_bg-blocked"]["state"], "you")
        self.assertEqual(s["bg_bg-working"]["state"], "active")

    def test_archived_and_bad_files_are_left_out_without_a_crash(self):
        s = fixture_sessions()
        self.assertNotIn(DDD, s)
        self.assertNotIn("local_bad00000-0000-4000-8000-000000000008", s)
        self.assertEqual(s[NOID]["title"], "Untitled session")
        self.assertIsNone(s[NOID]["createdAt"])

    def test_fields_are_shaped(self):
        a = fixture_sessions()[AAA]
        self.assertEqual(a["cliId"], "cli-busy")
        self.assertEqual(a["repo"], "dp-web-ui")
        self.assertEqual((a["prNumber"], a["prState"]), (1216, "OPEN"))
        self.assertEqual(a["summary"], "Fixed the inventory form; see PR.")
        self.assertEqual(a["link"], f"claude://claude.ai/epitaxy/{AAA}")
        self.assertEqual(a["childIds"], [EEE])
        self.assertTrue(a["live"])
        self.assertEqual(a["liveStatus"], "busy")
        b = fixture_sessions()[BBB]
        self.assertEqual(b["appStatus"], "blocked")
        self.assertEqual(b["needsAction"], "Jay's decision: do the vendor code switch")
        self.assertFalse(b["live"])
        self.assertIsNone(b["liveStatus"])
        self.assertEqual(fixture_sessions()[FFF]["summary"], "Wrote the draft Done.")
        self.assertEqual(fixture_sessions()[EEE]["parentId"], AAA)
        bg = fixture_sessions()["bg_bg-blocked"]
        self.assertEqual((bg["kind"], bg["liveStatus"], bg["link"]), ("background", "waiting", None))

    def test_in_view_covers_live_recent_and_family(self):
        s = fixture_sessions()
        self.assertTrue(s[AAA]["inView"])
        self.assertTrue(s[BBB]["inView"])
        self.assertFalse(s[FFF]["inView"])
        # A child keeps its old parent in view.
        later = fixture_sessions(now=FIXTURE_NOW + 4 * 24 * H)
        self.assertTrue(later[AAA]["inView"])          # live
        self.assertFalse(later[BBB]["inView"])

    def test_transcript_growth_makes_a_session_active_for_30_seconds(self):
        s = fixture_sessions(grew={"cli-needs": FIXTURE_NOW - 10_000})
        self.assertEqual(s[BBB]["state"], "you")       # "you" wins over growth
        s = fixture_sessions(grew={"cli-wait": FIXTURE_NOW - 10_000})
        self.assertEqual(s[CHIEF]["state"], "active")
        s = fixture_sessions(grew={"cli-wait": FIXTURE_NOW - 40_000})
        self.assertEqual(s[CHIEF]["state"], "wait")

    def test_chief_is_marked_and_not_counted(self):
        sessions = list(fixture_sessions(chief=CHIEF).values())
        chief = next(x for x in sessions if x["id"] == CHIEF)
        self.assertTrue(chief["isChief"])
        counts = counts_of(sessions)
        self.assertEqual(sum(counts.values()), len(sessions) - 1)

    def test_chief_is_marked_by_its_cli_id_before_its_desktop_id_is_known(self):
        desktop = DesktopSource(FIXTURES / "desktop").scan()
        rows = json.loads((FIXTURES / "agents.json").read_text(encoding="utf-8"))
        sessions = build_sessions(desktop, rows, config.defaults(), FIXTURE_NOW, None, chief_cli="cli-wait")
        self.assertEqual([s["id"] for s in sessions if s["isChief"]], [CHIEF])
        self.assertEqual(sum(counts_of(sessions).values()), len(sessions) - 1)

    def test_stale_hours_setting_is_used(self):
        settings = dict(config.defaults(), staleHours=1)
        self.assertEqual(fixture_sessions(settings=settings)[EEE]["state"], "you")
        self.assertEqual(fixture_sessions(settings=settings)[CHIEF]["state"], "wait")
        settings = dict(config.defaults(), staleHours=0.1)
        self.assertEqual(fixture_sessions(settings=settings)[CHIEF]["state"], "stale")

    def test_a_stopped_session_with_a_merged_pr_or_old_age_is_stale_even_with_an_old_note(self):
        base = {"live": False, "liveStatus": None, "kind": "interactive", "lastActivityAt": FIXTURE_NOW - H,
                "needsAction": "Pick a vendor", "appStatus": "blocked"}
        self.assertEqual(classify(dict(base, prState="MERGED", prNumber=12), FIXTURE_NOW, 24),
                         ("stale", "PR 12 merged"))
        self.assertEqual(classify(dict(base, lastActivityAt=FIXTURE_NOW - 72 * H), FIXTURE_NOW, 24),
                         ("stale", "No activity for 3 days"))
        self.assertEqual(classify(base, FIXTURE_NOW, 24)[0], "you")
        # Live sessions keep the app's note, and a live prompt always wins.
        live_idle = dict(base, live=True, liveStatus="idle", lastActivityAt=FIXTURE_NOW - 72 * H, prState="MERGED")
        self.assertEqual(classify(live_idle, FIXTURE_NOW, 24)[0], "you")
        waiting = dict(live_idle, liveStatus="waiting", waitingFor="permission prompt", needsAction=None)
        self.assertEqual(classify(waiting, FIXTURE_NOW, 24), ("you", "Waiting for a permission prompt"))
        blocked_bg = dict(base, kind="background", live=True, liveStatus="waiting", _bgState="blocked",
                          lastActivityAt=FIXTURE_NOW - 72 * H)
        self.assertEqual(classify(blocked_bg, FIXTURE_NOW, 24)[0], "you")

    def test_titles_lose_control_characters(self):
        from cos.sessions import _text
        self.assertEqual(_text("DP1\u0007-676‮ x\n"), "DP1-676 x")
        self.assertIsNone(_text("​"))

    def test_classify_review_ready_and_finished(self):
        base = {"live": False, "liveStatus": None, "kind": "interactive", "lastActivityAt": FIXTURE_NOW}
        self.assertEqual(classify(dict(base, appStatus="review_ready"), FIXTURE_NOW, 24)[0], "you")
        self.assertEqual(classify(dict(base, appStatus="completed"), FIXTURE_NOW, 24),
                         ("wait", "Idle, finished its last turn"))
        busy = dict(base, live=True, liveStatus="busy", needsAction="x")
        self.assertEqual(classify(busy, FIXTURE_NOW, 24)[0], "active")


class Reasons(unittest.TestCase):
    def test_waiting_reasons_read_naturally(self):
        from cos.sessions import waiting_reason
        self.assertEqual(waiting_reason("permission prompt"), "Waiting for a permission prompt")
        self.assertEqual(waiting_reason("input needed"), "Waiting for your input")
        self.assertEqual(waiting_reason(None), "Waiting for your input")
        self.assertEqual(waiting_reason("answer"), "Waiting for your answer")
        self.assertEqual(waiting_reason("elicitation"), "Waiting for an elicitation")


class Reader(unittest.TestCase):
    def test_reader_reads_files_and_never_writes_them(self):
        with Sandbox() as box:
            before = snapshot_tree(box.dir / "desktop")
            before_t = snapshot_tree(box.dir / "projects")
            reader = SessionReader(AgentsSource(), DesktopSource(), TranscriptIndex())
            reader.refresh_files()
            reader.refresh_live()
            sessions = {s["id"]: s for s in reader.build(config.defaults())}
            self.assertEqual(sessions[AAA]["state"], "active")
            self.assertFalse(reader.snapshot()["liveStale"])
            self.assertEqual(reader.local_id_for("cli-needs"), BBB)
            self.assertIsNone(reader.local_id_for("nope"))
            self.assertTrue(reader.transcript_path("cli-busy").endswith("cli-busy.jsonl"))
            self.assertEqual(before, snapshot_tree(box.dir / "desktop"))
            self.assertEqual(before_t, snapshot_tree(box.dir / "projects"))

    def test_failed_agents_call_keeps_the_last_rows(self):
        with Sandbox() as box:
            agents = AgentsSource()
            self.assertEqual(len(agents.poll()), 5)
            (box.dir / "agents.json").write_text("FAIL", encoding="utf-8")
            self.assertEqual(len(agents.poll()), 5)
            self.assertTrue(agents.stale)

    def test_desktop_files_are_parsed_again_only_when_changed(self):
        with Sandbox() as box:
            src = DesktopSource()
            first = src.scan()
            cached = dict(src.cache)
            src.scan()
            self.assertEqual({k: v[:2] for k, v in cached.items()}, {k: v[:2] for k, v in src.cache.items()})
            self.assertIs(next(iter(cached.values()))[2], src.cache[next(iter(cached))][2])
            self.assertIn(AAA, first)


if __name__ == "__main__":
    unittest.main()
