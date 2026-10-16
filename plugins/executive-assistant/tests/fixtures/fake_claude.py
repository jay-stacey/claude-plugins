#!/usr/bin/env python3
"""A stand-in for `claude -p --output-format stream-json` in tests.

Reads the prompt from stdin and writes a realistic stream: system/init, a few
partial text deltas, one assistant tool_use, the final assistant message and
a result. Environment options:

    FAKE_CLAUDE_ARGS      append {"argv", "stdin"} as one JSON line to this file
    FAKE_CLAUDE_SESSION   session id for a new session (default sess-new-1)
    FAKE_CLAUDE_TOOLS     comma-separated tool names for system/init
    FAKE_CLAUDE_EXIT      exit with this code after init, with no result
    FAKE_CLAUDE_IS_ERROR  "1": the result has is_error true
    FAKE_CLAUDE_ERROR_RESULT  send only a failed API call with this text, as the real CLI does
    FAKE_CLAUDE_SLOW      sleep this many seconds after init (timeout tests)
    FAKE_CLAUDE_CHILD     "1": start a child that sleeps too (tree-kill tests);
                          its pid goes to FAKE_CLAUDE_ARGS + ".child"
    FAKE_CLAUDE_RESULT    the final result text (default "Your Now task is X.")
    FAKE_CLAUDE_PIDFILE   write this process's pid here
"""
import json
import os
import subprocess
import sys
import time

DEFAULT_TOOLS = ["Task", "Agent", "Bash", "Read", "Glob", "Grep", "Skill", "ToolSearch", "TodoWrite",
                 "Write", "Edit", "WebFetch",
                 "mcp__google-workspace__get_events", "mcp__google-workspace__send_gmail_message"]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    argv = sys.argv[1:]
    stdin = sys.stdin.read()
    rec = os.environ.get("FAKE_CLAUDE_ARGS")
    if rec:
        with open(rec, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"argv": argv, "stdin": stdin}) + "\n")
    pidfile = os.environ.get("FAKE_CLAUDE_PIDFILE")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    sid = os.environ.get("FAKE_CLAUDE_SESSION", "sess-new-1")
    if "--resume" in argv:
        sid = argv[argv.index("--resume") + 1]
    tools = os.environ.get("FAKE_CLAUDE_TOOLS")
    tools = tools.split(",") if tools else DEFAULT_TOOLS
    emit({"type": "system", "subtype": "init", "session_id": sid, "tools": tools,
          "model": "claude-fake", "permissionMode": "dontAsk", "mcp_servers": []})

    if os.environ.get("FAKE_CLAUDE_CHILD") == "1":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        if rec:
            with open(rec + ".child", "w", encoding="utf-8") as fh:
                fh.write(str(child.pid))
    slow = float(os.environ.get("FAKE_CLAUDE_SLOW") or 0)
    if slow:
        time.sleep(slow)
    code = int(os.environ.get("FAKE_CLAUDE_EXIT") or 0)
    if code:
        sys.stderr.write("fake failure\n")
        return code

    api_error = os.environ.get("FAKE_CLAUDE_ERROR_RESULT")
    if api_error:
        # How the real CLI reports a failed API call, such as being signed out.
        emit({"type": "assistant", "parent_tool_use_id": None, "session_id": sid,
              "error": "authentication_failed", "is_api_error_message": True,
              "message": {"id": "msg_e", "model": "<synthetic>", "role": "assistant",
                          "content": [{"type": "text", "text": api_error}]}})
        emit({"type": "result", "subtype": "success", "is_error": True, "result": api_error,
              "session_id": sid, "num_turns": 1, "duration_ms": 5, "total_cost_usd": 0.0})
        return 0

    text = os.environ.get("FAKE_CLAUDE_RESULT", "Your Now task is X.")
    parts = [text[:5], text[5:12], text[12:]] if len(text) > 12 else [text]
    emit({"type": "stream_event", "parent_tool_use_id": None, "session_id": sid,
          "event": {"type": "message_start", "message": {"id": "msg_1"}}})
    emit({"type": "stream_event", "parent_tool_use_id": None, "session_id": sid,
          "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
    for p in parts:
        if p:
            emit({"type": "stream_event", "parent_tool_use_id": None, "session_id": sid,
                  "event": {"type": "content_block_delta", "index": 0,
                            "delta": {"type": "text_delta", "text": p}}})
    emit({"type": "assistant", "parent_tool_use_id": None, "session_id": sid,
          "message": {"id": "msg_1", "role": "assistant", "content": [
              {"type": "text", "text": text},
              {"type": "tool_use", "id": "toolu_1", "name": "mcp__google-workspace__get_events",
               "input": {"time_min": "2026-10-13T00:00:00-04:00"}}]}})
    emit({"type": "user", "parent_tool_use_id": None, "session_id": sid,
          "message": {"role": "user", "content": [
              {"type": "tool_result", "tool_use_id": "toolu_1", "content": "[]"}]}})
    is_error = os.environ.get("FAKE_CLAUDE_IS_ERROR") == "1"
    emit({"type": "result", "subtype": "error_during_execution" if is_error else "success",
          "is_error": is_error, "result": "" if is_error else text, "session_id": sid,
          "num_turns": 2, "duration_ms": 12, "total_cost_usd": 0.0})
    return 0


if __name__ == "__main__":
    sys.exit(main())
