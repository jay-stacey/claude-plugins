import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, utimesSync } from 'node:fs';
import { makeHome, lib, fakeDelivery, join, P } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

async function setup() {
  const env = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const a = await lib('actions');
  a.newGoal(env.home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  (await lib('lifecycle')).move(env.home, 'T-0001', 'in_progress', { data: { attempts: 1, current_run_id: 'R-000001' } });
  return env;
}

test('own-session runs are never orphaned on time alone; other-session runs go suspect then orphaned', async () => {
  const { home } = await setup();
  const store = await lib('store');
  const { recover } = await lib('recovery');
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running', session_id: 'S1', started_at: old, agent_id: 'x' });
  let r = await recover(home, { session: 'S1' });
  assert.deepEqual(r, []);
  assert.equal(store.get(home, 'run', 'R-000001').status, 'running');
  r = await recover(home, { session: 'S2' });
  assert.equal(r[0].outcome, 'suspect');
  r = await recover(home, { session: 'S2' });
  assert.equal(r[0].outcome, 'orphaned');
  assert.equal(store.get(home, 'run', 'R-000001').status, 'orphaned');
  const t = store.get(home, 'task', 'T-0001');
  assert.equal(t.status, 'ready');
});

test('a dispatch that never started is failed and the attempt is given back', async () => {
  const { home } = await setup();
  const store = await lib('store');
  const { recover } = await lib('recovery');
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'dispatching', dispatched_at: new Date(Date.now() - 3600000).toISOString() });
  const r = await recover(home, { session: 'S1' });
  assert.equal(r[0].outcome, 'never_started');
  const t = store.get(home, 'task', 'T-0001');
  assert.equal(t.status, 'ready');
  assert.equal(t.attempts, 0);
});

test('telemetry reconcile binds an unbound run by the FACTORY_RUN line and snapshots usage', async () => {
  const { home, root } = await setup();
  const store = await lib('store');
  const tel = await lib('telemetry');
  const usage = await lib('usage');
  store.create(home, 'run', { id: 'R-000042', task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'dispatching', session_id: 'S1' });
  const sessionTranscript = join(root, 'proj', 'S1.jsonl');
  const sub = join(root, 'proj', 'S1', 'subagents');
  mkdirSync(sub, { recursive: true });
  const f = join(sub, 'agent-abc123.jsonl');
  copyFileSync(join(P, 'test', 'fixtures', 'core', 'transcript-dup.jsonl'), f);
  const past = new Date(Date.now() - 120000);
  utimesSync(f, past, past);
  tel.recordSession(home, 'S1', sessionTranscript);
  const r = tel.reconcile(home, { session: 'S1' });
  assert.deepEqual(r.bound, ['R-000042']);
  const run = store.get(home, 'run', 'R-000042');
  assert.equal(run.agent_id, 'abc123');
  assert.equal(run.status, 'completed', 'transcript ends with a HANDOFF line');
  assert.equal(usage.latestSnapshots(home).get('abc123').requests, 3);
  const again = tel.reconcile(home, { session: 'S1' });
  assert.equal(again.snapshots, 0, 'unchanged transcript is not re-parsed');
});
