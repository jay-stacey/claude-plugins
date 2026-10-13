# Time and ownership examples — calendar-reviewer

Read this when a time or an ownership call is not obvious.

## Offsets for a range

Zone `America/Toronto`, five workdays from Monday 2026-10-26:

- `time_min`: `2026-10-26T00:00:00-04:00`
- `time_max`: `2026-10-31T00:00:00-04:00` (Saturday, exclusive)

Five workdays from Thursday 2026-10-29 cross the change on Sunday 2026-11-01:

- `time_min`: `2026-10-29T00:00:00-04:00`
- `time_max`: `2026-11-05T00:00:00-05:00`

Events on Monday 2026-11-02 and later use `-05:00` when you convert them.

## Converting returned times

Google returns each event in the zone it was created in, or in UTC.

- `2026-10-14T15:00:00Z` is 11:00 in Toronto (EDT, -04:00), not 15:00.
- `2026-10-14T17:00:00+02:00` (a webinar set up in Berlin) is 11:00 in
  Toronto.
- `2026-10-14T10:00:00-04:00` is 10:00. Same zone, no change.

Work out the instant first, then show it in the configured zone. When an event
also has a `timeZone` field, it tells you where it was created; the offset on
the value is still what decides the instant.

## Ownership calls

| Event | Keep? | Why |
|---|---|---|
| User organized, three guests | Yes | Organizer is the user |
| Invite from the CEO, user accepted | Yes | Attendee, not declined |
| Invite, user has not answered | Yes | Attendee, `needsAction`; also flag it |
| Invite, user declined | No | Declined |
| Event on the shared "Engineering" calendar, user not invited | No | Not on a picked calendar, and not an attendee |
| Team offsite copied to primary, user not in the guest list | No | Neither organizer nor attendee |
| Gym hold on primary, no guests | Yes | User is organizer; kind `personal` |
| `[Focus] Deep work: A, B` with `ea:focus · created by executive-assistant` | Yes | `ours: true` |
| `[Focus] Thinking time` the user typed by hand | Yes | `ours: false`, no marker |

This file is for the model's reading; tables here are fine. Replies to the
user still follow `response-style`.
