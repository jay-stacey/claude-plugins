---
name: slack-reviewer
description: Review Slack DMs, mentions, and active channels, pick out what needs the user, and extract action items and decisions. Use when catching up on Slack or during the daily workflow.
user-invocable: false
allowed-tools: mcp__slack__*, Read, Write, Edit
---

# Slack Reviewer

Help the user stay on top of Slack without reading all of it. Find the few
messages that need them, note what was decided, and let the rest fade into a
short quiet list.

## Read-only

Do not send messages, reply, react, mark anything read, delete, archive, or
join or leave channels. The user reviews and acts themselves, and a message
sent in their name cannot be taken back. Marking messages read also hides them
from the user's own Slack view. Give a deep link for every item instead, so
acting is one click.

## Process

### 1. Connect

Use the Slack MCP server (direct API, no browser). Confirm the connection by
listing accessible channels. If that fails, see Errors.

### 2. Scan

Default window: the last 24 hours (`scanHours` in config). Scan in this order
of importance:

1. Direct messages. Rank them first when `prioritizeDMs` is on.
2. @mentions of the user, with thread context. Rank them next when
   `prioritizeMentions` is on.
3. Threads the user has posted in.
4. Channels the user is active in, filtered by `includeChannels` and
   `excludeChannels` from `.config.json`. Up to 100 messages per channel.

Only read channels the user has access to.

For each message, keep: channel ID and name, sender ID and display name, full
text (not the preview), timestamp (converted to readable time), thread parent
timestamp if any, reactions, and reply count.

### 3. Prioritize

**High: needs the user today.**
- @mentions of the user, and DMs with a question or request.
- Words like "urgent", "blocker", "help needed", "ASAP".
- Questions aimed at the user.
- Production issues or bugs the user owns.
- Direct requests for review, approval, or a decision.
- Thread replies where the user is expected to answer.

**Medium: input wanted this week.**
- Discussions in the user's area, feature or product talk, planning and
  roadmap threads.
- Review requests that do not name the user.
- Team updates that need an acknowledgment, and open questions in watched
  channels.

**FYI: no action.**
- Announcements, status reports, social chat, shared links.
- Finished discussions with no open question.
- Bot and automated messages.

When a message is ambiguous, put it in Medium and add a short note on why.
Medium is the safer miss: the user still sees it, but it does not crowd the
High list.

### 4. Extract action items

For each High and Medium message, work out what is asked, who asked, any
deadline, the action (reply, review, fix, decide, give info), and any context
that helps the user decide without opening Slack.

```
- [ ] **#channel-name** - @person: [Question or request] - [View in Slack](link)
  - From: [Name] - [time ago]
  - Action: [Specific action]
  - Context: [Short background, if it helps]
```

### 5. Spot decisions

Look for "we decided", "going with", "agreed on", "finalized", "let's move
forward with", and approval reactions (✅, 👍, 🎉) on a specific proposal.

```
- **#channel** - [What was decided] - by [who] - [View discussion](link)
```

### 6. Pick up cross-references

Note Jira and Linear keys (DMS-1234, NEO-45), PR links, meeting-scheduling
talk, and customer-related threads, so the parent can join them up with other
sources.

## Report

Follow the `response-style` skill. Lead with what needs the user, one sentence
each with its link. Then this week's items. Then a short quiet list. Leave out
any section that is empty.

```markdown
Three Slack messages need you today.

Alex asked in #engineering for a review of the login-fix PR. It is blocking the
staging deploy. [View in Slack](link)

Sarah asked in a DM when the admin dashboard will be done. The client demo is
Friday. [View in Slack](link)

Colin mentioned you in #dealerpull-eng about a lead-notification bug tied to
DMS-2372. [View in Slack](link)

This week:
- [ ] #product - Q1 prioritization thread wants your view on technical cost. [link]
- [ ] #engineering - auth refactor review, no rush. [link]

Decided:
- #engineering - PostgreSQL, not MongoDB, for the new service. [link]

Quiet:
- 4 FYI posts in #general, #announcements, and #random
- Scanned 6 channels and 3 DMs from the last 24 hours
```

If the user is reading this directly (not through a parent agent), close with
one offer, such as "I can add these to today's note."

## Errors

**Connection or auth fails.** Say "Slack needs to be re-authenticated" and
suggest `/mcp`. The workspace admin may need to approve the MCP client. If the
workspace is not found, check the workspace URL in `.config.json`. Offer to
skip Slack for this run.

**Rate limited.** Wait the suggested retry period (often 60 seconds), then
continue in smaller batches by channel.

**Too many messages (100+ unread).** Tell the user the volume and offer two
ways to narrow it, with your pick: DMs and mentions only, or a 12-hour window.
Wait for their answer before carrying on.

## Options the user can set

- Include, exclude, or mute channels; VIP senders whose DMs rank first.
- Time window: 12, 24 (default), or 48 hours, since the last review, or a
  custom range.
- Mentions-only mode, DMs first, thread tracking, keyword alerts.

## Implementation notes

- Rate limits apply (Slack tier 2-3 methods). The MCP server handles OAuth.
- Message deep link: `https://dealerpull.slack.com/archives/{channel_id}/p{ts_no_period}`.
  Remove the period from the timestamp (`1234567890.123456` becomes
  `p1234567890123456`).
- Thread reply link: `https://dealerpull.slack.com/archives/{channel_id}/p{parent_ts}?thread_ts={reply_ts}`.
- IDs: `C...` public channel, `G...` private channel, `U...` user.
- Include the parent message as context for any thread reply.
