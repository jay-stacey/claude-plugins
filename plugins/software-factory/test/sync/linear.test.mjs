import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncHome, seed, fakeLinear, makeClock, ENV, core, lib, inboxFiles, readSync, approveFirstSync, freshLease } from './_sync.mjs';

async function engine() { return core('engine'); }

function deps(fake, clock, env = ENV) { return { env, fetch: fake.fetch, now: clock, sleep: async () => {} }; }

/** Home with goal + spec task, approved first sync, both mapped in the fake tracker. */
async function mapped(opts = {}) {
  const h = await syncHome({ provider: 'linear', ...(opts.home || {}) });
  const s = await seed(h.home, opts.seed);
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await engine();
  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, deps(fake, clock)); // labels + goal
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, deps(fake, clock)); // task (parent mapped now)
  clock.advance(1000);
  const map = readSync(h.home, 'map.json');
  return { ...h, ...s, clock, fake, e, map, d: deps(fake, clock), taskRid: map.items[s.t.id].remoteId, goalRid: map.goals[s.g.id].remoteId };
}

async function processInbox(home) { return (await lib('inbox')).process(home, { tick: 1 }); }

test('first sync is preview only; approval through the tracker gate starts creating items with footer, labels and parent', async () => {
  const h = await syncHome({ provider: 'linear' });
  const { g, t } = await seed(h.home);
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await engine();
  const r0 = await e.syncTick({ projectDir: h.repo }, deps(fake, clock));
  assert.match(r0.lines.join('\n'), /first sync not previewed/);
  assert.equal(fake.st.mutations.length, 0, 'no writes before approval');
  assert.equal(inboxFiles(h.home).length, 0, 'no requests before approval');

  const p = await e.preview({ projectDir: h.repo }, deps(fake, clock));
  assert.match(p.lines[0], /^PREVIEW [0-9a-f]{12}/);
  const md = readFileSync(join(h.home, 'sync', 'preview.md'), 'utf8');
  assert.match(md, /Items to create \(2\)/);
  assert.match(md, /- software-factory/);
  assert.match(md, /- role:staff-engineer/);
  assert.match(md, /in_progress -> In Progress/);
  assert.equal(fake.st.mutations.length, 0, 'preview writes nothing to the tracker');
  const req = inboxFiles(h.home, 'sync.first_sync');
  assert.equal(req.length, 1);
  assert.equal(req[0].needs_confirmation, true);

  const res = await processInbox(h.home);
  assert.equal(res[0].status, 'gated');
  const gate = (await lib('store')).get(h.home, 'gate', res[0].gate_id);
  assert.match(gate.artifact.summary, /First tracker sync: create 2 items/);
  await (await lib('flow')).decideGate(h.home, gate.id, { decision: 'approve', by: 'jay', via: 'cli' });
  assert.equal(readSync(h.home, 'state.json').first_sync_approved, true);

  await e.syncTick({ projectDir: h.repo }, deps(fake, clock));
  clock.advance(1000);
  await e.syncTick({ projectDir: h.repo }, deps(fake, clock));
  const map = readSync(h.home, 'map.json');
  assert.ok(map.goals[g.id].remoteId && map.items[t.id].remoteId);
  const issue = fake.st.issues.get(map.items[t.id].remoteId);
  assert.equal(issue.parentId, map.goals[g.id].remoteId);
  assert.match(issue.description, new RegExp(`sf-id: ${t.id}`));
  assert.equal(issue.stateId, 's-todo', 'ready maps to Todo');
  const names = issue.labelIds.map((id) => fake.st.labels.find((l) => l.id === id).name).sort();
  assert.deepEqual(names, ['role:staff-engineer', 'software-factory']);
  assert.equal(fake.st.mutations.filter((m) => m === 'issueLabelCreate').length, 2);
  // the log holds field names only
  const logFile = readdirSync(join(h.home, 'sync')).find((n) => n.startsWith('log-'));
  const log = readFileSync(join(h.home, 'sync', logFile), 'utf8');
  assert.ok(!log.includes('Decode VINs'), 'no field values in the audit log');
});

