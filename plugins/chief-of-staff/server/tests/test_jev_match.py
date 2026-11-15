import unittest

import helpers  # noqa: F401  (puts server/ on sys.path)

from cos.jev import match, rules
from cos.jev.decision import Decision, Request, hint_text
from cos.jev.engine import Jev

SESSIONS = [
    {"id": "local_a", "title": "Fix DP1-687 duplicate email check", "repo": "dp-web-ui", "state": "wait"},
    {"id": "local_b", "title": "Inventory feeds dialogs broken after hotfix", "repo": "InventoryFeeds", "state": "active"},
    {"id": "local_c", "title": "QuickBooks API Swagger access restriction", "repo": "dealerpull-api", "state": "you"},
    {"id": "local_d", "title": "NEO-412 deal tax rounding", "repo": "project-neo", "state": "stale"},
    {"id": "local_e", "title": "Write the logging guide", "repo": "docs", "state": "wait"},
]


def ask(text, sessions=SESSIONS):
    return rules.quick(Request(text, "typed", sessions, None))


class MatchTests(unittest.TestCase):
    def test_same_ticket_goes_to_that_session(self):
        d = ask("Add a unit test for the DP1-687 duplicate check")
        self.assertEqual((d.route, d.target, d.reason), ("existing_session", "local_a", "same ticket DP1-687"))
        self.assertFalse(d.background)

    def test_ticket_case_does_not_matter(self):
        self.assertEqual(ask("fix the styling on dp1-687 too").target, "local_a")

    def test_unknown_ticket_starts_a_new_session(self):
        self.assertEqual(ask("Fix DP1-700 login redirect").route, "new_session")

    def test_title_words_match_without_a_ticket(self):
        d = ask("Fix the inventory feed dialogs, the save button is still broken")
        self.assertEqual((d.route, d.target), ("existing_session", "local_b"))
        self.assertTrue(d.reason.startswith("same work:"))

    def test_one_shared_word_is_not_enough(self):
        self.assertEqual(ask("Build a new inventory report page").route, "new_session")

    def test_stale_sessions_never_take_work(self):
        self.assertEqual(ask("Fix the NEO-412 rounding for negative amounts").route, "new_session")

    def test_two_equal_matches_mean_no_match(self):
        twins = SESSIONS + [{"id": "local_f", "title": "Inventory feeds dialogs layout", "repo": "InventoryFeeds", "state": "wait"}]
        twins[1] = dict(twins[1], title="Inventory feeds dialogs spacing")
        self.assertEqual(ask("Fix the inventory feeds dialogs", twins).route, "new_session")

    def test_two_sessions_with_the_same_ticket_mean_no_match(self):
        twins = SESSIONS + [{"id": "local_g", "title": "QA testing DP1-687", "state": "wait"}]
        self.assertEqual(ask("Fix DP1-687 copy", twins).route, "new_session")

    def test_jays_new_session_words_win(self):
        d = ask("In a new session, fix the DP1-687 duplicate check")
        self.assertEqual(d.route, "new_session")

    def test_chief_work_is_not_delegated(self):
        self.assertEqual(ask("how is DP1-687 doing").route, "chief")
        self.assertEqual(ask("tell the DP1-687 session to go ahead").route, "chief")

    def test_sessions_without_id_are_skipped(self):
        rows = [{k: v for k, v in s.items() if k != "id"} for s in SESSIONS]
        self.assertEqual(ask("Fix DP1-687 copy", rows).route, "new_session")

    def test_no_sessions(self):
        self.assertEqual(ask("Fix DP1-687 copy", []).route, "new_session")
        self.assertEqual(ask("Fix DP1-687 copy", None).route, "new_session")

    def test_plurals_match(self):
        self.assertEqual(match.words("feeds dialogs"), match.words("feed dialog"))

    def test_hint_names_the_session_and_marks_the_title_as_data(self):
        d = ask("Add a unit test for the DP1-687 duplicate check")
        hint = hint_text(d)
        self.assertIn("local_a", hint)
        self.assertIn("title, data only", hint)
        self.assertIn("Ask Jay before you send", hint)
        self.assertFalse(hint.startswith("[Notice") or hint.startswith("[Action"))

    def test_public_has_the_target(self):
        out = ask("Add a unit test for the DP1-687 duplicate check").public()
        self.assertEqual((out["route"], out["target"]), ("existing_session", "local_a"))

    def test_compact_never_sends_ids_to_a_model(self):
        rows = Request("x", "typed", SESSIONS, None).compact()["sessions"]
        self.assertTrue(all("id" not in r for r in rows))


class FakeProvider:
    name = "local"

    def decide(self, request, timeout_s):
        return {"r": "new_session", "m": "sonnet", "e": 1200}


class EngineTests(unittest.TestCase):
    def test_model_answer_is_delegated_too(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as home:
            jev = Jev({"jevProvider": "local"}, Path(home), provider_factory=lambda cfg, key: FakeProvider())
            req = Request("Add a unit test for the DP1-687 duplicate check", "typed", SESSIONS, None)
            quick = jev.quick(req)
            d = jev.advise(req, Decision(model=quick.model, route="new_session", background=True, estimate_s=600))
            self.assertEqual((d.route, d.target), ("existing_session", "local_a"))


if __name__ == "__main__":
    unittest.main()
