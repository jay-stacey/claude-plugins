import builtins
import json
import sys
import unittest
from unittest import mock

from helpers import FIXTURE_NOW, FIXTURES, Sandbox, snapshot_tree

from cos import config
from cos.sessions import (AgentsSource, DesktopSource, RegistrySource, SessionReader, TranscriptIndex,
                          build_sessions, classify, counts_of)

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
        self.assertEqual((bg["kind"], bg["liveStatus"], bg["link"], bg["bgId"]), ("bg", "waiting", None, "c8d8"))

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


DESKTOP_CHIEF = {"desktopSessions": True, "desktopStart": True}
TERMINAL_CHIEF = {"desktopSessions": False, "sendMessage": True, "listAgents": True, "cliStop": True}
TERM_ROWS = [
    {"pid": 5, "cwd": "C:\\work", "kind": "interactive", "startedAt": FIXTURE_NOW - H, "sessionId": "cli-term",
     "name": "Terminal work", "status": "idle"},
    {"pid": 6, "cwd": "C:\\work", "kind": "interactive", "startedAt": FIXTURE_NOW - H, "sessionId": "cli-bare",
     "name": "Bare run", "status": "idle"},
    {"id": "d0ne", "cwd": "C:\\work", "kind": "background", "startedAt": FIXTURE_NOW - H, "sessionId": "bg-done",
     "name": "finished job", "state": "done"},
]
TERM_REG = {
    "cli-busy": {"sessionId": "cli-busy", "entrypoint": "cli", "hasInbox": True},
    "cli-term": {"sessionId": "cli-term", "entrypoint": "cli", "hasInbox": True},
    "cli-bare": {"sessionId": "cli-bare", "entrypoint": "cli", "hasInbox": False},
    "bg-working": {"sessionId": "bg-working", "entrypoint": "cli", "hasInbox": True},
    "bg-done": {"sessionId": "bg-done", "entrypoint": "cli", "hasInbox": True},
}


def acting(caps, chief=CHIEF, rows_extra=TERM_ROWS, registry=TERM_REG):
    desktop = DesktopSource(FIXTURES / "desktop").scan()
    rows = json.loads((FIXTURES / "agents.json").read_text(encoding="utf-8")) + list(rows_extra)
    return {s["id"]: s for s in build_sessions(desktop, rows, config.defaults(), FIXTURE_NOW, chief, {}, {},
                                                registry=registry, caps=caps)}


def cell(s, key):
    return s["actions"][key], s["actionNotes"].get(key)