test('echo suppression: our own pushes (reformatted by the tracker) raise no request and cost no write', async () => {
  const m = await mapped();
  const before = m.fake.st.mutations.length;
  for (let i = 0; i < 2; i++) { await m.e.syncTick({ projectDir: m.repo }, m.d); m.clock.advance(1000); }
  assert.equal(m.fake.st.mutations.length, before, 'no write after our own push');
  assert.equal(inboxFiles(m.home).length, 0, 'no request after our own push');
  assert.match(m.fake.st.issues.get(m.taskRid).description, /^\* AC-1/m, 'the fake rewrote the bullets');
  // an unrelated human edit (priority) re-reads the item: title/body still echo, only the priority request appears
  m.fake.human.edit(m.taskRid, { priority: 1 });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const reqs = inboxFiles(m.home);
  assert.deepEqual(reqs.map((r) => r.type), ['tracker.field_update']);
  assert.equal(reqs[0].auto_apply, true);
  assert.deepEqual(reqs[0].payload.field, 'priority');
  assert.equal(reqs[0].payload.value, 'P0');
  await processInbox(m.home);
  assert.equal((await lib('store')).get(m.home, 'task', m.t.id).priority, 'P0');
});

test('human cancel needs confirmation; reject restores the tracker status, approve cancels the task', async () => {
  const m = await mapped();
  const store = await lib('store');
  const flow = await lib('flow');
  m.fake.human.edit(m.taskRid, { stateId: 's-cancel' });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  let req = inboxFiles(m.home, 'tracker.status_change');
  assert.equal(req.length, 1);
  assert.equal(req[0].payload.class, 'cancel');
  assert.equal(req[0].needs_confirmation, true);
  const res = await processInbox(m.home);
  assert.equal(res[0].status, 'gated');
  await flow.decideGate(m.home, res[0].gate_id, { decision: 'reject', by: 'jay', via: 'cli' });
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.issues.get(m.taskRid).stateId, 's-todo', 'mapped status pushed back');
  assert.ok(m.fake.st.comments.some((c) => /not confirmed/.test(c.body)));
  assert.equal(store.get(m.home, 'task', m.t.id).status, 'ready');

  m.clock.advance(1000);
  m.fake.human.edit(m.taskRid, { stateId: 's-cancel' });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  req = inboxFiles(m.home, 'tracker.status_change');
  assert.equal(req.length, 1, 'a second cancel raises a new request');
  const res2 = await processInbox(m.home);
  await flow.decideGate(m.home, res2[0].gate_id, { decision: 'approve', by: 'jay', via: 'cli' });
  assert.equal(store.get(m.home, 'task', m.t.id).status, 'cancelled');
});

test('rework: a move back from In Review needs confirmation and sends the task back to ready', async () => {
  const m = await mapped();
  const store = await lib('store');
  store.update(m.home, 'task', m.t.id, (x) => { x.status = 'in_review'; });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.issues.get(m.taskRid).stateId, 's-review');
  m.clock.advance(1000);
  m.fake.human.edit(m.taskRid, { stateId: 's-prog' });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const req = inboxFiles(m.home, 'tracker.status_change');
  assert.equal(req[0].payload.class, 'rework');
  const res = await processInbox(m.home);
  await (await lib('flow')).decideGate(m.home, res[0].gate_id, { decision: 'approve', by: 'jay', via: 'cli' });
  const t = store.get(m.home, 'task', m.t.id);
  assert.equal(t.status, 'ready');
  assert.equal(t.rework_count, 1);
  assert.ok(t.feedback.some((f) => f.source === 'tracker'));
});

