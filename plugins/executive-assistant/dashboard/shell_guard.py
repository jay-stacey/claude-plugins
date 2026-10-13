#!/usr/bin/env python3
"""PreToolUse guard for the Day Desk chat.

The dashboard chat may run only the plugin's own scripts (tasks.py and
email_rules.py), allowed by permission rules in chat.py. This hook is a second,
fixed check that does not depend on the model or on how permission rules treat
shell syntax: it blocks any shell command that could run a second command or
write a file, such as `$(...)`, backticks, `;`, `&&`, `|`, `>` and line breaks.
Email text can carry prompt injection, so the chat must never be able to chain
commands.

Reads the hook JSON on stdin. Exit 0 allows; exit 2 blocks and the reason on
stderr goes back to Claude.
"""
import json
import re
import sys

# Outside quotes these start another command, redirect, or expand something.
UNQUOTED = set(";&|<>`$(){}%@!")
# Inside double quotes bash and PowerShell still expand $ and backticks.
IN_DOUBLE = set("$`")
SCRIPTS = re.compile(r"(?:^|[\\/])scripts[\\/](?:tasks|email_rules)\.py[\"']?(?:\s|$)")


def unsafe(command):
    """True when the command could run or expand anything beyond its words.

    Single-quoted text is literal in both shells. Double-quoted text is literal
    except for $ and backticks. Rule lines like "- trash | auto | X" stay
    allowed because their pipes sit inside quotes.
    """
    if "\n" in command or "\r" in command:
        return True
    quote = None
    for ch in command:
        if quote == "'":
            if ch == "'":
                quote = None
        elif quote == '"':
            if ch == '"':
                quote = None
            elif ch in IN_DOUBLE:
                return True
        elif ch in ("'", '"'):
            quote = ch
        elif ch in UNQUOTED:
            return True
    return quote is not None          # an unclosed quote is not a plain command


def check(command):
    """Return None when the command is allowed, else a plain reason."""
    if not isinstance(command, str) or not command.strip():
        return "Empty command."
    if unsafe(command):
        return ("Blocked: Day Desk chat runs one plain command at a time, with no $(), backticks, "
                "variables, pipes, redirects, ; or &&. Pass text in plain quotes.")
    if not SCRIPTS.search(command):
        return "Blocked: Day Desk chat may run only the plugin's tasks.py and email_rules.py."
    return None


def main():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print("Blocked: unreadable hook input.", file=sys.stderr)
        return 2
    tool = data.get("tool_name", "")
    if tool not in ("Bash", "PowerShell"):
        return 0
    reason = check((data.get("tool_input") or {}).get("command"))
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
