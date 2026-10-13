// CTO reports and self-improvement (contracts §21.7), schedule (§21.1.8), status and tick end (§21.10).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { makeHome, lib, runCli, fakeDelivery, simulateAgent, baseHandoff, writeReport, join, readFileSync, existsSync, writeFileSync } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

const proposal = (id, change, extra = {}) => ({ id, title: `Proposal ${id}`, why: 'metrics show 3 idle ticks', change, expected_effect: 'faster', risk: 'low', ...extra });

/** A started factory whose intake ran once; returns the libs. */
async function afterOneRun(home) {
  (await lib('deps')).setDelivery(fakeDelivery().d);
  (await lib('config')).merge(home, { project: { name: 'shop' }, baseline: { enabled: false } });
  const tick = await lib('tick');
  (await lib('control')).start(home, { session: 'S1' });
  (await lib('actions')).newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  await tick.begin(home, { session: 'S1', force: true });
  const p = await tick.plan(home, { session: 'S1' });
  for (const d of p.dispatches) await simulateAgent(home, d, async ({ run, task }) => baseHandoff(run, task));
  return tick;
}

test('periodic report: created after the first task ran, dispatched in the same tick as escalation with metrics.json; one open at most', async () => {
  const { home } = await makeHome();
  const tick = await afterOneRun(home);
  const store = await lib('store');
  await tick.begin(home, { session: 'S1', force: true });
  const p = await tick.plan(home, { session: 'S1' });
  const reports = store.list(home, 'task', (t) => t.kind === 'report');
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.equal(r.report_type, 'periodic');
  assert.equal(r.team, null);
  assert.match(r.output_rel, /^docs\/reports\/\d{4}-\d{2}-\d{2}-\d{4}-periodic\.md$/);
  const d = p.dispatches.find((x) => store.get(home, 'run', x.run_id).task_id === r.id);
  assert.ok(d, 'the report dispatches in the tick that created it');
  const run = store.get(home, 'run', d.run_id);
  assert.equal(run.kind, 'escalation');
  assert.ok(existsSync(join(home, 'runs', run.id, 'metrics.json')));
  const brief = (await lib('brief')).parseBrief(readFileSync(run.brief_path, 'utf8'));
  assert.equal(brief.metrics_path, `runs/${run.id}/metrics.json`);
  assert.equal(brief.report_type, 'periodic');
  assert.deepEqual(Object.keys(brief.report_period), ['from', 'to']);
  assert.equal(brief.last_report, null);
  assert.deepEqual(brief.output_paths, [r.output_rel]);
  assert.equal(brief.team.id, 'core');
  // a second plan while it is open makes no new report
  await tick.plan(home, { session: 'S1' });
  assert.equal(store.list(home, 'task', (t) => t.kind === 'report').length, 1);
});

