// Workspace mode (contracts §20): one factory home in a plain folder drives several git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lib, runCli, git, baseHandoff, writeReport } from '../core/_helpers.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/');

function makeRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

/** A plain folder with two repos (api, web), `init --workspace --repos api,web`, delivery local. */
async function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'sw-'));
  makeRepo(join(ws, 'api'), { 'src/api.js': 'export const api = 1;\n', 'api-check.mjs': 'process.exit(0);\n' });
  makeRepo(join(ws, 'web'), { 'src/web.js': 'export const web = 1;\n', 'web-check.mjs': 'process.exit(0);\n' });
  const r = runCli(['init', '--workspace', '--repos', 'api,web'], { cwd: ws, env: { FACTORY_HOME: '' } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const home = join(ws, '.factory');
  process.env.FACTORY_HOME = home;
  process.env.FACTORY_NO_NOTIFY = '1';
  const cfg = await lib('config');
  cfg.merge(home, {
    delivery: { mode: 'local' },
    repos: {
      api: { stack: ['node'], commands: { test: 'node api-check.mjs' } },
      web: { stack: ['node'], commands: { test: 'node web-check.mjs', run: 'node src/web.js' } },
    },
  });
  return { ws, home, api: join(ws, 'api'), web: join(ws, 'web') };
}

async function activeGoal(home, criteria = ['Joined flow works']) {
  const a = await lib('actions');
  const store = await lib('store');
  const g = a.newGoal(home, { title: 'Cross repo', outcome: 'API and UI together', success_criteria: criteria });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; x.tier = 'M'; });
  return store.get(home, 'goal', g.id);
}

test('init --workspace: plain folder only; without --repos it waits for setup; with --repos it turns workspace mode on', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sw-'));
  makeRepo(join(ws, 'api'), { 'a.txt': 'a\n' });
  const env = { FACTORY_HOME: '' };
  // inside a git repo: refused
  const inRepo = runCli(['init', '--workspace'], { cwd: join(ws, 'api'), env });
  assert.equal(inRepo.code, 2, inRepo.stdout + inRepo.stderr);
  // plain folder without --workspace keeps the old error
  const plain = runCli(['init'], { cwd: ws, env });
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /not inside a git repository/);
  const r = runCli(['init', '--workspace'], { cwd: ws, env });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /workspace: no repos yet/);
  const home = join(ws, '.factory');
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(raw.workspace.enabled, false);
  // unknown repo folder: refused; a real one: registered, default repo set, branch detected
  assert.equal(runCli(['init', '--workspace', '--repos', 'nope'], { cwd: ws, env }).code, 1);
  const r2 = runCli(['init', '--workspace', '--repos', 'api'], { cwd: ws, env });
  assert.equal(r2.code, 0, r2.stderr);
  const raw2 = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(raw2.workspace, { enabled: true, default_repo: 'api' });
  assert.deepEqual(raw2.repos.api, { path: 'api', default_branch: 'main' });
  // status works from the workspace root and from inside a repo (no FACTORY_HOME)
  assert.equal(runCli(['status'], { cwd: ws, env }).code, 0);
  assert.equal(runCli(['status'], { cwd: join(ws, 'api'), env }).code, 0);
});

test('home lookup: workspace root, a repo inside it and a CLI worktree under .factory/worktrees all find the workspace home', async () => {
  const { ws, home, web } = await makeWorkspace();
  const paths = await lib('paths');
  const saved = process.env.FACTORY_HOME;
  delete process.env.FACTORY_HOME;
  try {
    assert.equal(fwd(paths.findHome(ws)), fwd(home));
    assert.equal(fwd(paths.existingHome(ws)), fwd(home));
    assert.equal(fwd(paths.findHome(web)), fwd(home));
    const wt = join(home, 'worktrees', 'R-000099');
    git(web, 'worktree', 'add', '-q', '--detach', wt, 'main');
    assert.equal(fwd(paths.findHome(wt)), fwd(home));
    assert.equal(fwd(paths.existingHome(join(wt, 'src'))), fwd(home));
    git(web, 'worktree', 'remove', '--force', wt);
  } finally { process.env.FACTORY_HOME = saved; }
});

