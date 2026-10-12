// SessionStart: write run/machine.json; re-inject dispatcher context when this session holds the lease.
import { runHook } from './_run.mjs';

export const COMPLETION_RULE = "When a background factory agent's completion notice arrives (last line starts with HANDOFF), do not read or discuss it; invoke /software-factory:tick once; that tick does not call ScheduleWakeup.";

function optionValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

runHook('session-start', async ({ payload, home, env }) => {
  const { readJson, writeJsonAtomic, nowIso } = await import('../lib/fsutil.mjs');
  const { pluginRoot } = await import('../lib/paths.mjs');
  const { join } = await import('node:path');
  const root = env.CLAUDE_PLUGIN_ROOT || pluginRoot();
  const manifest = readJson(join(root, '.claude-plugin', 'plugin.json'), {}) || {};
  const uc = manifest.userConfig || {};
  const secret = new Set(Object.entries(uc).filter(([, v]) => v && v.sensitive).map(([k]) => k.toLowerCase()));
  const options = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) continue;
    const key = k.slice('CLAUDE_PLUGIN_OPTION_'.length).toLowerCase();
    if (secret.has(key) || /key|token|secret|password/i.test(key)) continue;
    options[key] = optionValue(v);
  }
  const prev = readJson(join(home, 'run', 'machine.json'), {}) || {};
  writeJsonAtomic(join(home, 'run', 'machine.json'), {
    ...prev, plugin_root: root.replace(/\\/g, '/'), plugin_data: env.CLAUDE_PLUGIN_DATA || prev.plugin_data || null,
    options, node: process.versions.node, updated_at: nowIso(),
  });
  const { recordSession } = await import('../lib/telemetry.mjs');
  recordSession(home, payload.session_id, payload.transcript_path);

  const st = await import('../lib/state.mjs');
  if (!st.isInitialized(home)) return null;
  const lease = st.readLease(home);
  const f = st.readFactory(home);
  const holds = lease && payload.session_id && lease.session_id === payload.session_id && st.leaseLive(lease);
  const stale = f && f.status === 'running' && !st.leaseLive(lease);
  if (!holds && !stale) return null;
  const { lines } = await import('../lib/status.mjs');
  const ctx = [];
  if (holds) {
    ctx.push('software-factory: this session is the factory dispatcher (it holds the lease).');
    ctx.push('Keep running the /loop with /software-factory:tick. Never reason about task content.');
    ctx.push(COMPLETION_RULE);
  } else {
    ctx.push('software-factory: the factory is running but no session holds a live dispatcher lease.');
    ctx.push('Run /software-factory:start in the session that should dispatch.');
  }
  for (const l of lines(home).slice(0, 15 - ctx.length)) ctx.push(l);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.slice(0, 15).join('\n') } };
});
