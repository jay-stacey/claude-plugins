import unittest

import fakes  # noqa: F401  (sets sys.path)
from cosvoice.text import CODE_NOTE, LINK_NOTE, clauses, is_noise, speakable, strip_wake


class SpeakableTest(unittest.TestCase):
    def test_code_blocks_are_never_read(self):
        out = speakable("Here is the fix.\n```python\nprint('secret code')\n```\nIt works now.")
        self.assertNotIn("print", out)
        self.assertNotIn("secret", out)
        self.assertIn("Here is the fix.", out)
        self.assertIn("It works now.", out)
        self.assertIn(CODE_NOTE, out)

    def test_urls_are_never_read(self):
        out = speakable("The PR is at https://github.com/dealerpull/x/pull/12 and www.example.com/a.")
        self.assertNotIn("http", out)
        self.assertNotIn("github", out)
        self.assertNotIn("www", out)
        self.assertTrue(out.endswith(LINK_NOTE), out)

    def test_markdown_link_keeps_label_only(self):
        out = speakable("See [PR 1216](https://github.com/o/r/pull/1216) for details.")
        self.assertIn("See pull request twelve sixteen for details.", out)
        self.assertIn(LINK_NOTE, out)
        self.assertNotIn("github", out)

    def test_markdown_is_stripped(self):
        out = speakable("## Status\n- **NEO-123** is _done_\n- `npm test` passes\n> quoted")
        self.assertNotIn("#", out)
        self.assertNotIn("*", out)
        self.assertNotIn("`", out)
        self.assertNotIn(">", out)
        self.assertIn("N E O one two three is done.", out)
        self.assertIn("npm test passes.", out)

    def test_paths_and_confirm_line_dropped(self):
        out = speakable("I saved it to C:\\Users\\Jay\\notes.md.\n[[confirm: Archive anyway | Leave it running]]")
        self.assertNotIn("Users", out)
        self.assertNotIn("confirm", out)

    def test_plain_text_unchanged(self):
        self.assertEqual(speakable("Two sessions need you."), "Two sessions need you.")
        self.assertEqual(speakable(""), "")


class ClauseTest(unittest.TestCase):
    def test_sentences(self):
        # first chunk one sentence (fast first audio), then up to two sentences per chunk
        self.assertEqual(clauses("Two sessions need you. The plan is waiting on a vendor name! Is that right? "
                                 "Then archive it. And the last one."),
                         ["Two sessions need you.", "The plan is waiting on a vendor name! Is that right?",
                          "Then archive it. And the last one."])
        self.assertEqual(clauses("One thing. OK. Done."), ["One thing. OK. Done."])  # tiny tails glued

    def test_first_clause_is_short(self):
        text = ("The plan for PRO-921 is waiting on you, because it needs a vendor name, "
                "and the dp1 branch is merged. Nothing else is blocked.")
        parts = clauses(text)
        self.assertLessEqual(len(parts[0]), 90)
        self.assertEqual(" ".join(parts), text)

    def test_long_without_commas(self):
        text = "word " * 80
        parts = clauses(text)
        self.assertTrue(all(len(p) <= 180 for p in parts))
        self.assertEqual(" ".join(parts).split(), text.split())

    def test_empty(self):
        self.assertEqual(clauses("  "), [])


class WakeStripTest(unittest.TestCase):
    def test_strip(self):
        self.assertEqual(strip_wake("Hey Chief, what needs me?"), "What needs me?")
        self.assertEqual(strip_wake("hey chief what needs me"), "What needs me")
        self.assertEqual(strip_wake("Hey, Chief. Close the DP1 session."), "Close the DP1 session.")
        self.assertEqual(strip_wake("What needs me?"), "What needs me?")
        self.assertEqual(strip_wake("Hey Chief."), "")

    def test_noise(self):
        self.assertTrue(is_noise("Thank you."))
        self.assertTrue(is_noise(""))
        self.assertFalse(is_noise("What needs me?"))


if __name__ == "__main__":
    unittest.main()


class RepeatedWakeTests(unittest.TestCase):
    def test_repeated_wake_phrases_all_go(self):
        from cosvoice.text import strip_wake
        self.assertEqual(strip_wake("Hey Chief. Hey Chief, what needs me?"), "What needs me?")

    def test_only_the_wake_phrase_is_empty(self):
        from cosvoice.text import strip_wake
        self.assertEqual(strip_wake("Hey, Chief."), "")
        self.assertEqual(strip_wake("Hey Chief Hey Chief"), "")

    def test_a_request_that_names_the_chief_later_keeps_it(self):
        from cosvoice.text import strip_wake
        self.assertEqual(strip_wake("Hey Chief, tell the chief of staff session to stop"),
                         "Tell the chief of staff session to stop")


class SelfCheckPhraseTest(unittest.TestCase):
    def test_close_transcripts_pass(self):
        from cosvoice.text import heard_self_check
        for heard in ("Chief of Staff voice check.", "Chief of Staff Voice Track",  # small.en on CPU, 2026-10-17
                      "chief of staff, voice check", "Chiefs of staff voice chuck", "voice check",
                      "Cheap of Staf voice check"):
            self.assertTrue(heard_self_check(heard), heard)

    def test_empty_or_unrelated_transcripts_fail(self):
        from cosvoice.text import heard_self_check
        for heard in ("", None, "   ", "...", "Thank you.", "The weather is nice today",
                      "you", "Check", "Chief"):
            self.assertFalse(heard_self_check(heard), heard)
