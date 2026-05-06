---
name: gmail-processor
description: Token-efficient Gmail triage. Sweeps ALL unread mail via paginated metadata-only queries, classifies by sender + subject + snippet before fetching any bodies, then proposes batch cleanup actions. Also archives read inbox mail older than 7 days. Use whenever the user asks to process email, check inbox, triage Gmail, do email cleanup, achieve inbox zero, or run a daily email review.
allowed-tools: mcp__google-workspace__*, Read, Write, Edit
model: opus
---

# Gmail Processor

You triage Jay's Gmail inbox efficiently. The two principles that drive every choice in this skill:

1. **Don't miss mail.** Paginate every search until exhausted — Gmail's default page size is small and unread counts of 200+ are normal. A skill that only looks at the first page is silently broken.
2. **Don't read what you don't have to.** Email bodies are expensive in tokens. Sender + subject + snippet is enough to decide the fate of ~80% of mail. Only fetch full content for the small set that's actually important enough to need a response.

Everything below operationalizes those two principles.

---

## Phases

1. **Sweep unread (metadata only)** — paginated, all of it
2. **Triage by metadata** — classify each into one of 6 buckets without reading bodies
3. **Old-read cleanup** — find inbox mail older than 7 days and propose batch archive
4. **Fetch bodies only for the important set** — Urgent/Important only
5. **Propose batch actions** — single approval prompt
6. **Execute and report**

---

## MCP Tools

| Operation | Tool | Notes |
|-----------|------|-------|
| Search (paginated) | `search_gmail_messages` | Pass `page_token` to continue. Stop when no token returned. |
| Read one message | `get_gmail_message_content` | Use sparingly — only for Urgent/Important after triage |
| Read many messages | `get_gmail_messages_content_batch` | Preferred over single fetches when fetching >2 |
| List labels | `list_gmail_labels` | |
| Modify labels | `modify_gmail_message_labels` | `add_labels` / `remove_labels` |
| Batch modify | `batch_modify_gmail_message_labels` | Use for any operation on >1 message |
| Archive | remove `INBOX` label | |
| Trash | add `TRASH` label | Recoverable for 30 days |

All MCP tools return structured data. No JSON parsing.

---

## Phase 1: Sweep all unread (metadata only)

Run a paginated search across the entire unread queue. Do **not** call `get_gmail_message_content` in this phase — the search results already contain sender, subject, snippet, and date, which is all triage needs.

```
results = []
page_token = null
loop:
  response = search_gmail_messages(query: "is:unread", max_results: 100, page_token: page_token)
  results.extend(response.messages)
  if response.next_page_token is empty: break
  page_token = response.next_page_token
```

If the total count exceeds 500, tell the user the count and ask whether to proceed with the full sweep or scope down (e.g., `is:unread newer_than:3d`). Don't silently truncate — the previous version of this skill did, and that's the bug we're fixing.

For each message keep only what triage needs: `message_id`, `from`, `subject`, `snippet`, `date`, `label_ids`.

---

## Phase 2: Metadata-only triage

Walk the unread list once and assign each message to exactly one bucket using sender, subject, and snippet. No body fetches.

### Buckets

**1. Urgent — needs response today**
- Sender matches a VIP contact (read from config), or
- Subject contains: `urgent`, `asap`, `deadline today`, `EOD`, `immediate`, or
- Sender is the user's manager / direct reports / known critical stakeholders.
- → Will fetch body in Phase 4.

**2. Important — needs response this week**
- Sender is a real person (not `noreply@`, `notifications@`, etc.) AND not a VIP, OR
- Subject pattern suggests a request: `?` in subject, `can you`, `review`, `approval`, `feedback`, `meeting`.
- → Will fetch body in Phase 4 only if subject + snippet aren't already enough to summarize.

**3. FYI / Notification — archive, no response**
- Sender: `no-reply@`, `noreply@`, `notifications@`, `updates@`, `alerts@`, `donotreply@`.
- Sender domain matches monitoring services: `azure-noreply@microsoft.com`, `notifications@github.com`, `*@atlassian.net`, `jira@`.
- → No body fetch. Count by source, archive in batch, summarize.

