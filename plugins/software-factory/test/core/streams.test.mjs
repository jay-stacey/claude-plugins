// Work streams (contracts §21.4) and goal kinds (§21.1): items, triage, stream epics, capacity, windows.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { makeHome, lib, runCli, fakeDelivery, simulateAgent, baseHandoff, addEvidence, writeReport, join, writeFileSync, readFileSync, existsSync } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

async function streamsOn(home, extra = {}) {
  const cfg = await lib('config');
  cfg.merge(home, { project: { name: 'shop' }, streams: { enabled: true }, reports: { enabled: false }, baseline: { enabled: false }, ...extra });
  return cfg.load(home);
}

test('item new fails while streams are off; on, it creates a ready triage task in the team stream goal', async () => {
  const { home } = await makeHome();
  const off = runCli(['item', 'new', '--team', 'core', '--class', 'bug', '--title', 'Login fails'], { home });
  assert.equal(off.code, 1);
  assert.match(off.stderr, /streams are off; set streams\.enabled true/);
  await streamsOn(home);
  const r = runCli(['item', 'new', '--team', 'core', '--class', 'bug', '--title', 'Login fails', '--description', 'repro: click', '--priority', 'P1'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ITEM T-0001 core bug P1$/m);
  const store = await lib('store');
  const t = store.get(home, 'task', 'T-0001');
  const g = store.get(home, 'goal', t.goal_id);
  assert.deepEqual({ kind: t.kind, role: t.role, status: t.status, team: t.team, item: t.item, epics: t.item_epic_ids }, { kind: 'triage', role: 'staff-engineer', status: 'ready', team: 'core', item: { class: 'bug', tracker_ref: null, reported_by: 'human' }, epics: [] });
  assert.deepEqual({ kind: g.kind, title: g.title, status: g.status, team: g.team }, { kind: 'stream', title: 'shop maintenance', status: 'active', team: 'core' });
  assert.ok(g.budget.window_start && g.budget.limit_tokens === 15000000);
  const ev = (await lib('events')).tail(home, 50);
  assert.ok(ev.some((e) => e.type === 'item.created' && e.task_id === 'T-0001'));
  // item list / show
  const l = runCli(['item', 'list', '--team', 'core'], { home });
  assert.equal(l.stdout.trim(), 'T-0001 ready bug P1 core Login fails');
  const s = runCli(['item', 'show', 'T-0001'], { home });
  assert.match(s.stdout, /^status ready; effective ready; reported by human$/m);
  assert.match(s.stdout, /^note: docs\/streams\/core\/items\/T-0001\.md$/m);
  assert.equal(runCli(['item', 'new', '--team', 'ghost', '--class', 'bug', '--title', 'x'], { home }).code, 1);
  assert.equal(runCli(['item', 'new', '--team', 'core', '--class', 'feature', '--title', 'x'], { home }).code, 2);
  // the stream goal is never pushed as a "kind: goal" goal row in status
  const st = runCli(['status'], { home });
  assert.match(st.stdout, /^streams: core 1 open, 0 building$/m);
  assert.ok(!/G-001 active/.test(st.stdout));
});

test('a tracker item is never created twice; inbox item.add and tracker.backlog_item keep the body only for trusted editors', async () => {
  const { home } = await makeHome();
  await streamsOn(home, { tracker: { provider: 'linear', scope: { team_key: 'SHP' }, trusted_editors: ['u-trusted'] } });
  const streams = await lib('streams');
  const inbox = await lib('inbox');
  const store = await lib('store');
  const ref = { provider: 'linear', remote_id: 'iss-1', key: 'SHP-1', url: 'https://linear.app/x/SHP-1', kind: 'issue' };
  const a = streams.newItem(home, { team: 'core', class: 'bug', title: 'One', tracker_ref: ref });
  const b = streams.newItem(home, { team: 'core', class: 'bug', title: 'Other title', tracker_ref: { ...ref } });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.task.id, a.task.id);
  inbox.write(home, { type: 'item.add', payload: { team: 'core', class: 'tech_debt', title: 'Split module', description: 'big file' }, source: 'dashboard' });
  inbox.write(home, { type: 'tracker.backlog_item', payload: { remote_id: 'iss-2', key: 'SHP-2', url: 'https://linear.app/x/SHP-2', team_key: 'SHP', class: 'bug', title: 'Untrusted', body: 'secret text', author_id: 'u-other', priority: 1, cycle_tracker_id: null }, source: 'tracker', actor: { kind: 'tracker' }, auto_apply: true });
  inbox.write(home, { type: 'tracker.backlog_item', payload: { remote_id: 'iss-3', key: 'SHP-3', url: 'u3', team_key: 'SHP', class: 'chore', title: 'Trusted', body: 'keep me', author_id: 'u-trusted', priority: 'P3' }, source: 'tracker', actor: { kind: 'tracker' } });
  inbox.write(home, { type: 'tracker.backlog_item', payload: { remote_id: 'iss-1', key: 'SHP-1', team_key: 'SHP', class: 'bug', title: 'dup' }, source: 'tracker', actor: { kind: 'tracker' } });
  inbox.write(home, { type: 'tracker.backlog_item', payload: { remote_id: 'iss-9', key: 'XX-9', team_key: 'XX', class: 'bug', title: 'other team' }, source: 'tracker', actor: { kind: 'tracker' } });
  const res = await inbox.process(home, { tick: 1 });
  // requests written in the same millisecond have no fixed order, so compare without it
  assert.deepEqual(res.map((r) => `${r.type} ${r.status}`).sort(), ['item.add applied', 'tracker.backlog_item applied', 'tracker.backlog_item applied', 'tracker.backlog_item applied', 'tracker.backlog_item rejected']);
  assert.equal(res.filter((r) => /already linked as T-0001/.test(r.reason || '')).length, 1, 'the duplicate tracker item is reported once');
  const items = streams.items(home);
  const by = (title) => items.find((t) => t.title === title);
  assert.equal(by('Split module').item.reported_by, 'human');
  assert.equal(by('Untrusted').description, 'See https://linear.app/x/SHP-2');
  assert.equal(by('Untrusted').priority, 'P0', 'Linear priority 1 (urgent) is P0');
  assert.equal(by('Untrusted').item.reported_by, 'tracker');
  assert.equal(by('Trusted').description, 'keep me');
  assert.equal(by('Trusted').priority, 'P3');
  assert.equal(items.length, 4);
  void store;
});

