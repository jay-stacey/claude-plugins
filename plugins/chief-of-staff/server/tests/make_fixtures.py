"""Writes the fixture desktop session files, agents rows and transcripts.

The fixtures are committed; run this only to change them:
    python plugins/chief-of-staff/server/tests/make_fixtures.py
Times are relative to FIXTURE_NOW (tests/helpers.py shifts them to now).
"""
import datetime as dt
import json
import shutil
from pathlib import Path

NOW = 1792160000000
H = 3_600_000
ROOT = Path(__file__).resolve().parent / "fixtures"
DESK = ROOT / "desktop" / "acct-1" / "org-1"
PROJ = ROOT / "projects" / "C--work-dp-web-ui"


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def desk(name, data):
    (DESK / name).write_text(json.dumps(data, indent=1), encoding="utf-8")


def main():
    shutil.rmtree(ROOT, ignore_errors=True)
    DESK.mkdir(parents=True)
    PROJ.mkdir(parents=True)
    desk("local_aaaa1111-0000-4000-8000-000000000001.json", {
        "sessionId": "local_aaaa1111-0000-4000-8000-000000000001", "cliSessionId": "cli-busy",
        "cwd": "C:\\work\\worktrees\\dp-web-ui\\dp1-676", "originCwd": "C:\\work\\repos\\dp-web-ui",
        "createdAt": NOW - 50 * H, "lastActivityAt": NOW - 60000, "isArchived": False, "title": "DP1-676",
        "model": "claude-sonnet-5-5", "effort": "high", "permissionMode": "auto", "branch": "DP/dp1-676",
        "prs": [{"prNumber": 1216, "branch": "DP/dp1-676", "state": "OPEN"}],
        "turnWrapUp": {"description": "Fixed the **inventory** form; see [PR](https://example.test/pr)."},
        "enabledMcpTools": {"x": True}})
    desk("local_bbbb2222-0000-4000-8000-000000000002.json", {
        "sessionId": "local_bbbb2222-0000-4000-8000-000000000002", "cliSessionId": "cli-needs",
        "cwd": "C:\\work", "originCwd": "C:\\work", "createdAt": NOW - 5 * H, "lastActivityAt": NOW - 2 * H,
        "isArchived": False, "title": "Plan PRO-921 into engineering stories",
        "postTurnSummary": {"status_category": "blocked", "status_detail": "Waiting on the vendor code",
                            "needs_action": "Jay's decision: do the vendor code switch", "summarizes_uuid": "u1"}})
    desk("local_cccc3333-0000-4000-8000-000000000003.json", {
        "sessionId": "local_cccc3333-0000-4000-8000-000000000003", "cliSessionId": "cli-merged",
        "cwd": "C:\\work", "originCwd": "C:\\work\\repos\\dealerpull-api", "createdAt": NOW - 30 * H,
        "lastActivityAt": NOW - 3 * H, "isArchived": False, "title": "API fix", "prNumber": 1608,
        "prState": "MERGED"})
    desk("local_dddd4444-0000-4000-8000-000000000004.json", {
        "sessionId": "local_dddd4444-0000-4000-8000-000000000004", "cliSessionId": "cli-archived",
        "createdAt": NOW - 10 * H, "lastActivityAt": NOW - H, "isArchived": True, "title": "Archived one"})
    desk("local_eeee5555-0000-4000-8000-000000000005.json", {
        "sessionId": "local_eeee5555-0000-4000-8000-000000000005", "cliSessionId": "cli-child",
        "cwd": "C:\\work", "createdAt": NOW - 2 * H, "lastActivityAt": NOW - H, "isArchived": False,
        "title": "Helper for DP1-676",
        "spawnedFrom": {"sessionId": "local_aaaa1111-0000-4000-8000-000000000001", "title": "DP1-676"},
        "postTurnSummary": {"status_category": "completed", "status_detail": "Ran the tests", "needs_action": ""}})
    desk("local_ffff6666-0000-4000-8000-000000000006.json", {
        "sessionId": "local_ffff6666-0000-4000-8000-000000000006", "cliSessionId": "cli-old",
        "createdAt": NOW - 200 * H, "lastActivityAt": NOW - 100 * H, "isArchived": False, "title": "Old idea",
        "lastTurnReport": "Wrote the draft \u23ce **Done.**"})
    desk("local_9999aaaa-0000-4000-8000-000000000007.json", {
        "sessionId": "local_9999aaaa-0000-4000-8000-000000000007", "cliSessionId": "cli-wait",
        "createdAt": NOW - 4 * H, "lastActivityAt": NOW - 10 * 60000, "isArchived": False, "title": "Chief session",
        "postTurnSummary": {"status_category": "completed", "status_detail": "Greeted Jay", "needs_action": ""}})
    (DESK / "local_bad00000-0000-4000-8000-000000000008.json").write_text("{ not json", encoding="utf-8")
    desk("local_noid0000-0000-4000-8000-000000000009.json",
         {"title": 7, "createdAt": "yesterday", "isArchived": False, "prs": "nope", "postTurnSummary": "x"})
    (DESK / "notes.txt").write_text("not a session", encoding="utf-8")

    agents = [
        {"pid": 1, "cwd": "C:\\work", "kind": "interactive", "startedAt": NOW - 50 * H, "sessionId": "cli-busy",
         "name": "DP1-676", "status": "busy"},
        {"pid": 2, "cwd": "C:\\work", "kind": "interactive", "startedAt": NOW - 4 * H, "sessionId": "cli-wait",
         "name": "Chief session", "status": "idle"},
        {"pid": 3, "cwd": "C:\\work", "kind": "interactive", "startedAt": NOW - 2 * H, "sessionId": "cli-child",
         "name": "Helper", "status": "waiting", "waitingFor": "permission prompt"},
        {"id": "c8d8", "cwd": "C:\\work\\repos\\dp-web-ui", "kind": "background", "startedAt": NOW - 20 * H,
         "sessionId": "bg-blocked", "name": "slack integration", "state": "blocked"},
        {"id": "0d10", "cwd": "C:\\work", "kind": "background", "startedAt": NOW - H, "sessionId": "bg-working",
         "name": "nightly import", "state": "working"},
    ]
    (ROOT / "agents.json").write_text(json.dumps(agents, indent=1), encoding="utf-8")

    peer = ("Another Claude session sent a message:\n<cross-session-message "
            "from=\"local_bbbb2222-0000-4000-8000-000000000002\" name=\"Dealerpull product spec review\">\n"
            "Please check the spec.\n</cross-session-message>")
    rows = [
        {"type": "custom-title", "customTitle": "DP1-676"},
        {"type": "user", "uuid": "u-1", "timestamp": iso(NOW - 600000), "origin": {"kind": "human"},
         "message": {"role": "user", "content": "Fix the inventory form validation"}},
        {"type": "user", "uuid": "u-meta", "isMeta": True, "timestamp": iso(NOW - 590000),
         "message": {"role": "user", "content": "<system-reminder>hidden</system-reminder>"}},
        {"type": "assistant", "uuid": "a-1", "timestamp": iso(NOW - 580000),
         "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"},
                                                      {"type": "text", "text": "I will run the tests first."}]}},
        {"type": "assistant", "uuid": "a-2", "timestamp": iso(NOW - 570000),
         "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                                                       "input": {"command": "npm test -- inventory-form",
                                                                 "description": "Run tests"}}]}},
        {"type": "user", "uuid": "u-2", "timestamp": iso(NOW - 560000),
         "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "assistant", "uuid": "a-3", "timestamp": iso(NOW - 550000),
         "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t2", "name": "Edit",
                                                       "input": {"file_path": "src/form.ts", "old_string": "a",
                                                                 "new_string": "b"}}]}},
        {"type": "user", "uuid": "u-3", "isMeta": True, "timestamp": iso(NOW - 540000),
         "origin": {"kind": "peer", "from": "local_bbbb2222-0000-4000-8000-000000000002", "hostInjected": True},
         "message": {"role": "user", "content": peer}},
        {"type": "user", "uuid": "u-4", "isMeta": True, "timestamp": iso(NOW - 530000),
         "origin": {"kind": "peer", "from": "a5b70cdd", "name": "helper"},
         "message": {"role": "user", "content": "[Subagent hand-back] report"}},
        {"type": "user", "uuid": "u-5", "timestamp": iso(NOW - 520000), "origin": {"kind": "task-notification"},
         "message": {"role": "user", "content": "<task-notification>done</task-notification>"}},
        {"type": "user", "uuid": "u-6", "timestamp": iso(NOW - 510000),
         "message": {"role": "user", "content": "<command-message>chief</command-message>\n"
                                                "<command-name>/chief</command-name>\n<command-args></command-args>"}},
        {"type": "assistant", "uuid": "a-side", "isSidechain": True, "timestamp": iso(NOW - 505000),
         "message": {"role": "assistant", "content": [{"type": "text", "text": "sidechain"}]}},
        {"type": "system", "uuid": "s-1", "timestamp": iso(NOW - 500000), "content": "hook ran"},
        {"type": "assistant", "uuid": "a-4", "timestamp": iso(NOW - 490000),
         "message": {"role": "assistant", "content": [{"type": "text", "text": "x" * 5000}]}},
    ]
    with open(PROJ / "cli-busy.jsonl", "w", encoding="utf-8", newline="\n") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
        fh.write('{"type": "assistant", "uuid": "broken"\n')
    write_tools(PROJ / "cli-tools.jsonl")
    with open(PROJ / "cli-needs.jsonl", "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps({"type": "user", "uuid": "n-1", "timestamp": iso(NOW - 2 * H),
                             "message": {"role": "user", "content": [{"type": "text", "text": "Plan PRO-921"}]}}) + "\n")


