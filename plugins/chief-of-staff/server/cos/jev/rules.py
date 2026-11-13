"""Jev's rules: a pure, fast first answer from word lists. No model, no I/O.

quick() runs on every request before anything else, so it must stay well under
20 ms. Jay's own words ("use opus", "do it yourself", "new session") win over
every other rule.
"""
import re

from .decision import Decision, Request

# Short replies that need no thought: greetings, thanks, yes or no, button labels.
CHAT_WORDS = (
    "hi", "hello", "hey", "yo", "morning", "good morning", "good afternoon", "good evening", "good night",
    "thanks", "thank you", "thx", "cheers", "ta", "nice", "great", "cool", "perfect", "awesome",
    "yes", "yeah", "yep", "yup", "no", "nope", "nah", "ok", "okay", "k", "sure", "fine", "right",
    "confirm", "confirmed", "cancel", "stop", "wait", "never mind", "nevermind", "go ahead", "do it",
    "sounds good", "got it", "agreed", "approve", "approved", "deny", "keep it", "archive it", "not now",
    "later", "done", "yes please", "no thanks", "no thank you", "please do", "of course",
)
# Status questions the Chief answers from the session list.
LOOKUP_LEADS = (
    "what needs me", "what needs my attention", "what's waiting", "what is waiting", "anything waiting",
    "anything need me", "anything needs me", "anything for me", "is anything", "is there anything",
    "how is", "how's", "how are", "how did", "how far", "which session", "which sessions", "what sessions",
    "list", "show me", "show", "status", "what's the status", "what is the status", "where are we",
    "where is", "where's", "what's happening", "what is happening", "what's going on", "what is going on",
    "what's new", "any updates", "any update", "is it done", "is that done", "did it finish", "are we done",
    "who is", "what's left", "what is left", "how many", "tell me", "give me an update", "give me a status",
    "check on", "check the status", "check how", "check if", "check whether", "catch me up", "brief me",
    "what's up", "what should i", "what do i", "remind me",
)
LOOKUP_WORDS = ("status", "waiting", "needs me", "needs my", "progress", "stale", "sessions", "update on")
# Real work in a repo: a new session does it.
WORK_VERBS = (
    "build", "fix", "implement", "write", "investigate", "research", "review", "refactor", "create",
    "debug", "plan", "design", "add", "update", "migrate", "rewrite", "port", "test", "deploy", "draft",
    "remove", "delete", "rename", "change", "make", "set up", "setup", "upgrade", "optimize", "optimise",
    "profile", "audit", "analyze", "analyse", "spec", "document", "prototype", "scaffold", "split", "merge",
    "rebase", "clean up", "cleanup", "convert", "translate", "benchmark",
)
# Light work for a cheap model when it runs in a session.
LIGHT_VERBS = ("search", "find", "summarize", "summarise", "look up", "lookup", "grep", "count")
LIGHT_WORDS = LIGHT_VERBS + ("list",)
# Hard thinking: the strongest model.
DEEP_WORDS = ("design", "architecture", "architect", "plan", "research", "investigate", "root cause",
              "spec", "strategy", "tradeoff", "trade-off", "trade off", "deep dive", "rethink")
# Things the Chief does to a session itself.
SESSION_ACTIONS = ("archive", "close", "reply", "tell", "send", "message", "answer", "ping", "nudge",
                   "unarchive", "open", "approve", "deny")
# Polite openings before the verb that counts.
LEAD_INS = ("please", "can you", "could you", "would you", "will you", "can we", "could we", "let's", "lets",
            "let us", "i need you to", "i want you to", "i'd like you to", "go", "go and", "now", "ok", "okay",
            "so", "and", "also", "then", "hey", "chief", "jev", "quickly", "just")

ESTIMATE_S = {"chat": 3, "lookup": 10, "haiku": 120, "sonnet": 600, "opus": 1200}
SESSION_ACTION_S = 10


def _alt(words):
    return "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in sorted(words, key=len, reverse=True))


def _any(words):
    return re.compile(r"\b(?:" + _alt(words) + r")\b", re.I)


FLAGS = re.I
CHAT_RE = re.compile(r"^\s*(?:(?:" + _alt(CHAT_WORDS) + r")[\s,.!?]*)+$", FLAGS)
LEAD_RE = re.compile(r"^\s*(?:(?:" + _alt(LEAD_INS) + r")\b[\s,]*)*", FLAGS)
LOOKUP_LEAD_RE = re.compile(r"^(?:" + _alt(LOOKUP_LEADS) + r")\b", FLAGS)
LOOKUP_RE = _any(LOOKUP_WORDS)
WORK_START_RE = re.compile(r"^(?:" + _alt(WORK_VERBS + LIGHT_VERBS) + r")\b", FLAGS)
WORK_RE = _any(WORK_VERBS)
LIGHT_RE = _any(LIGHT_WORDS)
DEEP_RE = _any(DEEP_WORDS)
ACTION_START_RE = re.compile(r"^(?:" + _alt(SESSION_ACTIONS) + r")\b", FLAGS)
# "Is the Node upgrade done?": a yes or no question about how work stands, even when it
# names a work verb.
STATE_QUESTION_RE = re.compile(
    r"^(?:is|are|was|were|did|has|have|does|do)\b.*\b(?:done|finished|merged|ready|working|running|"
    r"complete|completed|passing|green|failing|stuck|blocked|over|shipped|deployed|live)\b(?:\s+(?:yet|now|already))?[\s?.!]*$", FLAGS)
