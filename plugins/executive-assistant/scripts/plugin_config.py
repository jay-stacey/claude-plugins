"""Read the plugin's user settings (userConfig) from wherever they live.

Claude Code exports CLAUDE_PLUGIN_OPTION_<KEY> only to hook processes. Skills
that run a script through Bash do not get those variables, and a copy of the
plugin synced from claude.ai into the desktop app gets none at all. So a
script looks in three places, first match wins:

1. The CLAUDE_PLUGIN_OPTION_<KEY> environment variable (hooks, terminal).
2. pluginConfigs in the user's Claude settings file, under any
   "executive-assistant@<marketplace>" entry (personal-plugins first).
3. The default the caller passes.

EA_SETTINGS_FILE points at a different settings file (tests use it to keep the
real one out of the way).
"""
import json
import os
from pathlib import Path

PLUGIN = "executive-assistant"
PREFERRED = ("personal-plugins", "synced")


def settings_file():
    override = os.environ.get("EA_SETTINGS_FILE")
    if override:
        return Path(override)
    base = os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
    return Path(base) / "settings.json"


def saved_options():
    """The options dict from settings.json, or {} when there is none."""
    try:
        data = json.loads(settings_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    configs = data.get("pluginConfigs") or {}
    keys = [f"{PLUGIN}@{m}" for m in PREFERRED]
    keys += sorted(k for k in configs if k.startswith(PLUGIN + "@") and k not in keys)
    for key in keys:
        opts = (configs.get(key) or {}).get("options")
        if isinstance(opts, dict) and opts:
            return opts
    return {}


def option(key, default=None):
    """One setting by its userConfig key, e.g. option("notes_vault_path")."""
    value = os.environ.get("CLAUDE_PLUGIN_OPTION_" + key.upper())
    if value not in (None, ""):
        return value
    value = saved_options().get(key)
    if value not in (None, ""):
        return str(value)
    return default
