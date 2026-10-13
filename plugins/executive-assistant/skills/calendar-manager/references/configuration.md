# Configuration — calendar-manager

The profile at `{vault}/assistant/profile.md` wins over every value here. These
are the fallbacks in `config/default.json`, under `calendar`.

```json
{
  "calendar": {
    "workingHours": { "start": "06:30", "end": "15:00" },
    "timezone": "America/Toronto",
    "energyPatterns": {
      "deep":   { "start": "06:30", "end": "11:30" },
      "collab": { "start": "11:30", "end": "13:30" },
      "admin":  { "start": "13:30", "end": "15:00" }
    },
    "minFreeBlockMinutes": 25,
    "breaks": { "lunchBreak": { "start": "11:30", "duration": 30, "window": "11:00-13:30" } },
    "timeboxing": {
      "maxUtilization": 0.75,
      "bufferMinutes": 10,
      "maxBlockMinutes": 120,
      "roundToMinutes": 5,
      "defaultEstimateMinutes": 30
    },
    "focusBlock": {
      "titlePrefix": "[Focus]",
      "marker": "ea:focus",
      "descriptionFirstLine": "ea:focus · created by executive-assistant"
    }
  }
}
```

Environment values from `/plugin configure` sit between the two:
`CLAUDE_PLUGIN_OPTION_WORKING_HOURS_START`, `..._END` and
`CLAUDE_PLUGIN_OPTION_TIMEZONE`.

The `speed` multiplier is not a setting. It comes from
`tasks.py stats`, measured from finished tasks that had both an estimate and
an actual time.

Recurring strategic blocks (monthly security audit and similar) were removed
in 8.0. The user's fixed week lives in the profile's Recurring week section,
and those are real meetings, not blocks the assistant should make.
