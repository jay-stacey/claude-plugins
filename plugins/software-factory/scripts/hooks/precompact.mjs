// PreCompact: lease holder writes run/cto-checkpoint.md and rebuilds the index.
import { runHook } from './_run.mjs';

runHook('precompact', async ({ payload, home }) => {
  const st = await import('../lib/state.mjs');
  if (!st.isInitialized(home) || !st.holdsLease(home, payload.session_id)) return null;
  const { writeCtoCheckpoint } = await import('../lib/status.mjs');
  const { rebuild } = await import('../lib/index.mjs');
  writeCtoCheckpoint(home);
  rebuild(home);
  return null;
});
