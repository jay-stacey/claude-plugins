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
    t = naturalize(t)
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
    # A sentence that now starts with "pull request" or "for example" gets its capital back,
    # so chunks() still sees the sentence break.
    t = re.sub(r"(^|[.!?]\s+)(pull request|for example|that is|about|number)\b",
               lambda m: m.group(1) + m.group(2)[0].upper() + m.group(2)[1:], t)
    for note in notes:
        if note not in t:
            t = f"{t} {note}".strip()
    return t


def chunks(text: str, first_max: int = 90, max_len: int = 180) -> list[str]:
    """Speech chunks of one or two sentences.

    Chatterbox has no streaming, so time to first audio is the first chunk's synthesis time:
    the first chunk is one sentence (cut at a comma when long). Later chunks hold up to two
    sentences, so there are fewer joins (each join is a short pause) and the synthesizer
    stays ahead of playback.
    """
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    sentences: list[str] = []
    for s in re.split(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])", text):
        s = s.strip()
        if s:
            sentences.extend(_split_long(s, first_max if not sentences else max_len, max_len))
    out: list[str] = [sentences[0]]
    count = 1  # sentences in out[-1]
    for s in sentences[1:]:
        tiny = len(s) < 12
        # A chunk may grow to about 1.6 times the one before it. Synthesis takes roughly 0.6 of
        # the audio's length (Chatterbox on the RTX 4060), so chunk n+1 is ready before chunk n
        # ends and the join stays a short pause.
        limit = max_len if len(out) < 2 else min(max_len, int(1.6 * len(out[-2])) + 20)
        if len(out) > 1 and (count < 2 or tiny) and len(out[-1]) + 1 + len(s) <= limit:
            out[-1] = f"{out[-1]} {s}"
            count += 1
        elif len(out) == 1 and tiny and len(out[0]) + 1 + len(s) <= first_max:
            out[0] = f"{out[0]} {s}"
        else:
            grow = min(max_len, int(1.6 * len(out[-1])) + 20)
            parts = _split_long(s, grow, max_len) if len(s) > grow else [s]
            out.extend(parts)
            count = 1
    return out


clauses = chunks  # the name used before 0.1.1


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


def strip_wake(text: str, phrase: str = "hey chief", name: str = "") -> str:
    """Remove a leading wake phrase ("Hey Chief,") or the Chief's name from a transcript
    (the capture includes the wake word)."""
    t = text or ""
    # Repeated wake phrases ("Hey Chief. Hey Chief, what needs me?") all go, so a
    # capture that holds only the wake phrase ends up empty and is dropped.
    for _ in range(4):
        before = t
        if " ".join(phrase.lower().split()) == "hey chief":
            t = _WAKE_PREFIX.sub("", t, count=1)
        else:
            words = [re.escape(w) for w in re.findall(r"[a-z0-9']+", phrase.lower())]
            if words:
                t = re.sub(r"^\s*" + r"[\s,.!-]*".join(words) + r"\b[\s,.!?:;-]*", "", t, count=1, flags=re.I)
        if name:
            t = re.sub(r"^\s*" + re.escape(name) + r"\b[\s,.!?:;-]+", "", t, count=1, flags=re.I)
        if t == before:
            break
    t = t.strip()
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    return t


def is_noise(text: str) -> bool:
    """Whisper's usual output for silence or noise."""
    t = re.sub(r"[^a-z ]", "", (text or "").lower()).strip()
    return t in {"", "you", "thank you", "thanks for watching", "thank you for watching", "bye"}


