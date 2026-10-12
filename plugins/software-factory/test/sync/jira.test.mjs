import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncHome, seed, makeClock, core, lib, inboxFiles, readSync, approveFirstSync, ENV } from './_sync.mjs';

function fakeJira() {
  const statuses = [
    { id: '1', name: 'Backlog', statusCategory: { key: 'new' } }, { id: '2', name: 'To Do', statusCategory: { key: 'new' } },
    { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }, { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
    { id: '5', name: 'Done', statusCategory: { key: 'done' } }, { id: '6', name: "Won't Do", statusCategory: { key: 'done' } },
  ];
  const st = { issues: new Map(), n: 0, calls: [], transitions: [], comments: [], auth: null, clock: Date.now() };
  const ts = () => { st.clock += 1000; return new Date(st.clock).toISOString().replace('Z', '+0000'); };
  const view = (i) => ({ id: i.id, key: i.key, fields: { summary: i.summary, description: i.description, status: statuses.find((s) => s.id === i.status), labels: i.labels, assignee: null, priority: i.priority || null, duedate: null, parent: i.parent || null, updated: i.updated, project: { key: 'SF' }, issuetype: i.issuetype, comment: { comments: [] } } });
  const res = (status, obj) => ({ status, headers: new Map(), text: async () => (obj === undefined ? '' : JSON.stringify(obj)) });
  async function fetchFn(url, init = {}) {
    const u = new URL(url); const path = u.pathname.replace('/rest/api/3', ''); const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    st.auth = init.headers.Authorization;
    st.calls.push(`${method} ${path}`);
    let m;
    if (path === '/myself') return res(200, { accountId: 'acc-bot', displayName: 'Factory Bot' });
    if (path === '/project/SF') return res(200, { id: '100', key: 'SF', name: 'Software Factory' });
    if (path === '/project/SF/statuses') return res(200, [{ name: 'Task', statuses }, { name: 'Epic', statuses: statuses.slice(0, 3) }]);
    if (path === '/search/jql') return res(200, { issues: [...st.issues.values()].filter((i) => !/labels = /.test(body.jql) || i.labels.includes('factory-intake')).map(view), isLast: true });
    if (path === '/issue' && method === 'POST') {
      const n = ++st.n; const i = { id: String(10000 + n), key: `SF-${n}`, summary: body.fields.summary, description: body.fields.description, status: '1', labels: body.fields.labels, parent: body.fields.parent ? { id: body.fields.parent.id } : null, issuetype: body.fields.issuetype, priority: body.fields.priority, updated: ts() };
      st.issues.set(i.id, i); return res(201, { id: i.id, key: i.key });
    }
    if ((m = /^\/issue\/(\d+)\/transitions$/.exec(path))) {
      if (method === 'GET') {
        return res(200, { transitions: [
          { id: 't2', to: { id: '2' }, fields: {} }, { id: 't3', to: { id: '3' }, fields: {} }, { id: 't4', to: { id: '4' }, fields: {} },
          { id: 't5', to: { id: '5' }, fields: { resolution: { required: true, hasDefaultValue: false } } }, { id: 't6', to: { id: '6' }, fields: {} },
        ] });
      }
      const i = st.issues.get(m[1]); const target = { t2: '2', t3: '3', t4: '4', t5: '5', t6: '6' }[body.transition.id];
      st.transitions.push([i.key, body.transition.id]); i.status = target; i.updated = ts(); return res(204);
    }
    if ((m = /^\/issue\/(\d+)\/comment$/.exec(path))) { st.comments.push([m[1], body.body]); return res(201, { id: String(900 + st.comments.length) }); }
    if ((m = /^\/issue\/(\d+)\/remotelink$/.exec(path))) return res(201, { id: 1 });
    if ((m = /^\/issue\/(\d+)$/.exec(path))) {
      const i = st.issues.get(m[1]);
      if (!i) return res(404, { errorMessages: ['Issue does not exist'] });
      if (method === 'PUT') { if (body.fields.summary) i.summary = body.fields.summary; if (body.fields.description) i.description = body.fields.description; i.updated = ts(); return res(204); }
      return res(200, view(i));
    }
    return res(404, { errorMessages: [`fake jira: ${method} ${path}`] });
  }
  return { fetch: fetchFn, st };
}

test('Jira: discover proposes the status map; status pushes pick the matching transition; a screen with required fields is drift', async () => {
  const h = await syncHome({ provider: 'jira' });
  const { g, t } = await seed(h.home);
  const fake = fakeJira();
  const clock = makeClock();
  const e = await core('engine');
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  const disc = await e.discover({ projectDir: h.repo, tracker: 'jira', scopeHint: { project_key: 'SF' } }, d);
  assert.match(disc.lines[0], /^READY jira SF \(Software Factory\)/);
  assert.match(disc.lines[1], /backlog=Backlog, ready=To Do, in_progress=In Progress, in_review=In Review/);
  assert.match(disc.lines[1], /cancelled=Won't Do/);
  assert.equal(fake.st.auth, 'Basic ' + Buffer.from('bot@example.test:jt').toString('base64'));

  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, d);
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, d);
  const map = readSync(h.home, 'map.json');
  const epic = fake.st.issues.get(map.goals[g.id].remoteId);
  const task = fake.st.issues.get(map.items[t.id].remoteId);
  assert.equal(epic.issuetype.name, 'Epic');
  assert.equal(task.issuetype.name, 'Task');
  assert.deepEqual(task.parent, { id: epic.id });
  assert.equal(task.description.type, 'doc', 'body sent as ADF');
  assert.equal(task.status, '2', 'ready -> To Do through transition t2');
  assert.deepEqual(fake.st.transitions, [[task.key, 't2']]);

  // echo: ADF comes back, plain-text hashes match, no request
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, d);
  assert.equal(inboxFiles(h.home).length, 0);

  const store = await lib('store');
  store.update(h.home, 'task', t.id, (x) => { x.status = 'in_review'; });
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, d);
  assert.equal(task.status, '4');
  assert.deepEqual(fake.st.transitions.at(-1), [task.key, 't4']);

  store.update(h.home, 'task', t.id, (x) => { x.status = 'done'; });
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, d);
  assert.equal(task.status, '4', 'not forced through a screen with required fields');
  const drift = inboxFiles(h.home, 'tracker.config_drift');
  assert.equal(drift.length, 1);
  assert.match(drift[0].payload.reason, /required fields/);
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, d);
  assert.ok(fake.st.comments.some(([id, adf]) => id === task.id && JSON.stringify(adf).includes('no direct move')));
  assert.equal(inboxFiles(h.home, 'tracker.config_drift').length, 1, 'drift raised once');
});
