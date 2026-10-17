"""CLI transcript (JSONL) parsing into console turns, read incrementally.

The JSONL format is the CLI's own and not documented, so every field is
optional and a bad line is skipped, never fatal.
"""
import datetime as dt
import json
import os
import re
import threading
import time

MAX_TEXT = 4000
MAX_SUMMARY = 120
MAX_TURNS = 20000
MAX_WAITING_RESULTS = 2000
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
        return [dict(uuid=uuid, role="user", at=at, text=clip(text, MAX_TEXT), toolName=None, toolSummary=None,
                     fromSession=(peer or {}).get("name") or (sender if peer else None), **NO_TOOL)], peer

    turns = []
    blocks = content if isinstance(content, list) else ([{"type": "text", "text": content}] if isinstance(content, str) else [])
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            continue
        tid = uuid if not turns else f"{uuid}:{i}"
        if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
            turns.append(dict(uuid=tid, role="assistant", at=at, text=clip(b["text"], MAX_TEXT), toolName=None,
                              toolSummary=None, fromSession=None, **NO_TOOL))
        elif b.get("type") == "tool_use":
            name = b.get("name") if isinstance(b.get("name"), str) else "tool"
            question = question_of(b.get("input")) if name == "AskUserQuestion" else None
            summary = tool_summary(b.get("input"))
            if summary is None and question and question["questions"]:
                summary = clip(question["questions"][0]["question"] or question["questions"][0]["header"], MAX_SUMMARY) or None
            turn = {"uuid": tid, "role": "tool", "at": at, "text": summary or name, "toolName": name,
                    "toolSummary": summary, "fromSession": None, "toolResult": None, "toolError": False,
                    "question": question}
            if isinstance(b.get("id"), str):
                turn["_toolUseId"] = b["id"]
            turns.append(turn)
    return turns, None


# The tool fields of a turn that is not a tool call.
NO_TOOL = {"toolResult": None, "toolError": None, "question": None}
MAX_RESULT = 160
MAX_ANSWER = 500
MAX_QUESTIONS = 4
MAX_OPTIONS = 8
ANSWER_PAIR_RE = re.compile(r'"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"')


def _str(value, limit):
    return clip(value, limit) if isinstance(value, str) else ""


def question_of(tool_input):
    """AskUserQuestion's input in the console's shape, every field checked and clipped."""
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("questions"), list):
        return None
    questions = []
    for q in tool_input["questions"][:MAX_QUESTIONS]:
        if not isinstance(q, dict):
            continue
        options = []
        for o in (q.get("options") if isinstance(q.get("options"), list) else [])[:MAX_OPTIONS]:
            if isinstance(o, dict):
                options.append({"label": _str(o.get("label"), 120), "description": _str(o.get("description"), 300)})
            elif isinstance(o, str):
                options.append({"label": clip(o, 120), "description": ""})
        questions.append({"header": _str(q.get("header"), 60), "question": _str(q.get("question"), 500),
                          "multiSelect": q.get("multiSelect") is True, "options": options})
    return {"questions": questions, "answer": None}


def result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
    return ""


def short_result(text: str) -> str:
    """The first line with words in it, cut to about 160 characters."""
    for line in (text or "").splitlines():
        if line.strip():
            return clip(" ".join(line.split()), MAX_RESULT)
    return ""


def tool_results(row):
    """The tool_result blocks of a user row: [{"id", "text", "isError", "answers"}]."""
    if not isinstance(row, dict) or row.get("type") != "user" or row.get("isSidechain"):
        return []
    msg = row.get("message") if isinstance(row.get("message"), dict) else {}
    content = msg.get("content")
    if not isinstance(content, list):
        return []
    record = row.get("toolUseResult") if isinstance(row.get("toolUseResult"), dict) else {}
    answers = record.get("answers") if isinstance(record.get("answers"), dict) else None
    out = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str):
            out.append({"id": b["tool_use_id"], "text": result_text(b.get("content")),
                        "isError": b.get("is_error") is True, "answers": answers})
    return out


