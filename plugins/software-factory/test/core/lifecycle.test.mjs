import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, lib } from './_helpers.mjs';

test('transition table: allowed and forbidden moves', async () => {
  const { canMove, TRANSITIONS } = await lib('lifecycle');
  const t = (status) => ({ status });
  assert.ok(canMove(t('ready'), 'in_progress').ok);
  assert.ok(canMove(t('in_progress'), 'checking').ok);
  assert.ok(canMove(t('checking'), 'in_review').ok);
  assert.ok(canMove(t('in_review'), 'verified').ok);
  assert.ok(canMove(t('verified'), 'integrated').ok);
  assert.ok(canMove(t('integrated'), 'done').ok);
  assert.ok(!canMove(t('draft'), 'done').ok);
  assert.ok(!canMove(t('done'), 'ready').ok);
  assert.ok(!canMove(t('cancelled'), 'ready').ok);
  assert.ok(!canMove(t('backlog'), 'verified').ok);
  for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) assert.ok(TRANSITIONS[to], `${from} -> ${to} target exists`);
});

test('humans cannot set proof-backed statuses', async () => {
  const { canMove } = await lib('lifecycle');
  assert.match(canMove({ status: 'in_review' }, 'verified', 'human').reason, /only the flow engine/);
  assert.match(canMove({ status: 'awaiting_approval' }, 'done', 'human').reason, /only the flow engine/);
  assert.ok(canMove({ status: 'failed' }, 'ready', 'human').ok);
});

test('move writes the status and emits task.status', async () => {
  const { home } = await makeHome();
  const a = await lib('actions');
  const { move } = await lib('lifecycle');
  const { tail } = await lib('events');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const intake = (await lib('store')).list(home, 'task')[0];
  assert.equal(intake.goal_id, g.id);
  const t = move(home, intake.id, 'in_progress', { reason: 'test' });
  assert.equal(t.status, 'in_progress');
  const ev = tail(home, 5).find((e) => e.type === 'task.status');
  assert.deepEqual(ev.data, { from: 'ready', to: 'in_progress' });
  assert.throws(() => move(home, intake.id, 'backlog'), (e) => e.exitCode === 1);
});
