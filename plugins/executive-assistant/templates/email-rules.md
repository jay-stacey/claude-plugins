---
title: Email rules
tags: [assistant, email]
---
# Email rules

The assistant reads this file before every email pass. You can edit it by hand.
When you tell the assistant "always trash these" or "never touch these", it
adds a line here and shows you the line.

## How a rule is written

One rule per line, five parts split by `|`:

```
- action | mode | name | gmail query | label (only for label and archive)
```

- **action**: `keep` (always show it to you, never move it), `support`
  (support owns it: archive it, never make it a task), `label` (add the label,
  then archive, never delete), `archive`, or `trash`.
- **mode**: `auto` acts without asking and reports a count. `confirm` waits
  for your one yes per run.
- **gmail query**: normal Gmail search words, such as `from:`, `subject:`,
  `category:`, `OR`, `-word`. Test a query in the Gmail search box first.

The first rule that matches wins, so `keep` rules come first. A rule that
still holds a `<placeholder>` is skipped until you fill it in, and the morning
brief asks you once to fill it in.

Trash is safe to undo: Gmail keeps trashed mail for 30 days. Nothing here ever
deletes mail for good.

## Always keep

- keep | auto | Production incidents | from:azure-noreply@microsoft.com subject:(Sev0 OR Sev1) -subject:resolved
- keep | auto | Security advisories | subject:("security advisory" OR "vulnerability" OR "security alert")
- keep | auto | Money owed or failed | subject:("payment failed" OR "past due" OR "overdue" OR "action required" OR "final notice")
- keep | auto | Legal and contracts | subject:(contract OR legal OR agreement OR "terms update" OR subpoena)
- keep | auto | Auth and access deadlines | from:(auth0.com OR okta.com) subject:(deadline OR deprecat OR "action required")
- keep | auto | From the CEO | from:<ceo-address>
- keep | auto | Starred | is:starred

## Support owns these

- support | auto | Customer replies to support | to:<support-address>
- support | auto | Cancellations and refunds | subject:(cancel OR cancellation OR refund) to:<support-address>

## Label, never delete

- label | auto | Inventory feed error logs | subject:("feed error" OR "import failed" OR "feed failed") | Monitoring/Feeds
- archive | auto | Routine SaaS receipts | subject:(receipt OR invoice) from:(stripe.com OR microsoft.com OR twilio.com OR google.com) -subject:("payment failed" OR "past due") | Finance/Receipts

## Archive without asking

- archive | auto | Resolved Azure alerts | from:azure-noreply@microsoft.com subject:resolved
- archive | auto | Known-noise Azure alerts | from:azure-noreply@microsoft.com subject:("dependency failure" OR "client disconnect")

## Trash without asking

- trash | auto | Tech newsletters | from:(tldr.tech OR tldrnewsletter.com OR substack.com OR medium.com OR beehiiv.com)
- trash | auto | Promotions | category:promotions -is:starred
- trash | auto | Webinars and events | subject:(webinar OR "register now" OR "join us live" OR "save your seat")
- trash | auto | GitHub notifications | from:notifications@github.com
- trash | auto | Jira automation | from:(jira@ OR atlassian.net) subject:("changed" OR "assigned" OR "updated") -subject:mentioned
- trash | auto | Linear digests | from:linear.app subject:(digest OR "weekly summary")
- trash | auto | Calendar reminders | from:calendar-notification@google.com

## Trash after one yes

- trash | confirm | Cold sales | subject:("quick question" OR "15 minutes" OR "partnership" OR "following up") -from:<your-domain>

## Learned rules

New rules the assistant adds go below this line, with the date.