class Actions(unittest.TestCase):
    def test_kind_and_bg_id(self):
        s = acting(DESKTOP_CHIEF)
        self.assertEqual((s[AAA]["kind"], s[AAA]["bgId"]), ("desktop", None))
        self.assertEqual((s["cli_cli-term"]["kind"], s["cli_cli-term"]["bgId"]), ("cli", None))
        self.assertEqual((s["bg_bg-working"]["kind"], s["bg_bg-working"]["bgId"]), ("bg", "0d10"))
        for sess in s.values():
            self.assertFalse({"_live_kind", "_inbox", "_desktopHost", "_bgState"} & set(sess))
        # classify still tells a live prompt from a background job's state.
        self.assertEqual(s[EEE]["state"], "you")
        self.assertEqual(s["bg_bg-blocked"]["stateReason"], "Background job is blocked")

    def test_a_real_background_row_gives_the_full_uuid_as_cli_id_and_the_short_id_as_bg_id(self):
        # The shape `claude agents --json` (2.1.302) prints for a background session.
        uuid = "5f3c2a10-8b7d-4e21-9c0a-1d2e3f405162"
        row = {"pid": 4321, "id": "d8d55fa2", "cwd": "C:\\work", "kind": "background", "startedAt": FIXTURE_NOW,
               "sessionId": uuid, "name": "nightly import 2", "status": "busy", "state": "working"}
        reg = {uuid: {"sessionId": uuid, "entrypoint": "cli", "hasInbox": True}}
        s = acting(TERMINAL_CHIEF, rows_extra=[row], registry=reg)[f"bg_{uuid}"]
        self.assertEqual((s["kind"], s["cliId"], s["bgId"], s["title"]), ("bg", uuid, "d8d55fa2", "nightly import 2"))
        self.assertEqual((s["live"], s["liveStatus"]), (True, "busy"))
        self.assertEqual(s["actions"]["stop"], "yes")
        self.assertEqual(s["actions"]["reply"], "yes")
        # After `claude stop` the row leaves the list: the session is gone, so nothing more is offered.
        self.assertNotIn(f"bg_{uuid}", acting(TERMINAL_CHIEF, rows_extra=[], registry=reg))

    def test_bad_bg_id_is_dropped(self):
        for bad in ("--all", "-h", "../x", "a" * 65, ""):
            row = {"id": bad, "kind": "background", "sessionId": "bg-odd", "state": "working",
                   "startedAt": FIXTURE_NOW}
            s = acting(TERMINAL_CHIEF, rows_extra=[row])
            self.assertIsNone(s["bg_bg-odd"]["bgId"], bad)
            self.assertEqual(cell(s["bg_bg-odd"], "stop"),
                             ("no", "Its background id is missing, so it cannot be stopped."))

    def test_actions_with_a_desktop_chief(self):
        s = acting(DESKTOP_CHIEF)
        self.assertEqual(s[AAA]["actions"], {"reply": "yes", "archive": "yes", "stop": "no", "open": "yes"})
        self.assertEqual(s[AAA]["actionNotes"], {"stop": "Only background sessions can be stopped."})
        self.assertEqual(cell(s[BBB], "reply"), ("yes", None))          # not live: the desktop tool reaches it

    def test_actions_with_a_terminal_chief(self):
        s = acting(TERMINAL_CHIEF)
        self.assertEqual(cell(s["bg_bg-working"], "archive"), ("no", "Use Stop for a background session."))
        self.assertEqual(cell(s[AAA], "archive"),
                         ("app", "Archive it in the Claude app. A Chief in a terminal cannot archive desktop sessions."))
        self.assertEqual(cell(s[AAA], "reply"), ("yes", None))          # live, with an inbox
        self.assertEqual(cell(s[BBB], "reply"),
                         ("app", "Reply in the Claude app. A Chief in a terminal cannot reach this session."))
        self.assertEqual(cell(s[AAA], "open"), ("yes", None))
        self.assertEqual(cell(s["cli_cli-term"], "archive"),
                         ("no", "Close it in its own terminal window. The Chief does not end terminal sessions."))
        self.assertEqual(cell(s["cli_cli-term"], "open"), ("no", "Only desktop sessions open in the Claude app."))

    def test_no_chief(self):
        s = acting(None)
        self.assertEqual(cell(s[AAA], "open"), ("yes", None))
        self.assertEqual(cell(s[AAA], "archive"), ("app", "No Chief is connected. You can archive it in the Claude app."))
        self.assertEqual(cell(s[AAA], "reply"), ("app", "No Chief is connected. You can reply in the Claude app."))
        no_chief = "No Chief is connected. Type /chief in a Claude Code session first."
        self.assertEqual(set(s["cli_cli-term"]["actions"].values()), {"no"})
        self.assertEqual(cell(s["cli_cli-term"], "reply"), ("no", no_chief))
        self.assertEqual(set(s["bg_bg-working"]["actions"].values()), {"no"})
        self.assertEqual(cell(s["bg_bg-working"], "stop"), ("no", no_chief))

    def test_chief_session_has_no_actions(self):
        for caps in (DESKTOP_CHIEF, TERMINAL_CHIEF, None):
            chief = acting(caps)[CHIEF]
            self.assertEqual(chief["actions"], {"reply": "no", "archive": "no", "stop": "no", "open": "no"})
            self.assertEqual(set(chief["actionNotes"].values()), {"This is the Chief of Staff session."})

    def test_every_non_yes_action_has_a_note(self):
        for caps in (DESKTOP_CHIEF, TERMINAL_CHIEF, None):
            for s in acting(caps).values():
                self.assertEqual(set(s["actions"]), {"reply", "archive", "stop", "open"})
                for key, value in s["actions"].items():
                    self.assertIn(value, ("yes", "app", "no"))
                    if value == "yes":
                        self.assertNotIn(key, s["actionNotes"])
                    else:
                        self.assertTrue(s["actionNotes"].get(key), (s["id"], key))

    def test_desktop_entrypoint_on_a_cli_row_changes_only_the_archive_note(self):
        reg = dict(TERM_REG, **{"cli-term": {"sessionId": "cli-term", "entrypoint": "claude-desktop", "hasInbox": True}})
        plain, desk = acting(TERMINAL_CHIEF)["cli_cli-term"], acting(TERMINAL_CHIEF, registry=reg)["cli_cli-term"]
        self.assertEqual(desk["kind"], "cli")
        self.assertEqual(desk["actions"], plain["actions"])
        self.assertEqual(cell(desk, "archive"), ("no", "Archive it in the Claude app."))
        self.assertEqual({k: v for k, v in desk["actionNotes"].items() if k != "archive"},
                         {k: v for k, v in plain["actionNotes"].items() if k != "archive"})

    def test_registry_row_without_agents_row_is_ignored(self):
        # cli-gone is in the registry but not in `claude agents`: it is no session, and lends nothing.
        reg = RegistrySource(FIXTURES / "registry").scan()
        self.assertIn("cli-gone", reg)
        s = acting(TERMINAL_CHIEF, registry=reg)
        self.assertFalse([x for x in s.values() if x["cliId"] == "cli-gone"])
        # BBB's cli-needs has no agents row: even a registry row with an inbox gives no reply.
        reg["cli-needs"] = {"sessionId": "cli-needs", "entrypoint": "cli", "hasInbox": True}
        self.assertEqual(acting(TERMINAL_CHIEF, registry=reg)[BBB]["actions"]["reply"], "app")

    def test_terminal_and_background_actions(self):
        for caps in (DESKTOP_CHIEF, TERMINAL_CHIEF):
            s = acting(caps)
            self.assertEqual(cell(s["cli_cli-term"], "reply"), ("yes", None))
            self.assertEqual(cell(s["bg_bg-working"], "reply"), ("yes", None))
            self.assertEqual(cell(s["bg_bg-working"], "stop"), ("yes", None))
            self.assertEqual(cell(s["bg_bg-done"], "stop"), ("no", "It already finished. Its conversation is kept."))
            self.assertEqual(cell(s["bg_bg-blocked"], "stop"), ("yes", None))
            self.assertEqual(cell(s["bg_bg-blocked"], "reply"),
                             ("no", "It has no message inbox (it may run with --bare)."))

    def test_reply_needs_an_inbox(self):
        reg = RegistrySource(FIXTURES / "registry").scan()          # cli-wait's row has no messagingSocketPath
        s = acting(TERMINAL_CHIEF, chief=None, registry=reg)
        self.assertEqual(cell(s[CHIEF], "reply"),
                         ("app", "Reply in the Claude app. A Chief in a terminal cannot reach this session."))
        self.assertEqual(cell(s["cli_cli-bare"], "reply"), ("no", "It has no message inbox (it may run with --bare)."))
        self.assertEqual(cell(s["bg_bg-working"], "reply"), ("yes", None))

    def test_the_action_table_cell_by_cell(self):
        """Every combination of kind, Chief, live, inbox, bgId and finished, against THE table
        (plan-b 4.1) held here as data: the first rule that names a key sets it."""
        CH = "This is the Chief of Staff session."
        NC = "No Chief is connected. Type /chief in a Claude Code session first."
        TABLE = [
            ({"isChief": True}, {k: ("no", CH) for k in ("reply", "archive", "stop", "open")}),
            ({"kind": {"desktop"}}, {"open": ("yes", None)}),
            ({"kind": {"cli", "bg"}}, {"open": ("no", "Only desktop sessions open in the Claude app.")}),
            ({"kind": {"desktop", "cli"}}, {"stop": ("no", "Only background sessions can be stopped.")}),
            ({"kind": {"cli"}, "host": True}, {"archive": ("no", "Archive it in the Claude app.")}),
            ({"kind": {"cli"}}, {"archive": ("no", "Close it in its own terminal window. "
                                                   "The Chief does not end terminal sessions.")}),
            ({"kind": {"bg"}}, {"archive": ("no", "Use Stop for a background session.")}),
            ({"chief": "none", "kind": {"desktop"}},
             {"reply": ("app", "No Chief is connected. You can reply in the Claude app."),
              "archive": ("app", "No Chief is connected. You can archive it in the Claude app.")}),
            ({"chief": "none"}, {"reply": ("no", NC), "stop": ("no", NC)}),
            ({"chief": "D", "kind": {"desktop"}}, {"reply": ("yes", None), "archive": ("yes", None)}),
            ({"chief": "T", "kind": {"desktop"}, "L": True, "I": True}, {"reply": ("yes", None)}),
            ({"chief": "T", "kind": {"desktop"}},
             {"reply": ("app", "Reply in the Claude app. A Chief in a terminal cannot reach this session."),
              "archive": ("app", "Archive it in the Claude app. A Chief in a terminal cannot archive desktop sessions.")}),
            ({"L": False}, {"reply": ("no", "It is not running, so it cannot get a reply.")}),
            ({"I": False}, {"reply": ("no", "It has no message inbox (it may run with --bare).")}),
            ({}, {"reply": ("yes", None)}),
            ({"F": True}, {"stop": ("no", "It already finished. Its conversation is kept.")}),
            ({"L": False}, {"stop": ("no", "It is not running, so it cannot be stopped.")}),
            ({"B": False}, {"stop": ("no", "Its background id is missing, so it cannot be stopped.")}),
            ({}, {"stop": ("yes", None)}),
        ]
        CAPS = {"D": {"desktopSessions": True}, "T": {"desktopSessions": False}, "none": None}
        from cos.sessions import plan_actions
        seen = 0
        for kind in ("desktop", "cli", "bg"):
            for chief in CAPS:
                for L in (True, False):
                    for I in (True, False):
                        for B in ((True, False) if kind == "bg" else (False,)):
                            for F in ((True, False) if kind == "bg" else (False,)):
                                for host in ((True, False) if kind == "cli" else (False,)):
                                    for is_chief in (False, True):
                                        case = {"kind": kind, "chief": chief, "L": L, "I": I, "B": B, "F": F,
                                                "host": host, "isChief": is_chief}
                                        want = {}
                                        for cond, cells in TABLE:
                                            if all(case[k] in v if isinstance(v, set) else case[k] == v
                                                   for k, v in cond.items()):
                                                for k, v in cells.items():
                                                    want.setdefault(k, v)
                                        s = {"kind": kind, "isChief": is_chief, "live": L, "_inbox": I,
                                             "bgId": "0d10" if B else None, "_bgState": "done" if F else "working",
                                             "_desktopHost": host}
                                        actions, notes = plan_actions(s, CAPS[chief])
                                        got = {k: (actions[k], notes.get(k)) for k in actions}
                                        self.assertEqual(got, want, case)
                                        seen += 1
        self.assertEqual(seen, 3 * 4 * 2 + 3 * 4 * 2 * 2 + 3 * 4 * 4 * 2)


