---
name: ea
description: Short alias for daily-prep. Runs the full daily workflow preparation across Calendar, Gmail, Slack, Jira, and Linear. Use when the user types /ea or asks for their assistant by that name.
argument-hint: "[--quick] [--dry-run] [--only-email]"
context: fork
agent: assistant
model: opus
---

# /ea

Alias for `daily-prep`. Follow the `daily-prep` skill — it holds the options,
the sub-agent routing, and the output format. Nothing differs but the name.
