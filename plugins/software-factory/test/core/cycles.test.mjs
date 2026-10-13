// Cycles (contracts §21.6): local cycles, roll transitions, commit, tracker cycles, chooser gating.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, lib, runCli, fakeDelivery } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

const T0 = Date.parse('2026-10-13T10:00:00Z'); // cycle 21 of 14 days from 2026-01-05 runs 2026-10-12 .. 2026-10-26

async function cyclesOn(home, extra = {}) {
  const cfg = await lib('config');
  cfg.merge(home, { project: { name: 'shop' }, cycles: { enabled: true, anchor: '2026-01-05', length_days: 14 }, reports: { enabled: true }, baseline: { enabled: false }, ...extra });
  return cfg.load(home);
}

test('local cycles come from the anchor in whole lengths, numbered from 1, starting 00:00 UTC', async () => {
  const cyc = await lib('cycles');
  const cfg = { cycles: { anchor: '2026-01-05', length_days: 14 } };
  const c = cyc.localCycles(cfg, 'core', T0);
  assert.deepEqual(c.current, { id: 'core-21', team: 'core', number: 21, name: null, starts_at: '2026-10-12T00:00:00.000Z', ends_at: '2026-10-26T00:00:00.000Z', source: 'local', tracker_id: null });
  assert.equal(c.previous.id, 'core-20');
  assert.equal(c.next.starts_at, '2026-10-26T00:00:00.000Z');
  const before = cyc.localCycles(cfg, 'core', Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(before.current, null);
  assert.equal(before.next.id, 'core-1');
  assert.equal(cyc.sourceOf({ cycles: {}, tracker: { provider: 'linear' } }), 'tracker');
  assert.equal(cyc.sourceOf({ cycles: {}, tracker: { provider: 'github' } }), 'local');
});

test('cycle roll: the first roll plans; a new cycle emits ended/started, a cycle_review report, a cycle_plan and a stream window roll', async () => {
  const { home } = await makeHome();
  const cfg = await cyclesOn(home, { streams: { enabled: true } });
  const cyc = await lib('cycles');
  const store = await lib('store');
  const streams = await lib('streams');
  const r1 = await cyc.roll(home, cfg, { now: T0 });
  assert.equal(r1.first, true);
  assert.deepEqual(r1.transitions, []);
  let plans = store.list(home, 'task', (t) => t.kind === 'cycle_plan');
  assert.equal(plans.length, 1);
  assert.deepEqual({ team: plans[0].team, plan: plans[0].plan_cycle, cycle: plans[0].cycle ?? null, role: plans[0].role, out: plans[0].output_rel }, { team: 'core', plan: 'core-21', cycle: null, role: 'cto', out: 'docs/cycles/core-21-plan.md' });
  assert.equal(store.list(home, 'task', (t) => t.kind === 'report').length, 0, 'no cycle review on the first roll');
  assert.deepEqual((await cyc.roll(home, cfg, { now: T0 + 3600000 })).transitions, [], 'same cycle: nothing happens');
  streams.ensureStreams(home, cfg, { now: T0 });
  const sg = streams.streamGoal(home, 'core');
  assert.equal(sg.budget.window_start, '2026-10-12T00:00:00.000Z', 'a stream window starts at its cycle start');
  store.update(home, 'task', plans[0].id, (x) => { x.status = 'done'; });
  const t2 = Date.parse('2026-10-26T08:00:00Z');
  const r2 = await cyc.roll(home, cfg, { now: t2 });
  assert.deepEqual(r2.transitions, [{ team: 'core', from: 'core-21', to: 'core-22' }]);
  assert.deepEqual(r2.lines, ['cycles: core core-22']);
  const ev = (await lib('events')).tail(home, 80).map((e) => e.type);
  assert.ok(ev.includes('cycle.ended') && ev.includes('cycle.started'));
  plans = store.list(home, 'task', (t) => t.kind === 'cycle_plan' && t.status === 'ready');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].plan_cycle, 'core-22');
  const review = store.list(home, 'task', (t) => t.kind === 'report')[0];
  assert.deepEqual({ type: review.report_type, team: review.team, from: review.report_period.from }, { type: 'cycle_review', team: 'core', from: '2026-10-12T00:00:00.000Z' });
  assert.equal(store.get(home, 'goal', sg.id).budget.window_start, '2026-10-26T00:00:00.000Z', 'the stream window rolled at the new cycle start');
  assert.equal(cyc.readState(home).rolled.core, 'core-22');
});

