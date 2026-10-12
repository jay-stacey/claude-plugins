// Outbox: push ops persisted before the call (sync/outbox.jsonl). Coalesces ops for the same field,
// retries with exponential backoff (1, 2, 4, 8 ticks' worth, capped at 30 minutes).
import { join } from 'node:path';
import { readLines, writeTextAtomic } from '../../../scripts/lib/fsutil.mjs';

export const BASE_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 30 * 60_000;

export function outboxPath(home) { return join(home, 'sync', 'outbox.jsonl'); }

export function load(home) { return readLines(outboxPath(home)); }

export function save(home, entries) {
  writeTextAtomic(outboxPath(home), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

/** Coalescing key: same local item, same op type, same field -> only the newest value is sent. */
export function slot(op) {
  if (['add_comment', 'add_link', 'ensure_label', 'create_item'].includes(op.type)) return `${op.type}:${op.localId}:${op.opId}`;
  return `${op.type}:${op.localId}:${op.field || ''}`;
}

/** Add ops. An op whose opId is queued is kept as is; an op for the same slot replaces the older one. */
export function enqueue(entries, ops, now = Date.now()) {
  const out = [...entries];
  for (const op of ops) {
    if (out.some((e) => e.op.opId === op.opId)) continue;
    if (op.type === 'create_item' && out.some((e) => e.op.type === 'create_item' && e.op.localId === op.localId)) continue;
    const i = out.findIndex((e) => slot(e.op) === slot(op));
    const rec = { opId: op.opId, op, attempts: 0, nextAttemptAt: 0, lastError: null, createdAt: now };
    if (i >= 0) out[i] = rec; else out.push(rec);
  }
  return out;
}

export function due(entries, now = Date.now()) { return entries.filter((e) => (e.nextAttemptAt || 0) <= now); }

export function backoffMs(attempts) { return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1)); }

export function markFailed(entry, error, now = Date.now(), retryAfterMs = 0) {
  entry.attempts += 1;
  entry.lastError = String(error || 'failed').slice(0, 200);
  entry.nextAttemptAt = now + Math.max(backoffMs(entry.attempts), retryAfterMs || 0);
  return entry;
}
