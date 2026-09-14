# Adding a plugin to this marketplace

## 1. Create the folder

```
plugins/<your-plugin>/
├── .claude-plugin/
│   └── plugin.json        # ONLY this file goes in .claude-plugin/
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md       # required
│       └── references/    # optional, loaded on demand
├── agents/*.md            # optional
├── commands/*.md          # optional
├── hooks/hooks.json       # optional
└── .mcp.json              # optional, at plugin ROOT
```

**Do not** put `skills/`, `agents/`, `commands/`, or `hooks/` inside
`.claude-plugin/`. Only `plugin.json` lives there.

## 2. Register it

Add an entry to `.claude-plugin/marketplace.json`. Because `metadata.pluginRoot`
is `./plugins`, `source` is just the folder name:

```json
{
  "name": "your-plugin",
  "source": "./your-plugin",
  "version": "1.0.0",
  "description": "What it does.",
  "category": "productivity",
  "license": "MIT"
}
```

## 3. Validate before pushing

```bash
claude plugin validate . --strict
claude plugin validate ./plugins/your-plugin --strict
python scripts/check-skills.py
```

CI runs all three on every push and pull request.

## Rules that bite

| Rule | Why |
|---|---|
| Skills live at `skills/<name>/SKILL.md` — exactly one level deep | Deeper nesting is silently never discovered |
| A skill's `name:` must equal its directory name | Mismatch breaks invocation |
| Keep `SKILL.md` under 500 lines | Skill content stays in context once invoked; move detail to `references/` |
| `context: fork` is a skill/command field, not an agent field | Ignored on agents |
| `.mcp.json` is a bare `{ "server": {...} }` object | No `mcpServers` wrapper — that key is only used *inside* `plugin.json` |
| Pick the cheapest model that works | `haiku` for fetch/format, `sonnet` for judgement, `opus` for planning |
| Secrets go in `userConfig` with `"sensitive": true` | Keeps them out of `settings.json` |
| First positional arg is `$0`, not `$1` | 0-based |
