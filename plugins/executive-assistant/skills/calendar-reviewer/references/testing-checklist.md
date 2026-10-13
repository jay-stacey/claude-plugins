# Testing checklist — calendar-reviewer

Developer-facing checks for this skill. Not needed at runtime.

## Reading

- [ ] One ranged `get_events` call per picked calendar, with `detailed: true`
- [ ] `time_min` and `time_max` carry explicit offsets, computed per date
- [ ] A range across a daylight-saving change uses two different offsets
- [ ] `page_token` is followed until it runs out
- [ ] Only the primary calendar and `calendar.includeCalendars` are read

## Time

- [ ] An event stored in UTC shows at the right local hour
- [ ] An event created in another zone (a European webinar) shows at the right local hour
- [ ] Free time today starts at now, rounded up to 5 minutes

## Ownership

- [ ] Declined invites are left out
- [ ] Events on team calendars the user is not invited to are left out
- [ ] `ours` needs both the `[Focus]` prefix and `ea:focus` on the first description line
- [ ] A hand-made `[Focus]` block is `ours: false`

## Analysis

- [ ] Overlapping meetings are not counted twice in `meeting_hours`
- [ ] Profile fixtures block free time even when not on the calendar
- [ ] Free blocks under 25 minutes are dropped; blocks split at window edges
- [ ] Each flag kind fires on a fixture built for it, and not on a clean week
- [ ] Prep tasks: at most five, each with due, estimate, a 5-minute first step and `calendar:<id>` source
- [ ] `week_summary` names the heaviest day first

## Output and safety

- [ ] Spoken part has no tables or emoji headers
- [ ] JSON matches `CalendarReport` in `docs/brief-contract.md`, every list present
- [ ] No write tool is ever called
- [ ] A Google failure returns empty `days` and one plain line
