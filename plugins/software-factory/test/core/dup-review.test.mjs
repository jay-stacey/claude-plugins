import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { makeHome, lib, fakeDelivery, writeReport, baseHandoff, join, writeFileSync } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

/** A planning goal with a PRD task waiting for its critic in review round `round`. */
async function prdInReview(home, { round = 1 } = {}) {
  const a = await lib('actions');
  const store = await lib('store');
  const lifecycle = await lib('lifecycle');
  const g = a.newGoal(home, { title: 'Dup', outcome: 'o', success_criteria: ['c'] });
  const t = a.createTask(home, { goal_id: g.id, kind: 'prd', role: 'product-manager', gate: 'G1', status: 'ready', title: 'PRD' });
  lifecycle.move(home, t.id, 'in_progress');
  lifecycle.move(home, t.id, 'in_review');
  store.update(home, 'task', t.id, (x) => { x.reviews_required = [['critic']]; x.rework_count = round - 1; });
  return { g, t: store.get(home, 'task', t.id) };
}

function criticRun(store, home, g, t, extra) {
  return store.create(home, 'run', {
    task_id: t.id, goal_id: g.id, kind: 'review', role: 'critic', review_role: 'critic', round: 1,
    subagent_type: 'software-factory:critic', model: 'opus', status: 'running', ...extra,
  });
}

test('a review run that ended but is not yet collected still holds its task: no second critic is dispatched', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  const { g, t } = await prdInReview(home);
  const critics = () => dispatch.candidates(home).filter((c) => c.task.id === t.id && c.review_role === 'critic');
  assert.equal(critics().length, 1, 'the critic is wanted before any run exists');
  const run = criticRun(store, home, g, t);
  assert.equal(critics().length, 0, 'a running critic holds the task');
  // SubagentStop marks it completed; the tick that collects it has not run yet.
  store.update(home, 'run', run.id, (r) => { r.status = 'completed'; r.ended_at = new Date().toISOString(); });
  assert.equal(critics().length, 0, 'an uncollected completed critic still holds the task');
  store.update(home, 'run', run.id, (r) => { r.collected_at = new Date().toISOString(); });
  assert.equal(critics().length, 1, 'once collected, the hold is gone (the round needs its verdict again only if it was not applied)');
});

test('an author run that ended but is not yet collected holds its ready task', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const a = await lib('actions');
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  const g = a.newGoal(home, { title: 'Dup2', outcome: 'o', success_criteria: ['c'] });
  const t = a.createTask(home, { goal_id: g.id, kind: 'prd', role: 'product-manager', gate: 'G1', status: 'ready', title: 'PRD' });
  const authors = () => dispatch.candidates(home).filter((c) => c.task.id === t.id && !c.review_role);
  assert.equal(authors().length, 1);
  store.create(home, 'run', { task_id: t.id, goal_id: g.id, kind: 'author', role: 'product-manager', subagent_type: 'software-factory:product-manager', model: 'opus', status: 'completed', ended_at: new Date().toISOString() });
  assert.equal(authors().length, 0, 'an uncollected completed author run holds the task');
});

test('a critic verdict from an earlier review round is stale and does not judge the reworked version', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const store = await lib('store');
  const collect = await lib('collect');
  const { g, t } = await prdInReview(home, { round: 2 });
  const hp = join(home, 'runs', 'R-000001', 'handoff.json').replace(/\\/g, '/');
  const run = criticRun(store, home, g, t, { status: 'completed', handoff_path: hp, output_paths: ['docs/crit-r1.md'] });
  assert.equal(run.id, 'R-000001');
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  const rp = writeReport(home, 'docs/crit-r1.md');
  writeFileSync(hp, JSON.stringify(baseHandoff(run, t, { verdict: 'fail', report_path: rp, acceptance_criteria: [] })));
  const res = await collect.collect(home);
  const out = (res.collected || res).find ? (res.collected || res).find((x) => x.run_id === run.id) : null;
  const after = store.get(home, 'task', t.id);
  assert.equal(after.status, 'in_review', 'the round-2 version is still waiting for its own critic');
  assert.equal(after.rework_count, 1, 'no extra rework round was started');
  assert.ok(!after.reviews || !after.reviews.critic, 'the round-1 verdict was not recorded against round 2');
  if (out) assert.equal(out.outcome, 'stale');
  assert.ok(store.get(home, 'run', run.id).collected_at, 'the run was collected (the code under test ran)');
});

test('a critic verdict for the current round is still applied', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const store = await lib('store');
  const collect = await lib('collect');
  const { g, t } = await prdInReview(home, { round: 1 });
  const hp = join(home, 'runs', 'R-000001', 'handoff.json').replace(/\\/g, '/');
  const run = criticRun(store, home, g, t, { status: 'completed', handoff_path: hp, output_paths: ['docs/crit-r1.md'] });
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  const rp = writeReport(home, 'docs/crit-r1.md');
  writeFileSync(hp, JSON.stringify(baseHandoff(run, t, { verdict: 'fail', report_path: rp, acceptance_criteria: [] })));
  await collect.collect(home);
  const after = store.get(home, 'task', t.id);
  assert.equal(after.reviews.critic.verdict, 'fail');
  assert.equal(after.reviews.critic.round, 1);
  assert.notEqual(after.status, 'in_review', 'a fail moves the task out of review');
});
