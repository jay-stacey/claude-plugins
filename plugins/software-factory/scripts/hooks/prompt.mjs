// UserPromptSubmit: record human intent for /approve, /remove-goal, /pause, /sync --approve-preview (valid 15 minutes).
import { runHook } from './_run.mjs';

runHook('prompt', async ({ payload, home }) => {
  const { parseIntentCommand, writeIntent } = await import('../lib/intent.mjs');
  const cmd = parseIntentCommand(payload.prompt);
  if (cmd) writeIntent(home, payload.session_id || null, cmd);
  if (payload.session_id && payload.transcript_path) {
    const { recordSession } = await import('../lib/telemetry.mjs');
    recordSession(home, payload.session_id, payload.transcript_path);
  }
  return null;
});
