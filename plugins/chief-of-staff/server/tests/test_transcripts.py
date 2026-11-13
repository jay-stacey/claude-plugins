import json
import unittest

from helpers import FIXTURES, Sandbox

from cos.transcripts import Tail, Transcript, clip, parse_row, tool_summary

BUSY = FIXTURES / "projects" / "C--work-dp-web-ui" / "cli-busy.jsonl"
TOOLS = FIXTURES / "projects" / "C--work-dp-web-ui" / "cli-tools.jsonl"


class ToolResults(unittest.TestCase):
    def turns(self):
        return {t["uuid"]: t for t in Transcript(TOOLS).page(limit=100)["turns"]}

    def test_a_tool_turn_gets_its_result_line_and_error_flag(self):
        t = self.turns()
        self.assertEqual((t["t-1"]["toolResult"], t["t-1"]["toolError"]), ("12 passing (3s)", False))
        self.assertEqual((t["t-2"]["toolResult"], t["t-2"]["toolError"]), ("File does not exist.", True))
        self.assertTrue(all(not k.startswith("_") for turn in t.values() for k in turn))
        # Tool results are folded into their calls, never turns of their own.
        self.assertEqual(sorted(t), ["t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7"])

    def test_a_long_result_is_cut_like_other_text(self):
        from cos.transcripts import short_result
        self.assertEqual(len(short_result("y" * 500)), 160)
        self.assertTrue(short_result("y" * 500).endswith(" …"))
        self.assertEqual(short_result("\n \n  a   b \nc"), "a b")

    def test_ask_user_question_turns_carry_the_questions_and_the_answer(self):
        t = self.turns()
        q = t["t-3"]["question"]
        self.assertEqual(t["t-3"]["toolSummary"], "How should the story be split?")
        self.assertEqual([x["header"] for x in q["questions"]], ["Split", "Reviewer"])
        self.assertEqual(q["questions"][0]["options"][0], {"label": "Split into 3", "description": "One story per screen."})
        self.assertIs(q["questions"][1]["multiSelect"], True)
        self.assertEqual(q["answer"], "Split into 3; Nick")                 # from the tool's own record
        self.assertEqual(t["t-4"]["question"]["answer"], "Yes")             # from the result text
        self.assertEqual(t["t-4"]["question"]["questions"][0]["options"], [{"label": "Yes", "description": ""},
                                                                           {"label": "No", "description": ""}])
        declined = t["t-5"]
        self.assertIsNone(declined["question"]["answer"])
        self.assertTrue(declined["toolError"])
        self.assertEqual(len(declined["question"]["questions"][0]["options"][0]["description"]), 300)
        self.assertIsNone(t["t-6"]["question"])                            # input not in the expected shape
        waiting = t["t-7"]["question"]
        self.assertIsNone(waiting["answer"])
        self.assertIsNone(t["t-7"]["toolResult"])
        self.assertEqual([o["label"] for o in waiting["questions"][0]["options"]], ["A", "B"])

    def test_other_turns_have_empty_tool_fields(self):
        turn = Transcript(BUSY).page()["turns"][0]
        self.assertEqual((turn["toolResult"], turn["toolError"], turn["question"]), (None, None, None))

    def test_a_result_that_arrives_later_fills_in_its_call(self):
        with Sandbox() as box:
            path = box.dir / "later.jsonl"
            call = {"type": "assistant", "uuid": "c1", "message": {"content": [
                {"type": "tool_use", "id": "x1", "name": "Bash", "input": {"command": "ls"}}]}}
            path.write_text(json.dumps(call) + "\n", encoding="utf-8")
            t = Transcript(path)
            self.assertIsNone(t.page()["turns"][0]["toolResult"])
            done = {"type": "user", "uuid": "c2", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "x1", "content": [{"type": "text", "text": "a.txt"}]}]}}
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(done) + "\n")
            self.assertEqual(t.page()["turns"][0]["toolResult"], "a.txt")

    def test_bad_tool_rows_never_raise(self):
        from cos.transcripts import question_of, tool_results
        for row in ({"type": "user", "message": {"content": [{"type": "tool_result"}]}},
                    {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": 3}]}},
                    {"type": "user", "toolUseResult": "x", "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "a", "content": 5}]}}):
            tool_results(row)
        for value in (None, [], {"questions": [None, 3, {"options": "x"}]}):
            question_of(value)


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
