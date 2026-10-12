import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeHome, lib, runCli, join, writeFileSync, readFileSync, git, existsSync } from './_helpers.mjs';

test('not initialized: status and doctor exit 4; init creates the layout', async () => {
  const { home } = await makeHome({ init: false });
  assert.equal(runCli(['status'], { home }).code, 4);
  assert.equal(runCli(['doctor', '--quick'], { home }).code, 4);
  const r = runCli(['init'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^INIT /);
  const d = runCli(['doctor', '--quick'], { home });
  assert.equal(d.code, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /ok +config valid/);
  const full = runCli(['doctor'], { home, env: { PATH: process.env.PATH } });
  assert.match(full.stdout, /transcript parser ok/);
});

test('goal new takes repeated --criteria and --constraint; goal list/show', async () => {
  const { home } = await makeHome();
  const r = runCli(['goal', 'new', '--title', 'Add VIN decode', '--outcome', 'Decode VINs', '--criteria', 'decodes', '--criteria', 'clear errors', '--constraint', 'no new deps', '--priority', 'P1', '--budget', '2000000'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'G-001');
  const g = JSON.parse(runCli(['goal', 'show', 'G-001', '--json'], { home }).stdout);
  assert.deepEqual(g.success_criteria, ['decodes', 'clear errors']);
  assert.deepEqual(g.constraints, ['no new deps']);
  assert.equal(g.budget.limit_tokens, 2000000);
  assert.equal(g.budget.user_set, true);
  assert.match(runCli(['goal', 'list'], { home }).stdout, /G-001 planning P1 Add VIN decode/);
  assert.equal(runCli(['goal', 'new', '--title', 'x'], { home }).code, 2);
});

test('gate decide and budget override need human intent; with intent they apply', async () => {
  const { home } = await makeHome();
  runCli(['goal', 'new', '--title', 'G', '--outcome', 'o', '--criteria', 'c', '--budget', '1000'], { home });
  const budget = await lib('budget');
  const gate = budget.block(home, 'G-001', 500);
  const no = runCli(['gate', 'decide', gate.id, '--decision', 'approve', '--add-tokens', '5000'], { home });
  assert.equal(no.code, 1);
  assert.match(no.stderr, /human intent/);
  assert.equal(runCli(['budget', 'override', 'G-001', '--add', '10'], { home }).code, 1);
  (await lib('intent')).writeIntent(home, 'S1', 'approve');
  const yes = runCli(['gate', 'decide', gate.id, '--decision', 'approve', '--add-tokens', '5000', '--via', 'cli'], { home });
  assert.equal(yes.code, 0, yes.stderr);
  const g = JSON.parse(runCli(['goal', 'show', 'G-001', '--json'], { home }).stdout);
  assert.equal(g.budget.limit_tokens, 6000);
  assert.equal(g.status, 'planning');
  assert.match(runCli(['gate', 'list'], { home }).stdout, /no gates pending/);
});

test('task replan, waive (major only), block, answer', async () => {
  const { home } = await makeHome();
  const a = await lib('actions');
  const store = await lib('store');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'backlog', title: 'T', acceptance_criteria: ['x'] });
  store.update(home, 'task', t.id, (x) => { x.findings = [{ id: 'F-1', severity: 'major', text: 'slow', role: 'code-reviewer', run_id: 'R-1' }, { id: 'F-2', severity: 'blocker', text: 'bug' }]; });
  const f = join(home, '..', 'replan.json');
  writeFileSync(f, JSON.stringify({ acceptance_criteria: ['x', 'y'], estimate_tokens: 123 }));
  const rp = runCli(['task', 'replan', t.id, '--file', f], { home });
  assert.equal(rp.code, 0, rp.stderr);
  assert.match(rp.stdout, /ac_version 2/);
  writeFileSync(f, JSON.stringify({ status: 'done' }));
  assert.equal(runCli(['task', 'replan', t.id, '--file', f], { home }).code, 1);
  assert.equal(runCli(['task', 'waive', t.id, '--finding', 'F-2', '--reason', 'meh'], { home }).code, 1);
  const w = runCli(['task', 'waive', t.id, '--finding', 'F-1', '--reason', 'accepted risk'], { home });
  assert.equal(w.code, 0, w.stderr);
  const b = runCli(['task', 'block', t.id, '--needs', 'human', '--question', 'Which API?'], { home });
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /BLOCKED T-0002 Q-1 needs human/);
  const ans = runCli(['task', 'answer', t.id, '--question', 'Q-1', '--text', 'Use v2'], { home });
  assert.equal(ans.code, 0, ans.stderr);
  const t2 = store.get(home, 'task', t.id);
  assert.equal(t2.status, 'ready');
  assert.equal(t2.ac_version, 2);
  assert.equal(t2.waivers[0].finding, 'F-1');
  assert.equal(t2.answers[0].text, 'Use v2');
  assert.equal(runCli(['task', 'move', t.id, 'verified'], { home }).code, 1);
});

