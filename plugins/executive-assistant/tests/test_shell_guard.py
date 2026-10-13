"""The Day Desk chat's shell guard: one plain call to the plugin's own scripts."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dashboard"))
import shell_guard  # noqa: E402

TP = 'python "C:/x/plugins/executive-assistant/scripts/tasks.py"'


class GuardTests(unittest.TestCase):
    def test_plain_script_calls_pass(self):
        for cmd in (f'{TP} --vault "C:/notes" list --list now,today',
                    f'{TP} add --parse "call the bank fri 15m !high #admin"',
                    r'python C:\x\scripts\email_rules.py add --line "- trash | auto | X | from:x.example"'):
            self.assertIsNone(shell_guard.check(cmd), cmd)

    def test_chaining_substitution_redirects_and_variables_are_blocked(self):
        for tail in ('"$(echo x > m)"', '"`echo x`"', "; echo x", "&& echo x", "| tee m", "> m", "< m",
                     "\necho x", "${HOME}", "$HOME", "%USERPROFILE%", "@(1)", "$(id)", '"a" ; b',
                     "'unclosed", '"in double $HOME"'):
            self.assertIsNotNone(shell_guard.check(f"{TP} parse {tail}"), tail)

    def test_quoted_text_with_symbols_passes(self):
        for tail in ('"a; b | c > d"', "'$(literal) `x` $HOME'", '"<ceo-address> & co"'):
            self.assertIsNone(shell_guard.check(f"{TP} parse {tail}"), tail)

    def test_other_programs_are_blocked(self):
        for cmd in ("echo hi", "python other.py", "curl https://example.com", 'python -c "print(1)"',
                    "python scripts/tasks.pyc list"):
            self.assertIn("only the plugin", shell_guard.check(cmd), cmd)

    def test_hook_process_exit_codes(self):
        def run(payload):
            return subprocess.run([sys.executable, str(ROOT / "dashboard" / "shell_guard.py")],
                                  input=json.dumps(payload), capture_output=True, text=True)
        ok = run({"tool_name": "Bash", "tool_input": {"command": f"{TP} list"}})
        bad = run({"tool_name": "Bash", "tool_input": {"command": f"{TP} list; rm -rf x"}})
        other = run({"tool_name": "Read", "tool_input": {"file_path": "x"}})
        self.assertEqual((ok.returncode, bad.returncode, other.returncode), (0, 2, 0))
        self.assertIn("Blocked", bad.stderr)

    def test_chat_passes_the_guard_to_claude(self):
        import chat
        runner = chat.ChatRunner(str(ROOT), str(ROOT), claude_cmd=["claude"])
        argv = runner._base_argv()
        settings = json.loads(argv[argv.index("--settings") + 1])
        hook = settings["hooks"]["PreToolUse"][0]
        self.assertEqual(hook["matcher"], "Bash|PowerShell")
        self.assertIn("shell_guard.py", hook["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main()
