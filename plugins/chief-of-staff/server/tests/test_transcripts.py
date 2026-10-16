import json
import unittest

from helpers import FIXTURES, Sandbox

from cos.transcripts import Tail, Transcript, clip, parse_row, tool_summary

BUSY = FIXTURES / "projects" / "C--work-dp-web-ui" / "cli-busy.jsonl"


class Parsing(unittest.TestCase):
    def test_fixture_transcript_turns(self):
        page = Transcript(BUSY).page(limit=60)
        turns = page["turns"]
        self.assertIsNone(page["cursor"])
        roles = [(t["uuid"], t["role"]) for t in turns]
        self.assertEqual(roles, [("u-1", "user"), ("a-1", "assistant"), ("a-2", "tool"), ("a-3", "tool"),
                                 ("u-3", "user"), ("u-6", "user"), ("a-4", "assistant")])
        by = {t["uuid"]: t for t in turns}
        self.assertEqual(by["u-1"]["text"], "Fix the inventory form validation")
        self.assertEqual(by["a-1"]["text"], "I will run the tests first.")
        self.assertEqual((by["a-2"]["toolName"], by["a-2"]["toolSummary"]), ("Bash", "npm test -- inventory-form"))
        self.assertEqual(by["a-3"]["toolSummary"], "src/form.ts")
        self.assertEqual(by["u-3"]["fromSession"], "Dealerpull product spec review")
        self.assertEqual(by["u-3"]["text"], "Please check the spec.")
        self.assertEqual(by["u-6"]["text"], "/chief")
        self.assertEqual(len(by["a-4"]["text"]), 4000)
        self.assertTrue(by["a-4"]["text"].endswith(" …"))
        self.assertIsInstance(by["u-1"]["at"], int)
        self.assertIsNone(by["u-1"]["fromSession"])

    def test_paging_goes_back_with_the_cursor(self):
        t = Transcript(BUSY)
        last = t.page(limit=3)
        self.assertEqual([x["uuid"] for x in last["turns"]], ["u-3", "u-6", "a-4"])
        self.assertEqual(last["cursor"], "u-3")
        before = t.page(limit=3, before=last["cursor"])
        self.assertEqual([x["uuid"] for x in before["turns"]], ["a-1", "a-2", "a-3"])
        self.assertEqual(before["cursor"], "a-1")
        first = t.page(limit=3, before="a-1")
        self.assertEqual([x["uuid"] for x in first["turns"]], ["u-1"])
        self.assertIsNone(first["cursor"])

    def test_incremental_read_and_peer_detection(self):
        with Sandbox() as box:
            path = box.dir / "projects" / "C--work-dp-web-ui" / "cli-needs.jsonl"
            t = Transcript(path)
            self.assertEqual(len(t.page()["turns"]), 1)
            tail = Tail(path)
            self.assertEqual(tail.poll(), (False, []))
            row = {"type": "user", "uuid": "n-2", "isMeta": True, "origin": {"kind": "peer", "from": "local_x-1"},
                   "message": {"content": '<cross-session-message from="local_x-1" name="Other">hi</cross-session-message>'}}
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row))          # no newline yet: a partial line
            self.assertEqual(tail.poll(), (True, []))
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("\n")
            grew, peers = tail.poll()
            self.assertTrue(grew)
            self.assertEqual(peers, [{"from": "local_x-1", "name": "Other"}])
            turns = t.page()["turns"]
            self.assertEqual([x["uuid"] for x in turns], ["n-1", "n-2"])

    def test_bad_rows_never_raise(self):
        for row in (None, 3, {"type": "user"}, {"type": "assistant", "uuid": "x", "message": "s"},
                    {"type": "user", "uuid": "y", "message": {"content": 5}},
                    {"type": "assistant", "uuid": "z", "message": {"content": [None, 4, {"type": "tool_use"}]}}):
            parse_row(row)

    def test_helpers(self):
        self.assertEqual(clip("abcdef", 5), "abc …")
        self.assertEqual(tool_summary({"pattern": "TODO"}), "TODO")
        self.assertEqual(tool_summary({"x": 1, "y": "first string"}), "first string")
        self.assertIsNone(tool_summary({"x": 1}))
        self.assertEqual(len(tool_summary({"command": "a" * 300})), 120)


if __name__ == "__main__":
    unittest.main()