test('conflict: both sides changed the title -> tracker.conflict; a local-only change is pushed', async () => {
  const m = await mapped();
  const store = await lib('store');
  store.update(m.home, 'task', m.t.id, (x) => { x.title = 'Local new title'; });
  m.fake.human.edit(m.taskRid, { title: 'Remote new title' });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const c = inboxFiles(m.home, 'tracker.conflict');
  assert.equal(c.length, 1);
  assert.equal(c[0].payload.field, 'title');
  assert.equal(c[0].needs_confirmation, true);
  assert.equal(m.fake.st.issues.get(m.taskRid).title, 'Remote new title', 'neither side overwritten while the pick is open');

  const m2 = await mapped();
  store.update(m2.home, 'task', m2.t.id, (x) => { x.description = 'Decode VINs with retry and backoff.'; });
  await m2.e.syncTick({ projectDir: m2.repo }, m2.d);
  assert.match(m2.fake.st.issues.get(m2.taskRid).description, /retry and backoff/);
  assert.equal(inboxFiles(m2.home).length, 0);
});

test('human comments become tracker.comment; trusted editors feed the task, others are logged only', async () => {
  const m = await mapped({ home: { extra: { trusted_editors: ['u-human'] } } });
  m.fake.human.comment(m.taskRid, 'Please also handle 17-char edge cases', 'u-human', 'Pat');
  m.fake.human.comment(m.taskRid, 'drive-by remark', 'u-other', 'Sam');
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const reqs = inboxFiles(m.home, 'tracker.comment');
  assert.equal(reqs.length, 2);
  const res = await processInbox(m.home);
  assert.deepEqual(res.map((r) => r.reason).sort(), ['added to task feedback', 'logged only (author not in tracker.trusted_editors)']);
  const t = (await lib('store')).get(m.home, 'task', m.t.id);
  const fb = t.feedback.find((f) => f.source === 'tracker');
  assert.match(fb.text, /^> Please also handle/);
  assert.match(fb.text, /comment by Pat/);
  // our own comments (side-state notes) are never raised
  (await lib('store')).update(m.home, 'task', m.t.id, (x) => { x.status = 'blocked'; x.status_reason = 'waiting'; });
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(inboxFiles(m.home, 'tracker.comment').length, 0);
  assert.ok(m.fake.st.comments.some((c) => /is blocked: waiting/.test(c.body)));
});

test('outbox: a failed write stays queued with backoff and is retried later', async () => {
  const m = await mapped();
  (await lib('store')).update(m.home, 'task', m.t.id, (x) => { x.status = 'in_progress'; });
  m.fake.st.failNext.push({ match: 'issueUpdate', status: 500 });
  const r = await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.match(r.lines.join('\n'), /outbox 1 waiting/);
  let ob = readFileSync(join(m.home, 'sync', 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ob[0].attempts, 1);
  assert.equal(readSync(m.home, 'state.json').health, 'degraded');
  const n = m.fake.st.calls.length;
  m.clock.advance(10_000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.mutations.filter((x) => x === 'issueUpdate').length, 0, 'not retried before the backoff');
  assert.ok(m.fake.st.calls.length > n);
  m.clock.advance(61_000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.issues.get(m.taskRid).stateId, 's-prog');
  ob = readFileSync(join(m.home, 'sync', 'outbox.jsonl'), 'utf8').trim();
  assert.equal(ob, '');
  assert.equal(readSync(m.home, 'state.json').health, 'ok');
  const events = readFileSync(join(m.home, 'events', 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"sync\.completed"/, 'a successful sync with work emits sync.completed');
});

test('rate limit: 429 sets a backoff from Retry-After and stops the tick; SYNC is not due meanwhile', async () => {
  const m = await mapped();
  (await lib('store')).update(m.home, 'task', m.t.id, (x) => { x.status = 'in_progress'; });
  m.fake.st.failNext.push({ match: 'issueUpdate', status: 429, headers: { 'retry-after': '120' } });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const st = readSync(m.home, 'state.json');
  const wait = Date.parse(st.backoff_until) - m.clock();
  assert.ok(wait > 100_000 && wait <= 121_000, `backoff ${wait}`);
  const r = await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.match(r.lines[0], /^SYNC backoff until/);
  const tick = await lib('tick');
  const cfg = (await lib('config')).load(m.home);
  assert.equal(tick.syncDue(m.home, cfg, { sync_requested_at: null }), false);
  // Linear's GraphQL RATELIMITED (HTTP 400) is treated the same way
  const m2 = await mapped();
  (await lib('store')).update(m2.home, 'task', m2.t.id, (x) => { x.status = 'in_progress'; });
  m2.fake.st.failNext.push({ match: 'issueUpdate', status: 400, body: { errors: [{ message: 'limit', extensions: { code: 'RATELIMITED' } }] } });
  await m2.e.syncTick({ projectDir: m2.repo }, m2.d);
  assert.ok(readSync(m2.home, 'state.json').backoff_until);
});

test('redaction blocks an op with an email, raises sync.redaction_blocked with field names only', async () => {
  const m = await mapped();
  const a = await lib('actions');
  const t2 = a.createTask(m.home, { goal_id: m.g.id, kind: 'spec', title: 'Contact flow', description: 'Ask pat.doe@example.com for the sample file', status: 'ready', acceptance_criteria: ['x'] });
  const creates = m.fake.st.mutations.filter((x) => x === 'issueCreate').length;
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.mutations.filter((x) => x === 'issueCreate').length, creates, 'create blocked');
  const r = inboxFiles(m.home, 'sync.redaction_blocked');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].payload, { local_id: t2.id, op: 'create_item', field: 'body', kinds: ['email'] });
  assert.ok(!JSON.stringify(r[0]).includes('pat.doe'));
});