test('effective item status follows the fix epics (mixed done and cancelled is done; an unreadable epic is open)', async () => {
  const { home } = await makeHome();
  await streamsOn(home);
  const streams = await lib('streams');
  const store = await lib('store');
  const a = await lib('actions');
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'B' });
  const goal = store.get(home, 'goal', task.goal_id);
  const e1 = a.newEpic(home, { goal_id: goal.id, title: 'fix 1', item: task.id });
  const e2 = a.newEpic(home, { goal_id: goal.id, title: 'fix 2', item: task.id });
  assert.deepEqual(store.get(home, 'task', task.id).item_epic_ids, [e1.id, e2.id]);
  assert.equal(store.get(home, 'epic', e1.id).item_task_id, task.id);
  const set = (id, s) => store.update(home, 'epic', id, (x) => { x.status = s; });
  const status = () => streams.itemStatus(home, store.get(home, 'task', task.id));
  assert.equal(status(), 'ready');
  store.update(home, 'task', task.id, (x) => { x.status = 'done'; });
  assert.equal(status(), 'in_progress');
  set(e1.id, 'pr_open'); assert.equal(status(), 'in_review');
  set(e1.id, 'done'); set(e2.id, 'cancelled'); assert.equal(status(), 'done', 'done + cancelled = done');
  set(e1.id, 'cancelled'); assert.equal(status(), 'cancelled');
  set(e1.id, 'done'); set(e2.id, 'done'); assert.equal(status(), 'done');
  store.update(home, 'task', task.id, (x) => { x.item_epic_ids = [e1.id, 'E-9999']; });
  assert.equal(status(), 'in_progress', 'an epic that cannot be read counts as open');
  const t2 = streams.newItem(home, { team: 'core', class: 'chore', title: 'no epics' }).task;
  store.update(home, 'task', t2.id, (x) => { x.status = 'done'; });
  assert.equal(streams.itemStatus(home, store.get(home, 'task', t2.id)), 'done');
  assert.throws(() => a.newEpic(home, { goal_id: goal.id, title: 'x', item: 'T-9999' }), /not found/);
});

