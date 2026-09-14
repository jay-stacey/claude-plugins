# Testing Checklist — calendar-manager

Developer-facing verification steps for this skill. Not needed at runtime.

### Timeboxing
- [ ] Extracts todos correctly
- [ ] Matches to optimal slots
- [ ] Respects priorities
- [ ] Considers energy patterns
- [ ] Doesn't overschedule
- [ ] Leaves buffer time

### Event Creation
- [ ] `manage_event` creates events with correct details
- [ ] `manage_focus_time` creates focus blocks
- [ ] Uses [Focus] prefix
- [ ] Includes description with source
- [ ] Verifies creation via `get_events`
- [ ] Reports success/failure

### Recurring Blocks
- [ ] Loads templates from config
- [ ] Detects missing blocks via search
- [ ] Creates with recurrence rules
- [ ] Uses correct colors

### Bottlenecks
- [ ] Detects overcommitment
- [ ] Detects back-to-back meetings
- [ ] Detects insufficient deep work
- [ ] Detects fragmentation
- [ ] Provides actionable recommendations

### Safety
- [ ] Never modifies existing events
- [ ] Requires explicit approval
- [ ] Provides undo instructions
- [ ] Handles errors gracefully
