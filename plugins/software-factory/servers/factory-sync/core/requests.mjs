// Inbox requests raised by the sync (types tracker.* and sync.*), with dedupe, and their resolution.
// The sync never changes tasks itself: the CORE inbox processor applies requests (single writer).
import { join } from 'node:path';
import { listDir, readJson } from '../../../scripts/lib/fsutil.mjs';
import * as inbox from '../../../scripts/lib/inbox.mjs';
import * as store from '../../../scripts/lib/store.mjs';

const MAX_RAISED = 1000;

/** Every dedupe key already raised: our own record, the processor's archive, and pending inbox files. */
export function knownKeys(home, state) {
  const keys = new Set(Object.keys(state.raised || {}));
  for (const k of Object.keys(readJson(join(home, 'state', 'inbox-dedupe.json'), {}) || {})) keys.add(k);
  for (const name of inbox.pending(home)) {
    const r = readJson(join(home, 'inbox', name), null);
    if (r && r.dedupe_key) keys.add(r.dedupe_key);
  }
  return keys;
}

/**
 * Raise one request unless its dedupe key is known. Mutates state (raised, pending_requests).
 * Returns the request id, or null when deduped.
 */
export function raise(home, state, known, { type, payload, needs_confirmation = false, auto_apply = false, key, track = null, provider = 'tracker' }) {
  if (key && known.has(key)) return null;
  const req = inbox.write(home, {
    type, payload, source: 'tracker', actor: { kind: 'tracker', name: provider },
    needs_confirmation, auto_apply, ...(key ? { dedupe_key: key } : {}),
  });
  if (key) {
    known.add(key);
    state.raised = state.raised || {};
    state.raised[key] = req.id;
    const ks = Object.keys(state.raised);
    if (ks.length > MAX_RAISED) for (const k of ks.slice(0, ks.length - MAX_RAISED)) delete state.raised[k];
  }
  if (track) {
    state.pending_requests = state.pending_requests || {};
    state.pending_requests[req.id] = { type, ...track, at: req.created_at };
  }
  return req.id;
}

function findArchived(home, id) {
  const id8 = String(id).slice(0, 8);
  for (const dir of ['processed', 'rejected']) {
    const name = listDir(join(home, 'inbox', dir)).find((n) => n.includes(`-${id8}-`));
    if (name) return { dir, rec: readJson(join(home, 'inbox', dir, name), null) };
  }
  return null;
}

/** Outcome of a tracked request: pending | approved | rejected | superseded | lost. */
export function outcome(home, id) {
  if (inbox.pending(home).some((n) => n.includes(`-${String(id).slice(0, 8)}-`))) return 'pending';
  const hit = findArchived(home, id);
  if (!hit || !hit.rec) return 'lost';
  if (hit.dir === 'rejected') return 'rejected';
  const res = hit.rec.result || {};
  if (res.status === 'applied') return 'approved';
  if (res.status === 'superseded') return 'superseded';
  if (res.status === 'rejected') return 'rejected';
  if (res.status === 'gated' && res.gate_id) {
    const g = store.get(home, 'gate', res.gate_id);
    if (!g || g.status === 'pending') return 'pending';
    if (g.status === 'approved') return 'approved';
    if (g.status === 'superseded') return 'superseded';
    return 'rejected';
  }
  return 'pending';
}
