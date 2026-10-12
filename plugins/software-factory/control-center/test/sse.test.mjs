import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/server.mjs';
import { tempProject, sse, req, auth, sleep } from './helpers.mjs';

let t, s;
before(async () => {
  t = tempProject();
  s = await startServer({ home: t.home, projectDir: t.project, port: 0, pollMs: 150, log: () => {} });
});
after(async () => { await s.close(); t.cleanup(); });

const line = (o) => JSON.stringify({ v: 1, ts: new Date().toISOString(), source: 'cli', actor: { kind: 'system', role: 'cto' }, data: {}, ...o }) + '\n';

test('stream sends a snapshot on connect', async () => {
  const c = sse(s.port, s.token);
  assert.equal(await c.ready, 200);
  const m = await c.waitFor((x) => x.event === 'snapshot');
  assert.equal(m.data.instance_id, s.instanceId);
  assert.equal(m.data.tasks.length, 29);
  assert.equal(m.data.gates.filter((g) => g.status === 'pending').length, 3);
  assert.equal(m.data.roles.length, 15);
  assert.ok(m.data.events_tail.length > 100);
  assert.ok(m.data.usage.totals.billed > 0);
  c.close();
});

test('stream with a wrong token is 401', async () => {
  const c = sse(s.port, 'nope');
  assert.equal(await c.ready, 401);
  c.close();
});

test('changing a task file and the index sends a patch', async () => {
  const c = sse(s.port, s.token);
  await c.waitFor((x) => x.event === 'snapshot');
  const f = path.join(t.home, 'tasks', 'T-0016.json');
  const task = JSON.parse(fs.readFileSync(f, 'utf8'));
  task.status = 'in_progress';
  task.rev += 1;
  fs.writeFileSync(f, JSON.stringify(task));
  const idxF = path.join(t.home, 'state', 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxF, 'utf8'));
  idx.rev += 1;
  idx.tasks['T-0016'].status = 'in_progress';
  fs.writeFileSync(idxF, JSON.stringify(idx));
  const started = Date.now();
  const m = await c.waitFor((x) => x.event === 'patch' && x.data.slices.tasks?.some((tk) => tk.id === 'T-0016' && tk.status === 'in_progress'), 3000);
  assert.ok(Date.now() - started < 1500, 'patch within 1.5 s');
  assert.ok(m.data.rev > 0);
  c.close();
});

test('gate, budget and factory changes patch their slices', async () => {
  const c = sse(s.port, s.token);
  await c.waitFor((x) => x.event === 'snapshot');
  const gf = path.join(t.home, 'gates', 'GATE-0007.json');
  const g = JSON.parse(fs.readFileSync(gf, 'utf8'));
  g.status = 'approved';
  fs.writeFileSync(gf, JSON.stringify(g));
  await c.waitFor((x) => x.event === 'patch' && x.data.slices.gates?.find((y) => y.id === 'GATE-0007')?.status === 'approved');
  const bf = path.join(t.home, 'state', 'budget.json');
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b.goals['G-003'].spent = 999999;
  fs.writeFileSync(bf, JSON.stringify(b));
  await c.waitFor((x) => x.event === 'patch' && x.data.slices.budget?.goals['G-003'].spent === 999999);
  const ff = path.join(t.home, 'state', 'factory.json');
  const f = JSON.parse(fs.readFileSync(ff, 'utf8'));
  f.status = 'paused';
  fs.writeFileSync(ff, JSON.stringify(f));
  const m = await c.waitFor((x) => x.event === 'patch' && x.data.slices.factory?.status === 'paused');
  assert.equal(m.data.slices.factory.loop.label, 'Paused');
  c.close();
});

