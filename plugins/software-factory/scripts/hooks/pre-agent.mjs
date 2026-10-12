// PreToolUse(Agent): dispatch guard for software-factory role agents.
import { runHook, preToolDecision } from './_run.mjs';

runHook('pre-agent', async ({ payload, home }) => {
  const ti = payload.tool_input || {};
  const type = ti.subagent_type;
  if (typeof type !== 'string' || !type.startsWith('software-factory:')) return null;
  const { isFactoryRunAgent } = await import('../lib/roles.mjs');
  if (!isFactoryRunAgent(type)) return null; // setup-interviewer and other non-run agents
  const deny = (r) => preToolDecision('deny', `software-factory: ${r}`);
  const m = /FACTORY_RUN=(R-\d+)/.exec(ti.prompt || '');
  if (!m) return deny('no FACTORY_RUN= line; only tick DISPATCH lines start factory agents');
  const store = await import('../lib/store.mjs');
  const st = await import('../lib/state.mjs');
  const run = store.get(home, 'run', m[1]);
  if (!run) return deny(`run ${m[1]} not found`);
  if (run.status !== 'dispatching') return deny(`run ${run.id} is ${run.status}, not dispatching`);
  if (`software-factory:${run.role}` !== type) return deny(`run ${run.id} is for ${run.role}`);
  const f = st.readFactory(home);
  if (!f || f.status !== 'running') return deny(`factory is ${f ? f.status : 'not initialized'}`);
  const goal = store.get(home, 'goal', run.goal_id);
  const task = store.get(home, 'task', run.task_id);
  const { goalAllows } = await import('../lib/dispatch.mjs');
  if (!goal || !task || !goalAllows(goal, task)) return deny(`goal ${run.goal_id} is ${goal ? goal.status : 'missing'}`);
  const { hasPendingPause } = await import('../lib/inbox.mjs');
  if (hasPendingPause(home)) return deny('a pause or stop request is pending');
  return null;
});
