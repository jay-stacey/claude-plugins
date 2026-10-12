# Data integrity checks

## Migrations
- Expand then contract: add new columns or tables first, write to both or backfill, switch reads,
  and remove the old shape in a later task. A single change that renames or drops a column that
  running code still reads is a blocker.
- Every migration has a down step that restores the previous schema. If data cannot be restored,
  the handoff sets `destructive` and the change waits for a human gate.
- New non-null columns on existing tables have a default or a backfill before the constraint.
- Long-running operations on large tables (index builds, rewrites) follow the overlay's online
  migration pattern.
- Evidence: `migrate-up`, `migrate-down`, `migrate-up` on the local database.

## Backfills
- Idempotent: running twice gives the same result. Restartable after a crash mid-way.
- Batched with a bounded size; no full-table lock.
- Dry-run mode or count first; logs counts, never personal data.

## Writes
- Related writes happen in one transaction, or in an order that leaves valid data after any failure.
- Unique and foreign key constraints exist where the code assumes uniqueness or existence.
- Concurrent updates: optimistic version check or lock where two writers can collide.
- Deletes are scoped, authorised, and match the constitution's retention rules (soft vs hard).

## Reads
- Code handles rows written before the change (old shape, nulls in new columns).
- Enum or status values added in code are handled by every reader, including reports and exports.

## Data shape across services
- Payload or event schema changes are backward compatible, or versioned with both versions
  handled during rollout.
