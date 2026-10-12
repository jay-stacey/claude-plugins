import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { P, core, lib, syncHome, seed, inboxFiles } from './_sync.mjs';

test('no adapter exports or calls a delete or archive endpoint, and PushOp has no delete type', async () => {
  const dir = join(P, 'servers', 'factory-sync', 'adapters');
  const files = readdirSync(dir).filter((n) => n.endsWith('.mjs'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const code = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/delete|archive|destroy|remove/i.test(code), `${f} mentions delete/archive/remove`);
    const mod = await import(`../../servers/factory-sync/adapters/${f}`);
    for (const name of Object.keys(mod)) assert.ok(!/delete|archive|remove/i.test(name), `${f} exports ${name}`);
  }
  for (const f of ['planner.mjs', 'engine.mjs', 'outbox.mjs']) {
    const code = readFileSync(join(P, 'servers', 'factory-sync', 'core', f), 'utf8');
    assert.ok(!/type:\s*'(delete|archive)/i.test(code), `${f} builds a delete op`);
  }
  const a = await import('../../servers/factory-sync/adapters/none.mjs');
  assert.deepEqual(Object.keys(a.createNone()).filter((k) => /delete|archive/i.test(k)), []);
});

test('normalize: markdown and ADF reduce to the same plain text; labels hash order-free; footer helpers', async () => {
  const n = await core('normalize');
  const md = '## Scope\n\n- **Retry** with `backoff`\n- see [docs](https://x.y)\n\nsf-id: T-0042 · managed by software-factory';
  const linearish = md.replace(/^- /gm, '* ').replace('**Retry**', '__Retry__');
  assert.equal(n.hashValue(md), n.hashValue(linearish));
  const adf = n.mdToAdf('Line one\n\n- a\n- b');
  assert.equal(adf.type, 'doc');
  assert.equal(n.adfToPlain(adf), n.mdToPlain('Line one\n\n- a\n- b'));
  assert.equal(n.hashValue(['b', 'A'], 'labels'), n.hashValue(['a', 'b'], 'labels'));
  assert.equal(n.findSfId('text\n\nsf-id: T-0042 · managed by software-factory'), 'T-0042');
  assert.equal(n.findSfId('nothing'), null);
});

test('redaction: emails, phones, Luhn card numbers, VINs, secret prefixes and key=value secrets; clean text passes', async () => {
  const r = await core('redact');
  assert.deepEqual(r.scan('mail pat@example.com'), ['email']);
  assert.deepEqual(r.scan('call 555-123-4567 today'), ['phone']);
  assert.deepEqual(r.scan('card 4111 1111 1111 1111'), ['card_number']);
  assert.deepEqual(r.scan('order 4111 1111 1111 1112'), [], 'fails Luhn');
  assert.deepEqual(r.scan('VIN 1HGCM82633A004352 on file'), ['vin']);
  assert.deepEqual(r.scan('token ghp_abcdefghijklmnop1234'), ['secret']);
  assert.deepEqual(r.scan('AKIAABCDEFGHIJKLMNOP'), ['secret']);
  assert.deepEqual(r.scan('password=hunter2'), ['key_value_secret']);
  assert.deepEqual(r.scan('[software-factory] Backend Engineer → Code Reviewer · T-0042 · in_review\nAdded retry; 6 new tests.\nEvidence: `npm test` exit 0. PR: https://github.com/o/r/pull/77'), []);
  assert.deepEqual(r.scan('sha 0123456789abcdef0123456789abcdef01234567 and 2026-10-12T14:03:11Z'), []);
  assert.deepEqual(r.scan('ticket ACME-123', ['ACME-\\d+']), ['custom']);
  assert.deepEqual(r.checkOp({ payload: { title: 'ok', body: 'reach me at a@b.co' } }), { blocked: true, field: 'body', kinds: ['email'] });
});

test('ownership: status map proposal and human status classes', async () => {
  const o = await core('ownership');
  const states = [
    { id: 'tri', name: 'Triage', type: 'triage', position: 0 }, { id: 'bl', name: 'Backlog', type: 'backlog', position: 1 },
    { id: 'td', name: 'Todo', type: 'unstarted', position: 2 }, { id: 'ip', name: 'In Progress', type: 'started', position: 3 },
    { id: 'ir', name: 'In Review', type: 'started', position: 4 }, { id: 'dn', name: 'Done', type: 'completed', position: 5 },
    { id: 'cx', name: 'Canceled', type: 'canceled', position: 6 },
  ];
  const sm = o.proposeStatusMap(states);
  assert.deepEqual(Object.fromEntries(Object.entries(sm).map(([k, v]) => [k, v.id])), { backlog: 'bl', ready: 'td', in_progress: 'ip', in_review: 'ir', verified: 'ir', awaiting_approval: 'ir', done: 'dn', cancelled: 'cx' });
  const cls = (localStatus, id) => { const s = states.find((x) => x.id === id); return o.classifyStatusChange({ localStatus, remote: { statusId: s.id, statusType: s.type, statusName: s.name }, statusMap: sm }); };
  assert.equal(cls('verified', 'ir'), 'consistent', 'a shared target raises nothing');
  assert.equal(cls('in_progress', 'cx'), 'cancel');
  assert.equal(cls('in_review', 'dn'), 'done_override');
  assert.equal(cls('in_review', 'ip'), 'rework');
  assert.equal(cls('in_progress', 'td'), 'pause');
  assert.equal(cls('backlog', 'td'), 'promote');
  assert.equal(cls('in_progress', 'ir'), 'ignored_forward');
  assert.equal(o.classPolicy({ human_status_changes: { cancel: 'auto' } }, 'cancel'), 'confirm', 'destructive classes never auto-apply');
});

test('outbox: coalesces ops for the same field and backs off exponentially up to 30 minutes', async () => {
  const ob = await core('outbox');
  const a = { opId: 'a', type: 'set_status', localId: 'T-1', field: 'status', payload: { statusId: 'x' } };
  const b = { opId: 'b', type: 'set_status', localId: 'T-1', field: 'status', payload: { statusId: 'y' } };
  const c = { opId: 'c', type: 'add_comment', localId: 'T-1', field: 'side', payload: { text: 'hi' } };
  let e = ob.enqueue([], [a, c]);
  e = ob.enqueue(e, [b, c]);
  assert.deepEqual(e.map((x) => x.opId), ['b', 'c']);
  const r = e[0];
  for (let i = 0; i < 10; i++) ob.markFailed(r, 'x', 0);
  assert.equal(r.nextAttemptAt, 30 * 60_000);
  assert.deepEqual([1, 2, 3, 4].map((n) => ob.backoffMs(n)), [60_000, 120_000, 240_000, 480_000]);
});

test('inbox processor: done_override is a logged accept; pause auto-applies; a tracker gate for an unknown task is rejected safely', async () => {
  const h = await syncHome({ provider: 'linear' });
  const { t } = await seed(h.home);
  const inbox = await lib('inbox');
  const store = await lib('store');
  const flow = await lib('flow');
  store.update(h.home, 'task', t.id, (x) => { x.status = 'in_progress'; });
  inbox.write(h.home, { type: 'tracker.status_change', source: 'tracker', actor: { kind: 'tracker', name: 'linear' }, auto_apply: true, payload: { task_id: t.id, class: 'pause', remote_key: 'NEO-1', remote_status: 'Backlog' } });
  let res = await inbox.process(h.home, { tick: 1 });
  assert.equal(res[0].status, 'applied');
  assert.equal(store.get(h.home, 'task', t.id).status, 'paused');

  store.update(h.home, 'task', t.id, (x) => { x.status = 'in_review'; });
  inbox.write(h.home, { type: 'tracker.status_change', source: 'tracker', actor: { kind: 'tracker', name: 'linear' }, needs_confirmation: true, payload: { task_id: t.id, class: 'done_override', remote_key: 'NEO-1', remote_status: 'Done' } });
  res = await inbox.process(h.home, { tick: 2 });
  const gate = store.get(h.home, 'gate', res[0].gate_id);
  assert.match(gate.artifact.summary, /accept it without evidence/);
  await flow.decideGate(h.home, gate.id, { decision: 'approve', by: 'jay', via: 'dashboard' });
  const tt = store.get(h.home, 'task', t.id);
  assert.equal(tt.status, 'done');
  assert.equal(tt.done_override.by, 'jay', 'the approving human is recorded');
  const ev = (await lib('events')).tail(h.home, 20).find((x) => x.type === 'msg.approval_result' && x.data.done_override);
  assert.ok(ev, 'the accept is logged');

  inbox.write(h.home, { type: 'tracker.field_update', source: 'tracker', actor: { kind: 'tracker' }, auto_apply: true, payload: { task_id: 'T-9999', field: 'priority', value: 'P1' } });
  res = await inbox.process(h.home, { tick: 3 });
  assert.equal(res[0].status, 'rejected');
  assert.equal(inboxFiles(h.home).length, 0);
  assert.ok(existsSync(join(h.home, 'inbox', 'rejected')));
});