test('epic new --repo: required in workspace mode, branch made in that repo only; task repo follows the epic', async () => {
  const { home, api, web } = await makeWorkspace();
  const g = await activeGoal(home);
  assert.equal(runCli(['epic', 'new', '--goal', g.id, '--title', 'UI'], { home }).code, 2);
  assert.equal(runCli(['epic', 'new', '--goal', g.id, '--title', 'UI', '--repo', 'nope'], { home }).code, 1);
  const r = runCli(['epic', 'new', '--goal', g.id, '--title', 'UI screen', '--repo', 'web', '--json'], { home });
  assert.equal(r.code, 0, r.stderr);
  const e = JSON.parse(r.stdout);
  assert.equal(e.repo, 'web');
  assert.equal(e.base_branch, 'main');
  assert.match(runCli(['epic', 'list'], { home }).stdout, /E-0001 draft web factory\/E-0001-ui-screen/);
  const flow = await lib('flow');
  assert.ok(await flow.ensureEpicBranch(home, e));
  assert.ok(git(web, 'branch', '--list', e.branch).includes(e.branch));
  assert.equal(git(api, 'branch', '--list', e.branch), '');
  const a = await lib('actions');
  const [t] = a.newTasks(home, [{ epic_id: e.id, kind: 'code', role: 'frontend-engineer', title: 'Screen', size: 'S', acceptance_criteria: ['shows'], files_owned: ['src/web.js'] }]);
  assert.equal(t.repo, 'web');
  assert.throws(() => a.newTasks(home, [{ epic_id: e.id, repo: 'api', kind: 'code', role: 'backend-engineer', title: 'X', size: 'S', acceptance_criteria: ['x'] }]), /does not match epic/);
  // the same file name in another repo is not an overlap
  const api1 = a.newEpic(home, { goal_id: g.id, title: 'API', repo: 'api' });
  const [t2] = a.newTasks(home, [{ epic_id: api1.id, kind: 'code', role: 'backend-engineer', title: 'Endpoint', size: 'S', acceptance_criteria: ['serves'], files_owned: ['src/web.js'] }]);
  assert.equal(t2.repo, 'api');
});