test('appending to events.jsonl sends event messages; a torn line waits', async () => {
  const c = sse(s.port, s.token);
  await c.waitFor((x) => x.event === 'snapshot');
  const ef = path.join(t.home, 'events', 'events.jsonl');
  fs.appendFileSync(ef, line({ id: 'EV-TEST-1', type: 'msg.handoff', msg: 'handoff é ✓', data: { from: { role: 'backend-engineer' }, to: { role: 'cto' } } }));
  const m = await c.waitFor((x) => x.event === 'event' && x.data.id === 'EV-TEST-1');
  assert.equal(m.data.msg, 'handoff é ✓');
  // Torn write: half a line, then the rest.
  const full = line({ id: 'EV-TEST-2', type: 'task.status', msg: 'torn ✓' });
  const buf = Buffer.from(full);
  fs.appendFileSync(ef, buf.subarray(0, buf.length - 9));
  await sleep(400);
  assert.equal(c.messages.filter((x) => x.event === 'event' && x.data.id === 'EV-TEST-2').length, 0);
  fs.appendFileSync(ef, buf.subarray(buf.length - 9));
  const m2 = await c.waitFor((x) => x.event === 'event' && x.data.id === 'EV-TEST-2');
  assert.equal(m2.data.msg, 'torn ✓');
  c.close();
});

test('rotation of events.jsonl is detected and the new file is read from the start', async () => {
  const c = sse(s.port, s.token);
  await c.waitFor((x) => x.event === 'snapshot');
  const ef = path.join(t.home, 'events', 'events.jsonl');
  fs.mkdirSync(path.join(t.home, 'events', 'archive'), { recursive: true });
  fs.renameSync(ef, path.join(t.home, 'events', 'archive', 'events-20261012-000000.jsonl'));
  fs.writeFileSync(ef, line({ id: 'EV-ROT-1', type: 'tick.started', msg: 'after rotation' }));
  const m = await c.waitFor((x) => x.event === 'event' && x.data.id === 'EV-ROT-1');
  assert.equal(m.data.msg, 'after rotation');
  c.close();
  // History paging still sees archived events.
  const page = await req(s.port, { path: '/api/events?limit=5&type=msg.', headers: auth(s) });
  assert.equal(page.status, 200);
  assert.equal(page.json.events.length, 5);
  assert.ok(page.json.has_more);
});

test('Last-Event-ID resumes from the ring without a new snapshot', async () => {
  const c1 = sse(s.port, s.token);
  const snap = await c1.waitFor((x) => x.event === 'snapshot');
  fs.appendFileSync(path.join(t.home, 'events', 'events.jsonl'), line({ id: 'EV-RES-1', type: 'msg.dispatch', data: { from: { role: 'cto' }, to: { role: 'qa-engineer' } } }));
  await c1.waitFor((x) => x.event === 'event' && x.data.id === 'EV-RES-1');
  c1.close();
  const c2 = sse(s.port, s.token, { lastEventId: snap.id });
  const m = await c2.waitFor((x) => x.event === 'event' && x.data.id === 'EV-RES-1');
  assert.ok(m.id > snap.id);
  assert.equal(c2.messages.filter((x) => x.event === 'snapshot').length, 0);
  c2.close();
  const c3 = sse(s.port, s.token, { lastEventId: 999999 });
  await c3.waitFor((x) => x.event === 'snapshot');
  c3.close();
});

test('events paging with filters', async () => {
  const first = await req(s.port, { path: '/api/events?limit=3&role=code-reviewer', headers: auth(s) });
  assert.equal(first.json.events.length, 3);
  for (const e of first.json.events) {
    assert.ok([e.actor?.role, e.data?.from?.role, e.data?.to?.role].includes('code-reviewer'));
  }
  const next = await req(s.port, { path: `/api/events?limit=3&role=code-reviewer&before=${first.json.events.at(-1).id}`, headers: auth(s) });
  assert.ok(next.json.events.every((e) => !first.json.events.some((f) => f.id === e.id)));
  assert.ok(next.json.events[0].ts <= first.json.events.at(-1).ts);
});
