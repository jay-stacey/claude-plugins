# Google tools

Since 9.0.0 the plugin ships no Google MCP server. Gmail and Google Calendar
come from the native claude.ai connectors (Settings, Connectors, in Claude).
Google Tasks, when used, comes from the `gtasks` desktop extension.

## Tool names

A connector's tools get a different prefix depending on where Claude runs.
Skills and agents allow both.

| Connector | Claude desktop app | Claude Code CLI (`claude -p`) |
|---|---|---|
| Gmail | `mcp__0b5e66b0-f707-4eda-938d-88ec25a14b65__<tool>` | `mcp__claude_ai_Gmail__<tool>` |
| Google Calendar | `mcp__32385326-064a-48eb-a714-4b16525fd24a__<tool>` | `mcp__claude_ai_Google_Calendar__<tool>` |

The desktop prefix is the connector's id on the claude.ai account. It stays the
same across sessions and reconnects. It changes only if the connector is
removed and added again. Then find the new id (run `ToolSearch` for
`search_threads` in a desktop session) and replace the old one in
`agents/*.md` and the `allowed-tools` lines of `skills/*/SKILL.md`.

The skills below name only the tool, such as `search_threads`. Use whichever
prefix the session has.

## Gmail

| Job | Tool | Notes |
|---|---|---|
| Search | `search_threads` | Returns threads, `pageSize` up to 50, keep passing `pageToken` until none comes back. Each thread carries up to 5 messages with `labelIds`, sender, subject and snippet. `view: "THREAD_VIEW_IDS_ONLY"` for counts. |
| Read a thread | `get_thread` | `messageFormat: "MINIMAL"` for headers, `PLAIN_TEXT` for bodies. Shows who wrote last. |
| Read one message | `get_message` | |
| Labels | `list_labels`, `create_label` | Label changes take label **ids**. `INBOX`, `UNREAD`, `STARRED` are system ids. |
| Add or remove labels | `label_thread`, `unlabel_thread` | Archive is `unlabel_thread` with `INBOX`. One call per thread. |
| One message only | `update_message_labels` | Add and remove in one call. |
| Trash | `trash_thread` | Recoverable for 30 days. `untrash_thread` undoes it. |
| Draft | `create_draft` | `replyToMessageId` makes it a reply. Never send. |

There is no batch call. Act thread by thread, and print a status line every
25 threads so the user sees progress.

Not available natively: Gmail filters (list or create). The plugin no longer
creates filters. When a rule earns a filter offer, show the user the query and
the click path instead (see `gmail-processor`, phase 10).

## Google Calendar

| Job | Tool | Notes |
|---|---|---|
| Calendars | `list_calendars` | The primary calendar's id is the user's address. |
| Events in a range | `list_events` | `startTime`, `endTime` as local ISO times with no offset, `pageSize` up to 250, page with `pageToken`, `orderBy: "startTime"`. |
| One event | `get_event` | |
| Keyword search | `search_events` | |
| Free time | `suggest_time` | Or read `list_events` and find the gaps yourself. |
| Create | `create_event` | `eventType: "FOCUS_TIME"` for focus blocks, `"OUT_OF_OFFICE"` for time off. `notificationLevel: "NONE"`. |
| Change | `update_event` | Only for the assistant's own blocks. |

Never call `delete_event` or `respond_to_event`.

## Not covered

Contacts, Docs, Sheets and Apps Script have no native connector here. The
plugin does not use them. Drive has a native connector, but no skill needs it.
