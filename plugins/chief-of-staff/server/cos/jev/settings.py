"""Jev's effective settings: the plugin's userConfig over what setup wrote to HOME/jev.json."""
import json
from pathlib import Path

PROVIDERS = ("rules", "local", "hosted")
ADAPTERS = ("openai_compat", "anthropic")
DEFAULT_ADAPTER = {"local": "openai_compat", "hosted": "anthropic"}
DEFAULT_TIMEOUT_MS = 800


def jev_json_path(home: Path) -> Path:
    return Path(home) / "jev.json"


def read_jev_json(home: Path) -> dict:
    """HOME/jev.json as a dict; {} when it is missing or not valid JSON."""
    try:
        data = json.loads(jev_json_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _key_ref(value) -> str:
    text = _text(value)
    return text if text.startswith(("env:", "wincred:")) else ""


def effective(settings: dict, home: Path) -> dict:
    """{"provider", "adapter", "model", "endpoint", "timeoutMs", "keyRef"} for this run."""
    settings = settings or {}
    data = read_jev_json(home)
    wanted = _text(settings.get("jevProvider")).lower() or "auto"
    if wanted == "auto":
        provider = data.get("provider") if data.get("provider") in PROVIDERS else "rules"
    else:
        provider = wanted if wanted in PROVIDERS else "rules"
    if provider == "rules":
        section = {}
    elif data.get("provider") == provider:
        section = data
    elif provider == "hosted" and isinstance(data.get("hosted"), dict):
        section = data["hosted"]
    else:
        section = {}
    runtime = section.get("runtime") if isinstance(section.get("runtime"), dict) else {}
    adapter = _text(settings.get("jevAdapter")) or _text(section.get("adapter")) or DEFAULT_ADAPTER.get(provider, "")
    if provider != "rules" and adapter not in ADAPTERS:
        adapter = DEFAULT_ADAPTER[provider]
    timeout = settings.get("jevTimeoutMs")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 100 <= timeout <= 5000:
        timeout = DEFAULT_TIMEOUT_MS
    return {
        "provider": provider,
        "adapter": adapter if provider != "rules" else "",
        "model": _text(settings.get("jevModel")) or _text(section.get("model")),
        "endpoint": _text(settings.get("jevEndpoint")) or _text(section.get("endpoint")),
        "timeoutMs": int(timeout),
        "keyRef": (_key_ref(settings.get("jevKeyRef")) or _key_ref(section.get("keyRef"))
                   or _key_ref(section.get("apiKeyRef")) or _key_ref(runtime.get("apiKeyRef"))),
    }
