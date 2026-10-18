"""The decision Jev returns, the JSON schema a model must follow, and the prompt
every model provider shares. Standard library only."""
import json
from dataclasses import asdict, dataclass

MODELS = ("haiku", "sonnet", "opus")
ROUTES = ("chief", "new_session")
FILLERS = ("lookup", "work", "chat")
SOURCES = ("rules", "user", "local", "hosted")
MAX_ESTIMATE_S = 4 * 3600
MAX_SESSIONS = 20
MAX_TITLE = 60
MAX_TEXT = 1000

# Model ids for start_session. The Chief may only start the same family or a cheaper one.
MODEL_IDS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}

# Short keys, route first: every answer token is one decode step, and decode is most of a
# local model's time. background is not asked for: it follows the route (as in rules.py).
DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "r": {"type": "string", "enum": list(ROUTES)},
        "m": {"type": "string", "enum": list(MODELS)},
        "e": {"type": "integer", "minimum": 0, "maximum": MAX_ESTIMATE_S},
    },
    "required": ["r", "m", "e"],
    "additionalProperties": False,
}

# Fixed text, so the runtime's prompt cache keeps it; the examples are worded unlike the
# eval set (tests/fixtures/jev-eval.json) so they do not inflate its score.
SYSTEM_PROMPT = (
    "You route requests for a chief of staff that manages Claude Code sessions. "
    "Answer with JSON only, keys r, m, e.\n"
    "r (route): chief when the chief can answer from the session list or act on a session: "
    "status questions, what needs me, archive or close, reply, approve, tell or ping a session, "
    "thanks, yes, no, greetings. new_session when the request is work in a repo: build, fix, "
    "write code or docs, review, refactor, search code, research, design, plan, debug.\n"
    "m (model): when r is chief, m is always haiku. For new_session: haiku to search, find, "
    "list or summarize; sonnet for normal coding, tests, reviews and writing; opus for "
    "design, architecture, planning, research, root causes and hard debugging.\n"
    "If the request names a model or says new session or do it yourself, follow it.\n"
    "e (estimate): seconds until done: chief about 10, haiku work about 300, sonnet about 1200, "
    "opus about 3600.\n"
    "Examples, in the same shape as the real input:\n"
)

# Each example is (request, repo, route, model, estimate). They are shown as the exact JSON
# a real request uses, sessions first, so the model sees the request at the end every time.
_EXAMPLE_SESSIONS = [
    {"title": "Speed up the image upload", "repo": "media-api", "state": "working", "model": "sonnet"},
    {"title": "Write the logging guide", "repo": "docs", "state": "waiting", "model": "haiku"},
]
_EXAMPLES = [
    ("Is the image upload session still running?", None, "chief", "haiku", 10),
    ("What did the logging guide session decide?", None, "chief", "haiku", 10),
    ("Archive the sessions for the docs repo.", None, "chief", "haiku", 10),
    ("Tell the image upload session to use the staging bucket.", None, "chief", "haiku", 10),
    ("Okay, thank you.", None, "chief", "haiku", 10),
    ("Check the open issues yourself, no new session.", None, "chief", "haiku", 10),
    ("List every file that imports the old logger.", "media-api", "new_session", "haiku", 300),
    ("Summarize the commits on the main branch this week.", "docs", "new_session", "haiku", 300),
    ("Add a retry to the thumbnail resize call.", "media-api", "new_session", "sonnet", 1200),
    ("Write tests for the tax rounding helper.", "billing", "new_session", "sonnet", 1200),
    ("Find out why the report job is slow at night and fix it.", "billing", "new_session", "opus", 3600),
    ("Plan how we move file storage to a new provider.", "media-api", "new_session", "opus", 3600),
]
SYSTEM_PROMPT += "\n".join(
    "Input: " + json.dumps({"sessions": _EXAMPLE_SESSIONS, "repo": repo, "request": text}, separators=(",", ":"))
    + "\nAnswer: " + json.dumps({"r": route, "m": model, "e": est}, separators=(",", ":"))
    for text, repo, route, model, est in _EXAMPLES)


@dataclass
class Request:
    """What Jev sees. sessions holds dicts with title, repo, state and model."""
    text: str
    source: str = "typed"
    sessions: list = None
    repo: str | None = None

    def compact(self) -> dict:
        rows = []
        for s in (self.sessions or [])[:MAX_SESSIONS]:
            rows.append({"title": str(s.get("title") or "")[:MAX_TITLE], "repo": s.get("repo"),
                         "state": s.get("state"), "model": s.get("model")})
        # The session list goes first and the request last, so an unchanged list stays in the
        # runtime's prompt cache and only the new text is read.
        return {"sessions": rows, "repo": self.repo, "request": self.text[:MAX_TEXT]}


@dataclass
class Decision:
    model: str
    route: str
    background: bool
    estimate_s: int
    filler: str = "work"
    source: str = "rules"
    ms: float = 0.0
    override: bool = False

    def public(self) -> dict:
        out = asdict(self)
        out["ms"] = round(self.ms, 1)
        return out


def build_messages(request: Request) -> list[dict]:
    """The chat messages for any model provider: one system, one user."""
    return [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(request.compact(), separators=(",", ":"))}]


def parse(raw, filler: str = "work", source: str = "local", ms: float = 0.0) -> Decision:
    """A model's answer (a dict or a JSON string) as a Decision. Raises ValueError."""
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except ValueError as err:
            raise ValueError(f"not JSON: {err}") from None
    if not isinstance(raw, dict):
        raise ValueError("not a JSON object")
    # Short keys from the schema; the long names are still read.
    model = raw.get("m", raw.get("model"))
    route = raw.get("r", raw.get("route"))
    estimate = raw.get("e", raw.get("estimate_s"))
    background = raw.get("background", route == "new_session")
    if model not in MODELS:
        raise ValueError(f"bad model {model!r}")
    if route not in ROUTES:
        raise ValueError(f"bad route {route!r}")
    if route == "chief":
        model = "haiku"  # the Chief starts no session, so the cheapest model; small models miss this rule
    if not isinstance(background, bool):
        raise ValueError("background must be true or false")
    if isinstance(estimate, bool) or not isinstance(estimate, (int, float)) or not 0 <= estimate <= MAX_ESTIMATE_S:
        raise ValueError(f"bad estimate_s {estimate!r}")
    return Decision(model, route, background, int(estimate), filler if filler in FILLERS else "work", source, ms)


def hint_text(d: Decision) -> str:
    """One line of advice for the Chief. It never starts with "[Notice" or "[Action"."""
    where = "start a new session" if d.route == "new_session" else "handle it yourself"
    bg = " as background work" if d.background else ""
    return (f"Jev suggests: {where}{bg}, model {d.model} ({MODEL_IDS[d.model]}), "
            f"about {d.estimate_s} seconds. Advice only. Jay's words win.")
