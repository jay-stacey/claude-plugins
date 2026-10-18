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

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "model": {"type": "string", "enum": list(MODELS)},
        "route": {"type": "string", "enum": list(ROUTES)},
        "background": {"type": "boolean"},
        "estimate_s": {"type": "integer", "minimum": 0, "maximum": MAX_ESTIMATE_S},
    },
    "required": ["model", "route", "background", "estimate_s"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = (
    "You route requests for a chief of staff that manages Claude Code sessions. "
    "Answer with JSON only. "
    "route: chief when the chief can answer from the session list or act on a session "
    "(status, what needs me, archive, reply, small lookups); new_session when the request is "
    "real work in a repo (build, fix, write, research, review, debug). "
    "model: haiku for lookups, search and summaries; sonnet for normal coding and writing; "
    "opus for design, architecture, planning, hard debugging and research. "
    "background: true when the work runs for more than about a minute. "
    "estimate_s: your best guess of the seconds until the work is done."
)


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
        return {"request": self.text[:MAX_TEXT], "repo": self.repo, "sessions": rows}


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
    model, route, background, estimate = (raw.get(k) for k in ("model", "route", "background", "estimate_s"))
    if model not in MODELS:
        raise ValueError(f"bad model {model!r}")
    if route not in ROUTES:
        raise ValueError(f"bad route {route!r}")
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
