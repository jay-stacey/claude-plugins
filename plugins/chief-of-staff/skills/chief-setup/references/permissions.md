# The archive and message permission

## Why it is needed

The Chief changes other sessions only through the desktop app's own session tools:
`mcp__ccd_session_mgmt__archive_session` and `mcp__ccd_session_mgmt__send_message`.
The app asks the user to approve each call, except in auto mode, where its classifier
decides. A request that arrives by voice or from the console button reaches the Chief as
a prompt the mod submitted, not as text the user typed, so auto mode may refuse the call.
A permission rule in the project settings allows the two tools for sessions in that folder.

## The rule

`.claude\settings.json` in the folder the Chief's session runs in:

```json
{
  "permissions": {
    "allow": [
      "mcp__ccd_session_mgmt__archive_session",
      "mcp__ccd_session_mgmt__send_message"
    ]
  }
}
```

## Merging into an existing file

1. Read the file. If it is not valid JSON, stop and show the user the problem.
2. Keep every key. Create `permissions` and `permissions.allow` only when missing.
3. Add each of the two names to `allow` only when it is not there yet.
4. Write the file with two-space indentation.

Show the user the resulting file before writing, and write only after a yes. Auto mode may
refuse an edit to its own permission settings; then give the user the path and content to
create the file themselves.

## What stays safe

- Archive is the strongest action. The Chief never deletes a session.
- The Chief asks before archiving a session that is working, or whose helper session is.
- The mod refuses the Chief's own archive call on a working session until the user has
  answered yes to a question about that session.
- The server refuses an unconfirmed console archive of a working session.

## Removing it

Delete the two names from `permissions.allow`. The Chief then asks the app for approval
on each archive or message, or is refused in auto mode, and says so.
