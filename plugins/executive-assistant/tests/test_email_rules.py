"""Tests for scripts/email_rules.py. Run: python -m unittest discover -s plugins/executive-assistant/tests"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN / "scripts"))
import email_rules  # noqa: E402

TEMPLATE = PLUGIN / "templates" / "email-rules.md"
NOW = "2026-10-13T06:05"

# Counted by hand from templates/email-rules.md. 21 rule lines, 4 of them hold a
# placeholder: From the CEO, both support rules, and Cold sales.
TEMPLATE_RULES = 21
TEMPLATE_SKIPPED = {"From the CEO", "Customer replies to support", "Cancellations and refunds", "Cold sales"}


class RulesCase(unittest.TestCase):
    def setUp(self):
        self.vault = Path(tempfile.mkdtemp(prefix="ea-rules-"))
        (self.vault / "assistant").mkdir()
        self.rules = self.vault / "assistant" / "email-rules.md"
        shutil.copyfile(TEMPLATE, self.rules)

    def tearDown(self):
        shutil.rmtree(self.vault, ignore_errors=True)

    def run_cli(self, *argv, now=NOW, expect=0):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = email_rules.main(["--vault", str(self.vault), "--now", now, *argv])
        out = json.loads(buf.getvalue())
        self.assertEqual(code, expect, out)
        return out

    def write_rules(self, text):
        self.rules.write_bytes(text.encode("utf-8"))

    def record(self, date, matches):
        path = self.vault / f"run-{date}-{len(matches)}.json"
        path.write_text(json.dumps({"date": date, "matches": matches}), encoding="utf-8")
        return self.run_cli("record", "--run-json", str(path))


class ParseTests(RulesCase):
    def test_template_parses_with_expected_active_and_skipped_rules(self):
        out = self.run_cli("parse")
        self.assertEqual(out["errors"], [])
        self.assertEqual(len(out["rules"]), TEMPLATE_RULES)
        skipped = {r["name"] for r in out["rules"] if r["skipped"]}
        self.assertEqual(skipped, TEMPLATE_SKIPPED)
        self.assertEqual(out["placeholders"], ["<ceo-address>", "<support-address>", "<your-domain>"])
        ceo = next(r for r in out["rules"] if r["name"] == "From the CEO")
        self.assertEqual(ceo["skipped"], "placeholder <ceo-address>")
        self.assertEqual(ceo["section"], "Always keep")
        receipts = next(r for r in out["rules"] if r["name"] == "Routine SaaS receipts")
        self.assertEqual((receipts["action"], receipts["label"]), ("archive", "Finance/Receipts"))

    def test_grammar_line_in_code_block_is_ignored(self):
        text = TEMPLATE.read_text(encoding="utf-8")
        grammar_no = text.splitlines().index("- action | mode | name | gmail query | label (only for label and archive)") + 1
        out = self.run_cli("parse")
        self.assertNotIn(grammar_no, [r["line_no"] for r in out["rules"]])
        self.assertNotIn(grammar_no, [e["line_no"] for e in out["errors"]])
        # The same valid rule is parsed outside a fence and ignored inside one.
        self.write_rules("# Rules\n\n```\n- trash | auto | Inside fence | from:inside.example\n```\n\n"
                         "- trash | auto | Outside fence | from:outside.example\n")
        names = [r["name"] for r in self.run_cli("parse")["rules"]]
        self.assertEqual(names, ["Outside fence"])

    def test_malformed_lines_become_errors_and_good_lines_still_parse(self):
        self.write_rules(
            "# Rules\n\n"
            "- trash | auto | Good one | from:good.example\n"          # 3
            "- shred | auto | Bad action | from:a.example\n"           # 4
            "- trash | later | Bad mode | from:b.example\n"            # 5
            "- label | auto | Label without label | from:c.example\n"  # 6
            "- trash | auto | Trash with label | from:d.example | X\n"  # 7
            "- trash | auto | Too few\n"                               # 8
            "- trash | auto |  | from:e.example\n"                     # 9
            "- keep | auto | Too many | from:f.example | L | extra\n"  # 10
            "- just a normal note about mail\n"                        # 11, not a rule
            "- archive | confirm | Second good | from:g.example\n")    # 12
        out = self.run_cli("parse")
        self.assertEqual([r["name"] for r in out["rules"]], ["Good one", "Second good"])
        self.assertEqual([e["line_no"] for e in out["errors"]], [4, 5, 6, 7, 8, 9, 10])
        whys = {e["line_no"]: e["why"] for e in out["errors"]}
        self.assertIn("shred", whys[4])
        self.assertIn("5th part", whys[6])
        self.assertIn("Only label and archive", whys[7])

    def test_first_match_order_is_file_order(self):
        out = self.run_cli("parse")
        self.assertEqual([r["n"] for r in out["rules"]], list(range(1, TEMPLATE_RULES + 1)))
        lines = [r["line_no"] for r in out["rules"]]
        self.assertEqual(lines, sorted(lines))
        self.assertEqual(out["rules"][0]["name"], "Production incidents")
        self.assertEqual(out["rules"][-1]["name"], "Cold sales")
        q = self.run_cli("queries")
        self.assertEqual([x["n"] for x in q["queries"]],
                         [r["n"] for r in out["rules"] if not r["skipped"]])
        self.assertEqual(len(q["queries"]), TEMPLATE_RULES - len(TEMPLATE_SKIPPED))

    def test_queries_wrap_in_inbox_and_protect_starred_for_trash_and_archive(self):
        q = {x["name"]: x for x in self.run_cli("queries")["queries"]}
        self.assertEqual(q["Tech newsletters"]["query"],
                         "in:inbox (from:(tldr.tech OR tldrnewsletter.com OR substack.com OR medium.com "
                         "OR beehiiv.com)) -is:starred")
        self.assertTrue(q["Resolved Azure alerts"]["query"].endswith(" -is:starred"))
        self.assertEqual(q["Starred"]["query"], "in:inbox (is:starred)")
        self.assertNotIn("-is:starred", q["Inventory feed error logs"]["query"])
        self.assertNotIn("From the CEO", q)

    def test_missing_rules_file_exits_5_and_points_to_init(self):
        self.rules.unlink()
        for cmd in ("parse", "queries", "filter-offers"):
            out = self.run_cli(cmd, expect=5)
            self.assertIn("tasks.py init", out["error"])
        out = self.run_cli("add", "--line", "- trash | auto | Any | from:any.example", expect=5)
        self.assertIn("tasks.py init", out["error"])


class AddTests(RulesCase):
    LINE = "- trash | auto | Vendor webinars | from:vendor.example subject:webinar"

    def test_add_appends_under_learned_rules_with_dated_comment(self):
        out = self.run_cli("add", "--line", self.LINE, "--why", "6 this week, all trashed after a yes")
        self.assertEqual(out["added"], self.LINE)
        lines = self.rules.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[out["line_no"] - 1],
                         self.LINE + "  <!-- added 2026-10-13: 6 this week, all trashed after a yes -->")
        self.assertGreater(out["line_no"], lines.index("## Learned rules") + 1)
        parsed = self.run_cli("parse")
        last = parsed["rules"][-1]
        self.assertEqual((last["name"], last["section"], last["n"]), ("Vendor webinars", "Learned rules", 22))
        self.assertEqual(parsed["errors"], [])
        second = self.run_cli("add", "--line", "archive | confirm | Survey asks | subject:survey | FYI/Surveys")
        self.assertEqual(second["line_no"], out["line_no"] + 1)

    def test_add_goes_into_the_section_even_when_another_section_follows(self):
        self.write_rules("# Rules\n\n## Learned rules\n\n- trash | auto | Old | from:old.example\n\n"
                         "## Notes\n\n- keep | auto | After | from:after.example\n")
        out = self.run_cli("add", "--line", self.LINE)
        self.assertEqual(out["line_no"], 6)
        names = [(r["name"], r["section"]) for r in self.run_cli("parse")["rules"]]
        self.assertEqual(names, [("Old", "Learned rules"), ("Vendor webinars", "Learned rules"),
                                 ("After", "Notes")])
        self.assertIn("\n\n## Notes\n", self.rules.read_text(encoding="utf-8"))

    def test_add_creates_the_heading_when_missing(self):
        self.write_rules("# Rules\n\n## Trash\n\n- trash | auto | Old | from:old.example\n")
        out = self.run_cli("add", "--line", self.LINE)
        text = self.rules.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n## Learned rules\n\n" + self.LINE + "  <!-- added 2026-10-13 -->\n"), text)
        self.assertEqual(out["rule"]["section"], "Learned rules")

    def test_add_rejects_duplicate_query_and_leaves_file_alone(self):
        before = self.rules.read_bytes()
        out = self.run_cli("add", "--line", "- archive | auto | Same query | FROM:notifications@github.com",
                           expect=2)
        self.assertIn("GitHub notifications", out["error"])
        self.assertEqual(self.rules.read_bytes(), before)

    def test_add_rejects_duplicate_name(self):
        out = self.run_cli("add", "--line", "- trash | auto | promotions | from:unique.example", expect=2)
        self.assertIn("Promotions", out["error"])

    def test_add_rejects_invalid_line_and_placeholder(self):
        before = self.rules.read_bytes()
        self.run_cli("add", "--line", "- trash | sometimes | Bad | from:x.example", expect=2)
        self.run_cli("add", "--line", "- label | auto | No label | from:y.example", expect=2)
        self.run_cli("add", "--line", "- keep | auto | Boss | from:<boss-address>", expect=2)
        self.assertEqual(self.rules.read_bytes(), before)

    def test_add_keeps_crlf_line_endings(self):
        crlf = TEMPLATE.read_text(encoding="utf-8").replace("\n", "\r\n")
        self.write_rules(crlf)
        self.run_cli("add", "--line", self.LINE)
        data = self.rules.read_bytes()
        self.assertEqual(data.count(b"\n"), data.count(b"\r\n"))
        self.assertEqual(data.count(b"\r\n"), crlf.count("\r\n") + 2)   # blank line + the rule
        self.assertEqual(self.run_cli("parse")["rules"][-1]["name"], "Vendor webinars")

    def test_add_keeps_lf_line_endings(self):
        self.run_cli("add", "--line", self.LINE)
        self.assertNotIn(b"\r\n", self.rules.read_bytes())


class StatsTests(RulesCase):
    def stats(self):
        return json.loads((self.vault / ".assistant" / "email-stats.json").read_text(encoding="utf-8"))["rules"]

    def test_record_accumulates_and_skips_zero_counts(self):
        self.record("2026-10-01", {"Tech newsletters": 61, "Promotions": 17, "GitHub notifications": 0})
        out = self.record("2026-10-03", {"Tech newsletters": 44, "Promotions": 0})
        self.assertEqual(out["updated"]["Tech newsletters"]["total_matched"], 105)
        s = self.stats()
        self.assertEqual(s["Tech newsletters"], {"runs_matched": 2, "total_matched": 105, "first_date": "2026-10-01",
                                                 "last_date": "2026-10-03", "undone": 0})
        self.assertEqual(s["Promotions"]["runs_matched"], 1)
        self.assertEqual(s["Promotions"]["last_date"], "2026-10-01")
        self.assertNotIn("GitHub notifications", s)

    def test_record_reports_unknown_rule_names_and_rejects_bad_counts(self):
        out = self.record("2026-10-02", {"Renamed rule": 3})
        self.assertEqual(out["unknown_rules"], ["Renamed rule"])
        bad = self.vault / "bad.json"
        bad.write_text(json.dumps({"date": "2026-10-02", "matches": {"Promotions": -4}}), encoding="utf-8")
        self.run_cli("record", "--run-json", str(bad), expect=2)
        bad.write_text("not json", encoding="utf-8")
        self.run_cli("record", "--run-json", str(bad), expect=2)

    def test_undo_counts_up(self):
        self.record("2026-10-02", {"Promotions": 9})
        self.run_cli("undo", "--rule", "Promotions")
        out = self.run_cli("undo", "--rule", "Promotions")
        self.assertEqual(out["stats"]["undone"], 2)
        self.assertEqual(self.stats()["Promotions"]["total_matched"], 9)


class FilterOfferTests(RulesCase):
    def build_history(self):
        # Tech newsletters: 5 runs over exactly 10 days -> offered.
        # Promotions: 4 runs over 12 days -> too few runs.
        # GitHub notifications: 6 runs over 9 days -> too short a span.
        # Linear digests: qualifies, but the user undid one -> never offered.
        # Production incidents: qualifies on numbers, but keep rules never become filters.
        plan = {
            "Tech newsletters": ["2026-10-01", "2026-10-03", "2026-10-06", "2026-10-08", "2026-10-11"],
            "Promotions": ["2026-10-01", "2026-10-05", "2026-10-09", "2026-10-13"],
            "GitHub notifications": ["2026-10-02", "2026-10-03", "2026-10-05", "2026-10-07", "2026-10-09",
                                     "2026-10-11"],
            "Linear digests": ["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10", "2026-10-13"],
            "Production incidents": ["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10", "2026-10-13"],
        }
        for i, day in enumerate(sorted({d for days in plan.values() for d in days})):
            self.record(day, {name: 3 + i + k for k, (name, days) in enumerate(plan.items()) if day in days})
        self.run_cli("undo", "--rule", "Linear digests")

    def test_offers_respect_runs_span_undone_and_action(self):
        self.build_history()
        offers = self.run_cli("filter-offers")["offers"]
        self.assertEqual([o["rule"] for o in offers], ["Tech newsletters"])
        o = offers[0]
        self.assertEqual((o["runs"], o["span_days"], o["action"]), (5, 10, "trash"))
        self.assertEqual(o["query"], "from:(tldr.tech OR tldrnewsletter.com OR substack.com OR medium.com OR beehiiv.com)")
        self.assertEqual(o["matched"], sum(json.loads(p.read_text(encoding="utf-8"))["matches"].get("Tech newsletters", 0)
                                           for p in self.vault.glob("run-*.json")))

    def test_one_more_run_tips_promotions_over(self):
        self.build_history()
        self.record("2026-10-14", {"Promotions": 8})
        self.assertEqual([o["rule"] for o in self.run_cli("filter-offers")["offers"]],
                         ["Tech newsletters", "Promotions"])

    def test_mark_filter_removes_the_offer(self):
        self.build_history()
        self.record("2026-10-14", {"Promotions": 8})
        self.run_cli("mark-filter", "--rule", "Tech newsletters", "--state", "offered")
        self.assertEqual([o["rule"] for o in self.run_cli("filter-offers")["offers"]], ["Promotions"])
        out = self.run_cli("mark-filter", "--rule", "Promotions", "--state", "declined")
        self.assertEqual(out["stats"]["filter_date"], "2026-10-13")
        self.assertEqual(self.run_cli("filter-offers")["offers"], [])
        created = self.run_cli("mark-filter", "--rule", "Tech newsletters", "--state", "created")
        self.assertEqual(created["stats"]["filter"], "created")
        self.assertEqual(self.run_cli("filter-offers")["offers"], [])


if __name__ == "__main__":
    unittest.main()