test('task new validates size, ACs, overlap and cycles', async () => {
  const { home } = await makeHome();
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const f = join(home, '..', 'tasks.json');
  writeFileSync(f, JSON.stringify([{ epic_id: e.id, title: 'big', size: 'L', acceptance_criteria: ['x'] }]));
  assert.match(runCli(['task', 'new', '--file', f], { home }).stderr, /split it/);
  writeFileSync(f, JSON.stringify([
    { ref: 'a', epic_id: e.id, title: 'A', acceptance_criteria: ['x'], files_owned: ['src/**'] },
    { ref: 'b', epic_id: e.id, title: 'B', acceptance_criteria: ['x'], files_owned: ['src/a.js'] },
  ]));
  assert.match(runCli(['task', 'new', '--file', f], { home }).stderr, /overlaps/);
  writeFileSync(f, JSON.stringify([
    { ref: 'a', epic_id: e.id, title: 'A', acceptance_criteria: ['x'], files_owned: ['src/a.js'], depends_on: ['b'] },
    { ref: 'b', epic_id: e.id, title: 'B', acceptance_criteria: ['x'], files_owned: ['src/b.js'], depends_on: ['a'] },
  ]));
  assert.match(runCli(['task', 'new', '--file', f], { home }).stderr, /cycle/);
  writeFileSync(f, JSON.stringify([
    { ref: 'a', epic_id: e.id, title: 'A', acceptance_criteria: ['x'], files_owned: ['src/a.js'] },
    { ref: 'b', epic_id: e.id, title: 'B', role: 'frontend-engineer', acceptance_criteria: ['x'], files_owned: ['src/b.js'], depends_on: ['a'] },
  ]));
  const ok = runCli(['task', 'new', '--file', f, '--json'], { home });
  assert.equal(ok.code, 0, ok.stderr);
  const made = JSON.parse(ok.stdout);
  assert.deepEqual(made.map((t) => t.status), ['draft', 'draft']);
  assert.deepEqual(made[1].depends_on, [made[0].id]);
  assert.deepEqual(made[1].reviews_required, [['code-reviewer'], ['qa-engineer']]);
});

test('pause --now prints STOP lines; --stop needs intent; goal remove prints STOP lines', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  (await lib('control')).start(home, { session: 'S1' });
  runCli(['goal', 'new', '--title', 'G', '--outcome', 'o', '--criteria', 'c'], { home });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running', agent_id: 'ag1' });
  const now = runCli(['pause', '--now', '--session', 'S1'], { home });
  assert.equal(now.code, 0, now.stderr);
  assert.match(now.stdout, /^STOP R-000001 ag1$/m);
  assert.match(now.stdout, /PAUSING now/);
  const stop = runCli(['pause', '--now', '--stop', '--session', 'S1'], { home });
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /human intent/);
  const cp = runCli(['run', 'checkpoint', 'R-000001'], { home });
  assert.equal(cp.code, 0, cp.stderr);
  assert.match(cp.stdout, /^CHECKPOINT R-000001/);
  assert.equal(JSON.parse(runCli(['run', 'show', 'R-000001', '--json'], { home }).stdout).status, 'stopped');
  assert.equal((await lib('state')).readFactory(home).status, 'paused');
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running', agent_id: 'ag2' });
  assert.equal(runCli(['goal', 'remove', 'G-001', '--confirm', 'G-001'], { home }).code, 1);
  (await lib('intent')).writeIntent(home, null, 'remove-goal');
  const rm = runCli(['goal', 'remove', 'G-001', '--confirm', 'G-001'], { home });
  assert.equal(rm.code, 0, rm.stderr);
  assert.match(rm.stdout, /^STOP R-000002 ag2$/m);
  assert.equal(JSON.parse(runCli(['goal', 'show', 'G-001', '--json'], { home }).stdout).status, 'cancelled');
});