**4. Newsletter — label + archive**
- Sender domain or address matches a known newsletter pattern: `tldr.tech`, `tldrnewsletter.com`, `substack.com`, `mailchimp`, `*newsletter*`, `digest@`, `weekly@`, sender contains "newsletter" / "digest" / "roundup".
- → No body fetch. Apply `FYI/Newsletters` label, archive.

**5. Marketing / Spam — propose delete**
- Subject contains: `% off`, `sale`, `deal`, `promo`, `offer`, `limited time`, `discount`, `coupon`, `free trial`, `last chance`.
- Sender is a known commercial domain not on VIP list.
- → No body fetch. Propose batch trash.

**6. Skip / Ambiguous**
- Doesn't match any of the above. Leave for the user to look at directly. Count and report; don't act on these.

### Safety overrides (applied last, before any action)

A message is moved out of any "delete" or "auto-archive" bucket and into "Important" if **any** of these are true:
- Sender matches `vipContacts` from config
- Subject contains: `invoice`, `receipt`, `contract`, `legal`, `tax`, `payment`, `wire`, `1099`, `W-2`, `W-9`
- Already has `STARRED` or `IMPORTANT` label
- Subject contains the user's full name (likely personal)

This is non-negotiable. False positives in these categories are expensive (lost legal docs, missed payments). Better to leave a marketing email in the Important bucket than auto-trash a contract.

---

## Phase 3: Old-read inbox cleanup

After triaging unread, look for read mail rotting in the inbox.

```
old_read = []
page_token = null
loop:
  response = search_gmail_messages(
    query: "in:inbox -is:unread older_than:7d -is:starred -label:Action/Urgent",
    max_results: 100,
    page_token: page_token
  )
  old_read.extend(response.messages)
  if no next_page_token: break
```

Apply the same safety overrides from Phase 2 (VIP senders, financial/legal subject keywords, `IMPORTANT` label). Anything that survives is a candidate for batch archive.

These don't go to Trash — just remove the `INBOX` label. They stay in All Mail and are fully searchable. Read-and-7-days-old is a strong "you don't need this in your face anymore" signal.

---

## Phase 4: Fetch bodies for the important set only

Only now, after triage and safety filtering, do you fetch any message bodies.

```
ids_to_fetch = urgent_ids + important_ids_that_need_summary
if len(ids_to_fetch) > 0:
  bodies = get_gmail_messages_content_batch(message_ids: ids_to_fetch)
```

For Important emails where subject + snippet already make the action item obvious (e.g., "Approve PR #123" from a known colleague), skip the body fetch. Use judgment — the goal is to fetch the minimum that lets you write a useful summary.

If `ids_to_fetch` is empty, skip the call entirely. Don't fetch bodies "just in case."

---

## Phase 5: Propose batch actions

Present one consolidated proposal. The user gets a single decision point, not a stream of approvals.

```markdown
## EMAIL TRIAGE PROPOSAL

**Inbox sweep:** {unread_count} unread, {old_read_count} read >7d in inbox
**Bodies fetched:** {fetched_count} (out of {unread_count} unread)

---

### URGENT — keep in inbox, needs response today ({n})
- **{from}** — {subject}
  - {one-line summary from body}
  - [Open in Gmail]({link})

### IMPORTANT — needs response this week ({n})
- **{from}** — {subject} ({snippet preview if no body fetched})

### PROPOSED: Archive ({n})
- FYI/Notifications: {n} (Azure: {n}, GitHub: {n}, Jira field-changes: {n}, other: {n})
- Newsletters: {n} ({list of newsletter sources})
- Old read mail (>7d): {n}

### PROPOSED: Trash ({n})
- Marketing/Spam: {n}
  - Top senders: {top 3 senders with counts}

### LEFT FOR YOU ({n})
- {n} messages didn't match triage rules — review manually in Gmail

---

**Options:**
- `execute all` — archive + trash everything proposed
- `archive only` — archive the {n} but skip the {n} trash
- `show details` — list every proposed deletion before deciding
- `skip` — leave the inbox as-is
```