test('bulk guard holds a tick with too many ops and raises sync.bulk_confirm', async () => {
  const m = await mapped({ home: { extra: { max_ops_before_confirm: 1 } } });
  const a = await lib('actions');
  for (const n of [1, 2]) a.createTask(m.home, { goal_id: m.g.id, kind: 'spec', title: `More ${n}`, description: 'x', status: 'ready', acceptance_criteria: ['x'] });
  const creates = m.fake.st.mutations.filter((x) => x === 'issueCreate').length;
  const r = await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.match(r.lines.join('\n'), /bulk guard/);
  assert.equal(m.fake.st.mutations.filter((x) => x === 'issueCreate').length, creates);
  const b = inboxFiles(m.home, 'sync.bulk_confirm');
  assert.equal(b.length, 1);
  assert.equal(b[0].needs_confirmation, true);
  const res = await processInbox(m.home);
  await (await lib('flow')).decideGate(m.home, res[0].gate_id, { decision: 'approve', by: 'jay', via: 'cli' });
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.mutations.filter((x) => x === 'issueCreate').length, creates + 2, 'sent once after approval');
});

test('scope guard drops ops aimed at items outside the configured scope', async () => {
  const m = await mapped();
  const { writeJsonAtomic } = await lib('fsutil');
  const map = readSync(m.home, 'map.json');
  map.items[m.t.id].scopeKey = 'linear:team:OPS';
  writeJsonAtomic(join(m.home, 'sync', 'map.json'), map);
  (await lib('store')).update(m.home, 'task', m.t.id, (x) => { x.status = 'in_progress'; });
  const n = m.fake.st.mutations.length;
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.mutations.length, n);
  const s = inboxFiles(m.home, 'sync.scope_blocked');
  assert.equal(s.length, 1);
  assert.match(s[0].payload.reason, /linear:team:OPS/);
});

test('lease refusal, kill switch and missing credentials make no network call', async () => {
  const m = await mapped();
  const calls = m.fake.st.calls.length;
  freshLease(m.home, Date.now() - 5000 * 1000);
  let r = await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.match(r.lines[0], /^REFUSED/);
  freshLease(m.home);
  r = await m.e.syncTick({ projectDir: m.repo }, { ...m.d, env: { ...ENV, SF_SYNC_ENABLED: 'false' } });
  assert.match(r.lines[0], /disabled/);
  r = await m.e.syncTick({ projectDir: m.repo }, { ...m.d, env: { SF_SYNC_ENABLED: 'true', SF_LINEAR_API_KEY: '${user_config.linear_api_key}' } });
  assert.match(r.lines[0], /^PENDING_CREDENTIALS missing: linear_api_key/);
  assert.equal(m.fake.st.calls.length, calls);
});

