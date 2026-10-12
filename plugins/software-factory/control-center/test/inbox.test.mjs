import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../server/server.mjs';
import { validateRequest, diskLookup } from '../server/inbox.mjs';
import { tempProject, req, postHeaders, useInboxLib, CC, sleep } from './helpers.mjs';

let t, s, libKind;
const post = (body, extra) => req(s.port, { method: 'POST', path: '/api/inbox', headers: postHeaders(s, extra), body });
const inboxFiles = () => fs.readdirSync(path.join(t.home, 'inbox')).filter((n) => !fs.statSync(path.join(t.home, 'inbox', n)).isDirectory());

before(async () => {
  libKind = useInboxLib();
  t = tempProject();
  process.env.FACTORY_PLUGIN_DATA = t.data;
  s = await startServer({ home: t.home, projectDir: t.project, port: 0, pollMs: 200, log: () => {} });
});
after(async () => {
  await s.close();
  delete process.env.FACTORY_PLUGIN_DATA;
  t.cleanup();
});

const VALID = {
  'gate.decide': { gate_id: 'GATE-0007', decision: 'approve', notes: '' },
  'goal.add': { title: 'Trade-in appraisal', outcome: 'Appraise a trade-in from the deal screen.', success_criteria: ['Shows book value', 'Saves to deal'], priority: 'P2', budget_tokens: 5000000 },
  'goal.pause': { goal_id: 'G-001' },
  'goal.remove': { goal_id: 'G-003', confirm_text: 'G-003', discard: false },
  'factory.pause': { mode: 'drain' },
  'budget.override': { goal_id: 'G-002', add_tokens: 2000000, note: 'Finish the spec' },
  'task.note': { task_id: 'T-0012', text: 'Use the existing panel component.' },
};
const INVALID = [
  ['gate.decide', { gate_id: 'GATE-0001', decision: 'approve' }, /already approved/],
  ['gate.decide', { gate_id: 'GATE-0007', decision: 'reject', notes: '  ' }, /notes is required/],
  ['gate.decide', { gate_id: 'GATE-0007', decision: 'changes' }, /notes is required/],
  ['gate.decide', { gate_id: 'GATE-0007', decision: 'merge' }, /decision must be/],
  ['gate.decide', { gate_id: '../goals/G-001', decision: 'approve' }, /gate_id is not valid/],
  ['gate.decide', { gate_id: 'GATE-9999', decision: 'approve' }, /not found/],
  ['gate.decide', { gate_id: 'GATE-0007', decision: 'approve', extra: 1 }, /unknown field extra/],
  ['goal.add', { title: '', outcome: 'x', success_criteria: ['a'], priority: 'P1' }, /title is required/],
  ['goal.add', { title: 'x'.repeat(81), outcome: 'x', success_criteria: ['a'], priority: 'P1' }, /at most 80/],
  ['goal.add', { title: 'x', outcome: 'x', success_criteria: [], priority: 'P1' }, /1 to 7/],
  ['goal.add', { title: 'x', outcome: 'x', success_criteria: Array(8).fill('a'), priority: 'P1' }, /1 to 7/],
  ['goal.add', { title: 'x', outcome: 'x', success_criteria: ['a'], priority: 'high' }, /priority/],
  ['goal.add', { title: 'x', outcome: 'x', success_criteria: ['a'], priority: 'P1', budget_tokens: 5 }, /budget_tokens/],
  ['goal.add', { title: 'a\u0007b', outcome: 'x', success_criteria: ['a'], priority: 'P1' }, /not allowed/],
  ['goal.pause', { goal_id: 'G-404' }, /not found/],
  ['goal.resume', { goal_id: 'G-001' }, /not paused/],
  ['goal.remove', { goal_id: 'G-003', confirm_text: 'g-003' }, /confirm_text/],
  ['goal.remove', { goal_id: 'G-003', confirm_text: 'G-003', discard: true }, /discard must be false/],
  ['factory.pause', { mode: 'later' }, /mode must be/],
  ['factory.resume', {}, /the factory is running/],
  ['budget.override', { goal_id: 'G-002', add_tokens: -5, note: 'x' }, /add_tokens/],
  ['budget.override', { goal_id: 'G-002', add_tokens: 100 }, /note is required/],
  ['task.note', { task_id: 'T-0012', text: '' }, /text is required/],
  ['task.note', { task_id: 'T-9999', text: 'x' }, /not found/],
  ['factory.stop', {}, /not allowed from the dashboard/],
  ['goal.activate', { goal_id: 'G-003' }, /not allowed from the dashboard/],
];

