# Testing checklist — calendar-manager

Developer-facing checks for this skill. Not needed at runtime.

## Planning (propose)

- [ ] Each task uses `estimate_min * speed`, rounded up to 5 minutes
- [ ] Missing estimate becomes 30 minutes and is named in the reply
- [ ] Deep tasks land in the deep window first; admin after 13:30
- [ ] Tasks of one kind share a block; titles follow `[Focus] Deep work: A, B`
- [ ] No block over 2 hours; 10 minutes after every meeting
- [ ] Lunch keeps 30 free minutes between 11:00 and 13:30
- [ ] Total booked time is at most 75% of free time
- [ ] Unplaced tasks carry a plain `why`
- [ ] At most two options, with a pick

## Booking (book)

- [ ] Nothing is created without `mode: book`
- [ ] Slots are re-checked before creating
- [ ] An existing `ours` block for the same tasks is not duplicated
- [ ] Description first line is exactly `ea:focus · created by executive-assistant`
- [ ] Times carry explicit offsets plus the IANA `timezone`
- [ ] Every block is marked from a read-back; `verified` is true only after it
- [ ] Only blocks proven missing are retried, once
- [ ] Reply reports "Made N of M" from the read-back

## Shifting (shift)

- [ ] Only `ours` events are updated, checked on a fresh read by id
- [ ] A hand-made `[Focus]` block without the marker is never touched
- [ ] Blocks move later the same day only, keeping order and length
- [ ] A shared block is shortened and a new block made for the moved task
- [ ] Each update is read back and marked `moved` or `failed`

## Safety

- [ ] No event that is not `ours` is changed, deleted, accepted or declined
- [ ] `send_updates` is `none` on every write