def write_tools(path):
    """Tool calls and their results, including AskUserQuestion in every state."""
    def use(uuid, at, tid, name, tool_input):
        return {"type": "assistant", "uuid": uuid, "timestamp": iso(NOW - at),
                "message": {"role": "assistant",
                            "content": [{"type": "tool_use", "id": tid, "name": name, "input": tool_input}]}}

    def result(uuid, at, tid, content, is_error=None, record=None):
        block = {"type": "tool_result", "tool_use_id": tid, "content": content}
        if is_error is not None:
            block["is_error"] = is_error
        row = {"type": "user", "uuid": uuid, "timestamp": iso(NOW - at),
               "message": {"role": "user", "content": [block]}}
        if record is not None:
            row["toolUseResult"] = record
        return row

    split = {"questions": [
        {"question": "How should the story be split?", "header": "Split", "multiSelect": False,
         "options": [{"label": "Split into 3", "description": "One story per screen."},
                     {"label": "Keep one story", "description": "Ship it together."}]},
        {"question": "Who reviews it?", "header": "Reviewer", "multiSelect": True,
         "options": [{"label": "Nick", "description": ""}, {"label": "Colin", "description": "Product"}]}]}
    rows = [
        use("t-1", 900000, "tu_bash", "Bash", {"command": "npm test", "description": "Run tests"}),
        result("r-1", 890000, "tu_bash", "\n\n  12 passing (3s)  \n  0 failing\n" + "x" * 300),
        use("t-2", 880000, "tu_read", "Read", {"file_path": "src/missing.ts"}),
        result("r-2", 870000, "tu_read", [{"type": "text", "text": "File does not exist."}], is_error=True),
        use("t-3", 860000, "tu_ask1", "AskUserQuestion", split),
        result("r-3", 850000, "tu_ask1",
               'The user answered: "How should the story be split?"="Split into 3", "Who reviews it?"="Nick". '
               "Read the answers carefully.",
               record={"questions": split["questions"],
                       "answers": {"How should the story be split?": "Split into 3", "Who reviews it?": "Nick"}}),
        use("t-4", 840000, "tu_ask2", "AskUserQuestion",
            {"questions": [{"question": "Ship today?", "header": "Ship", "options": ["Yes", "No"]}]}),
        result("r-4", 830000, "tu_ask2", 'The user answered: "Ship today?"="Yes". Continue.'),
        use("t-5", 820000, "tu_ask3", "AskUserQuestion",
            {"questions": [{"question": "Delete the branch?", "header": "Cleanup",
                            "options": [{"label": "Delete", "description": "x" * 400}]}]}),
        result("r-5", 810000, "tu_ask3", "The user declined to answer.", is_error=True),
        use("t-6", 800000, "tu_ask4", "AskUserQuestion", {"questions": "not a list"}),
        result("r-6", 790000, "tu_unknown", "A result for a call this file does not hold."),
        use("t-7", 780000, "tu_ask5", "AskUserQuestion",
            {"questions": [{"question": "Which vendor?", "header": "Vendor", "multiSelect": False,
                            "options": [{"label": "A"}, {"label": "B"}, 7]}]}),
    ]
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