test('code task in a workspace: dispatch sets run repo and worktree, prepare makes it in that repo (twice is safe), checks use that repo, integrate merges there', async () => {
  const { home, api, web } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const dispatch = await lib('dispatch');
  const { parseBrief } = await lib('brief');
  const g = await activeGoal(home);
  const e = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'web' });
  assert.ok(await flow.ensureEpicBranch(home, e));
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'frontend-engineer', size: 'S', status: 'ready', title: 'Screen', acceptance_criteria: ['shows'], files_owned: ['src/web.js'] });
  assert.equal(t.repo, 'web');
  const line = await dispatch.dispatch(home, { task: t, goal: g, kind: 'author', role: 'frontend-engineer', review_role: null }, { session: 'S1' });
  const run = store.get(home, 'run', line.run_id);
  const wt = fwd(join(home, 'worktrees', run.id));
  assert.equal(run.repo, 'web');
  assert.equal(run.worktree_path, wt);
  // brief
  const brief = parseBrief(readFileSync(run.brief_path, 'utf8'));
  assert.equal(brief.workspace, true);
  assert.deepEqual(brief.repos.map((r) => r.name), ['api', 'web']);
  assert.deepEqual(brief.repo, { name: 'web', path: fwd(web), base_branch: 'main' });
  assert.equal(brief.worktree, wt);
  assert.equal(brief.cd_prefix, `cd "${wt}" && `);
  assert.equal(brief.commands.test, 'node web-check.mjs');
  assert.equal(brief.handoff_path, `${wt}/.factory-out/handoff.json`);
  assert.equal(brief.outbox, `${wt}/.factory-out/`);
  assert.ok(brief.setup.endsWith(`worktree prepare --run ${run.id} --home "${fwd(home)}"`));
  assert.ok(brief.validate.endsWith(`handoff validate --run ${run.id} --home "${fwd(home)}"`));
  assert.ok(brief.evidence_cmd.includes(`--home "${fwd(home)}"`));
  // prepare from the workspace root, twice
  for (let i = 0; i < 2; i++) {
    const r = runCli(['worktree', 'prepare', '--run', run.id], { home, cwd: join(home, '..') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^PREPARED ${wt} ${t.id ? 'factory/T-' : ''}`));
  }
  assert.ok(git(web, 'worktree', 'list').replace(/\\/g, '/').includes(wt));
  assert.ok(!git(api, 'worktree', 'list').replace(/\\/g, '/').includes(wt));
  const task = store.get(home, 'task', t.id);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), task.branch);
  assert.match(readFileSync(join(web, '.git', 'info', 'exclude'), 'utf8'), /^\.factory-out\/$/m);
  // the agent commits in its worktree
  writeFileSync(join(wt, 'src', 'web.js'), 'export const web = 2;\n');
  git(wt, 'commit', '-q', '-am', 'screen');
  const sha = git(wt, 'rev-parse', 'HEAD');
  store.update(home, 'run', run.id, (x) => { x.head_sha = sha; });
  // check runner: the web repo's pre_review checks, in a detached worktree of web
  const ck = runCli(['checks', 'run', '--run', run.id], { home });
  assert.equal(ck.code, 0, ck.stdout + ck.stderr);
  assert.match(ck.stdout, /^CHECKS pass/);
  const ev = readFileSync(join(home, 'runs', run.id, 'evidence', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((x) => [x.command, x.exit_code, x.source]), [['node web-check.mjs', 0, 'cli']]);
  // integrate: merges in web, not api
  store.update(home, 'task', t.id, (x) => { x.status = 'verified'; x.head_sha = sha; });
  const res = await flow.integrateEpic(home, e.id);
  assert.deepEqual(res.merged, [task.branch]);
  assert.equal(git(web, 'merge-base', '--is-ancestor', sha, e.branch), '');
  assert.equal(store.get(home, 'task', t.id).status, 'integrated');
  assert.equal(git(api, 'branch', '--list', e.branch), '');
  // collect-time removal takes the worktree out of web
  const rm = await (await lib('collect')).removeRunWorktree(home, store.get(home, 'run', run.id));
  assert.equal(rm.removed, true);
  assert.ok(!git(web, 'worktree', 'list').replace(/\\/g, '/').includes(wt));
});

/** Put an epic at "docs integrated": code and docs tasks integrated, branch with one commit. */
async function epicReady(home, repoDir, epic) {
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  await flow.ensureEpicBranch(home, epic);
  git(repoDir, 'checkout', '-q', epic.branch);
  writeFileSync(join(repoDir, `${epic.id}.txt`), `${epic.id}\n`);
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-q', '-m', epic.id);
  git(repoDir, 'checkout', '-q', 'main');
  a.createTask(home, { goal_id: epic.goal_id, epic_id: epic.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'integrated', title: `Code ${epic.id}`, acceptance_criteria: ['x'] });
  a.createTask(home, { goal_id: epic.goal_id, epic_id: epic.id, kind: 'docs', size: 'S', status: 'integrated', title: `Docs ${epic.id}`, acceptance_criteria: ['x'] });
  store.update(home, 'epic', epic.id, (x) => { x.status = 'docs'; });
}

test('cross-repo QA: qa_goal only when epics span 2 repos and all reach goal_qa; prepare makes one worktree per epic; pass opens a PR per epic', async () => {
  const { home, api, web } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const dispatch = await lib('dispatch');
  const collect = await lib('collect');
  const { parseBrief } = await lib('brief');
  const g = await activeGoal(home, ['Order shows in UI', 'API returns order']);
  const eApi = a.newEpic(home, { goal_id: g.id, title: 'Orders API', repo: 'api' });
  const eWeb = a.newEpic(home, { goal_id: g.id, title: 'Orders UI', repo: 'web' });
  assert.equal(flow.goalSpansRepos(home, g.id), true);
  await epicReady(home, api, eApi);
  store.update(home, 'epic', eWeb.id, (x) => { x.status = 'building'; });
  await flow.ensureEpicBranch(home, eWeb);
  a.createTask(home, { goal_id: g.id, epic_id: eWeb.id, kind: 'code', role: 'frontend-engineer', size: 'S', status: 'backlog', title: 'UI', acceptance_criteria: ['x'] });
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eApi.id).status, 'goal_qa');
  assert.equal(store.get(home, 'epic', eApi.id).pr, null, 'no PR before cross-repo QA');
  assert.equal(store.list(home, 'task', (t) => t.kind === 'qa_goal').length, 0);
  // web catches up
  for (const t of store.list(home, 'task', (x) => x.epic_id === eWeb.id)) store.update(home, 'task', t.id, (x) => { x.status = 'integrated'; });
  await epicReady(home, web, store.get(home, 'epic', eWeb.id));
  await flow.advanceGoal(home, g.id);
  await flow.advanceGoal(home, g.id);
  const qas = store.list(home, 'task', (t) => t.kind === 'qa_goal');
  assert.equal(qas.length, 1);
  const qa = qas[0];
  assert.equal(qa.role, 'qa-engineer');
  assert.equal(qa.epic_id, null);
  assert.equal(qa.repo, null);
  assert.equal(qa.title, `Cross-repo QA for ${g.id}`);
  assert.deepEqual(qa.acceptance_criteria.map((x) => x.id), ['AC-1', 'AC-2']);
  assert.equal(qa.estimate_tokens, 400000);
  // dispatch: reviewers slot, parent folder, planned repo worktrees
  const cand = dispatch.candidates(home).find((c) => c.task.id === qa.id);
  assert.equal(cand.kind, 'qa');
  const line = await dispatch.dispatch(home, cand, { session: 'S1' });
  let run = store.get(home, 'run', line.run_id);
  const parent = fwd(join(home, 'worktrees', run.id));
  assert.equal(run.worktree_path, parent);
  assert.equal(run.repo, null);
  assert.deepEqual(run.repo_worktrees.map((x) => [x.repo, x.epic_id, x.path]), [['api', eApi.id, `${parent}/api`], ['web', eWeb.id, `${parent}/web`]]);
  const brief = parseBrief(readFileSync(run.brief_path, 'utf8'));
  assert.equal(brief.repo_worktrees.length, 2);
  assert.equal(brief.commands_by_repo.web.test, 'node web-check.mjs');
  assert.equal(brief.commands_by_repo.api.test, 'node api-check.mjs');
  assert.deepEqual(brief.output_paths, [`docs/${g.id}-${g.slug}/qa/${g.id}-goal.md`]);
  assert.equal(brief.handoff_path, `${parent}/.factory-out/handoff.json`);
  // prepare: one detached worktree per epic, in the right repo, at the epic head; twice is safe
  for (let i = 0; i < 2; i++) {
    const r = runCli(['worktree', 'prepare', '--run', run.id], { home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^PREPARED ${parent} detached 2 repos`));
  }
  run = store.get(home, 'run', run.id);
  assert.equal(git(`${parent}/api`, 'rev-parse', 'HEAD'), git(api, 'rev-parse', eApi.branch));
  assert.equal(git(`${parent}/web`, 'rev-parse', 'HEAD'), git(web, 'rev-parse', eWeb.branch));
  assert.ok(existsSync(`${parent}/web/${eWeb.id}.txt`));
  assert.ok(run.repo_worktrees.every((x) => /^[0-9a-f]{40}$/.test(x.head_sha)));
  // the QA agent writes its report and handoff to the outbox, then finishes
  const rel = brief.output_paths[0];
  mkdirSync(join(parent, '.factory-out', rel, '..'), { recursive: true });
  writeFileSync(join(parent, '.factory-out', rel), '# goal QA\n');
  const task = store.get(home, 'task', qa.id);
  writeFileSync(join(parent, '.factory-out', 'handoff.json'), JSON.stringify(baseHandoff(run, task, { verdict: 'pass', report_path: `${parent}/.factory-out/${rel}` })));
  store.update(home, 'run', run.id, (x) => { x.status = 'completed'; x.agent_id = 'q1'; });
  const res = await collect.collect(home);
  assert.deepEqual(res.map((x) => x.outcome), ['pass']);
  assert.equal(store.get(home, 'task', qa.id).status, 'done');
  // pass -> a PR (local) and a G4 gate per epic, naming the goal QA report
  for (const eid of [eApi.id, eWeb.id]) {
    const ep = store.get(home, 'epic', eid);
    assert.equal(ep.status, 'pr_open', `${eid} ${ep.status}`);
    const gate = store.get(home, 'gate', ep.gates.G4);
    assert.match(gate.artifact.summary, /Cross-repo QA T-\d+ passed: docs\/.*-goal\.md/);
    assert.match(gate.artifact.summary, new RegExp(`^\\[${ep.repo}\\]`));
  }
  // collect removed both repo worktrees and the parent folder
  assert.ok(!existsSync(parent));
  assert.ok(!git(api, 'worktree', 'list').includes(`${run.id}/api`));
  assert.ok(!git(web, 'worktree', 'list').includes(`${run.id}/web`));
  assert.ok(existsSync(join(home, rel)));
});

