// sync/map.json: identity between local goals/tasks and tracker items (design C §7).
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../../../scripts/lib/fsutil.mjs';

export function mapPath(home) { return join(home, 'sync', 'map.json'); }

export function emptyMap(tracker = null, scopeKey = null) {
  return { version: 1, tracker, scopeKey, items: {}, goals: {} };
}

export function loadMap(home) {
  const m = readJson(mapPath(home), null);
  if (!m) return emptyMap();
  return { ...emptyMap(), ...m, items: m.items || {}, goals: m.goals || {} };
}

export function saveMap(home, map) { writeJsonAtomic(mapPath(home), map); }

/** The bucket for a local id: goals for G-*, items for T-*. */
export function bucket(map, localId) { return String(localId).startsWith('G-') ? map.goals : map.items; }

export function entryFor(map, localId) { return bucket(map, localId)[localId] || null; }

export function ensureEntry(map, localId) {
  const b = bucket(map, localId);
  if (!b[localId]) {
    b[localId] = {
      kind: String(localId).startsWith('G-') ? 'goal' : 'task', remoteId: null, key: null, url: null,
      pushed: {}, pulled: {}, local: {}, pendingCreate: false, ourCommentIds: [], linkedPRs: [], commentedRuns: [],
    };
  }
  return b[localId];
}

/** remoteId -> localId index. */
export function byRemote(map) {
  const out = new Map();
  for (const b of [map.goals, map.items]) for (const [id, e] of Object.entries(b)) if (e.remoteId) out.set(String(e.remoteId), id);
  return out;
}

export function allEntries(map) { return [...Object.entries(map.goals), ...Object.entries(map.items)]; }