test('cycle commit current|next|none and cycle show; inbox cycle.commit; tracker.field_update cycle and tracker.cycles', async () => {
  const { home } = await makeHome();
  const cfg = await cyclesOn(home, { streams: { enabled: true }, tracker: { provider: 'linear', scope: { team_key: 'shp' } } });
  const cyc = await lib('cycles');
  const store = await lib('store');
  const streams = await lib('streams');
  const inbox = await lib('inbox');
  // tracker cycles arrive from the sync; key compare is case-insensitive, the team falls back to local without them
  cyc.refresh(home, cfg, T0);
  assert.equal(cyc.readState(home).teams.core.current.source, 'local');
  inbox.write(home, { type: 'tracker.cycles', payload: { teams: { SHP: { current: { tracker_id: 'cyc-a', number: 40, name: 'Sprint 40', starts_at: '2026-10-07T00:00:00Z', ends_at: '2026-10-21T00:00:00Z' }, next: { tracker_id: 'cyc-b', number: 41, name: null, starts_at: '2026-10-21T00:00:00Z', ends_at: '2026-11-04T00:00:00Z' } } } }, source: 'tracker', actor: { kind: 'tracker' }, auto_apply: true });
  await inbox.process(home, { tick: 1 });
  const st = cyc.readState(home);
  assert.deepEqual({ id: st.teams.core.current.id, src: st.teams.core.current.source, tid: st.teams.core.current.tracker_id }, { id: 'core-40', src: 'tracker', tid: 'cyc-a' });
  const { task } = streams.newItem(home, { team: 'core', class: 'bug', title: 'B' });
  let r = runCli(['cycle', 'commit', task.id, '--cycle', 'next'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `COMMITTED ${task.id} core-41`);
  assert.equal(runCli(['cycle', 'commit', task.id, '--cycle', 'core-x'], { home }).code, 1);
  r = runCli(['cycle', 'commit', task.id, '--cycle', 'none'], { home });
  assert.equal(store.get(home, 'task', task.id).cycle, null);
  inbox.write(home, { type: 'cycle.commit', payload: { task_id: task.id, cycle: 'current' }, source: 'dashboard' });
  await inbox.process(home, { tick: 2 });
  assert.equal(store.get(home, 'task', task.id).cycle, 'core-40');
  // a human moved the issue to the next cycle in the tracker; an unknown cycle maps to null
  // one request per process call: requests written in the same millisecond have no fixed order
  inbox.write(home, { type: 'tracker.field_update', payload: { task_id: task.id, field: 'cycle', value: 'cyc-b' }, source: 'tracker', actor: { kind: 'tracker' } });
  const res = await inbox.process(home, { tick: 3 });
  inbox.write(home, { type: 'tracker.field_update', payload: { task_id: task.id, field: 'cycle', value: 'cyc-zzz' }, source: 'tracker', actor: { kind: 'tracker' } });
  res.push(...await inbox.process(home, { tick: 3 }));
  assert.deepEqual(res.map((x) => x.reason), ['cycle core-41', 'cycle none']);
  store.update(home, 'task', task.id, (x) => { x.cycle = 'core-40'; });
  const show = runCli(['cycle', 'show'], { home });
  assert.match(show.stdout, /^core current core-40 "Sprint 40" 2026-10-07\.\.2026-10-21 \(\d+d left; tracker\): committed 1, done 0, open 1$/m);
  assert.match(show.stdout, /^core next core-41 starts 2026-10-21$/m);
  // a tracker item pulled while in the active cycle gets that cycle
  inbox.write(home, { type: 'tracker.backlog_item', payload: { remote_id: 'iss-7', key: 'SHP-7', url: 'u', team_key: 'SHP', class: 'bug', title: 'In cycle', body: '', author_id: null, priority: null, cycle_tracker_id: 'cyc-a' }, source: 'tracker', actor: { kind: 'tracker' } });
  await inbox.process(home, { tick: 4 });
  assert.equal(streams.items(home).find((t) => t.title === 'In cycle').cycle, 'core-40');
});

test('choose: with cycles on, stream work runs only in the current cycle (or P0); committed work sorts first', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const cfg = await cyclesOn(home, { streams: { enabled: true }, reports: { enabled: false }, concurrency: { planners: 5 } });
  const cyc = await lib('cycles');
  const streams = await lib('streams');
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  cyc.refresh(home, cfg); // real now: whatever cycle is current
  const cur = cyc.readState(home).teams.core.current.id;
  const mk = (title, cycle, priority = 'P2') => { const t = streams.newItem(home, { team: 'core', class: 'bug', title, priority }).task; store.update(home, 'task', t.id, (x) => { x.cycle = cycle; }); return t; };
  mk('later', 'core-999'); mk('none', null); mk('urgent', null, 'P0'); mk('now', cur);
  const r = dispatch.choose(home, { factory: { status: 'running' } });
  assert.deepEqual(r.chosen.map((c) => c.task.title), ['urgent', 'now']);
  assert.deepEqual(r.skipped.filter((s) => s.reason === 'not in the current cycle').length, 2);
  // goal work is never blocked by cycles, and in-cycle goal work sorts before other work of the same priority
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  const intake = store.list(home, 'task', (t) => t.kind === 'intake')[0];
  const res2 = a.createTask(home, { goal_id: g.id, kind: 'research', status: 'ready', title: 'R2' });
  store.update(home, 'task', res2.id, (x) => { x.cycle = cur; });
  const c = dispatch.candidates(home).filter((x) => x.goal.id === g.id).map((x) => x.task.id);
  assert.deepEqual(c, [res2.id, intake.id]);
});