test('stream code tasks start in backlog, inherit cycle and priority, and the epic builds once it has a task', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  await streamsOn(home);
  const streams = await lib('streams');
  const store = await lib('store');
  const a = await lib('actions');
  const flow = await lib('flow');
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'Crash', priority: 'P1' });
  store.update(home, 'task', task.id, (x) => { x.cycle = 'core-7'; });
  const e = a.newEpic(home, { goal_id: task.goal_id, title: 'Fix crash', item: task.id });
  await flow.advance(home);
  assert.equal(store.get(home, 'epic', e.id).status, 'draft', 'no task yet');
  const [c] = a.newTasks(home, [{ epic_id: e.id, kind: 'code', role: 'backend-engineer', title: 'Guard null', size: 'S', acceptance_criteria: ['no crash'], files_owned: ['src/a.js'] }]);
  assert.equal(c.status, 'backlog');
  assert.equal(c.priority, 'P1');
  assert.equal(c.cycle, 'core-7');
  assert.equal(c.item_task_id, task.id);
  await flow.advance(home);
  assert.equal(store.get(home, 'epic', e.id).status, 'building');
  assert.equal(store.get(home, 'task', c.id).status, 'ready');
  assert.ok(fake.state.shas[e.branch], 'epic branch created');
});

async function driveStreamEpic(home, fake) {
  const streams = await lib('streams');
  const store = await lib('store');
  const a = await lib('actions');
  const flow = await lib('flow');
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'Crash' });
  store.update(home, 'task', task.id, (x) => { x.status = 'done'; });
  const e = a.newEpic(home, { goal_id: task.goal_id, title: 'Fix crash', item: task.id });
  const [c] = a.newTasks(home, [{ epic_id: e.id, kind: 'code', role: 'backend-engineer', title: 'Guard', size: 'S', acceptance_criteria: ['ok'], files_owned: ['src/a.js'] }]);
  await flow.advance(home);
  store.update(home, 'task', c.id, (x) => { x.status = 'verified'; x.branch = 'factory/T-x'; });
  fake.state.shas['factory/T-x'] = 'abc';
  await flow.advance(home); // integrate -> qa
  const qa = store.list(home, 'task', (t) => t.kind === 'qa_epic' && t.epic_id === e.id)[0];
  assert.ok(qa, 'qa_epic created');
  assert.equal(qa.goal_id, task.goal_id);
  store.update(home, 'task', qa.id, (x) => { x.status = 'done'; x.verdict = 'pass'; });
  await flow.advance(home);
  return { e, task };
}

test('stream epic pipeline: integrate -> qa_epic -> PR with G4 (no docs, no review unless streams.epic_review)', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  await streamsOn(home);
  const store = await lib('store');
  const flow = await lib('flow');
  const streams = await lib('streams');
  const { e, task } = await driveStreamEpic(home, fake);
  const ep = store.get(home, 'epic', e.id);
  assert.equal(ep.status, 'pr_open');
  assert.equal(store.list(home, 'task', (t) => t.epic_id === e.id && ['docs', 'review_epic'].includes(t.kind)).length, 0);
  assert.equal(store.get(home, 'gate', ep.gates.G4).type, 'G4');
  assert.equal(streams.itemStatus(home, store.get(home, 'task', task.id)), 'in_review');
  fake.state.prState = 'MERGED';
  await flow.pollPr(home, e.id, { force: true });
  assert.equal(store.get(home, 'epic', e.id).status, 'done');
  assert.equal(streams.itemStatus(home, store.get(home, 'task', task.id)), 'done');
  assert.equal(store.get(home, 'goal', task.goal_id).status, 'active', 'a stream goal is never done');

  const { home: h2 } = await makeHome();
  const fake2 = fakeDelivery();
  (await lib('deps')).setDelivery(fake2.d);
  await streamsOn(h2, { streams: { enabled: true, epic_review: true } });
  const r = await driveStreamEpic(h2, fake2);
  assert.equal(store.get(h2, 'epic', r.e.id).status, 'review');
  const rv = store.list(h2, 'task', (t) => t.kind === 'review_epic')[0];
  store.update(h2, 'task', rv.id, (x) => { x.status = 'done'; x.verdict = 'pass'; });
  await flow.advance(h2);
  assert.equal(store.get(h2, 'epic', r.e.id).status, 'pr_open');
  assert.equal(store.list(h2, 'task', (t) => t.kind === 'docs').length, 0);
});

