import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { makeHome, lib, join, readFileSync, writeFileSync } from './_helpers.mjs';

test('canonical JSON sorts keys and sign/verify round-trips; tampering fails', async () => {
  const h = await lib('hmac');
  assert.equal(h.canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  const key = Buffer.alloc(32, 7);
  const req = { id: 'abc', type: 'gate.decide', payload: { gate_id: 'GATE-0001', decision: 'approve' } };
  req.sig = h.sign(req, key);
  assert.ok(h.verify(req, key));
  assert.ok(!h.verify({ ...req, payload: { ...req.payload, decision: 'reject' } }, key));
  assert.ok(!h.verify({ ...req, sig: undefined }, key));
});

test('key lives in the plugin data dir and is stable', async () => {
  const { home, pd } = await makeHome();
  const h = await lib('hmac');
  const k1 = h.getKey(home);
  const k2 = h.getKey(home);
  assert.equal(k1.length, 32);
  assert.deepEqual(k1, k2);
  assert.ok(h.keyPath(home, pd).replace(/\\/g, '/').includes('/hmac/'));
});

test('signed human request applies; unsigned or forged is rejected', async () => {
  const { home } = await makeHome();
  const inbox = await lib('inbox');
  const store = await lib('store');
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const u = inbox.write(home, { type: 'budget.override', payload: { goal_id: g.id, add_tokens: 1000, note: 'x' } }, { sign: false });
  const forged = inbox.write(home, { type: 'budget.override', payload: { goal_id: g.id, add_tokens: 5, note: 'x' } }, { sign: true, key: Buffer.alloc(32, 1) });
  const good = inbox.write(home, { type: 'budget.override', payload: { goal_id: g.id, add_tokens: 2000, note: 'ok' } }, { sign: true });
  const res = await inbox.process(home, { tick: 1 });
  const by = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(by[u.id].status, 'rejected');
  assert.match(by[u.id].reason, /unsigned/);
  assert.equal(by[forged.id].status, 'rejected');
  assert.match(by[forged.id].reason, /bad signature/);
  assert.equal(by[good.id].status, 'applied');
  assert.ok(forged.sig);
  assert.equal(store.get(home, 'goal', g.id).budget.limit_tokens, 15000000 + 2000);
  assert.equal(readdirSync(join(home, 'inbox', 'rejected')).length, 2);
  const done = readdirSync(join(home, 'inbox', 'processed'));
  assert.equal(done.length, 1);
  assert.equal(JSON.parse(readFileSync(join(home, 'inbox', 'processed', done[0]), 'utf8')).result.status, 'applied');
  const ev = (await lib('events')).tail(home, 50).filter((e) => e.type === 'inbox.processed' && e.data.request_id === good.id);
  assert.deepEqual(Object.keys(ev[0].data).sort(), ['outcome', 'reason', 'request_id', 'type']);
});

test('non-human goal.add needs no signature; needs_confirmation becomes a tracker gate; dedupe supersedes', async () => {
  const { home } = await makeHome();
  const inbox = await lib('inbox');
  const store = await lib('store');
  inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'New', outcome: 'o', success_criteria: ['c'], priority: 'P1' }, dedupe_key: 'k1' });
  inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'New', outcome: 'o', success_criteria: ['c'] }, dedupe_key: 'k1' });
  const tr = inbox.write(home, { type: 'task.note', source: 'tracker', actor: { kind: 'tracker' }, payload: { task_id: 'T-0001', text: 'hi' }, needs_confirmation: true });
  const res = await inbox.process(home, { tick: 2 });
  assert.deepEqual(res.map((r) => r.status).sort(), ['applied', 'gated', 'superseded']);
  assert.equal(store.list(home, 'goal').length, 1);
  const gate = store.get(home, 'gate', res.find((r) => r.id === tr.id).gate_id);
  assert.equal(gate.type, 'tracker');
});

test('goal.add keeps its tracker_ref, so sync links the goal to an existing project instead of creating one', async () => {
  const { home } = await makeHome();
  const inbox = await lib('inbox');
  const store = await lib('store');
  const ref = { provider: 'linear', kind: 'project', remote_id: 'proj-uuid-7', key: 'P-DP1-89', url: 'https://linear.app/x/project/p-dp1-89' };
  inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'Linked', outcome: 'o', success_criteria: ['c'], tracker_ref: ref } });
  inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'Unlinked', outcome: 'o', success_criteria: ['c'] } });
  const res = await inbox.process(home, { tick: 3 });
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied']);
  const goals = store.list(home, 'goal');
  assert.deepEqual(goals.find((g) => g.title === 'Linked').tracker_ref, ref);
  assert.equal(goals.find((g) => g.title === 'Unlinked').tracker_ref, undefined);
});

test('goal.add rejects a malformed tracker_ref', async () => {
  const { home } = await makeHome();
  const inbox = await lib('inbox');
  const store = await lib('store');
  assert.throws(
    () => inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'Bad', outcome: 'o', success_criteria: ['c'], tracker_ref: { kind: 'epic', remote_id: '' } } }),
    /tracker_ref\.remote_id required.*tracker_ref\.kind must be issue\|project/,
  );
  inbox.write(home, { type: 'goal.add', source: 'dashboard', payload: { title: 'Good', outcome: 'o', success_criteria: ['c'] } });
  await inbox.process(home, { tick: 4 });
  assert.deepEqual(store.list(home, 'goal').map((g) => g.title), ['Good']);
});

test('invalid file name content is rejected, tmp files are ignored', async () => {
  const { home } = await makeHome();
  const inbox = await lib('inbox');
  writeFileSync(join(home, 'inbox', '20261012T000000Z-deadbeef-goal.add.json'), '{"nope":1}');
  writeFileSync(join(home, 'inbox', '.x.json.tmp-1'), '{}');
  const res = await inbox.process(home, {});
  assert.equal(res.length, 1);
  assert.equal(res[0].status, 'rejected');
});