test('cross-repo QA fail: CTO escalation, epics stay in goal_qa; rework sends one epic back; qa_goal comes back when all are in goal_qa again', async () => {
  const { home, api, web } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const g = await activeGoal(home);
  const eApi = a.newEpic(home, { goal_id: g.id, title: 'API', repo: 'api' });
  const eWeb = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'web' });
  await epicReady(home, api, eApi);
  await epicReady(home, web, eWeb);
  await flow.advanceGoal(home, g.id);
  const qa1 = store.list(home, 'task', (t) => t.kind === 'qa_goal')[0];
  assert.ok(qa1);
  // QA fails (as collect applies it)
  const run = store.create(home, 'run', { task_id: qa1.id, goal_id: g.id, kind: 'qa', role: 'qa-engineer', subagent_type: 'software-factory:qa-engineer', model: 'sonnet', status: 'completed', isolation: 'none', handoff_path: fwd(join(home, 'runs', 'R-000001', 'handoff.json')), output_paths: [`docs/${g.id}-${g.slug}/qa/${g.id}-goal.md`] });
  (await lib('lifecycle')).move(home, qa1.id, 'in_progress');
  const rp = writeReport(home, run.output_paths[0]);
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  writeFileSync(run.handoff_path, JSON.stringify(baseHandoff(run, store.get(home, 'task', qa1.id), { verdict: 'fail', report_path: rp })));
  await (await lib('collect')).collect(home);
  assert.equal(store.get(home, 'task', qa1.id).verdict, 'fail');
  assert.equal(store.get(home, 'epic', eApi.id).status, 'goal_qa');
  assert.equal(store.get(home, 'epic', eWeb.id).status, 'goal_qa');
  const esc = store.list(home, 'task', (t) => t.kind === 'escalation' && t.subject_task_id === qa1.id);
  assert.equal(esc.length, 1);
  assert.match(esc[0].title, /qa_goal failed/);
  await flow.advanceGoal(home, g.id);
  assert.equal(store.list(home, 'task', (t) => t.kind === 'qa_goal').length, 1, 'no new QA before rework');
  // the CTO adds a rework task to the web epic -> web goes back to building
  const [rw] = a.newTasks(home, [{ epic_id: eWeb.id, kind: 'code', role: 'frontend-engineer', title: 'Fix UI', size: 'S', acceptance_criteria: ['fixed'] }]);
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eWeb.id).status, 'building');
  // rework integrated, epic QA + review pass again; docs already done -> straight back to goal_qa
  store.update(home, 'task', rw.id, (x) => { x.status = 'integrated'; });
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eWeb.id).status, 'qa');
  const qaE = store.list(home, 'task', (t) => t.kind === 'qa_epic' && t.epic_id === eWeb.id)[0];
  assert.equal(qaE.repo, 'web');
  store.update(home, 'task', qaE.id, (x) => { x.status = 'done'; x.verdict = 'pass'; });
  await flow.advanceGoal(home, g.id);
  const rvE = store.list(home, 'task', (t) => t.kind === 'review_epic' && t.epic_id === eWeb.id)[0];
  store.update(home, 'task', rvE.id, (x) => { x.status = 'done'; x.verdict = 'pass'; });
  await new Promise((r) => setTimeout(r, 5));
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eWeb.id).status, 'goal_qa');
  assert.equal(store.list(home, 'task', (t) => t.kind === 'docs' && t.epic_id === eWeb.id).length, 1, 'no second docs task');
  const qas = store.list(home, 'task', (t) => t.kind === 'qa_goal');
  assert.equal(qas.length, 2);
  assert.equal(qas[1].status, 'ready');
});