test('collect of a report: factory.json reports.*, report.published, one improvement gate per proposal; bad proposals fail validation', async () => {
  const { home } = await makeHome();
  const tick = await afterOneRun(home);
  const store = await lib('store');
  await tick.begin(home, { session: 'S1', force: true });
  const p = await tick.plan(home, { session: 'S1' });
  const d = p.dispatches.find((x) => store.get(home, 'task', store.get(home, 'run', x.run_id).task_id).kind === 'report');
  // invalid proposals first: the handoff is rejected
  const bad = [proposal('P-1', { kind: 'config', patch: {} }), proposal('X', { kind: 'advice' }, { risk: 'huge' }), proposal('P-2', { kind: 'overlay_note', role: 'wizard', note: 'n' })];
  const { validateHandoff } = await lib('handoff');
  const run = store.get(home, 'run', d.run_id);
  const task = store.get(home, 'task', run.task_id);
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  writeFileSync(join(home, 'runs', run.id, 'handoff.json'), JSON.stringify(baseHandoff(run, task, { proposals: bad })));
  const v = validateHandoff(home, join(home, 'runs', run.id, 'handoff.json'), { run });
  assert.ok(v.errors.some((e) => /proposals\[0\]\.change\.patch/.test(e)));
  assert.ok(v.errors.some((e) => /proposals\[1\]\.id/.test(e)));
  assert.ok(v.errors.some((e) => /proposals\[1\]\.risk/.test(e)));
  assert.ok(v.errors.some((e) => /proposals\[2\]\.change\.role: unknown role wizard/.test(e)));
  const six = Array.from({ length: 6 }, (_, i) => proposal(`P-${i + 1}`, { kind: 'advice' }));
  writeFileSync(join(home, 'runs', run.id, 'handoff.json'), JSON.stringify(baseHandoff(run, task, { proposals: six })));
  assert.ok(validateHandoff(home, join(home, 'runs', run.id, 'handoff.json'), { run }).errors.some((e) => /at most 5/.test(e)));
  const good = [proposal('P-1', { kind: 'config', patch: { 'concurrency.builders': 4 } }), proposal('P-2', { kind: 'advice' })];
  await simulateAgent(home, d, async ({ run: r2, task: t2, home: h }) => { writeReport(h, t2.output_rel); return baseHandoff(r2, t2, { proposals: good }); });
  await tick.begin(home, { session: 'S1', force: true });
  const f = (await lib('state')).readFactory(home);
  assert.equal(f.reports.last_path, task.output_rel);
  assert.equal(f.reports.last_type, 'periodic');
  assert.equal(f.reports.last_task_id, task.id);
  assert.ok(f.reports.last_at);
  const gates = store.list(home, 'gate', (g) => g.type === 'improvement');
  assert.equal(gates.length, 2);
  assert.deepEqual({ subject: gates[0].subject, goal: gates[0].goal_id, paths: gates[0].artifact.paths, action: gates[0].request.action, pid: gates[0].request.proposal.id }, { subject: { kind: 'task', id: task.id }, goal: task.goal_id, paths: [task.output_rel], action: 'proposal', pid: 'P-1' });
  assert.equal(gates[0].artifact.summary, 'P-1 Proposal P-1: metrics show 3 idle ticks');
  const pub = (await lib('events')).tail(home, 100).find((e) => e.type === 'report.published');
  assert.deepEqual(pub.data, { path: task.output_rel, report_type: 'periodic', proposals: 2, team: null });
  // gate show --json prints the whole gate with the proposal
  const gs = JSON.parse(runCli(['gate', 'show', gates[0].id, '--json'], { home }).stdout);
  assert.deepEqual(gs.request.proposal.change, { kind: 'config', patch: { 'concurrency.builders': 4 } });
  // report list
  const rl = runCli(['report', 'list'], { home });
  assert.match(rl.stdout.split('\n')[0], new RegExp(`^last report: ${task.output_rel.replace(/\./g, '\\.')} \\(0h ago\\); last assess never$`));
  assert.match(rl.stdout, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}Z report ${task.output_rel.replace(/\./g, '\\.')}$`, 'm'));
});

test('improvement gates: allowed config keys apply; a disallowed or invalid patch leaves config unchanged; overlay notes append; advice is recorded', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  const flow = await lib('flow');
  const config = await lib('config');
  const ops = await lib('ops');
  const og = ops.ensureOps(home);
  const mk = (p) => store.create(home, 'gate', { type: 'improvement', subject: { kind: 'task', id: 'T-0001' }, goal_id: og.id, status: 'pending', opened_at: new Date().toISOString(), artifact: { paths: ['docs/reports/r.md'], summary: 's' }, request: { action: 'proposal', proposal: p } });
  const g1 = mk(proposal('P-1', { kind: 'config', patch: { 'concurrency.builders': 4, 'reports.every_h': 12 } }));
  await flow.decideGate(home, g1.id, { decision: 'approve', by: 'human' });
  let cfg = config.load(home);
  assert.equal(cfg.concurrency.builders, 4);
  assert.equal(cfg.reports.every_h, 12);
  const before = JSON.stringify(config.readRaw(home));
  const g2 = mk(proposal('P-2', { kind: 'config', patch: { 'concurrency.builders': 6, 'gates.G1.enabled': false } }));
  await flow.decideGate(home, g2.id, { decision: 'approve', by: 'human' });
  assert.equal(JSON.stringify(config.readRaw(home)), before, 'one bad key rejects the whole patch');
  assert.match(store.get(home, 'gate', g2.id).decision.notes, /not applied: gates\.G1\.enabled not in the allowed config keys/);
  const g3 = mk(proposal('P-3', { kind: 'config', patch: { 'concurrency.builders': 'many' } }));
  await flow.decideGate(home, g3.id, { decision: 'approve', by: 'human' });
  assert.equal(JSON.stringify(config.readRaw(home)), before, 'an invalid value is rolled back');
  assert.match(store.get(home, 'gate', g3.id).decision.notes, /not applied: config invalid/);
  writeFileSync(join(home, 'roles', 'qa-engineer.md'), '# QA overlay\n\nRun the e2e suite.\n\n## Local notes\n\n- 2026-10-01 old note\n\n## Other\n\nkeep\n');
  const g4 = mk(proposal('P-4', { kind: 'overlay_note', role: 'qa-engineer', note: 'Start the app before QA' }));
  await flow.decideGate(home, g4.id, { decision: 'approve', by: 'human' });
  const ov = readFileSync(join(home, 'roles', 'qa-engineer.md'), 'utf8');
  assert.match(ov, /- 2026-10-01 old note\n- \d{4}-\d{2}-\d{2} Start the app before QA \(from docs\/reports\/r\.md\)\n\n## Other\n\nkeep\n$/);
  const g5 = mk(proposal('P-5', { kind: 'overlay_note', role: 'critic', note: 'Quote the text' }));
  await flow.decideGate(home, g5.id, { decision: 'approve', by: 'human' });
  assert.match(readFileSync(join(home, 'roles', 'critic.md'), 'utf8'), /## Local notes\n\n- \d{4}-\d{2}-\d{2} Quote the text \(from docs\/reports\/r\.md\)\n$/);
  const g6 = mk(proposal('P-6', { kind: 'advice' }));
  await flow.decideGate(home, g6.id, { decision: 'approve', by: 'human' });
  const g7 = mk(proposal('P-7', { kind: 'config', patch: { 'concurrency.builders': 2 } }));
  await flow.decideGate(home, g7.id, { decision: 'reject', by: 'human' });
  assert.equal(config.load(home).concurrency.builders, 4);
  const ev = (await lib('events')).tail(home, 200).filter((e) => e.type === 'improvement.decided').map((e) => `${e.data.proposal_id} ${e.data.decision} ${e.data.applied}`);
  assert.deepEqual(ev, ['P-1 approve true', 'P-2 approve false', 'P-3 approve false', 'P-4 approve true', 'P-5 approve true', 'P-6 approve false', 'P-7 reject false']);
  assert.equal(ops.keyAllowed('budget.estimates.code_M'), true);
  assert.equal(ops.keyAllowed('budget.warn_pct'), true);
  assert.equal(ops.keyAllowed('budget.warn_pct_x'), false);
  assert.equal(ops.keyAllowed('budget.tier_defaults.M'), false);
  assert.equal(ops.keyAllowed('models.all'), true);
  assert.equal(ops.keyAllowed('reports'), false);
});

test('report request, idle reports, schedule: NONE when nothing happened since the last report, else wake for the next one', async () => {
  const { home } = await makeHome();
  (await lib('config')).merge(home, { baseline: { enabled: false } });
  const ops = await lib('ops');
  const store = await lib('store');
  const st = await lib('state');
  const tick = await lib('tick');
  const cfg = (await lib('config')).load(home);
  (await lib('control')).start(home, { session: 'S1' });
  // no run yet: no report can come due -> NONE
  assert.equal(ops.nextReportDueS(home, cfg), null);
  assert.equal((await tick.end(home, { session: 'S1', loop: true })).lines.at(-1), 'NONE');
  // a report was published just now and nothing happened since -> NONE
  const last = new Date().toISOString();
  st.updateFactory(home, (f) => { f.reports.last_at = last; });
  assert.equal(ops.nextReportDueS(home, cfg), null);
  assert.equal((await tick.end(home, { session: 'S1', loop: true })).lines.at(-1), 'NONE');
  // something happened: wake when the next periodic report is due, capped at the largest waiting_s
  (await lib('events')).emit(home, { type: 'task.status', msg: 'x' });
  assert.ok(ops.nextReportDueS(home, cfg) > 80000);
  assert.equal((await tick.end(home, { session: 'S1', loop: true })).lines.at(-1), 'SCHEDULE 3600');
  // report request (CLI) -> the next plan creates a requested report
  assert.equal(runCli(['report', 'request'], { home }).stdout.trim(), 'REQUESTED a CTO report; the next tick creates it');
  assert.equal(ops.nextReportDueS(home, cfg), 0);
  const made = ops.planReports(home, cfg);
  assert.deepEqual(made.map((t) => t.report_type), ['requested']);
  assert.equal(st.readFactory(home).reports.requested_at, null);
  store.update(home, 'task', made[0].id, (x) => { x.status = 'done'; });
  // idle: last report 5h ago, >= 10 non-tick events since, nothing chosen and no cto task open
  const t5 = Date.now();
  st.updateFactory(home, (f) => { f.reports.last_at = new Date(t5 - 5 * 3600000).toISOString(); f.reports.last_attempt_at = f.reports.last_at; });
  assert.deepEqual(ops.planReports(home, cfg, { chosen: 0, now: t5 }), [], 'only one non-tick event so far');
  for (let i = 0; i < 10; i++) (await lib('events')).emit(home, { type: i % 2 ? 'tick.started' : 'task.created', msg: 'e' });
  for (let i = 0; i < 5; i++) (await lib('events')).emit(home, { type: 'task.created', msg: 'e' });
  assert.deepEqual(ops.planReports(home, cfg, { chosen: 1, now: t5 }), [], 'not idle when something was chosen');
  const idle = ops.planReports(home, cfg, { chosen: 0, now: t5 });
  assert.deepEqual(idle.map((t) => t.report_type), ['idle']);
  // reports off: never due
  (await lib('config')).set(home, 'reports.enabled', false);
  assert.equal(ops.nextReportDueS(home, (await lib('config')).load(home)), null);
});

test('report data: metrics json and text (<= 40 lines), --team filter, --out file', async () => {
  const { home, root } = await makeHome();
  const tick = await afterOneRun(home);
  void tick;
  const r = runCli(['report', 'data'], { home });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length <= 40);
  assert.match(lines[0], /^METRICS \S+ \.\. \S+$/);
  assert.ok(lines.some((l) => /^ticks 1, idle 0$/.test(l)), lines.join('\n'));
  const j = JSON.parse(runCli(['report', 'data', '--json', '--team', 'core'], { home }).stdout);
  for (const k of ['period', 'goals', 'teams', 'code_cycle_hours', 'first_pass_review_rate', 'rework_count', 'fixup_runs', 'failed_tasks', 'escalations', 'blocked', 'gates_pending', 'prs', 'tokens', 'estimate_vs_actual', 'budget_pct', 'ticks']) assert.ok(k in j, k);
  assert.equal(j.team, 'core');
  assert.equal(j.teams.core.tasks_created >= 1, true);
  assert.equal(runCli(['report', 'data', '--team', 'ghost'], { home }).code, 1);
  const outFile = join(root, 'm.json');
  const w = runCli(['report', 'data', '--out', outFile], { home });
  assert.match(w.stdout, /^WROTE /m);
  assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).v, 1);
});

test('status and tick end: goal rows only for kind goal, one streams line, one ops line, teams line with cycles; caps hold', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  (await lib('config')).merge(home, { project: { name: 'shop' }, baseline: { enabled: false }, streams: { enabled: true }, cycles: { enabled: true } });
  const a = await lib('actions');
  const streams = await lib('streams');
  const ops = await lib('ops');
  (await lib('control')).start(home, { session: 'S1' });
  for (let i = 0; i < 7; i++) a.newGoal(home, { title: `Goal ${i}`, outcome: 'o', success_criteria: ['c'] });
  streams.newItem(home, { team: 'core', class: 'bug', title: 'B' });
  ops.createReport(home, (await lib('config')).load(home), { type: 'requested' });
  await (await lib('cycles')).roll(home, (await lib('config')).load(home));
  const s = runCli(['status'], { home }).stdout.trim().split('\n');
  assert.ok(s.length <= 20, s.join('\n'));
  assert.match(s[1], /^teams: core \d+ \(\d+d left\)$/);
  assert.ok(s.includes('streams: core 1 open, 0 building'));
  assert.ok(s.some((l) => /^ops: last report never; last assess never$/.test(l)));
  assert.ok(!s.some((l) => /maintenance|Factory operations/.test(l)), 'standing goals have no goal rows');
  const e = await (await lib('tick')).end(home, { session: 'S1', loop: true });
  assert.ok(e.lines.length <= 12);
  assert.match(e.lines[1], /^G-001 planning Goal 0/);
  assert.ok(e.lines.includes('streams: core 1 open, 0 building'));
  assert.ok(e.lines.some((l) => /^ops: \d+ open \(.*report.*\); last report never$/.test(l)), e.lines.join('\n'));
  assert.ok(e.lines.findIndex((l) => l.startsWith('streams:')) > e.lines.findIndex((l) => l.startsWith('G-005')));
});