test('evidence run records an agent evidence entry; handoff validate exits 1 with errors', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  runCli(['goal', 'new', '--title', 'G', '--outcome', 'o', '--criteria', 'c'], { home });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running' });
  const ev = runCli(['evidence', 'run', '--run', 'R-000001', '--label', 'echo', '--', 'git', '--version'], { home });
  assert.equal(ev.code, 0, ev.stderr);
  assert.match(ev.stdout, /^EV-1 exit 0/);
  const idx = readFileSync(join(home, 'runs', 'R-000001', 'evidence', 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(idx[0].source, 'agent');
  const hp = join(home, 'runs', 'R-000001', 'handoff.json');
  writeFileSync(hp, JSON.stringify({ schema: 'factory/handoff@1', run_id: 'R-000001', task_id: 'T-0001', from_role: 'cto', status: 'handed_off', summary: 'x', evidence: ['EV-1', 'EV-2'] }));
  const v = runCli(['handoff', 'validate', hp], { home });
  assert.equal(v.code, 1);
  assert.match(v.stdout, /EV-2 not found/);
});

test('inbox add signs only with intent; config get/set; events tail; watch --once', async () => {
  const { home } = await makeHome();
  const add = runCli(['inbox', 'add', '--type', 'goal.add', '--payload', JSON.stringify({ title: 'X', outcome: 'o', success_criteria: ['c'] })], { home });
  assert.equal(add.code, 0, add.stderr);
  const un = runCli(['inbox', 'add', '--type', 'factory.stop', '--payload', '{}'], { home });
  assert.match(un.stdout, /unsigned/);
  const pr = runCli(['inbox', 'process'], { home });
  assert.match(pr.stdout, /goal.add applied/);
  assert.match(pr.stdout, /factory.stop rejected: unsigned/);
  assert.equal(runCli(['config', 'set', 'reviews.profile', '"thorough"'], { home }).code, 0);
  assert.equal(runCli(['config', 'get', 'reviews.profile'], { home }).stdout.trim(), '"thorough"');
  assert.equal(runCli(['config', 'set', 'reviews.profile', '"bogus"'], { home }).code, 1);
  assert.match(runCli(['events', 'tail', '--n', '5'], { home }).stdout, /inbox.processed/);
  const dir = mkdtempSync(join(tmpdir(), 'sfw-'));
  void dir;
  const w = runCli(['watch', '--interval', '1', '--timeout', '1'], { home });
  assert.equal(w.code, 0);
});

test('worktree prepare with the real delivery modules switches the agent worktree to the task branch and writes a branch lock', async () => {
  const { home, repo } = await makeHome();
  const a = await lib('actions');
  const store = await lib('store');
  const flow = await lib('flow');
  const dispatch = await lib('dispatch');
  (await lib('config')).set(home, 'delivery.mode', 'local');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  const e = a.newEpic(home, { goal_id: g.id, title: 'Epic' });
  assert.ok(await flow.ensureEpicBranch(home, e));
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'Code it', acceptance_criteria: ['x'], files_owned: ['src/a.js'] });
  const line = await dispatch.dispatch(home, dispatch.candidates(home).find((c) => c.task.id === t.id), { session: 'S1' });
  const wt = join(repo, '.claude', 'worktrees', 'agent-x1');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const r = runCli(['worktree', 'prepare', '--run', line.run_id], { home, cwd: wt });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PREPARED .* factory\/T-0002-code-it /);
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'factory/T-0002-code-it');
  assert.ok(existsSync(join(home, 'run', 'branch-locks', 'factory__T-0002-code-it.json')));
  const run = store.get(home, 'run', line.run_id);
  assert.equal(run.branch, 'factory/T-0002-code-it');
  assert.ok(run.worktree_path.endsWith('agent-x1'));
});
