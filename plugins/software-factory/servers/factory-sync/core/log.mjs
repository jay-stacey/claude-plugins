// Audit log: sync/log-YYYY-MM.jsonl, one line per op. Field NAMES only, never values (keeps PII out).
import { join } from 'node:path';
import { appendLine, nowIso } from '../../../scripts/lib/fsutil.mjs';

export function logPath(home, now = Date.now()) {
  const d = new Date(now);
  return join(home, 'sync', `log-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
}

const KEEP = ['tick', 'dir', 'op', 'localId', 'remoteKey', 'result', 'httpStatus', 'requestId', 'rateRemaining', 'reason'];

export function audit(home, entry, now = Date.now()) {
  const line = { ts: nowIso(now) };
  for (const k of KEEP) if (entry[k] !== undefined && entry[k] !== null) line[k] = entry[k];
  line.fields = (entry.fields || []).map((f) => String(f)).slice(0, 20);
  if (line.reason) line.reason = String(line.reason).replace(/\s+/g, ' ').slice(0, 160);
  try { appendLine(logPath(home, now), line); } catch { /* best effort */ }
  return line;
}