def answer_of(question, result):
    """The chosen answers in question order, joined by "; ", from the tool's own record,
    else from the result text's "question"="answer" pairs, else the text itself."""
    if result["isError"]:
        return None
    asked = [q["question"] for q in question["questions"]]
    picked = []
    if result["answers"]:
        for q in asked:
            a = result["answers"].get(q)
            if isinstance(a, str) and a.strip():
                picked.append(a.strip())
        if not picked:
            picked = [a.strip() for a in result["answers"].values() if isinstance(a, str) and a.strip()]
    if not picked:
        picked = [a for _, a in ANSWER_PAIR_RE.findall(result["text"]) if a.strip()]
    text = "; ".join(picked) if picked else result["text"].strip()
    return clip(text, MAX_ANSWER) or None


def apply_result(turn, result):
    turn["toolResult"] = short_result(result["text"]) or None
    turn["toolError"] = result["isError"]
    if turn.get("question") is not None:
        turn["question"]["answer"] = answer_of(turn["question"], result)


def public_turn(turn):
    out = {k: v for k, v in turn.items() if not k.startswith("_")}
    if isinstance(out.get("question"), dict):
        q = out["question"]
        out["question"] = {"questions": [dict(x, options=[dict(o) for o in x["options"]]) for x in q["questions"]],
                           "answer": q["answer"]}
    return out


class Transcript:
    """One JSONL file, parsed incrementally as it grows."""

    def __init__(self, path):
        self.path = str(path)
        self.offset = 0
        self.partial = b""
        self.turns = []
        self.waiting = {}       # tool_use id -> the tool turn whose result has not come yet
        self.lock = threading.Lock()

    def refresh(self) -> tuple[list, list]:
        """Reads what was appended since last time. Returns (new turns, peers)."""
        with self.lock:
            try:
                size = os.path.getsize(self.path)
            except OSError:
                return [], []
            if size < self.offset:          # rewritten: start over
                self.offset, self.partial, self.turns, self.waiting = 0, b"", [], {}
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
                turns, peer, results = parse_line_full(line)
                for t in turns:
                    if t.get("_toolUseId"):
                        self.waiting[t["_toolUseId"]] = t
                new_turns += turns
                if peer:
                    peers.append(peer)
                # A tool's result comes in a later row: it fills in the call's turn.
                for r in results:
                    turn = self.waiting.pop(r["id"], None)
                    if turn is not None:
                        apply_result(turn, r)
            while len(self.waiting) > MAX_WAITING_RESULTS:
                self.waiting.pop(next(iter(self.waiting)))
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
            return {"turns": [public_turn(t) for t in chunk], "cursor": chunk[0]["uuid"] if start > 0 and chunk else None}


def parse_line(line: bytes):
    turns, peer, _ = parse_line_full(line)
    return turns, peer


def parse_line_full(line: bytes):
    """(turns, peer, tool results) of one JSONL line; a bad line gives nothing."""
    line = line.strip()
    if not line:
        return [], None, []
    try:
        row = json.loads(line.decode("utf-8", errors="replace"))
    except ValueError:
        return [], None, []
    try:
        turns, peer = parse_row(row)
        return turns, peer, tool_results(row)
    except Exception:
        return [], None, []


# ------------------------------------------------------- background work ---

BACKGROUND_TOOLS = ("Bash", "Agent", "Task")
STOP_TOOLS = ("KillShell", "KillBash", "TaskStop")
BACKGROUND_FIRST_READ = 16 * 1024 * 1024
# Lines worth a JSON parse for this scan; every other line is skipped unread.
BACKGROUND_MARKS = (b"run_in_background", b"task-notification", b"handback", b"KillShell", b"KillBash", b"TaskStop")
NOTE_TOOL_RE = re.compile(r"<tool-use-id>\s*([^<\s]+)\s*</tool-use-id>")
NOTE_TASK_RE = re.compile(r"<task-id>\s*([^<\s]+)\s*</task-id>")


