---
name: sync
description: Shows and controls two-way tracker sync (Linear, GitHub Issues or Jira) for the software factory - preview the first sync, approve it, check sync health, run a full reconcile or a dry run, or re-link items after the map was lost. Use when the user runs /software-factory:sync or asks about tracker sync, the sync preview, or sync health.
argument-hint: "[--status | --preview | --approve-preview | --full | --dry-run | --rebuild-map]"
allowed-tools: Read, AskUserQuestion, mcp__plugin_software-factory_factory-sync__sync_status, mcp__plugin_software-factory_factory-sync__sync_preview, mcp__plugin_software-factory_factory-sync__sync_apply_preview, mcp__plugin_software-factory_factory-sync__sync_tick
---

# Sync

Arguments: `$ARGUMENTS`. Empty means `--status`.

The tools come from the plugin's `factory-sync` MCP server (`mcp__plugin_software-factory_factory-sync__*`).
If they are not available in this session, say: "The factory-sync server is not running. Run
/reload-plugins, then try again." Then stop.

Pass `{"projectDir": "<absolute path of the current project>"}` to every tool. Relay at most 10 lines
of tool output, as it is. Never call a tracker API or any other MCP tracker tool yourself.

- `--status`: call `sync_status`.
- `--preview`: call `sync_preview`. Read `.factory/sync/preview.md` and show at most 15 lines: items to
  create, labels to create, the status map, intake candidates, items to re-link. Then say: "Approve it
  with /software-factory:sync --approve-preview."
- `--approve-preview`: run only when the user typed `/software-factory:sync --approve-preview`
  themselves in this turn. Ask with AskUserQuestion: "Approving lets the factory create and update
  items in <tracker>. It never deletes tracker items. Do you want to approve the first sync?" Options:
  "Approve", "Not yet". On "Approve", call `sync_apply_preview` with the `previewId` from the
  `Preview id:` line of `preview.md`.
- `--full`: call `sync_tick` with `"mode": "full"`.
- `--dry-run`: call `sync_tick` with `"mode": "dry_run"`. Say: "Nothing was sent. Planned changes are in
  .factory/sync/log-<month>.jsonl."
- `--rebuild-map`: call `sync_tick` with `"mode": "rebuild_map"`.

What the answers mean:
- `REFUSED` (lease): say "Run this from the dispatcher session, or run /software-factory:start here first."
- `PENDING_CREDENTIALS`: say "Add the key with `/plugin configure software-factory@personal-plugins`,
  then run `/reload-plugins`."
- `NOT_APPROVED`: say "Type /software-factory:sync --approve-preview yourself to approve."
- `SYNC not ready`: say "Finish the tracker step with /software-factory:setup --section tracker."