class Registry(unittest.TestCase):
    def test_registry_reader_skips_keys_bad_and_big_files(self):
        with Sandbox() as box:
            reg_dir = box.dir / "registry"
            (reg_dir / "77.json").write_text(json.dumps({"sessionId": "big", "pad": "x" * 70000}), encoding="utf-8")
            (reg_dir / "notes.json").write_text(json.dumps({"sessionId": "named"}), encoding="utf-8")
            (reg_dir / "5.json").write_text(json.dumps({"sessionId": "../bad"}), encoding="utf-8")
            opened = []
            real_open = builtins.open

            def spy(file, *a, **kw):
                opened.append(str(file))
                return real_open(file, *a, **kw)

            with mock.patch("builtins.open", spy):
                rows = RegistrySource().scan()
            self.assertEqual(set(rows), {"cli-busy", "cli-wait", "cli-child", "bg-working", "cli-gone"})
            self.assertFalse([p for p in opened if p.endswith(".key")])
            self.assertFalse([p for p in opened if p.endswith(("77.json", "notes.json"))])
            busy = rows["cli-busy"]
            self.assertEqual(busy, {"pid": 1, "sessionId": "cli-busy", "kind": "interactive", "entrypoint": "cli",
                                    "status": "busy", "name": "DP1-676", "hasInbox": True})
            self.assertFalse(rows["cli-wait"]["hasInbox"])
            # Parsed again only when a file changes.
            opened.clear()
            with mock.patch("builtins.open", spy):
                src = RegistrySource()
                src.scan()
                src.scan()
            self.assertEqual(len([p for p in opened if p.endswith("1.json")]), 1)

    def test_the_reader_joins_the_registry(self):
        with Sandbox():
            reader = SessionReader(AgentsSource(), DesktopSource(), TranscriptIndex())
            reader.refresh_files()
            reader.refresh_live()
            s = {x["id"]: x for x in reader.build(config.defaults(), caps=TERMINAL_CHIEF)}
            self.assertEqual(s[AAA]["actions"]["reply"], "yes")         # cli-busy has an inbox
            self.assertEqual(s[CHIEF]["actions"]["reply"], "app")       # cli-wait has none


if __name__ == "__main__":
    unittest.main()