test('capacity: stream builders are capped while goal builder work waits; P0 ignores the cap; max_goals_building counts goals only', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  await streamsOn(home, { concurrency: { builders: 3, max_goals_building: 1 }, streams: { enabled: true, capacity_pct: 30 } });
  const streams = await lib('streams');
  const store = await lib('store');
  const a = await lib('actions');
  const dispatch = await lib('dispatch');
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'B' });
  const se = a.newEpic(home, { goal_id: task.goal_id, title: 'stream fix', item: task.id });
  const mkStream = (title, file, prio = 'P2') => a.createTask(home, { goal_id: task.goal_id, epic_id: se.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title, priority: prio, acceptance_criteria: ['x'], files_owned: [file] });
  store.update(home, 'task', task.id, (x) => { x.status = 'done'; });
  mkStream('s1', 'src/s1.js'); mkStream('s2', 'src/s2.js');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  for (const t of store.list(home, 'task', (x) => x.kind === 'intake')) store.update(home, 'task', t.id, (x) => { x.status = 'cancelled'; }); // drop the intake
  const ge = a.newEpic(home, { goal_id: g.id, title: 'goal epic' });
  a.createTask(home, { goal_id: g.id, epic_id: ge.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'g1', acceptance_criteria: ['x'], files_owned: ['src/g1.js'] });
  const r = dispatch.choose(home, { factory: { status: 'running' } });
  assert.deepEqual(r.chosen.map((c) => c.task.title).sort(), ['g1', 's1']);
  assert.ok(r.skipped.some((s) => s.reason === 'stream capacity'));
  // a P0 item fix ignores the cap
  mkStream('s0', 'src/s0.js', 'P0');
  const r2 = dispatch.choose(home, { factory: { status: 'running' } });
  assert.deepEqual(r2.chosen.map((c) => c.task.title).sort(), ['g1', 's0'], 'the P0 fix runs and counts toward the cap');
  // no goal builder work waiting: streams may use every builder slot; max_goals_building ignores streams
  for (const t of store.list(home, 'task', (x) => x.title === 'g1')) store.update(home, 'task', t.id, (x) => { x.status = 'cancelled'; });
  const r3 = dispatch.choose(home, { factory: { status: 'running' } });
  assert.deepEqual(r3.chosen.map((c) => c.task.title).sort(), ['s0', 's1', 's2']);
});

test('budget windows: an ops goal rolls at UTC midnight and a stream every 7 days; a roll unblocks and supersedes the budget gate', async () => {
  const { home } = await makeHome();
  await streamsOn(home);
  const ops = await lib('ops');
  const streams = await lib('streams');
  const budget = await lib('budget');
  const store = await lib('store');
  const cfg = (await lib('config')).load(home);
  const day0 = Date.parse('2026-10-13T10:00:00Z');
  const og = ops.ensureOps(home, cfg, { now: day0 });
  assert.equal(og.budget.window_start, '2026-10-13T00:00:00.000Z');
  assert.equal(og.budget.limit_tokens, 2000000);
  const sg = streams.ensureStreams(home, cfg, { now: day0 })[0];
  store.update(home, 'goal', sg.id, (x) => { x.budget.window_start = '2026-10-06T09:00:00.000Z'; });
  // spend in the old window does not count once the window rolls
  store.create(home, 'run', { task_id: 'T-0001', goal_id: og.id, kind: 'escalation', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'completed', dispatched_at: '2026-10-13T01:00:00.000Z', estimate_tokens: 0, agent_id: 'agx' });
  (await lib('usage')).writeSnapshot(home, { scope: 'agent', agent_id: 'agx', session_id: 's', run_id: 'R-000001', status: 'finished', requests: 1, by_model: { m: { input: 1900000, output: 0, cache_read: 0, cache_creation: 0 } } });
  assert.equal(budget.compute(home).goals[og.id].spent, 1900000);
  const gate = budget.block(home, og.id, 250000);
  assert.equal(store.get(home, 'goal', og.id).status, 'budget_blocked');
  const rolled = await ops.rollWindows(home, cfg, { now: Date.parse('2026-10-14T00:05:00Z') });
  assert.deepEqual(rolled.sort(), [og.id, sg.id].sort());
  const og2 = store.get(home, 'goal', og.id);
  assert.equal(og2.status, 'active');
  assert.equal(og2.budget.window_start, '2026-10-14T00:00:00.000Z');
  assert.equal(store.get(home, 'gate', gate.id).status, 'superseded');
  assert.equal(budget.compute(home).goals[og.id].spent, 0, 'runs before the window do not count');
  assert.equal(store.get(home, 'goal', sg.id).budget.window_start, '2026-10-13T09:00:00.000Z', 'stream window steps in whole weeks');
  assert.deepEqual(await ops.rollWindows(home, cfg, { now: Date.parse('2026-10-14T05:00:00Z') }), [], 'no second roll inside a window');
});