test('a workspace goal whose epics are all in one repo skips cross-repo QA', async () => {
  const { home, web } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const g = await activeGoal(home);
  const e = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'web' });
  await epicReady(home, web, e);
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', e.id).status, 'pr_open');
  assert.equal(store.list(home, 'task', (t) => t.kind === 'qa_goal').length, 0);
});

test('status and doctor in workspace mode show repos', async () => {
  const { home } = await makeWorkspace();
  const a = await lib('actions');
  const g = await activeGoal(home);
  a.newEpic(home, { goal_id: g.id, title: 'API', repo: 'api' });
  const st = runCli(['status'], { home });
  assert.match(st.stdout, /epics: E-0001 api draft/);
  const d = runCli(['doctor', '--quick'], { home });
  assert.equal(d.code, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /ok +repo api /);
  assert.match(d.stdout, /ok +repo web /);
});

test('home lookup rules: an unlisted repo keeps its own home; a CLI worktree finds the home it lives in; workspace off claims no repo; outside git finds the workspace; FACTORY_HOME wins', async () => {
  const { ws, home, api, web } = await makeWorkspace();
  const paths = await lib('paths');
  const saved = process.env.FACTORY_HOME;
  delete process.env.FACTORY_HOME;
  try {
    const other = join(ws, 'other');
    makeRepo(other, { 'x.txt': 'x\n' });
    assert.equal(fwd(paths.findHome(other)), fwd(join(other, '.factory')));
    assert.equal(paths.existingHome(other), null);
    const r = runCli(['init'], { cwd: other, env: { FACTORY_HOME: '' } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(other, '.factory', 'config.json')));
    assert.equal(fwd(paths.existingHome(other)), fwd(join(other, '.factory')));
    assert.ok(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).repos.web, 'workspace config untouched');
    // a listed repo with its own .factory: its own home inside it, the workspace home inside a CLI worktree
    mkdirSync(join(web, '.factory'));
    assert.equal(fwd(paths.findHome(web)), fwd(join(web, '.factory')));
    const wt = join(home, 'worktrees', 'R-000098');
    git(web, 'worktree', 'add', '-q', '--detach', wt, 'main');
    assert.equal(fwd(paths.findHome(join(wt, 'src'))), fwd(home));
    assert.equal(fwd(paths.existingHome(wt)), fwd(home));
    git(web, 'worktree', 'remove', '--force', wt);
    // listed repo without its own home -> workspace; workspace mode off -> not claimed
    assert.equal(fwd(paths.existingHome(api)), fwd(home));
    (await lib('config')).set(home, 'workspace.enabled', false);
    assert.equal(fwd(paths.findHome(api)), fwd(join(api, '.factory')));
    assert.equal(paths.existingHome(api), null);
    // outside git: the nearest workspace home
    mkdirSync(join(ws, 'notes'));
    assert.equal(fwd(paths.findHome(join(ws, 'notes'))), fwd(home));
    process.env.FACTORY_HOME = join(ws, 'elsewhere');
    assert.equal(fwd(paths.findHome(api)), fwd(join(ws, 'elsewhere')));
    assert.equal(paths.existingHome(api), null);
  } finally { process.env.FACTORY_HOME = saved; }
});

