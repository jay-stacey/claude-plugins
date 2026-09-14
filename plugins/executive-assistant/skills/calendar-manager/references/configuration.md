# Configuration Reference — calendar-manager

Read from config:

```json
{
  "calendarManager": {
    "timeboxing": {
      "enabled": true,
      "maxUtilization": 0.75,
      "bufferMinutes": 10,
      "preferredFocusTime": "morning"
    },
    "recurringBlocks": [...],
    "bottleneckThresholds": {
      "overcommitment": 0.85,
      "minDeepWorkHours": 2,
      "backToBackMeetingHours": 2.5,
      "fragmentationThreshold": 4
    },
    "protectedTime": {
      "morningDeepWork": {
        "enabled": true,
        "days": ["Monday", "Wednesday", "Friday"],
        "timeRange": "08:00-10:00"
      }
    }
  }
}
```

---