test('follow-ups with kind bug|tech_debt|chore become items in the team of the reporting task, deduped by title', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  await streamsOn(home);
  const a = await lib('actions');
  const store = await lib('store');
  const collect = await lib('collect');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const run = store.create(home, 'run', { task_id: 'T-0001', goal_id: g.id, kind: 'escalation', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'completed', handoff_path: join(home, 'runs', 'R-000001', 'handoff.json').replace(/\\/g, '/') });
  (await lib('lifecycle')).move(home, 'T-0001', 'in_progress');
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  const fu = [{ title: 'Flaky test in cart', kind: 'bug', reason: 'seen twice' }, { title: 'Flaky test in cart', kind: 'bug', reason: 'dup' }, { title: 'Docs typo', kind: 'docs', reason: 'not a stream kind' }, { title: 'Old helper', kind: 'tech_debt', reason: 'unused' }];
  writeFileSync(run.handoff_path, JSON.stringify(baseHandoff(run, store.get(home, 'task', 'T-0001'), { follow_ups: fu })));
  await collect.collect(home);
  const items = store.list(home, 'task', (t) => t.kind === 'triage');
  assert.deepEqual(items.map((t) => `${t.title}|${t.item.class}|${t.item.reported_by}|${t.team}`).sort(), ['Flaky test in cart|bug|agent|core', 'Old helper|tech_debt|agent|core']);
  void fake; void addEvidence; void writeReport; void readFileSync; void existsSync; void simulateAgent;
});

test('a triage run: staff-engineer author run, no worktree, item note output path, done on a handoff without acceptance criteria', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  await streamsOn(home);
  const streams = await lib('streams');
  const store = await lib('store');
  const tick = await lib('tick');
  (await lib('control')).start(home, { session: 'S1' });
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'Crash on save' });
  await tick.begin(home, { session: 'S1', force: true });
  const p = await tick.plan(home, { session: 'S1' });
  assert.equal(p.dispatches.length, 1);
  const run = store.get(home, 'run', p.dispatches[0].run_id);
  assert.deepEqual({ role: run.role, kind: run.kind, iso: run.isolation, out: run.output_paths }, { role: 'staff-engineer', kind: 'author', iso: 'none', out: [`docs/streams/core/items/${task.id}.md`] });
  await simulateAgent(home, p.dispatches[0], async ({ run: r, task: t, home: h }) => { writeReport(h, r.output_paths[0]); return baseHandoff(r, t, { acceptance_criteria: [] }); });
  await tick.begin(home, { session: 'S1', force: true });
  assert.equal(store.get(home, 'task', task.id).status, 'done');
  assert.equal(streams.itemStatus(home, store.get(home, 'task', task.id)), 'done');
  void readFileSync; void existsSync;
});

test('task new accepts team, cycle and item in the file; inbox report.request asks for a report', async () => {
  const { home, root } = await makeHome();
  await streamsOn(home);
  const streams = await lib('streams');
  const a = await lib('actions');
  const { task } = streams.newItem(home, { team: 'core', class: 'tech_debt', title: 'Old API', priority: 'P1' });
  const e = a.newEpic(home, { goal_id: task.goal_id, title: 'Remove old API' });
  const file = join(root, 'tasks.json');
  writeFileSync(file, JSON.stringify([{ epic_id: e.id, kind: 'code', role: 'backend-engineer', title: 'Drop it', size: 'S', acceptance_criteria: ['gone'], files_owned: ['src/b.js'], item: task.id, cycle: 'core-3', team: 'core' }]));
  const r = runCli(['task', 'new', '--file', file, '--json'], { home });
  assert.equal(r.code, 0, r.stderr);
  const [t] = JSON.parse(r.stdout);
  assert.deepEqual({ team: t.team, cycle: t.cycle, item: t.item_task_id, prio: t.priority, status: t.status }, { team: 'core', cycle: 'core-3', item: task.id, prio: 'P1', status: 'backlog' });
  writeFileSync(file, JSON.stringify({ epic_id: e.id, kind: 'code', title: 'x', size: 'S', acceptance_criteria: ['y'], team: 'ghost', item: 'T-0999' }));
  const bad = runCli(['task', 'new', '--file', file], { home });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown team ghost/);
  assert.match(bad.stderr, /item T-0999 is not a triage task/);
  const inbox = await lib('inbox');
  inbox.write(home, { type: 'report.request', payload: {}, source: 'dashboard' });
  const res = await inbox.process(home, { tick: 1 });
  assert.equal(res[0].status, 'applied');
  assert.ok((await lib('state')).readFactory(home).reports.requested_at);
});
