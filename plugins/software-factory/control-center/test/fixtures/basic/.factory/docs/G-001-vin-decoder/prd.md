# PRD: VIN decoder for inventory intake

## Problem
Staff type year, make, model and trim by hand at intake. This is slow and error prone.

## Users
- Intake staff at independent dealers
- Managers who review stock data

## Success criteria
1. A valid VIN fills year, make, model and trim in under **2 seconds**.
2. An invalid VIN shows a clear error.
3. Decodes are cached for 30 days.

| Metric | Today | Target |
|---|---|---|
| Intake time per unit | 4 min | 1 min |
| Data errors per 100 units | 7 | 1 |

See the [vendor docs](https://example.com/vin-api). This link is unsafe and must not render: [x](javascript:alert(1)).

<script>alert('should be escaped')</script>