If the trash count is large (>30) or the proposal touches >50% of all unread, default to showing details rather than asking for blind approval. Big batches deserve a closer look.

---

## Phase 6: Execute and report

Use `batch_modify_gmail_message_labels` for every action. Never loop single calls when a batch is available — that's both slower and more tokens.

```
# Archives (FYI + newsletters + old-read)
batch_modify_gmail_message_labels(
  message_ids: archive_ids,
  remove_labels: ["INBOX"],
  add_labels: [category_label]  # e.g., "FYI/Newsletters" for newsletter batch
)

# Trash
batch_modify_gmail_message_labels(
  message_ids: trash_ids,
  add_labels: ["TRASH"]
)
```

Then report:

```markdown
## EMAIL TRIAGE COMPLETE — {date} {time}

**Sweep:** {unread} unread, {old_read} old read mail
**Bodies fetched:** {fetched} ({pct}% of total)

**Actions:**
- Archived: {n} ({fyi_n} FYI, {newsletter_n} newsletters, {old_n} old-read)
- Trashed: {n} marketing
- Kept urgent in inbox (starred): {n}
- Left for manual review: {n}

**Urgent — needs your attention today:**
- [ ] **{from}**: {subject} — {summary} — [Open]({link})

**Important — this week:**
- [ ] **{from}**: {subject} — {summary} — [Open]({link})

**Recovery:** trashed mail recoverable from Gmail Trash for 30 days. Archived mail in All Mail.
```

---

## Hand-off to gmail-organizer

Pass categorized data to gmail-organizer for label application:

```json
{
  "urgent": [{"messageId": "...", "from": "...", "subject": "..."}],
  "important": [...],
  "fyi": [...],
  "azureAlerts": [...],
  "githubNotifications": [...],
  "jiraNotifications": [...],
  "newsletters": [...]
}
```

---

## Safety rules

- **Always batch-confirm before any delete or archive.** No silent actions.
- **Trash is recoverable, archive is reversible** — but the user still gets a final yes/no.
- **Safety overrides win.** VIP/financial/legal/starred mail is never auto-trashed even if it triggers spam keywords.
- **Never auto-reply or send.**
- **Read-only by default.** All triage and classification happens before any write.

---

## Error handling

**MCP connection fails** → Report error, suggest `/mcp` to check status. Don't retry silently.

**Pagination returns an error mid-sweep** → Report what was retrieved, ask whether to proceed with partial data or retry.

**Triage rule unsure about a message** → Bucket 6 (Skip / Ambiguous). Never guess into a destructive bucket.

**Batch operation partially fails** → Report which IDs failed; the rest succeed. Continue, don't roll back.

---

## Configuration

Reads from plugin config:

```json
{
  "gmailProcessor": {
    "vipContacts": ["boss@company.com", "spouse@personal.com"],
    "oldReadCleanupDays": 7,
    "maxUnreadBeforeAsking": 500,
    "newsletterSenderPatterns": ["tldr.tech", "substack.com", "*newsletter*", "digest@"],
    "alwaysKeepKeywords": ["invoice", "receipt", "contract", "legal", "tax", "payment", "wire"]
  }
}
```

If config is missing, use the defaults baked into the bucket rules above.

---

## Testing checklist

- [ ] Pagination retrieves all unread (test with inbox >100 unread)
- [ ] Body fetch count is much smaller than total unread count
- [ ] Old-read sweep finds read mail >7d and respects starred/urgent labels
- [ ] VIP override prevents auto-trash even with marketing subject
- [ ] Financial/legal keyword override works
- [ ] Batch operations used for all multi-message actions
- [ ] Single approval prompt covers archive + trash batches
- [ ] Report shows fetched-vs-total ratio (efficiency signal)
