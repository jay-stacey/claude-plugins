// sync/state.json: shared by the factory-sync MCP server and the CLI (`factory sync status|approve-preview`).
// Only the sync server and these helpers write it. Writes take the home mutex (the CLI writes it too).
import { join } from 'node:path';
import { nowIso, readJson, readLines, writeJsonAtomic, withMutex } from './fsutil.mjs';

export function syncDir(home) { return join(home, 'sync'); }
export function statePath(home) { return join(home, 'sync', 'state.json'); }

export function defaultState() {
  return {
    version: 1, provider: null, scope_key: null, first_sync_approved: false, approved_at: null, approved_by: null,
    preview: null, cursor: null, last_pull_at: null, last_push_at: null, last_full_tick: 0, tick_count: 0,
    health: 'ok', consecutive_failures: 0, last_error: null, backoff_until: null, rate: {},
    discovery: null, status_map: null, pending_requests: {}, raised: {}, bulk_approved: false, machine_id: null,
  };
}

export function readState(home) {
  const s = readJson(statePath(home), null);
  return { ...defaultState(), ...(s || {}) };
}

export function updateState(home, fn) {
  return withMutex(home, () => {
    const cur = readState(home);
    const out = fn(cur) || cur;
    writeJsonAtomic(statePath(home), out);
    return out;
  });
}

/** Approve the first-sync preview. Idempotent. Returns the new state. */
export function approvePreview(home, previewId, { by = 'human' } = {}) {
  const s = readState(home);
  if (!s.preview || !s.preview.id) { const e = new Error('no sync preview yet; run /software-factory:sync --preview'); e.exitCode = 1; throw e; }
  if (previewId && previewId !== s.preview.id) { const e = new Error(`preview ${previewId} is stale; the current preview is ${s.preview.id}`); e.exitCode = 1; throw e; }
  return updateState(home, (x) => {
    if (!x.first_sync_approved) {
      x.first_sync_approved = true; x.approved_at = nowIso(); x.approved_by = by;
      x.cursor = null; // the first approved tick pulls everything in scope
    }
  });
}

/** Short status lines (no network). */
export function statusLines(home) {
  const s = readState(home);
  const map = readJson(join(home, 'sync', 'map.json'), null) || { items: {}, goals: {} };
  const outbox = readLines(join(home, 'sync', 'outbox.jsonl'));
  const lines = [
    `sync ${s.provider || 'not set up'} health ${s.health}${s.consecutive_failures ? ` (${s.consecutive_failures} failed ticks)` : ''}`,
    `first sync ${s.first_sync_approved ? `approved ${s.approved_at || ''}`.trim() : s.preview ? `waiting for approval of preview ${s.preview.id}` : 'not previewed'}`,
    `last pull ${s.last_pull_at || 'never'}; last push ${s.last_push_at || 'never'}`,
    `mapped ${Object.keys(map.goals || {}).length} goals, ${Object.keys(map.items || {}).length} tasks; outbox ${outbox.length}`,
  ];
  if (s.backoff_until && Date.parse(s.backoff_until) > Date.now()) lines.push(`backoff until ${s.backoff_until}`);
  const pend = Object.keys(s.pending_requests || {}).length;
  if (pend) lines.push(`${pend} tracker requests waiting on a decision`);
  if (s.last_error) lines.push(`last error: ${String(s.last_error).slice(0, 100)}`);
  return lines;
}
