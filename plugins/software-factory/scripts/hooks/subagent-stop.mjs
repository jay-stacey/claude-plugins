// SubagentStop: usage snapshot (finished), run -> completed (or deferred on a usage limit). Never exit 2.
import { runHook } from './_run.mjs';

runHook('subagent-stop', async ({ payload, home }) => {
  const type = payload.agent_type;
  if (typeof type !== 'string' || !type.startsWith('software-factory:')) return null;
  const { isFactoryRunAgent } = await import('../lib/roles.mjs');
  const usage = await import('../lib/usage.mjs');
  const file = payload.agent_transcript_path;
  const parsed = file ? usage.parseTranscript(file) : { requests: 0, by_model: {} };
  if (!isFactoryRunAgent(type)) {
    // Not a run (setup-interviewer): book as overhead, never against a goal.
    if (payload.agent_id) usage.writeSnapshot(home, { source: 'hook', scope: 'agent', agent_id: payload.agent_id, session_id: payload.session_id, agent_type: type, status: 'finished', requests: parsed.requests, by_model: parsed.by_model });
    return null;
  }
  const store = await import('../lib/store.mjs');
  const { emit } = await import('../lib/events.mjs');
  const { nowIso } = await import('../lib/fsutil.mjs');
  const { existsSync } = await import('node:fs');
  let run = payload.agent_id ? store.list(home, 'run', (r) => r.agent_id === payload.agent_id).pop() || null : null;
  if (!run && file) {
    const { runIdOfAgentFile } = await import('../lib/telemetry.mjs');
    const id = runIdOfAgentFile(file);
    run = id ? store.get(home, 'run', id) : null;
  }
  usage.writeSnapshot(home, {
    source: 'hook', scope: 'agent', agent_id: payload.agent_id, session_id: payload.session_id, agent_type: type,
    run_id: run && run.id, task_id: run && run.task_id, goal_id: run && run.goal_id, role: run && run.role,
    status: 'finished', requests: parsed.requests, by_model: parsed.by_model,
  });
  if (!run || !['dispatching', 'running', 'suspect'].includes(run.status)) return null;
  const ending = usage.endingOf(parsed);
  const deferred = ending === 'limit' && !(run.handoff_path && existsSync(run.handoff_path));
  const r = store.update(home, 'run', run.id, (x) => {
    x.agent_id = x.agent_id || payload.agent_id || null;
    x.status = deferred ? 'deferred' : 'completed';
    x.ended_at = nowIso(); x.usage_final = true;
    x.exit = deferred ? { reason: 'usage_limit', message: (parsed.last_assistant_text || '').slice(0, 200) } : { reason: ending === 'handoff' ? 'handoff' : 'ended', message: null };
  });
  const actor = { kind: 'system', role: r.role, run_id: r.id, agent_id: r.agent_id };
  emit(home, { type: 'run.ended', source: 'hook', session_id: payload.session_id, actor, goal_id: r.goal_id, epic_id: r.epic_id, task_id: r.task_id, run_id: r.id, msg: `${r.id} ${r.role} ${r.status}` });
  if (!deferred) emit(home, { type: 'msg.handoff', source: 'hook', session_id: payload.session_id, actor, goal_id: r.goal_id, task_id: r.task_id, run_id: r.id, msg: `${r.role} -> cto: ${r.task_id}`, data: { from: { role: r.role, run_id: r.id }, to: { role: 'cto' }, ref_path: r.handoff_path } });
  else emit(home, { type: 'run.deferred', source: 'hook', goal_id: r.goal_id, task_id: r.task_id, run_id: r.id, msg: `${r.id} hit a usage limit` });
  return null;
});
