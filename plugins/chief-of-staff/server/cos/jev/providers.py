"""Model providers for Jev: one client per wire format. urllib only, no retries
(the time budget is too small). Errors never include the key or the request body."""
import ipaddress
import json
import socket
import urllib.error
import urllib.parse
import urllib.request

from .decision import DECISION_SCHEMA, Request, build_messages

USER_AGENT = "chief-of-staff-jev"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_URL = "https://api.anthropic.com"
OPENAI_MAX_TOKENS = 60
# Claude Haiku 5.5 counts any thinking toward max_tokens, so leave room above the short answer.
ANTHROPIC_MAX_TOKENS = 512

# Hosted endpoints setup refuses, and why.
BLOCKED_HOSTS = {
    "generativelanguage.googleapis.com": "the Gemini free tier may use request text to improve products",
    "api.mistral.ai": "the Mistral free tier may train on request text",
    "openrouter.ai": "OpenRouter free models pass data to providers with mixed data policies",
    "api.cerebras.ai": "Cerebras has no published data policy for this use",
    "models.inference.ai.azure.com": "GitHub Models closed on July 30, 2026",
    "models.github.ai": "GitHub Models closed on July 30, 2026",
}


class ProviderError(Exception):
    """A provider call failed. The message is short and holds no secret."""


