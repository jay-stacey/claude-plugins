// SessionEnd: the lease holder releases the lease (renewed_at -> epoch) so another session can take over.
import { runHook } from './_run.mjs';

runHook('session-end', async ({ payload, home }) => {
  const st = await import('../lib/state.mjs');
  const lease = st.readLease(home);
  if (!lease || !payload.session_id || lease.session_id !== payload.session_id) return null;
  st.releaseLease(home, payload.session_id);
  return null;
});