test('every dashboard type has a valid case', () => {
  const look = diskLookup(t.home);
  for (const [type, payload] of Object.entries(VALID)) {
    const { errors } = validateRequest(type, payload, look);
    assert.deepEqual(errors, [], type);
  }
});

test('invalid payloads are refused with a reason', () => {
  const look = diskLookup(t.home);
  for (const [type, payload, re] of INVALID) {
    const { errors } = validateRequest(type, payload, look);
    assert.ok(errors.some((e) => re.test(e)), `${type} ${JSON.stringify(payload)} -> ${errors.join('; ')}`);
  }
});

test('POST writes one signed inbox file atomically', async () => {
  const before = inboxFiles();
  const r = await post({ type: 'task.note', payload: VALID['task.note'] });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.id);
  const after = inboxFiles();
  assert.equal(after.length, before.length + 1);
  assert.equal(after.filter((n) => n.includes('.tmp')).length, 0, 'no temp files left');
  const name = after.find((n) => !before.includes(n));
  assert.match(name, /^\d{8}T\d{6}Z-.+-task\.note\.json$/);
  const saved = JSON.parse(fs.readFileSync(path.join(t.home, 'inbox', name), 'utf8'));
  assert.equal(saved.id, r.json.id);
  assert.equal(saved.source, 'dashboard');
  assert.equal(saved.actor.kind, 'human');
  assert.deepEqual(saved.payload, VALID['task.note']);
  assert.match(saved.sig, /^[0-9a-f]{64}$/);
  const libDir = process.env.FACTORY_CC_LIB_DIR || path.join(CC, '..', 'scripts', 'lib');
  const hmac = await import(pathToFileURL(path.join(libDir, 'hmac.mjs')).href);
  const key = hmac.getKey(t.home, { pluginDataDir: t.data });
  assert.ok(hmac.verify(saved, key), `signature verifies (${libKind} inbox module)`);
  assert.ok(fs.existsSync(path.join(t.data, 'hmac')), 'key lives under FACTORY_PLUGIN_DATA');
});

test('invalid POSTs return 400 and write nothing', async () => {
  const before = inboxFiles().length;
  const r = await post({ type: 'gate.decide', payload: { gate_id: 'GATE-0007', decision: 'reject' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /notes is required/);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ type: 'task.note', payload: VALID['task.note'], sneaky: true })).status, 400);
  assert.equal((await post({ type: 'task.note', payload: VALID['task.note'] }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(inboxFiles().length, before);
});

test('a second pending decision on one gate is 409', async () => {
  const a = await post({ type: 'gate.decide', payload: { gate_id: 'GATE-0006', decision: 'approve', notes: 'merged on GitHub' } });
  assert.equal(a.status, 201, a.text);
  const b = await post({ type: 'gate.decide', payload: { gate_id: 'GATE-0006', decision: 'reject', notes: 'changed my mind' } });
  assert.equal(b.status, 409);
  assert.equal(b.json.pending_id, a.json.id);
});

test('reusing a client_id is 409', async () => {
  const body = { type: 'goal.add', payload: VALID['goal.add'], client_id: 'c-0123456789ab' };
  assert.equal((await post(body)).status, 201);
  const again = await post(body);
  assert.equal(again.status, 409);
  assert.ok(again.json.pending_id);
});

test('pending requests appear in the inbox slice', async () => {
  await sleep(500); // one poll cycle
  const st = await req(s.port, { path: '/api/state', headers: { 'X-Factory-Token': s.token } });
  assert.ok(st.json.inbox.pending.length >= 3);
  assert.ok(st.json.inbox.recent.some((r) => r.status === 'rejected'));
});