test('intake: a labelled issue becomes a draft goal created by the tracker that waits for goal.activate', async () => {
  const m = await mapped();
  m.fake.st.labels.push({ id: 'l-intake', name: 'factory-intake' });
  m.fake.human.create({ title: 'Export deals to CSV', description: 'Customers want CSV', labelIds: ['l-intake'] });
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  const r = inboxFiles(m.home, 'tracker.intake');
  assert.equal(r.length, 1);
  await processInbox(m.home);
  const store = await lib('store');
  const g = store.list(m.home, 'goal').find((x) => x.title.includes('Export deals'));
  assert.equal(g.status, 'draft');
  assert.equal(g.created_by.kind, 'tracker');
  const dispatch = await lib('dispatch');
  assert.ok(!dispatch.candidates(m.home).some((c) => (c.task || c).goal_id === g.id), 'draft goal is not dispatched');
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(inboxFiles(m.home, 'tracker.intake').length, 0, 'deduped');
});

test('full reconcile detects a missing item; approval unlinks it; crash recovery relinks by footer', async () => {
  const m = await mapped();
  m.fake.st.issues.delete(m.taskRid); // gone from the tracker (the fake models an archive)
  await m.e.syncTick({ projectDir: m.repo, mode: 'full' }, m.d);
  const miss = inboxFiles(m.home, 'tracker.missing');
  assert.equal(miss.length, 1);
  const res = await processInbox(m.home);
  await (await lib('flow')).decideGate(m.home, res[0].gate_id, { decision: 'approve', by: 'jay', via: 'cli' });
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(readSync(m.home, 'map.json').items[m.t.id].unlinked, true);

  // crash after create: map entry pending, the item exists with our footer -> relinked, no second create
  const m2 = await mapped();
  const a = await lib('actions');
  const t2 = a.createTask(m2.home, { goal_id: m2.g.id, kind: 'spec', title: 'Second', description: 'y', status: 'ready', acceptance_criteria: ['x'] });
  const existing = m2.fake.human.create({ title: 'Second', description: `y\n\nsf-id: ${t2.id} · managed by software-factory`, parentId: m2.goalRid });
  const { writeJsonAtomic } = await lib('fsutil');
  const map = readSync(m2.home, 'map.json');
  map.items[t2.id] = { kind: 'task', remoteId: null, pendingCreate: true, pushed: {}, pulled: {}, local: {}, ourCommentIds: [], linkedPRs: [], commentedRuns: [] };
  writeJsonAtomic(join(m2.home, 'sync', 'map.json'), map);
  const creates = m2.fake.st.mutations.filter((x) => x === 'issueCreate').length;
  await m2.e.syncTick({ projectDir: m2.repo }, m2.d);
  assert.equal(m2.fake.st.mutations.filter((x) => x === 'issueCreate').length, creates);
  assert.equal(readSync(m2.home, 'map.json').items[t2.id].remoteId, existing.id);
});

test('sync_apply_preview needs the human intent from /software-factory:sync --approve-preview', async () => {
  const h = await syncHome({ provider: 'linear' });
  await seed(h.home);
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await engine();
  await e.preview({ projectDir: h.repo }, deps(fake, clock));
  const id = readSync(h.home, 'state.json').preview.id;
  const env = { ...process.env, FACTORY_HOME: h.home };
  const { spawnSync } = await import('node:child_process');
  const { CLI } = await import('../core/_helpers.mjs');
  const runCli = (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, CLAUDE_CODE_SESSION_ID: '' } }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  let r = await e.applyPreview({ projectDir: h.repo, previewId: id }, { runCli });
  assert.match(r.lines[0], /^NOT_APPROVED .*sync --approve-preview/);
  const intent = await lib('intent');
  assert.equal(intent.parseIntentCommand('/software-factory:sync --approve-preview'), 'sync-approve');
  intent.writeIntent(h.home, null, 'sync-approve');
  await processInbox(h.home);
  r = await e.applyPreview({ projectDir: h.repo, previewId: id }, { runCli });
  assert.match(r.lines[0], /^APPROVED first sync/);
  assert.equal(readSync(h.home, 'state.json').first_sync_approved, true);
  const gates = (await lib('store')).list(h.home, 'gate', (g) => g.type === 'tracker');
  assert.equal(gates[0].status, 'superseded', 'the pending first-sync gate is closed');
  const st = runCli(['sync', 'status', '--home', h.home]);
  assert.equal(st.code, 0);
  assert.match(st.stdout, /first sync approved/);
});