QUESTION_RE = re.compile(r"^(?:what|which|who|where|when|why|how|is|are|did|any|anything)\b", FLAGS)

# Jay's overrides.
MODEL_OVERRIDE_RE = re.compile(r"\b(?:use|using|with|on|in|via|pick|try)\s+(?:the\s+)?(opus|sonnet|haiku)\b", FLAGS)
CHIEF_OVERRIDE_RE = re.compile(
    r"\b(?:do\s+it\s+yourself|handle\s+it\s+yourself|do\s+this\s+yourself|"
    r"(?:don'?t|do\s+not|no\s+need\s+to)\s+(?:start|spin\s+up|open)\s+(?:a\s+)?(?:new\s+)?session|"
    r"no\s+new\s+session|without\s+a\s+(?:new\s+)?session)\b", FLAGS)
# "You do it" says who, unless it is part of a request like "can you do it in a new session".
WEAK_CHIEF_RE = re.compile(r"(?<!can )(?<!could )(?<!would )(?<!will )\byou\s+(?:do|handle)\s+it\b", FLAGS)
SESSION_OVERRIDE_RE = re.compile(
    r"\b(?:(?:in|start|open|spin\s+up|use|with)\s+(?:a\s+)?new\s+session|new\s+session|"
    r"(?:start|spin\s+up|open|kick\s+off)\s+(?:a\s+)?session|in\s+the\s+background|as\s+background\s+work)\b", FLAGS)


def overrides(text: str) -> dict:
    """What Jay set in his own words: {"model": ..., "route": ...}, only the keys he set."""
    out = {}
    text = text or ""
    m = MODEL_OVERRIDE_RE.search(text)
    if m:
        out["model"] = m.group(1).lower()
    if CHIEF_OVERRIDE_RE.search(text):
        out["route"] = "chief"
    elif SESSION_OVERRIDE_RE.search(text):
        out["route"] = "new_session"
    elif WEAK_CHIEF_RE.search(text):
        out["route"] = "chief"
    return out


def kind(text: str) -> str:
    """"chat", "lookup", "action" (the Chief acts on a session) or "work"."""
    text = (text or "").strip()
    if not text or CHAT_RE.match(text):
        return "chat"
    body = text[LEAD_RE.match(text).end():]
    if LOOKUP_LEAD_RE.match(body) or STATE_QUESTION_RE.match(body):
        return "lookup"
    if ACTION_START_RE.match(body):
        return "action"
    if WORK_START_RE.match(body):
        return "work"
    # A question ("why did the build fail?") is for the Chief to answer, even when it names work.
    if QUESTION_RE.match(body):
        return "lookup"
    if WORK_RE.search(body):
        return "work"
    if LOOKUP_RE.search(body) or QUESTION_RE.match(body) or text.endswith("?"):
        return "lookup"
    return "work" if len(body.split()) > 6 else "chat"


def pick_model(text: str) -> str:
    """The model a new session would use for this text."""
    if DEEP_RE.search(text):
        return "opus"
    if LIGHT_RE.search(text) and not WORK_RE.search(text):
        return "haiku"
    return "sonnet"


def quick(request: Request) -> Decision:
    """Jev's first answer, from rules alone."""
    text = request.text or ""
    k = kind(text)
    filler = "work" if k in ("work", "action") else k
    route = "new_session" if k == "work" else "chief"
    ov = overrides(text)
    if "route" in ov:
        route = ov["route"]
    if route == "new_session":
        model = pick_model(text)
    else:
        model = "haiku"
    if "model" in ov:
        model = ov["model"]
    if k == "chat" and route == "chief":
        estimate = ESTIMATE_S["chat"]
    elif k in ("lookup", "action") and route == "chief":
        estimate = ESTIMATE_S["lookup"] if k == "lookup" else SESSION_ACTION_S
    else:
        if filler != "work":
            filler = "work"
        estimate = ESTIMATE_S[model]
    return Decision(model=model, route=route, background=route == "new_session", estimate_s=estimate,
                    filler=filler, source="user" if ov else "rules", ms=0.0, override=bool(ov))
