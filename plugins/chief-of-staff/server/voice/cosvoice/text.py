"""Text rules for speech: what to read aloud, and how to split it into clauses.

Never read code blocks or URLs aloud. A reply with a URL says "I've put the link on screen."
"""

from __future__ import annotations

import re

LINK_NOTE = "I've put the link on screen."
CODE_NOTE = "I've put the code on screen."

_FENCE = re.compile(r"```.*?(```|$)|~~~.*?(~~~|$)", re.S)
_CONFIRM = re.compile(r"^\s*\[\[confirm:.*?\]\]\s*$", re.M | re.I)
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)")
_URL = re.compile(r"(?:\bhttps?://|\bwww\.)[^\s<>()\[\]]+|<https?://[^>]+>", re.I)
_EMAIL_LIKE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b")
_WIN_PATH = re.compile(r"\b[A-Za-z]:\\[^\s,;]+")
_POSIX_PATH = re.compile(r"(?<![\w.])(?:~|\.{1,2})?/(?:[\w.-]+/)+[\w.-]*")
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_HTML = re.compile(r"</?[a-zA-Z][^>]*>")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_QUOTE = re.compile(r"^\s{0,3}>\s?", re.M)
_BULLET = re.compile(r"^\s*(?:[-*+•]|\d+[.)])\s+", re.M)
_TABLE_RULE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.M)
_HR = re.compile(r"^\s*([-*_])\s*(\1\s*){2,}$", re.M)
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|~~)(?=\S)(.+?)(?<=\S)\1")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF️‍]")
_WAKE_PREFIX = re.compile(r"^\s*(?:hey|hay|hi|a|ok|okay)[\s,.!-]*(?:chief|cheef|chef|cheap)\b[\s,.!?:;-]*", re.I)


def speakable(text: str) -> str:
    """Plain words to read aloud from a Chief reply (markdown, code and links removed)."""
    if not text:
        return ""
    notes: list[str] = []
    t = _CONFIRM.sub("", text)
    if _FENCE.search(t):
        t = _FENCE.sub(" ", t)
        notes.append(CODE_NOTE)
    had_link = False

    def link_text(m: re.Match) -> str:
        nonlocal had_link
        had_link = True
        label = m.group(1).strip()
        return label if label and not _URL.match(label) else ""

    t = _MD_LINK.sub(link_text, t)
    if _URL.search(t):
        had_link = True
        t = _URL.sub("", t)
    if had_link:
        notes.append(LINK_NOTE)
    t = _EMAIL_LIKE.sub("", t)
    t = _WIN_PATH.sub("", t)
    t = _POSIX_PATH.sub("", t)

    def inline(m: re.Match) -> str:
        inner = m.group(1).strip()
        # Short names read fine ("npm test"); long or path-like code does not.
        if len(inner) > 32 or any(c in inner for c in "/\\{}<>=;$"):
            return ""
        return inner

    t = _INLINE_CODE.sub(inline, t)
    t = _HTML.sub(" ", t)
    t = _TABLE_RULE.sub("", t)
    t = _HR.sub("", t)
    t = _HEADING.sub("", t)
    t = _QUOTE.sub("", t)
    t = _BULLET.sub("", t)
    for _ in range(2):
        t = _EMPHASIS.sub(r"\2", t)
    t = t.replace("|", ", ")
    t = _EMOJI.sub("", t)
    lines = []
    for line in t.splitlines():
        line = re.sub(r"\s+", " ", line).strip(" ,")
        if not line:
            continue
        if line[-1] not in ".!?:;,":
            line += "."
        lines.append(line)
    t = " ".join(lines)
    t = re.sub(r"\s+([,.!?;:])", r"\1", t)
    t = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", t)
    t = re.sub(r"\(\s*\)|\[\s*\]", "", t)
    t = re.sub(r"\s{2,}", " ", t).strip()
    for note in notes:
        if note not in t:
            t = f"{t} {note}".strip()
    return t


def clauses(text: str, first_max: int = 70, max_len: int = 160) -> list[str]:
    """Split into sentences, then split long ones at commas or semicolons.

    Chatterbox has no streaming, so time to first audio is the first clause's synthesis time.
    The first clause is kept short so speech starts sooner (Pepper speak_queue pattern).
    """
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    sentences = re.split(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])", text)
    out: list[str] = []
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        limit = first_max if not out else max_len
        out.extend(_split_long(s, limit, max_len))
    # Glue tiny tails ("OK.") onto the clause before so they do not cost a synth call.
    merged: list[str] = []
    for c in out:
        if merged and len(c) < 12 and len(merged[-1]) + len(c) < max_len:
            merged[-1] = f"{merged[-1]} {c}"
        else:
            merged.append(c)
    return merged


def _split_long(s: str, limit: int, max_len: int) -> list[str]:
    if len(s) <= limit:
        return [s]
    parts = re.split(r"(?<=[,;:])\s+", s)
    out: list[str] = []
    cur = ""
    for p in parts:
        cap = limit if not out else max_len
        if cur and len(cur) + 1 + len(p) > cap:
            out.append(cur)
            cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        out.append(cur)
    final: list[str] = []
    for c in out:  # still too long with no commas: cut at a word boundary
        while len(c) > max_len:
            cut = c.rfind(" ", 0, max_len)
            cut = cut if cut > 20 else max_len
            final.append(c[:cut].strip())
            c = c[cut:].strip()
        if c:
            final.append(c)
    return final


def strip_wake(text: str) -> str:
    """Remove a leading "Hey Chief," from a transcript (the capture includes the wake word)."""
    t = _WAKE_PREFIX.sub("", text or "", count=1).strip()
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    return t


def is_noise(text: str) -> bool:
    """Whisper's usual output for silence or noise."""
    t = re.sub(r"[^a-z ]", "", (text or "").lower()).strip()
    return t in {"", "you", "thank you", "thanks for watching", "thank you for watching", "bye"}
