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
        self.assertEqual(hook["matcher"], "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit")
        command = hook["hooks"][0]["command"]
        self.assertIn("shell_guard.py", command)
        self.assertIn(f'--allow-dir "{ROOT.resolve().as_posix()}"', command)
        self.assertIn("agent-memory", command)

    def test_chat_run_denies_dangerous_tools(self):
        import chat
        import tempfile
        runner = chat.ChatRunner(tempfile.mkdtemp(prefix="guard-chat-"), str(ROOT), claude_cmd=["claude"])
        runner.discover_tools = lambda force=False: ["mcp__g__send_gmail_message", "mcp__g__get_events"]
        seen = {}

        def fake_run(argv, stdin):
            seen["argv"] = argv
            yield from ()
        runner._run = fake_run
        list(runner._stream("hi", new=True))
        argv = seen["argv"]
        deny, allow = argv.index("--disallowedTools"), argv.index("--allowedTools")
        self.assertLess(deny, allow)
        self.assertIn("mcp__g__send_gmail_message", argv[deny + 1:allow])
        self.assertIn("mcp__g__get_events", argv[allow + 1:])
        self.assertNotIn("mcp__g__send_gmail_message", argv[allow + 1:])


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.vault = Path(tempfile.mkdtemp(prefix="guard-vault-"))
        self.memory = Path(tempfile.mkdtemp(prefix="guard-mem-"))
        self.allow = [str(self.vault), str(self.memory)]

    def test_inside_vault_and_memory_pass(self):
        self.assertIsNone(shell_guard.check_path(str(self.vault / "daily" / "x.md"), self.allow))
        self.assertIsNone(shell_guard.check_path(str(self.memory / "assistant" / "MEMORY.md"), self.allow))

    def test_outside_and_traversal_are_blocked(self):
        for bad in (str(self.vault.parent / "elsewhere.txt"), str(self.vault / ".." / "escape.md"),
                    str(Path.home() / ".bashrc"), "", None):
            self.assertIsNotNone(shell_guard.check_path(bad, self.allow), bad)

    def test_sibling_folder_with_shared_prefix_is_blocked(self):
        sibling = str(self.vault) + "-evil" + "/x.md"
        self.assertIsNotNone(shell_guard.check_path(sibling, self.allow))

    def test_hook_blocks_a_write_outside(self):
        def run(path):
            payload = {"tool_name": "Write", "tool_input": {"file_path": path, "content": "x"}}
            return subprocess.run([sys.executable, str(ROOT / "dashboard" / "shell_guard.py"),
                                   "--allow-dir", str(self.vault)],
                                  input=json.dumps(payload), capture_output=True, text=True)
        self.assertEqual(run(str(self.vault / "ok.md")).returncode, 0)
        bad = run(str(Path.home() / "Startup" / "evil.cmd"))
        self.assertEqual(bad.returncode, 2)
        self.assertIn("only inside your notes folder", bad.stderr)


if __name__ == "__main__":
    unittest.main()
