// Baseline (contracts §21.5): collect, show, gh.prList, wip_conflicts, assess, briefs, broker access.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync as wf } from 'node:fs';
import { makeHome, lib, runCli, fakeDelivery, git, join, readFileSync, existsSync, P, CLI } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); delete process.env.FACTORY_GH; });

test('baseline collect on a real repo: branches ahead of base, factory branches, no remote -> pr_error; files <= 80 lines', async () => {
  const { home, repo } = await makeHome();
  (await lib('config')).merge(home, { project: { name: 'shop' } });
  git(repo, 'switch', '-q', '-c', 'feature-x');
  wf(join(repo, 'src', 'c.js'), 'export const c = 1;\n');
  git(repo, 'add', 'src'); git(repo, 'commit', '-q', '-m', 'wip');
  git(repo, 'switch', '-q', 'main');
  git(repo, 'branch', 'factory/T-0009-old');
  const r = runCli(['baseline', 'collect'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^BASELINE 1 repos; 0 open human PRs$/m);
  const b = JSON.parse(readFileSync(join(home, 'state', 'baseline.json'), 'utf8'));
  const s = b.repos.shop;
  assert.equal(s.team, 'core');
  assert.equal(s.base_branch, 'main');
  assert.equal(s.head_sha, git(repo, 'rev-parse', 'main'));
  assert.equal(s.recent_commits_7d, 1);
  assert.deepEqual(s.branches.map((x) => [x.name, x.ahead, x.behind]), [['feature-x', 1, 0]]);
  assert.equal(s.factory_branches, 1);
  assert.deepEqual(s.open_prs, []);
  assert.equal(s.pr_error, 'no remote origin');
  for (const rel of ['docs/baseline/factory.md', 'docs/baseline/teams/core.md']) {
    const txt = readFileSync(join(home, rel), 'utf8');
    assert.ok(txt.split('\n').length <= 81, `${rel} <= 80 lines`);
  }
  assert.match(readFileSync(join(home, 'docs/baseline/teams/core.md'), 'utf8'), /branch "feature-x": 1 ahead, 0 behind/);
  const st = (await lib('state')).readFactory(home);
  assert.equal(st.baseline.last_collect_at, b.at);
  const show = runCli(['baseline', 'show'], { home });
  assert.equal(show.stdout.split('\n')[0], 'BASELINE docs/baseline/factory.md');
  assert.match(runCli(['baseline', 'show', '--team', 'core'], { home }).stdout, /^BASELINE docs\/baseline\/teams\/core\.md$/m);
  assert.ok((await lib('events')).tail(home, 10).some((e) => e.type === 'baseline.collected'));
  // local delivery mode never calls gh
  (await lib('config')).set(home, 'delivery.mode', 'local');
  assert.equal((await (await lib('baseline')).collect(home)).repos.shop.pr_error, 'local delivery mode');
});

test('gh.prList runs gh pr list with the contract fields and maps author logins and file paths', async () => {
  const logFile = join((await makeHome()).root, 'gh.log');
  process.env.FACTORY_GH = join(P, 'test', 'fixtures', 'delivery', 'fake-gh.mjs');
  process.env.FAKE_GH_LOG = logFile;
  const gh = await lib('gh');
  const l = gh.prList({ cwd: process.cwd(), limit: 30 });
  assert.deepEqual(l, [{ number: 12, title: 'Fix login', url: 'https://github.com/o/r/pull/12', headRefName: 'fix-login', author: 'dana', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', updatedAt: '2026-10-12T09:00:00Z', files: ['src/login.js'] }]);
  assert.deepEqual(JSON.parse(readFileSync(logFile, 'utf8').trim()), ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,url,headRefName,author,isDraft,reviewDecision,updatedAt,files']);
  process.env.FAKE_GH_MODE = 'fail';
  assert.throws(() => gh.prList({ cwd: process.cwd() }), /gh pr list failed/);
  delete process.env.FAKE_GH_MODE; delete process.env.FAKE_GH_LOG;
});

test('open human PRs land in the baseline; a code brief lists wip_conflicts that touch its files_owned, plus team and team_baseline', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  fake.state.remoteUrl = 'https://github.com/o/r.git';
  fake.state.prs = [
    { number: 31, title: 'Human refactor', url: 'https://github.com/o/r/pull/31', headRefName: 'dana/refactor', author: 'dana', isDraft: true, reviewDecision: null, updatedAt: '2026-10-12T00:00:00Z', files: ['src/a.js', 'README.md'] },
    { number: 32, title: 'Other area', url: 'https://github.com/o/r/pull/32', headRefName: 'lee/docs', author: 'lee', isDraft: false, reviewDecision: null, updatedAt: '2026-10-12T00:00:00Z', files: ['docs/x.md'] },
    { number: 33, title: 'Factory PR', url: 'https://github.com/o/r/pull/33', headRefName: 'factory/E-0002-x', author: 'bot', isDraft: false, reviewDecision: null, updatedAt: '2026-10-12T00:00:00Z', files: ['src/a.js'] },
  ];
  (await lib('deps')).setDelivery(fake.d);
  (await lib('config')).merge(home, { project: { name: 'shop' } });
  const b = await (await lib('baseline')).collect(home);
  assert.deepEqual(b.repos.shop.open_prs.map((p) => [p.number, p.factory, p.draft, p.author]), [[31, false, true, 'dana'], [32, false, false, 'lee'], [33, true, false, 'bot']]);
  const a = await lib('actions');
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  const { parseBrief } = await lib('brief');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'Touch a', acceptance_criteria: ['x'], files_owned: ['src/**'] });
  const line = await dispatch.dispatch(home, dispatch.candidates(home).find((c) => c.task.id === t.id), { session: 'S1' });
  const text = readFileSync(join(home, 'runs', line.run_id, 'brief.md'), 'utf8');
  const brief = parseBrief(text);
  assert.deepEqual(brief.wip_conflicts, [{ pr: 31, url: 'https://github.com/o/r/pull/31', title: '"Human refactor"', files: ['src/a.js'] }]);
  assert.deepEqual(brief.team, { id: 'core', name: 'shop', tracker_key: null });
  assert.equal(brief.team_baseline, 'docs/baseline/teams/core.md');
  assert.match(text, /## Work in flight on your files/);
  assert.match(text, /- PR #31 "Human refactor"/);
});

test('tick begin collects the baseline once per collect_every_s; start collects and requests an assessment; the assess brief gets a frozen baseline', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  (await lib('config')).merge(home, { project: { name: 'shop' }, reports: { enabled: false } });
  const tick = await lib('tick');
  const store = await lib('store');
  const st = await lib('state');
  const s = runCli(['start', '--session', 'S1'], { home });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /^baseline collected \(1 repos\); assessment requested$/m);
  assert.equal(s.stdout.trim().split('\n').at(-1), 'NEXT invoke the loop skill with /software-factory:tick');
  assert.equal(st.readFactory(home).baseline.assess_requested, true);
  const at1 = st.readFactory(home).baseline.last_collect_at;
  const b1 = await tick.begin(home, { session: 'S1', force: true });
  assert.ok(b1.lines.length <= 8);
  assert.equal(st.readFactory(home).baseline.last_collect_at, at1, 'collected less than collect_every_s ago: no new collect');
  const p = await tick.plan(home, { session: 'S1' });
  const assess = store.list(home, 'task', (t) => t.kind === 'assess');
  assert.equal(assess.length, 1);
  assert.equal(st.readFactory(home).baseline.assess_requested, false, 'creating the assess clears the request');
  const ops = store.get(home, 'goal', assess[0].goal_id);
  assert.deepEqual({ kind: ops.kind, title: ops.title, status: ops.status }, { kind: 'ops', title: 'Factory operations', status: 'active' });
  const d = p.dispatches.find((x) => store.get(home, 'run', x.run_id).task_id === assess[0].id);
  assert.ok(d, 'assess dispatched in the same tick');
  assert.equal(d.subagent_type, 'software-factory:cto');
  const run = store.get(home, 'run', d.run_id);
  assert.equal(run.kind, 'escalation');
  const brief = (await lib('brief')).parseBrief(readFileSync(run.brief_path, 'utf8'));
  assert.equal(brief.baseline_path, `runs/${run.id}/baseline.json`);
  assert.ok(existsSync(join(home, brief.baseline_path)));
  assert.deepEqual(brief.team_baselines, ['docs/baseline/teams/core.md']);
  assert.deepEqual(brief.output_paths, [assess[0].output_rel]);
  assert.match(assess[0].output_rel, /^docs\/baseline\/assessment-\d{4}-\d{2}-\d{2}\.md$/);
  // intake briefs get the live baseline
  const intakeRun = store.list(home, 'run', (r) => r.role === 'cto' && store.get(home, 'task', r.task_id).kind === 'intake')[0];
  if (intakeRun) assert.equal((await lib('brief')).parseBrief(readFileSync(intakeRun.brief_path, 'utf8')).baseline_path, 'state/baseline.json');
  // one open assess at most, even when another is requested
  st.updateFactory(home, (f) => { f.baseline.assess_requested = true; });
  await tick.plan(home, { session: 'S1' });
  assert.equal(store.list(home, 'task', (t) => t.kind === 'assess').length, 1);
  // a stale collect is redone by tick begin
  st.updateFactory(home, (f) => { f.baseline.last_collect_at = '2026-01-01T00:00:00.000Z'; });
  const b2 = await tick.begin(home, { session: 'S1', force: true });
  assert.ok(b2.lines.some((l) => /^baseline: 1 repos$/.test(l)), b2.lines.join('|'));
  assert.ok(b2.lines.length <= 8);
});

test('broker: every role may read baseline, cycles, items and reports; cto and staff-engineer may add items; report data --out is denied', async () => {
  const { decide } = await lib('broker');
  const { home } = await makeHome();
  const ctx = (role) => ({ home, cliPath: CLI, role, run: { id: 'R-000001', kind: 'author' }, task: null, cwd: home, config: {} });
  const call = (role, rest) => decide({ tool_name: 'Bash', tool_input: { command: `node "${CLI}" ${rest}` }, agent_type: `software-factory:${role}` }, ctx(role)).decision;
  for (const role of ['backend-engineer', 'qa-engineer', 'critic', 'cto']) {
    for (const rest of ['baseline show', 'cycle show --team core', 'item list', 'item show T-0001', 'report data --json', 'report list']) assert.equal(call(role, rest), 'allow', `${role} ${rest}`);
  }
  assert.equal(call('cto', 'item new --team core --class bug --title x'), 'allow');
  assert.equal(call('staff-engineer', 'item new --team core --class bug --title x'), 'allow');
  assert.equal(call('backend-engineer', 'item new --team core --class bug --title x'), 'deny');
  assert.equal(call('cto', 'cycle commit T-0001 --cycle next'), 'allow');
  assert.equal(call('staff-engineer', 'cycle commit T-0001 --cycle next'), 'deny');
  assert.equal(call('cto', 'goal set G-001 --teams a,b --lead-team a'), 'allow');
  assert.equal(call('cto', 'report data --out x.json'), 'deny');
  assert.equal(call('cto', 'baseline collect'), 'deny');
  assert.equal(call('cto', 'report request'), 'deny');
});
