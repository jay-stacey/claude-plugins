# Provider Integration Points

### Provider-Specific Features

**Obsidian:**
- **WikiLinks**: Use `[[YYYY-MM-DD]]` format for daily note references
- **Tags**: Add tags like #urgent, #waiting-for, #follow-up
- **Backlinks**: Create links to project notes, people notes
- **Dataview**: Structure for query compatibility

**Notion:**
- **Database Properties**: Update Status, Tags, Urgent Count
- **Links**: Use `[Page Title](notion://...)` format
- **Mentions**: Link to @people and pages

**Logseq:**
- **Block References**: Use `((block-uid))` for references
- **Page Links**: Use `[[page-name]]` format
- **Properties**: Add block properties for metadata

**Roam Research:**
- **Page References**: Use `[[page-name]]` format
- **Block References**: Use `((block-uid))`
- **Attributes**: Use `attribute:: value` format

**Plain Markdown:**
- **Links**: Use standard `[text](path)` format
- **Cross-references**: Use relative paths `./YYYY-MM-DD.md`

### Fallback Behavior
- If consolidation fails, save to provider's designated inbox/capture location
- User can manually process later
- Include full report in fallback location

---
