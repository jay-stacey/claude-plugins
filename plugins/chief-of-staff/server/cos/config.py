"""Settings: the plugin's userConfig, in the contract's camelCase shape.

Sources, first match wins per field: the options the mod sends with
/api/mod/hello, CLAUDE_PLUGIN_OPTION_<KEY>, pluginConfigs in the user's
Claude settings file, then the defaults below.
"""
import json
import os
import re

from . import paths

PLUGIN = "chief-of-staff"

# camelCase (contract) -> snake_case (userConfig key), default
FIELDS = {
    "staleHours": ("stale_hours", 24),
    "recentDays": ("recent_days", 3),
    "speakReplies": ("speak_replies", True),
    "listen": ("listen", "wake"),
    "voice": ("voice", "auto"),
    "wakeWord": ("wake_word", "hey chief"),
    "notify": ("notify", True),
    "quietHours": ("quiet_hours", "22:00-07:00"),
}
LISTEN_MODES = ("wake", "ptt", "off")
QUIET_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$")


def defaults() -> dict:
    return {k: v for k, (_, v) in FIELDS.items()}


def saved_options() -> dict:
    try:
        data = json.loads(paths.settings_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    configs = data.get("pluginConfigs") or {}
    keys = [f"{PLUGIN}@personal-plugins"] + sorted(k for k in configs if k.startswith(PLUGIN + "@"))
    for key in keys:
        opts = (configs.get(key) or {}).get("options") if isinstance(configs.get(key), dict) else None
        if isinstance(opts, dict) and opts:
            return opts
    return {}


def _coerce(name, value, default):
    if value is None or value == "":
        return None if name != "quietHours" or value is None else ""
    if isinstance(default, bool):
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in ("true", "1", "yes", "on"):
            return True
        if text in ("false", "0", "no", "off"):
            return False
        return None
    if isinstance(default, int):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None
    text = str(value).strip()
    if name == "listen":
        return text if text in LISTEN_MODES else None
    if name == "quietHours":
        return text if text == "" or QUIET_RE.match(text) else None
    return text or None


def load(mod_options: dict | None = None, env=None) -> dict:
    env = os.environ if env is None else env
    saved = saved_options() if env is os.environ else {}
    out = defaults()
    for name, (key, default) in FIELDS.items():
        for source in ((mod_options or {}).get(key), (mod_options or {}).get(name),
                       env.get("CLAUDE_PLUGIN_OPTION_" + key.upper()), saved.get(key)):
            value = _coerce(name, source, default)
            if value is not None:
                out[name] = value
                break
    for name in ("staleHours", "recentDays"):
        if float(out[name]).is_integer():
            out[name] = int(out[name])
    return out


def in_quiet_hours(quiet: str, minutes_of_day: int) -> bool:
    """True when the local time (minutes after midnight) falls in "22:00-07:00"."""
    m = QUIET_RE.match(quiet or "")
    if not m:
        return False
    start = int(m.group(1)) * 60 + int(m.group(2))
    end = int(m.group(3)) * 60 + int(m.group(4))
    if start == end:
        return False
    if start < end:
        return start <= minutes_of_day < end
    return minutes_of_day >= start or minutes_of_day < end
