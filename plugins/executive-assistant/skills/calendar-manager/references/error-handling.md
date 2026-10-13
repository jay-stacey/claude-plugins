# Error handling — calendar-manager

Say what broke, whether it matters, and what happens next, in one or two
sentences.

## A create or update fails

- Keep going with the other blocks.
- Read the day back before deciding anything. A call that returned an error
  may still have saved.
- Retry once, only for blocks the read-back shows missing. Then read back
  again and report the final count.
- Give the reason in plain words: "that slot was taken", "Google said no
  permission", "it did not save".

> Made 2 of 3. The 1:40 admin block did not save after two tries. You can add
> it by hand, or I can try again later.

## The read-back fails

Set `verified: false`. Do not say the blocks were made.

> I sent three blocks but could not read the calendar back to check them.
> Open today's calendar to see which ones are there.

## Google does not connect or needs sign-in

No writes. Return the proposed plan as text so it is still useful, and suggest
`/mcp`.

## The event to shift is not `ours`

Leave it. Say you only move the assistant's own blocks. This includes a
`[Focus]` block with no `ea:focus` marker, because the user made it.

## The event to shift is gone

The user may have deleted it. Do not recreate it unless they ask. Mark it
`failed` with the reason "no longer on the calendar".
