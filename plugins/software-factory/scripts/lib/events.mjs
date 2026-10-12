// Event log: one JSON line per event, lock-free append, rotation at 20 MB.
import { renameSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, ensureDir, nowIso, retry } from './fsutil.mjs';
import { compactTs, ulid } from './ids.mjs';

const MAX_LINE = 4096;

export function eventsFile(home) { return join(home, 'events', 'events.jsonl'); }

export function emit(home, ev) {
  if (!home || !ev || !ev.type) return null;
  const line = {
    v: 1, id: ulid(), ts: nowIso(), type: ev.type, source: ev.source || 'cli',
    ...(ev.session_id ? { session_id: ev.session_id } : {}),
    actor: ev.actor || { kind: 'system' },
  };
  for (const k of ['goal_id', 'epic_id', 'task_id', 'run_id']) if (ev[k]) line[k] = ev[k];
  line.msg = String(ev.msg || ev.type).replace(/\s+/g, ' ').slice(0, 140);
  line.data = ev.data || {};
  let s = JSON.stringify(line);
  if (Buffer.byteLength(s) > MAX_LINE) {
    line.data = { truncated: true };
    s = JSON.stringify(line);
  }
  try { appendLine(eventsFile(home), s); } catch { /* best effort */ }
  return line;
}

export function rotate(home, maxBytes = 20 * 1024 * 1024) {
  const f = eventsFile(home);
  let size = 0;
  try { size = statSync(f).size; } catch { return false; }
  if (size < maxBytes) return false;
  ensureDir(join(home, 'events', 'archive'));
  try {
    retry(() => renameSync(f, join(home, 'events', 'archive', `events-${compactTs()}.jsonl`)));
    return true;
  } catch { return false; }
}

/** Last n events (reads only the tail of the file). */
export function tail(home, n = 50) {
  const f = eventsFile(home);
  let size = 0;
  try { size = statSync(f).size; } catch { return []; }
  const want = Math.min(size, Math.max(8192, n * 1024));
  let txt;
  if (want === size) txt = readFileSync(f, 'utf8');
  else {
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    closeSync(fd);
    txt = buf.toString('utf8');
    txt = txt.slice(txt.indexOf('\n') + 1);
  }
  const out = [];
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn */ }
  }
  return out.slice(-n);
}