test('tick plan prints SYNC due only for a ready tracker after min_interval_s', async () => {
  const h = await syncHome({ provider: 'linear' });
  const tick = await lib('tick');
  const cfgLib = await lib('config');
  const f = { sync_requested_at: null };
  assert.equal(tick.syncDue(h.home, cfgLib.load(h.home), f), true);
  cfgLib.set(h.home, 'tracker.status', 'pending_credentials');
  assert.equal(tick.syncDue(h.home, cfgLib.load(h.home), f), false);
  cfgLib.set(h.home, 'tracker.status', 'ready');
  const ss = await lib('syncstate');
  ss.updateState(h.home, (s) => { s.last_pull_at = new Date().toISOString(); });
  assert.equal(tick.syncDue(h.home, cfgLib.load(h.home), f), false);
  assert.equal(tick.syncDue(h.home, cfgLib.load(h.home), f, Date.now() + 61_000), true);
  assert.ok(existsSync(join(h.home, 'sync', 'state.json')));
});

test('dry run plans and logs without writing to the tracker, the inbox or the map; rebuild_map re-links by footer', async () => {
  const m = await mapped();
  (await lib('store')).update(m.home, 'task', m.t.id, (x) => { x.status = 'in_progress'; });
  m.fake.human.edit(m.taskRid, { priority: 2 });
  const n = m.fake.st.mutations.length;
  const mapBefore = readFileSync(join(m.home, 'sync', 'map.json'), 'utf8');
  const r = await m.e.syncTick({ projectDir: m.repo, mode: 'dry_run' }, m.d);
  assert.match(r.lines.join('\n'), /dry run: 1 ops planned, none sent/);
  assert.equal(m.fake.st.mutations.length, n);
  assert.equal(inboxFiles(m.home).length, 0);
  assert.equal(readFileSync(join(m.home, 'sync', 'map.json'), 'utf8'), mapBefore);
  const log = readFileSync(join(m.home, 'sync', readdirSync(join(m.home, 'sync')).find((x) => x.startsWith('log-'))), 'utf8');
  assert.match(log, /"result":"dry_run"/);
  // the real tick afterwards still sees the human change
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(inboxFiles(m.home, 'tracker.field_update').length, 1);
  assert.equal(m.fake.st.issues.get(m.taskRid).stateId, 's-prog');

  // map lost: rebuild_map re-links both items without creating anything
  const { writeJsonAtomic } = await lib('fsutil');
  writeJsonAtomic(join(m.home, 'sync', 'map.json'), { version: 1, items: {}, goals: {} });
  const creates = m.fake.st.mutations.filter((x) => x === 'issueCreate').length;
  const rb = await m.e.syncTick({ projectDir: m.repo, mode: 'rebuild_map' }, m.d);
  assert.match(rb.lines[0], /re-linked 2 of 2/);
  const map = readSync(m.home, 'map.json');
  assert.equal(map.items[m.t.id].remoteId, m.taskRid);
  assert.equal(map.goals[m.g.id].remoteId, m.goalRid);
  m.clock.advance(1000);
  await m.e.syncTick({ projectDir: m.repo }, m.d);
  assert.equal(m.fake.st.mutations.filter((x) => x === 'issueCreate').length, creates);
});
