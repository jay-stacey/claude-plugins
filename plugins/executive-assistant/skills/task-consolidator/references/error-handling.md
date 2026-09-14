# Error Handling — task-consolidator

### Daily Note Doesn't Exist
1. Check template exists at expected location
2. If template found, create new daily note
3. If template not found:
   - Alert user: "Template not found at expected location"
   - Offer: Create basic note, specify template, or skip consolidation

### Section Not Found in Daily Note
For new sections (Schedule, Reading List, Email Summaries):
- Insert section in proper order relative to existing sections
- Follow the order defined above

For core sections (URGENT, IMPORTANT, etc.):
- **Option 1**: Add new section header and insert tasks
- **Option 2**: Ask user where to place tasks
- **Option 3**: Add to INBOX section as fallback

### Edit Conflict
- If daily note was modified during processing:
  - Re-read daily note
  - Merge changes carefully
  - Inform user: "Daily note updated during processing. Merging..."

### File Permission Error
- Check whether another app has the file locked
- Ask the user to close the daily note if it is open in an editor
- If still failing, save to Quick Captures as backup

---
