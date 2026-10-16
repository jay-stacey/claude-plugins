"""CLI transcript (JSONL) parsing into console turns, read incrementally.

The JSONL format is the CLI's own and not documented, so every field is
optional and a bad line is skipped, never fatal.
"""
import datetime as dt
import json
import os
import re
import threading

MAX_TEXT = 4000
MAX_SUMMARY = 120
MAX_TURNS = 20000
MAX_FIRST_READ = 64 * 1024 * 1024   # a transcript bigger than this is read from its last 64 MB

PEER_RE = re.compile(r'<cross-session-message\b([^>]*)>(.*?)(?:</cross-session-message>|$)', re.S)
NAME_RE = re.compile(r'\bname="([^"]*)"')
TAG_BLOCK_RE = re.compile(r"<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>.*?</\1>", re.S)
COMMAND_RE = re.compile(r"<command-name>\s*([^<]*?)\s*</command-name>")
COMMAND_ARGS_RE = re.compile(r"<command-args>\s*([^<]*?)\s*</command-args>")
ANY_TAG_RE = re.compile(r"</?(command-message|command-name|command-args)>")


def clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 2)].rstrip() + " …"


def to_ms(value):
    """ISO 8601 or epoch (s or ms) to epoch ms; None when unreadable."""
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    if isinstance(value, str) and value:
        try:
            return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def block_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def clean_prompt(text: str) -> str:
    text = TAG_BLOCK_RE.sub("", text or "")
    m = COMMAND_RE.search(text)
    if m:
        args = COMMAND_ARGS_RE.search(text)
        name = m.group(1)
        if not name.startswith("/"):
            name = "/" + name
        return (name + (" " + args.group(1) if args and args.group(1) else "")).strip()
    return ANY_TAG_RE.sub("", text).strip()


def tool_summary(tool_input) -> str | None:
    if not isinstance(tool_input, dict):
        return None
    for key in ("command", "file_path", "pattern", "description", "url", "query", "prompt"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return clip(" ".join(value.split()), MAX_SUMMARY)
    for value in tool_input.values():
        if isinstance(value, str) and value.strip():
            return clip(" ".join(value.split()), MAX_SUMMARY)
    return None


def parse_row(row) -> tuple[list, dict | None]:
    """One JSONL row to (turns, peer). `peer` is {"from": "local_...", "name": ...}
    when the row is a message another desktop session sent."""
    if not isinstance(row, dict) or row.get("isSidechain"):
        return [], None
    kind = row.get("type")
    if kind not in ("user", "assistant"):
        return [], None
    origin = row.get("origin") if isinstance(row.get("origin"), dict) else {}
    sender = origin.get("from") if isinstance(origin.get("from"), str) else ""
    is_peer = origin.get("kind") == "peer" and sender.startswith("local_")
    if row.get("isMeta") and not is_peer:
        return [], None
    msg = row.get("message") if isinstance(row.get("message"), dict) else {}
    content = msg.get("content")
    uuid = row.get("uuid") if isinstance(row.get("uuid"), str) else None
    if not uuid:
        return [], None
    at = to_ms(row.get("timestamp"))

    if kind == "user":
        if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return [], None
        if origin.get("kind") == "task-notification":
            return [], None
        raw = block_text(content)
        peer = None
        if is_peer:
            m = PEER_RE.search(raw)
            name = None
            if m:
                n = NAME_RE.search(m.group(1))
                name = n.group(1) if n else None
                raw = m.group(2)
            peer = {"from": sender, "name": name}
        text = clean_prompt(raw)
        if not text:
            return [], peer
        return [{"uuid": uuid, "role": "user", "at": at, "text": clip(text, MAX_TEXT),
                 "toolName": None, "toolSummary": None,
                 "fromSession": (peer or {}).get("name") or (sender if peer else None)}], peer

    turns = []
    blocks = content if isinstance(content, list) else ([{"type": "text", "text": content}] if isinstance(content, str) else [])
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            continue
        tid = uuid if not turns else f"{uuid}:{i}"
        if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
            turns.append({"uuid": tid, "role": "assistant", "at": at, "text": clip(b["text"], MAX_TEXT),
                          "toolName": None, "toolSummary": None, "fromSession": None})
        elif b.get("type") == "tool_use":
            name = b.get("name") if isinstance(b.get("name"), str) else "tool"
            summary = tool_summary(b.get("input"))
            turns.append({"uuid": tid, "role": "tool", "at": at, "text": summary or name,
                          "toolName": name, "toolSummary": summary, "fromSession": None})
    return turns, None


class Transcript:
    """One JSONL file, parsed incrementally as it grows."""

    def __init__(self, path):
        self.path = str(path)
        self.offset = 0
        self.partial = b""
        self.turns = []
        self.lock = threading.Lock()

    def refresh(self) -> tuple[list, list]:
        """Reads what was appended since last time. Returns (new turns, peers)."""
        with self.lock:
            try:
                size = os.path.getsize(self.path)
            except OSError:
                return [], []
            if size < self.offset:          # rewritten: start over
                self.offset, self.partial, self.turns = 0, b"", []
            if size == self.offset:
                return [], []
            start = self.offset
            if start == 0 and size > MAX_FIRST_READ:
                start = size - MAX_FIRST_READ
            try:
                with open(self.path, "rb") as fh:
                    fh.seek(start)
                    data = fh.read(size - start)
            except OSError:
                return [], []
            if start != self.offset:
                data = data.split(b"\n", 1)[1] if b"\n" in data else b""
            self.offset = size
            data = self.partial + data
            lines = data.split(b"\n")
            self.partial = lines.pop()
            new_turns, peers = [], []
            for line in lines:
                turns, peer = parse_line(line)
                new_turns += turns
                if peer:
                    peers.append(peer)
            self.turns += new_turns
            if len(self.turns) > MAX_TURNS:
                self.turns = self.turns[-MAX_TURNS:]
            return new_turns, peers

    def page(self, limit=60, before=None) -> dict:
        self.refresh()
        with self.lock:
            turns = self.turns
            end = len(turns)
            if before:
                idx = next((i for i in range(len(turns) - 1, -1, -1) if turns[i]["uuid"] == before), None)
                end = idx if idx is not None else len(turns)
            limit = max(1, min(int(limit or 60), 500))
            start = max(0, end - limit)
            chunk = turns[start:end]
            return {"turns": [dict(t) for t in chunk], "cursor": chunk[0]["uuid"] if start > 0 and chunk else None}


def parse_line(line: bytes):
    line = line.strip()
    if not line:
        return [], None
    try:
        row = json.loads(line.decode("utf-8", errors="replace"))
    except ValueError:
        return [], None
    try:
        return parse_row(row)
    except Exception:
        return [], None


class Tail:
    """Watches a transcript's size for activity pulses and reads only the
    appended bytes for peer messages. Starts at the current end."""

    def __init__(self, path):
        self.path = str(path)
        try:
            self.offset = os.path.getsize(self.path)
        except OSError:
            self.offset = 0
        self.partial = b""

    def poll(self) -> tuple[bool, list]:
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return False, []
        if size < self.offset:
            self.offset, self.partial = size, b""
            return True, []
        if size == self.offset:
            return False, []
        try:
            with open(self.path, "rb") as fh:
                fh.seek(self.offset)
                data = fh.read(min(size - self.offset, 8 * 1024 * 1024))
        except OSError:
            return False, []
        self.offset += len(data)
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()
        peers = []
        for line in lines:
            _, peer = parse_line(line)
            if peer:
                peers.append(peer)
        return True, peers