test('goal_qa never sticks: a goal left in one repo goes to PR; pr_open and done epics do not block a later epic', async () => {
  const { home, api, web } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  // (a) the other repo's only epic is cancelled while one epic waits in goal_qa
  const g = await activeGoal(home);
  const eApi = a.newEpic(home, { goal_id: g.id, title: 'API', repo: 'api' });
  const eWeb = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'web' });
  await epicReady(home, api, eApi);
  store.update(home, 'epic', eWeb.id, (x) => { x.status = 'building'; });
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eApi.id).status, 'goal_qa');
  store.update(home, 'epic', eWeb.id, (x) => { x.status = 'cancelled'; });
  await flow.advanceGoal(home, g.id);
  assert.equal(store.get(home, 'epic', eApi.id).status, 'pr_open');
  assert.equal(store.list(home, 'task', (t) => t.kind === 'qa_goal').length, 0);
  // (b) epics already pr_open or done do not block an epic added later
  const g2 = await activeGoal(home);
  const e1 = a.newEpic(home, { goal_id: g2.id, title: 'API one', repo: 'api' });
  const e2 = a.newEpic(home, { goal_id: g2.id, title: 'API two', repo: 'api' });
  const e3 = a.newEpic(home, { goal_id: g2.id, title: 'UI late', repo: 'web' });
  store.update(home, 'epic', e1.id, (x) => { x.status = 'pr_open'; });
  store.update(home, 'epic', e2.id, (x) => { x.status = 'done'; });
  await epicReady(home, web, e3);
  await flow.advanceGoal(home, g2.id);
  assert.equal(store.get(home, 'epic', e3.id).status, 'goal_qa');
  const qas = store.list(home, 'task', (t) => t.kind === 'qa_goal' && t.goal_id === g2.id);
  assert.equal(qas.length, 1);
  // the QA run plan uses the base branch for the merged epic
  const plan = (await lib('dispatch')).goalRepoWorktrees(home, (await lib('config')).load(home), g2.id, join(home, 'worktrees', 'R-1'));
  assert.deepEqual(plan.map((x) => [x.epic_id, x.branch]), [[e1.id, e1.branch], [e2.id, 'main'], [e3.id, e3.branch]]);
  store.update(home, 'task', qas[0].id, (x) => { x.status = 'done'; x.verdict = 'pass'; });
  await flow.advanceGoal(home, g2.id);
  assert.equal(store.get(home, 'epic', e3.id).status, 'pr_open');
  assert.equal(store.get(home, 'epic', e1.id).pr, null, 'the pr_open epic was not touched');
});