def _strip_numeric_limits(schema):
    """A copy of a JSON schema without minimum/maximum, which the Claude API does not accept."""
    if isinstance(schema, dict):
        return {k: _strip_numeric_limits(v) for k, v in schema.items()
                if k not in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")}
    if isinstance(schema, list):
        return [_strip_numeric_limits(v) for v in schema]
    return schema


def is_loopback(host: str) -> bool:
    host = (host or "").strip("[]").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_endpoint(url: str, hosted: bool = False) -> str:
    """The endpoint without a trailing slash. Raises ValueError when it is not allowed."""
    parts = urllib.parse.urlsplit(str(url or "").strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("endpoint must be an http or https URL")
    if parts.username or parts.password:
        raise ValueError("endpoint must not hold a user name or password")
    host = parts.hostname.lower()
    if parts.scheme == "http" and not is_loopback(host):
        raise ValueError("plain http is only allowed on 127.0.0.1; use https for a remote server")
    if hosted:
        for blocked, why in BLOCKED_HOSTS.items():
            if host == blocked or host.endswith("." + blocked):
                raise ValueError(f"{blocked} is blocked: {why}")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib copies the Authorization and x-api-key headers onto a redirect, even to another
    host, so Jev never follows one: a redirect is an error."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _opener(url: str):
    """No redirects anywhere, and no proxy for a server on this PC, so the local key and
    Jay's words never go to a proxy."""
    handlers = [_NoRedirect()]
    if is_loopback(urllib.parse.urlsplit(url).hostname or ""):
        handlers.insert(0, urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)


class Provider:
    name = "local"

    def decide(self, request: Request, timeout_s: float) -> dict:
        raise NotImplementedError

    def _post(self, url: str, body: dict, headers: dict, timeout_s: float) -> dict:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", USER_AGENT)
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with _opener(url).open(req, timeout=max(0.05, float(timeout_s))) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as err:
            err.close()
            raise ProviderError(f"{self.name}: HTTP {err.code}") from None
        except (socket.timeout, TimeoutError):
            raise ProviderError(f"{self.name}: timed out") from None
        except urllib.error.URLError as err:
            reason = err.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise ProviderError(f"{self.name}: timed out") from None
            raise ProviderError(f"{self.name}: cannot connect ({type(reason).__name__})") from None
        except OSError as err:
            raise ProviderError(f"{self.name}: connection error ({type(err).__name__})") from None
        except Exception as err:
            # http.client puts a bad header value, which can be the key, in its message.
            raise ProviderError(f"{self.name}: request failed ({type(err).__name__})") from None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ProviderError(f"{self.name}: reply is not JSON") from None

    @staticmethod
    def _decision_json(text, who: str) -> dict:
        if not isinstance(text, str) or not text.strip():
            raise ProviderError(f"{who}: empty answer")
        try:
            out = json.loads(text)
        except ValueError:
            raise ProviderError(f"{who}: answer is not JSON") from None
        if not isinstance(out, dict):
            raise ProviderError(f"{who}: answer is not a JSON object")
        return out


class OpenAICompatProvider(Provider):
    """Ollama, llama.cpp llama-server, Groq, Cloudflare Workers AI and self-hosted servers."""

    def __init__(self, base_url: str, model: str, api_key=None, name: str = "local"):
        self.base_url = str(base_url).rstrip("/")
        self.model = model
        self._key = api_key or None
        self.name = name

    def __repr__(self):
        return f"OpenAICompatProvider({self.base_url!r}, {self.model!r}, name={self.name!r})"

    def body(self, request: Request) -> dict:
        return {"model": self.model, "messages": build_messages(request), "temperature": 0,
                "max_tokens": OPENAI_MAX_TOKENS, "stream": False,
                "response_format": {"type": "json_schema",
                                    "json_schema": {"name": "jev", "schema": DECISION_SCHEMA, "strict": True}}}

    def decide(self, request: Request, timeout_s: float) -> dict:
        headers = {"Authorization": f"Bearer {self._key}"} if self._key else {}
        reply = self._post(f"{self.base_url}/chat/completions", self.body(request), headers, timeout_s)
        try:
            content = reply["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ProviderError(f"{self.name}: reply has no message") from None
        return self._decision_json(content, self.name)


class AnthropicProvider(Provider):
    """The Claude Messages API with structured outputs. Haiku 5.5 rejects a non-default
    temperature, so none is sent; effort low keeps thinking short."""
    name = "hosted"

    def __init__(self, model: str, api_key: str, effort: str = "low", base_url: str = ANTHROPIC_URL):
        self.model = model
        self._key = api_key or None
        self.effort = effort
        self.base_url = str(base_url).rstrip("/")

    def __repr__(self):
        return f"AnthropicProvider({self.model!r}, effort={self.effort!r})"

    def body(self, request: Request) -> dict:
        msgs = build_messages(request)
        system = "\n".join(m["content"] for m in msgs if m["role"] == "system")
        return {"model": self.model, "max_tokens": ANTHROPIC_MAX_TOKENS, "system": system,
                "messages": [m for m in msgs if m["role"] != "system"],
                "output_config": {"format": {"type": "json_schema", "schema": _strip_numeric_limits(DECISION_SCHEMA)},
                                  "effort": self.effort}}

    def decide(self, request: Request, timeout_s: float) -> dict:
        if not self._key:
            raise ProviderError("hosted: no API key")
        headers = {"x-api-key": self._key, "anthropic-version": ANTHROPIC_VERSION}
        reply = self._post(f"{self.base_url}/v1/messages", self.body(request), headers, timeout_s)
        if not isinstance(reply, dict):
            raise ProviderError("hosted: reply is not an object")
        if reply.get("stop_reason") == "refusal":
            raise ProviderError("hosted: model declined")
        for block in reply.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                return self._decision_json(block.get("text"), "hosted")
        if reply.get("stop_reason") == "max_tokens":
            raise ProviderError("hosted: ran out of tokens before answering")
        raise ProviderError("hosted: reply has no text")


def make_provider(cfg: dict, key=None):
    """The provider for merged settings, or None for rules. Raises ValueError for a
    setting that is not allowed (bad endpoint, blocked host, unknown adapter)."""
    cfg = cfg or {}
    provider = (cfg.get("provider") or "rules").lower()
    if provider in ("rules", "auto", ""):
        return None
    model = cfg.get("model") or ""
    endpoint = cfg.get("endpoint") or ""
    if provider == "local":
        adapter = cfg.get("adapter") or "openai_compat"
        if adapter != "openai_compat":
            raise ValueError("the local provider uses the openai_compat adapter")
        url = check_endpoint(endpoint)
        if not is_loopback(urllib.parse.urlsplit(url).hostname):
            raise ValueError("the local provider must run on 127.0.0.1; use hosted for another machine")
        if not model:
            raise ValueError("no model set")
        return OpenAICompatProvider(url, model, key, name="local")
    if provider == "hosted":
        adapter = cfg.get("adapter") or "anthropic"
        if not model:
            raise ValueError("no model set")
        if adapter == "anthropic":
            base = check_endpoint(endpoint, hosted=True) if endpoint else ANTHROPIC_URL
            return AnthropicProvider(model, key, base_url=base)
        if adapter == "openai_compat":
            if not endpoint:
                raise ValueError("no endpoint set")
            return OpenAICompatProvider(check_endpoint(endpoint, hosted=True), model, key, name="hosted")
        raise ValueError(f"unknown adapter {adapter!r}")
    raise ValueError(f"unknown provider {provider!r}")
