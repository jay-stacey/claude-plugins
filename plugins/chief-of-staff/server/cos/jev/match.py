"""Jev's delegation check: does an open session already own this work?

A pure, fast word match, no model and no I/O. It runs after the route is picked:
work that would start a new session goes to an existing one instead only when
exactly one open session clearly matches. A wrong delegation sends Jay's words
into the wrong conversation, so every doubt means no match and a new session.
"""
import re

# Sessions that can take more work. "stale" sessions are old or their pull request
# merged or closed, so new work there would be lost or start a second PR.
OPEN_STATES = ("active", "wait", "you")
TICKET_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,6})\b")  # NEO-12, DP1-687, if-39
WORD_RE = re.compile(r"[a-z0-9][a-z0-9.+#-]*[a-z0-9]|[a-z0-9]")
# Words that say nothing about which work it is.
STOP = frozenset("""
a an the and or but for nor so yet to of in on at by with from into onto over under up down out off
this that these those it its it's is are was were be been being am do does did done doing have has had
i me my we our us you your he she they them their his her who what which when where why how
can could would should will shall may might must please just also then now still again more some any all
new old one two three get got make made let lets need needs want wants like see look looking work working
session sessions chief jev task tasks thing things stuff issue issues ticket tickets bug bugs fix fixes fixed
add adds added update updates updated change changes changed write writes build builds review reviews test tests
implement investigate research refactor create debug plan design remove delete rename check run running
code repo branch pr file files page pages there here about after before because while same other another
""".split())
MIN_SHARED = 2          # at least two real words in common with the title
MIN_TITLE_SHARE = 0.5   # and at least half of the title's real words


def tickets(text: str) -> set:
    """Ticket keys like NEO-123, upper case. Bare numbers do not count."""
    return {f"{a.upper()}-{int(b)}" for a, b in TICKET_RE.findall(text or "")}


def words(text: str) -> set:
    """The words that name the work: lower case, no stop words, no ticket keys, no short bits."""
    text = TICKET_RE.sub(" ", (text or "").lower())
    out = set()
    for w in WORD_RE.findall(text):
        w = w.strip(".-")
        if len(w) < 3 or w in STOP or w.isdigit():
            continue
        # A plain plural matches its singular: "feeds" and "feed".
        out.add(w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w)
    return out


def _is_open(s: dict) -> bool:
    return bool(s.get("id")) and s.get("state") in OPEN_STATES


def match(text: str, sessions) -> tuple | None:
    """(session, reason) for the one open session that owns this work, else None.

    A ticket key in the request that exactly one open session's title also names wins.
    Without a key, the title must share at least MIN_SHARED real words with the request,
    covering at least MIN_TITLE_SHARE of the title's words, and no other session may do
    as well. Two sessions that both match means no match: the Chief asks instead.
    """
    candidates = [s for s in (sessions or []) if isinstance(s, dict) and _is_open(s)]
    if not candidates:
        return None
    keys = tickets(text)
    if keys:
        hits = [s for s in candidates if keys & tickets(str(s.get("title") or ""))]
        if len(hits) == 1:
            key = sorted(keys & tickets(str(hits[0].get("title") or "")))[0]
            return hits[0], f"same ticket {key}"
        # A key that names no open session, or several, is a new piece of work or a question.
        return None
    asked = words(text)
    if len(asked) < MIN_SHARED:
        return None
    scored = []
    for s in candidates:
        title = words(str(s.get("title") or ""))
        if not title:
            continue
        shared = asked & title
        if len(shared) >= MIN_SHARED and len(shared) / len(title) >= MIN_TITLE_SHARE:
            scored.append((len(shared) / len(title), len(shared), s, shared))
    if not scored:
        return None
    scored.sort(key=lambda row: (row[0], row[1]), reverse=True)
    if len(scored) > 1 and scored[1][:2] == scored[0][:2]:
        return None
    best = scored[0]
    return best[2], "same work: " + ", ".join(sorted(best[3]))
