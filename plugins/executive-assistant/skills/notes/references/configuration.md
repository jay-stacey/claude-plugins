# Configuration

`userConfig` in `.claude-plugin/plugin.json` is the single source of truth for
plugin settings. The user sets these at install time, or later with
`/plugin configure executive-assistant@personal-plugins`.

## Reading a setting

Each `userConfig` key arrives as an environment variable named
`CLAUDE_PLUGIN_OPTION_<KEY>`, where `<KEY>` is the key uppercased:

| userConfig key | Environment variable |
|---|---|
| `notes_vault_path` | `CLAUDE_PLUGIN_OPTION_NOTES_VAULT_PATH` |
| `notes_daily_folder` | `CLAUDE_PLUGIN_OPTION_NOTES_DAILY_FOLDER` |
| `notes_date_format` | `CLAUDE_PLUGIN_OPTION_NOTES_DATE_FORMAT` |
| `timezone` | `CLAUDE_PLUGIN_OPTION_TIMEZONE` |
| `working_hours_start` | `CLAUDE_PLUGIN_OPTION_WORKING_HOURS_START` |
| `working_hours_end` | `CLAUDE_PLUGIN_OPTION_WORKING_HOURS_END` |
| `enabled_integrations` | `CLAUDE_PLUGIN_OPTION_ENABLED_INTEGRATIONS` |
| `assistant_name` | `CLAUDE_PLUGIN_OPTION_ASSISTANT_NAME` |
| `personality_preset` | `CLAUDE_PLUGIN_OPTION_PERSONALITY_PRESET` |

**An option the user has not set is absent from the environment entirely** — it
is not present-but-empty. Always fall back to the documented default, and treat
a missing required value as a reason to stop and ask rather than to guess.

## Precedence

1. `CLAUDE_PLUGIN_OPTION_*` — what the user configured. Authoritative.
2. `config/default.json` — defaults only, for values with no `userConfig` key
   (the detailed Gmail/Calendar tuning). Never overrides a set option.
3. The documented default in the skill itself.

`.config.local.json` and `user-profile.md` are legacy from before `userConfig`
existed. Read them if present so existing setups keep working, but write new
settings through `userConfig`, and prefer a configured option over either.

## Secrets

`google_oauth_client_id` and `google_oauth_client_secret` are marked
`sensitive`, so they are kept in secure storage rather than `settings.json` and
are substituted directly into `.mcp.json` via `${user_config.*}`. Skills never
need to read them, and must never print them.
