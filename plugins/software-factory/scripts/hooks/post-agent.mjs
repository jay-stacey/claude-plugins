// PostToolUse(Agent): bind agent_id + tool_use_id to the run; run -> running.
import { runHook } from './_run.mjs';

runHook('post-agent', async ({ payload, home }) => {
  const ti = payload.tool_input || {};
  const type = ti.subagent_type;
  if (typeof type !== 'string' || !type.startsWith('software-factory:')) return null;
  const { isFactoryRunAgent } = await import('../lib/roles.mjs');
  if (!isFactoryRunAgent(type)) return null;
  const m = /FACTORY_RUN=(R-\d+)/.exec(ti.prompt || '');
  if (!m) return null;
  const store = await import('../lib/store.mjs');
  const { emit } = await import('../lib/events.mjs');
  const { nowIso } = await import('../lib/fsutil.mjs');
  const tr = payload.tool_response || {};
  const agentId = tr.agentId || tr.agent_id || null;
  const run = store.get(home, 'run', m[1]);
  if (!run) return null;
  const updated = store.update(home, 'run', run.id, (r) => {
    if (agentId) r.agent_id = agentId;
    r.tool_use_id = payload.tool_use_id || r.tool_use_id;
    r.session_id = r.session_id || payload.session_id || null;
    if (r.status === 'dispatching' && agentId) { r.status = 'running'; r.started_at = nowIso(); }
  });
  if (payload.session_id && payload.transcript_path) {
    const { recordSession } = await import('../lib/telemetry.mjs');
    recordSession(home, payload.session_id, payload.transcript_path);
  }
  if (updated.status === 'running' && run.status === 'dispatching') {
    const actor = { kind: 'system', role: updated.role, run_id: updated.id, agent_id: agentId };
    emit(home, { type: 'run.started', source: 'hook', session_id: payload.session_id, actor, goal_id: updated.goal_id, epic_id: updated.epic_id, task_id: updated.task_id, run_id: updated.id, msg: `${updated.id} ${updated.role} started` });
    emit(home, { type: 'msg.dispatch', source: 'hook', session_id: payload.session_id, actor: { kind: 'system', role: 'cto' }, goal_id: updated.goal_id, task_id: updated.task_id, run_id: updated.id, msg: `cto -> ${updated.role}: ${updated.task_id}`, data: { from: { role: 'cto' }, to: { role: updated.role, run_id: updated.id }, ref_path: updated.brief_path } });
  }
  return null;
});