class BackgroundWork:
    """Background work a session started and has not seen finish: a Bash call or an
    Agent run with run_in_background true, until its <task-notification> (in a user
    row or a queued one), a sub-agent's hand-back, or a stop tool names it.
    Read incrementally, from the last 16 MB on the first read."""

    def __init__(self, path):
        self.path = str(path)
        self.offset = 0
        self.partial = b""
        self.open = {}          # tool_use id -> {"at": ms, "taskId": str | None}

    def poll(self):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return self.started()
        if size < self.offset:
            self.offset, self.partial, self.open = 0, b"", {}
        if size == self.offset:
            return self.started()
        start = self.offset
        if start == 0 and size > BACKGROUND_FIRST_READ:
            start = size - BACKGROUND_FIRST_READ
        try:
            with open(self.path, "rb") as fh:
                fh.seek(start)
                data = fh.read(size - start)
        except OSError:
            return self.started()
        if start != self.offset:
            data = data.split(b"\n", 1)[1] if b"\n" in data else b""
        self.offset = size
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()
        for line in lines:
            if not any(m in line for m in BACKGROUND_MARKS) and not (self.open and b"tool_result" in line):
                continue
            try:
                self.read_row(json.loads(line.decode("utf-8", errors="replace")))
            except Exception:
                continue
        return self.started()

    def started(self):
        """Start times (ms) of the work still open."""
        return [w["at"] for w in self.open.values()]

    def finish(self, tool_ids=(), task_ids=()):
        for tid in list(self.open):
            if tid in tool_ids or (self.open[tid]["taskId"] and self.open[tid]["taskId"] in task_ids):
                del self.open[tid]

    def read_row(self, row):
        if not isinstance(row, dict) or row.get("isSidechain"):
            return
        kind = row.get("type")
        msg = row.get("message") if isinstance(row.get("message"), dict) else {}
        content = msg.get("content")
        if kind == "queue-operation":
            content = row.get("content")
        text = block_text(content)
        if "<task-notification>" in text:
            self.finish(set(NOTE_TOOL_RE.findall(text)), set(NOTE_TASK_RE.findall(text)))
        origin = row.get("origin") if isinstance(row.get("origin"), dict) else {}
        if origin.get("kind") == "peer" and origin.get("handback") and isinstance(origin.get("from"), str):
            self.finish(task_ids={origin["from"]})
        if not isinstance(content, list):
            return
        at = to_ms(row.get("timestamp")) or int(time.time() * 1000)
        record = row.get("toolUseResult") if isinstance(row.get("toolUseResult"), dict) else {}
        for b in content:
            if not isinstance(b, dict):
                continue
            if kind == "assistant" and b.get("type") == "tool_use" and isinstance(b.get("id"), str):
                tool_input = b.get("input") if isinstance(b.get("input"), dict) else {}
                if b.get("name") in BACKGROUND_TOOLS and tool_input.get("run_in_background") is True:
                    self.open[b["id"]] = {"at": at, "taskId": None}
                elif b.get("name") in STOP_TOOLS:
                    ids = {v for k, v in tool_input.items() if k in ("shell_id", "task_id", "bash_id") and isinstance(v, str)}
                    self.finish(task_ids=ids)
            elif kind == "user" and b.get("type") == "tool_result" and b.get("tool_use_id") in self.open:
                tid = b["tool_use_id"]
                if b.get("is_error") is True or record.get("status") == "completed":
                    del self.open[tid]          # it never started, or ran to the end in the foreground
                    continue
                task = record.get("backgroundTaskId") or record.get("agentId") or record.get("shellId")
                if isinstance(task, str):
                    self.open[tid]["taskId"] = task


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