# --------------------------------------------------------------------------- natural reading
_ONES = ("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
         "fifteen sixteen seventeen eighteen nineteen").split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def two_digits(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (f" {_ONES[ones]}" if ones else "")


def say_number(n: int) -> str:
    """How a person reads a pull request or issue number: 24 "twenty four",
    216 "two sixteen", 1205 "twelve oh five", 1737 "seventeen thirty seven"."""
    if n < 100:
        return two_digits(n)
    if n < 1000:
        h, r = divmod(n, 100)
        if r == 0:
            return f"{_ONES[h]} hundred"
        return f"{_ONES[h]} " + (f"oh {_ONES[r]}" if r < 10 else two_digits(r))
    if n < 10000:
        h, r = divmod(n, 100)
        if n % 1000 == 0:
            return f"{_ONES[n // 1000]} thousand"
        if r == 0:
            return f"{two_digits(h)} hundred"
        return f"{two_digits(h)} " + (f"oh {_ONES[r]}" if r < 10 else two_digits(r))
    return " ".join(_ONES[int(d)] for d in str(n))


def spell(s: str) -> str:
    """Letters one by one, digits as words: "DP1" -> "D P one"."""
    return " ".join(_ONES[int(c)] if c.isdigit() else c.upper() for c in s if c.isalnum())


_PR = re.compile(r"\b(?:PRs?|[Pp]ull [Rr]equest)[\s-]*#?\s*(\d{1,5})\b")
_PRS = re.compile(r"\bPRs\b")
_PR_WORD = re.compile(r"\bPR\b")
# Ticket keys: 2 to 5 capitals or digits starting with a capital, a dash, 1 to 5 digits (DP1-676, NEO-123).
_TICKET = re.compile(r"\b([A-Z][A-Z0-9]{1,4})-(\d{1,5})\b")
_TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*([AaPp])\.?[Mm]\.?)?(?![\d:])")
_HASH_NUM = re.compile(r"(?<![\w&])#(\d{1,6})\b")


def _time(m: re.Match) -> str:
    h, mm, ampm = int(m.group(1)), int(m.group(2)), m.group(3)
    words = two_digits(h)
    if mm == 0:
        words += "" if ampm else " o'clock"
    else:
        words += f" oh {_ONES[mm]}" if mm < 10 else f" {two_digits(mm)}"
    if ampm:
        words += f" {ampm.upper()} M"
    return words


def naturalize(t: str) -> str:
    """Make leftover symbols, ticket keys, pull request numbers and times read naturally.
    Conservative: anything it does not recognise is left as it is."""
    t = _TIME.sub(_time, t)
    t = _PR.sub(lambda m: f"pull request {say_number(int(m.group(1)))}", t)
    t = _PRS.sub("pull requests", t)
    t = _PR_WORD.sub("pull request", t)
    t = _TICKET.sub(lambda m: f"{spell(m.group(1))} {spell(m.group(2))}", t)
    t = _HASH_NUM.sub(lambda m: f"number {say_number(int(m.group(1)))}", t)
    t = re.sub(r"\s*(?:->|=>|→|⇒)\s*", " to ", t)
    t = re.sub(r"\s*(?:<-|←)\s*", " from ", t)
    t = re.sub(r"(?<=\w)\s*&\s*(?=\w)", " and ", t)
    t = t.replace("&", " and ")
    t = re.sub(r"(\d)\s*%", r"\1 percent", t)
    t = re.sub(r"(?<=\d)\s*\+(?=\s|$|[.,;])", " plus", t)
    t = re.sub(r"(?<![\w~])~\s*(?=\d)", "about ", t)
    t = re.sub(r"\s+=\s+", " equals ", t)
    t = re.sub(r"\be\.g\.,?", "for example", t)
    t = re.sub(r"\bi\.e\.,?", "that is", t)
    t = re.sub(r"\betc\.", "and so on.", t)
    t = re.sub(r"\bvs\.?(?=\s)", "versus", t)
    t = re.sub(r"(?<=[A-Za-z])/(?=[A-Za-z])", " or ", t)
    t = re.sub(r"(?<=\w)_(?=\w)", " ", t)          # snake_case -> snake case
    t = re.sub(r"[*_`#\\^{}<>\[\]~]+", " ", t)     # leftover markdown or code symbols
    t = re.sub(r"(?<=\s)/(?=\s)|^/|/$", " ", t)
    return re.sub(r"[ \t]{2,}", " ", t)
