---
name: roam-provider
description: Roam Research integration for daily pages and task management. Uses Roam API.
allowed-tools: Read, Write, Edit
model: opus
---

# Roam Provider

Implements the Notes Provider interface for Roam Research graphs.

## Configuration

```json
{
  "notes": {
    "provider": "roam",
    "roam": {
      "graphName": "my-graph",
      "apiToken": "${ROAM_API_TOKEN}"
    }
  }
}
```

---

## Prerequisites

1. **Roam API Access** - Requires Roam Pro or higher
2. **API Token** - Generate from Roam settings
3. **Graph Name** - Your Roam graph name

---

## Operations

### findDailyNote(date)

```
1. Roam daily pages use format: "January 15th, 2026"
2. Query graph for page with this title
3. API endpoint: GET /api/graph/{graph}/page/{title}
4. Return { exists, pageUid, content, blocks }
```

### createDailyNote(date, template)

```
1. Check if daily page exists
2. Roam auto-creates daily pages
3. If blocks needed: add via API
4. Return { success, pageUid, created }
```

### readNote(pageUid)

```
1. Query page blocks via API
2. Build block tree from response
3. Convert to markdown-like structure
4. Return { content, blocks, sections }
```

### updateNote(pageUid, content)

```
1. Parse content into Roam blocks
2. Update via batch API
3. Return { success, pageUid }
```

### appendToSection(pageUid, section, content)

```
1. Find block with section text
2. Create child blocks under section
3. Use API to append
4. Return { success, section, blocksAdded }
```

---

## Roam Format

### Block Structure

Roam uses nested bullet points with UIDs:

```
- Today's Focus {{[[TODO]]}}
  - [[TODO]] Priority 1
  - [[TODO]] Priority 2
- URGENT
  - [[TODO]] **Email from John**
    - Deadline: Today 5 PM
```

### TODO Items

Roam uses special syntax for tasks:

```
- {{[[TODO]]}} Task description
- {{[[DONE]]}} Completed task
```

### Links and References

```
- See [[January 14th, 2026]] for yesterday
- Related to [[Project Alpha]]
- #urgent #work
```

### Attributes

```
- Task description
  - Priority:: High
  - Deadline:: [[January 15th, 2026]]
```

---

## Date Format

Roam daily pages use a specific format:

```
January 15th, 2026
```

**Format Rules:**
- Month: Full name (January, February, etc.)
- Day: Ordinal (1st, 2nd, 3rd, 4th, ..., 15th, ...)
- Year: Four digits
- Separator: Comma and space

**Examples:**
- January 1st, 2026
- February 22nd, 2026
- March 3rd, 2026
- April 4th, 2026

---

## API Endpoints

Roam uses a backend API:

| Operation | Endpoint |
|-----------|----------|
| Get page | GET /api/graph/{graph}/page/{title} |
| Create block | POST /api/graph/{graph}/create-block |
| Update block | POST /api/graph/{graph}/update-block |
| Delete block | POST /api/graph/{graph}/delete-block |
| Query | POST /api/graph/{graph}/q |

---

## Default Page Structure

```
- Today's Focus
  - {{[[TODO]]}}
- ---
- INBOX
  -
- ---
- URGENT
  -
- ---
- IMPORTANT
  -
- ---
- WORK LOG
  -
- ---
- AUTOMATED REVIEW
  -
```

---

## Section Finding

Find sections by block text content:

```javascript
// Find block with text matching section
const sectionBlock = blocks.find(b =>
  b.string.includes('URGENT') ||
  b.string === 'URGENT'
);

// Get section UID for appending
const sectionUid = sectionBlock.uid;
```

---

## Error Handling

### API Authentication Failed
```
Error: Invalid API token
Action: Verify token in config
Suggest: Regenerate token in Roam settings
```

### Graph Not Found
```
Error: Graph {graphName} not found
Action: Verify graph name in config
Suggest: Check Roam graph exists and is accessible
```

### Rate Limited
```
Error: API rate limit exceeded
Action: Wait and retry
Note: Roam API has strict rate limits
```

### No API Access
```
Error: API not available (Roam Pro required)
Action: Inform user of requirement
Suggest: Upgrade to Roam Pro or use different provider
```

---

## Testing Checklist

- [ ] Authenticates with Roam API
- [ ] Finds daily page by date
- [ ] Creates blocks with proper format
- [ ] Reads block tree structure
- [ ] Converts blocks to markdown
- [ ] Appends child blocks to sections
- [ ] Handles TODO syntax correctly
- [ ] Creates proper page links [[]]
- [ ] Handles rate limiting
- [ ] Handles missing API access gracefully