test('a no-new-commits fixup keeps the worktree, and the fixup run continues in it with the unsaved work', async () => {
  const { home } = await makeWorkspace();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const dispatch = await lib('dispatch');
  const collect = await lib('collect');
  (await lib('control')).start(home, { session: 'S1' });
  const g = await activeGoal(home);
  const e = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'web' });
  assert.ok(await flow.ensureEpicBranch(home, e));
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'frontend-engineer', size: 'S', status: 'ready', title: 'Screen', acceptance_criteria: ['shows'], files_owned: ['src/web.js'] });
  const line = await dispatch.dispatch(home, { task: t, goal: g, kind: 'author', role: 'frontend-engineer', review_role: null }, { session: 'S1' });
  assert.equal(runCli(['worktree', 'prepare', '--run', line.run_id], { home }).code, 0);
  const run = store.get(home, 'run', line.run_id);
  const wt = run.worktree_path;
  writeFileSync(join(wt, 'src', 'web.js'), 'export const web = 3; // unsaved\n');
  mkdirSync(join(home, 'runs', run.id, 'evidence'), { recursive: true });
  writeFileSync(join(home, 'runs', run.id, 'evidence', 'index.jsonl'), `${JSON.stringify({ id: 'EV-1', label: 't', command: 'x', cwd: wt, exit_code: 0, log_path: 'x', head_sha: 'x', source: 'agent' })}\n`);
  const task = store.get(home, 'task', t.id);
  writeFileSync(run.handoff_path, JSON.stringify(baseHandoff(run, task, { acceptance_criteria: [{ id: 'AC-1', met: true, evidence: ['EV-1'] }], evidence: ['EV-1'], branch: task.branch })));
  store.update(home, 'run', run.id, (x) => { x.status = 'completed'; x.agent_id = 'f1'; });
  const res = await collect.collect(home);
  assert.deepEqual(res.map((x) => x.outcome), ['fixup']);
  assert.match(readFileSync(join(wt, 'src', 'web.js'), 'utf8'), /unsaved/);
  assert.equal(store.get(home, 'task', t.id).kept_worktree.path, wt);
  const cand = dispatch.candidates(home).find((c) => c.task.id === t.id);
  assert.equal(cand.kind, 'fixup');
  const line2 = await dispatch.dispatch(home, cand, { session: 'S1' });
  assert.equal(store.get(home, 'run', line2.run_id).worktree_path, wt);
  assert.equal(store.get(home, 'task', t.id).kept_worktree, null);
  const r = runCli(['worktree', 'prepare', '--run', line2.run_id], { home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(wt, 'src', 'web.js'), 'utf8'), /unsaved/);
});
