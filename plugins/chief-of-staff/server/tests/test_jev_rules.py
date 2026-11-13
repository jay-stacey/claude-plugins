import time
import unittest

import helpers  # noqa: F401  (puts server/ on sys.path)

from cos.jev.decision import Request
from cos.jev import rules
from cos.jev.rules import overrides, quick

# text -> (filler, route, model, estimate_s, source)
TABLE = {
    "hello": ("chat", "chief", "haiku", 3, "rules"),
    "Thanks!": ("chat", "chief", "haiku", 3, "rules"),
    "yes": ("chat", "chief", "haiku", 3, "rules"),
    "No thanks": ("chat", "chief", "haiku", 3, "rules"),
    "Archive it": ("chat", "chief", "haiku", 3, "rules"),
    "what needs me?": ("lookup", "chief", "haiku", 10, "rules"),
    "How is the build session doing": ("lookup", "chief", "haiku", 10, "rules"),
    "anything waiting on me": ("lookup", "chief", "haiku", 10, "rules"),
    "which sessions are stale": ("lookup", "chief", "haiku", 10, "rules"),
    "list my sessions": ("lookup", "chief", "haiku", 10, "rules"),
    "can you check the status of the build": ("lookup", "chief", "haiku", 10, "rules"),
    "tell me what needs me": ("lookup", "chief", "haiku", 10, "rules"),
    "Fix the login bug in the api repo": ("work", "new_session", "sonnet", 600, "rules"),
    "please implement the export button": ("work", "new_session", "sonnet", 600, "rules"),
    "Design the architecture for the new sync service": ("work", "new_session", "opus", 1200, "rules"),
    "research how the local runtime handles json schema": ("work", "new_session", "opus", 1200, "rules"),
    "find the root cause of the flaky test": ("work", "new_session", "opus", 1200, "rules"),
    "summarize the open pull requests": ("work", "new_session", "haiku", 120, "rules"),
    "archive the docs session": ("work", "chief", "haiku", 10, "rules"),
    "tell the api session to rebase": ("work", "chief", "haiku", 10, "rules"),
    "reply to the console session with yes": ("work", "chief", "haiku", 10, "rules"),
}

OVERRIDES = {
    "what needs me, use opus": ({"model": "opus"}, "lookup", "chief", "opus"),
    "please implement the export button with haiku": ({"model": "haiku"}, "work", "new_session", "haiku"),
    "fix the typo, do it yourself": ({"route": "chief"}, "work", "chief", "haiku"),
    "don't start a new session, just fix the typo": ({"route": "chief"}, "work", "chief", "haiku"),
    "You handle it": ({"route": "chief"}, "chat", "chief", "haiku"),
    "search the repo for TODO notes in a new session": ({"route": "new_session"}, "work", "new_session", "haiku"),
    "Spin up a session to refactor the auth module": ({"route": "new_session"}, "work", "new_session", "sonnet"),
    "summarize the logs in the background": ({"route": "new_session"}, "work", "new_session", "haiku"),
    "list sessions in a new session using sonnet": ({"model": "sonnet", "route": "new_session"}, "work",
                                                    "new_session", "sonnet"),
}


class Rules(unittest.TestCase):
    def test_classification_table(self):
        for text, want in TABLE.items():
            d = quick(Request(text))
            with self.subTest(text=text):
                self.assertEqual((d.filler, d.route, d.model, d.estimate_s, d.source), want)
                self.assertEqual(d.background, d.route == "new_session")
                self.assertFalse(d.override)

    def test_user_overrides_win(self):
        for text, (ov, filler, route, model) in OVERRIDES.items():
            d = quick(Request(text))
            with self.subTest(text=text):
                self.assertEqual(overrides(text), ov)
                self.assertEqual((d.filler, d.route, d.model), (filler, route, model))
                self.assertEqual((d.source, d.override), ("user", True))
                self.assertEqual(d.background, route == "new_session")

    def test_case_and_word_boundaries(self):
        self.assertEqual(overrides("USE OPUS"), {"model": "opus"})
        self.assertEqual(overrides("the opusculum"), {})
        self.assertEqual(overrides("refuse opus"), {})
        self.assertEqual(quick(Request("prefix the files")).filler, "chat")    # "fix" inside a word does not count

    def test_empty_text_is_chat(self):
        self.assertEqual(quick(Request("")).filler, "chat")

    def test_speed(self):
        req = Request("Design the architecture for the new sync service and tell me what you think, use opus")
        quick(req)
        start = time.perf_counter()
        for _ in range(1000):
            quick(req)
        average_ms = (time.perf_counter() - start)
        self.assertLess(average_ms, 2.0)          # total seconds for 1000 calls == ms per call


if __name__ == "__main__":
    unittest.main()


class StateQuestions(unittest.TestCase):
    def test_yes_or_no_questions_about_work_are_lookups(self):
        for text in ("Is the Node 22 upgrade done?", "Has the deploy finished", "Is the review of PR 12 done yet",
                     "Did the build pass and is it green?"):
            self.assertEqual(rules.kind(text), "lookup", text)
            self.assertEqual(rules.quick(Request(text)).route, "chief", text)

    def test_questions_that_name_work_are_for_the_chief(self):
        for text in ("Why did the build fail?", "What did the review say", "Did the deploy work?",
                     "What is the plan for today", "Is it worth it to fix the login bug?"):
            self.assertEqual(rules.quick(Request(text)).route, "chief", text)

    def test_a_request_for_work_with_a_question_mark_is_still_work(self):
        self.assertEqual(rules.quick(Request("Can you fix the login bug?")).route, "new_session")

    def test_can_you_do_it_in_a_new_session_keeps_the_new_session(self):
        self.assertEqual(overrides("can you do it in a new session"), {"route": "new_session"})
        self.assertEqual(overrides("no, you do it"), {"route": "chief"})
        self.assertEqual(overrides("do it yourself, not in a new session"), {"route": "chief"})

