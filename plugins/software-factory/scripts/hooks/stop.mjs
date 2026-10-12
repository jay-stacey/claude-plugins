// Stop (main thread, lease holder only): cursor-based usage snapshot of the dispatcher session (overhead).
import { runHook } from './_run.mjs';

runHook('stop', async ({ payload, home }) => {
  if (payload.agent_id || !payload.session_id || !payload.transcript_path) return null;
  const st = await import('../lib/state.mjs');
  if (!st.holdsLease(home, payload.session_id)) return null;
  const { join } = await import('node:path');
  const { readJson, writeJsonAtomic } = await import('../lib/fsutil.mjs');
  const usage = await import('../lib/usage.mjs');
  const file = join(home, 'state', 'session-cursors.json');
  const all = readJson(file, {}) || {};
  const cur = usage.parseIncremental(payload.transcript_path, all[payload.session_id] || null);
  all[payload.session_id] = cur;
  writeJsonAtomic(file, all);
  usage.writeSnapshot(home, { source: 'hook', scope: 'session', session_id: payload.session_id, role: 'cto', status: 'running', requests: cur.requests, by_model: cur.by_model });
  return null;
});
