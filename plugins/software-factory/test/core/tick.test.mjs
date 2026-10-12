import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, lib, fakeDelivery, readFileSync, CLI, writeFileSync, join } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

test('tick plan prints DISPATCH lines in the exact contract format, then SYNC', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const tick = await lib('tick');
  (await lib('control')).start(home, { session: 'S1' });
  const g = (await lib('actions')).newGoal(home, { title: 'Add VIN decoder', outcome: 'o', success_criteria: ['c'] });
  const b = await tick.begin(home, { session: 'S1', force: true });
  assert.match(b.lines[0], /^TICK 1 factory running/);
  assert.ok(b.lines.length <= 8);
  const p = await tick.plan(home, { session: 'S1' });
  const disp = p.lines.filter((l) => l.startsWith('DISPATCH '));
  assert.equal(disp.length, 1);
  assert.equal(p.lines[p.lines.length - 1], 'SYNC skip');
  const obj = JSON.parse(disp[0].slice('DISPATCH '.length));
  assert.deepEqual(Object.keys(obj), ['run_id', 'subagent_type', 'model', 'description', 'prompt']);
  assert.equal(obj.run_id, 'R-000001');
  assert.equal(obj.subagent_type, 'software-factory:cto');
  assert.equal(obj.model, 'opus');
  assert.equal(obj.description, '[T-0001] Intake: Add VIN decoder');
  const lines = obj.prompt.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `FACTORY_RUN=R-000001 task=T-0001 goal=${g.id} role=cto attempt=1`);
  const briefPath = join(home, 'runs', 'R-000001', 'brief.md').replace(/\\/g, '/');
  assert.equal(lines[1], `Read and follow your brief: ${briefPath}`);
  assert.equal(lines[2], 'When done, write your handoff file, run the validate command in the brief, then reply with one line: HANDOFF <path> <status>');
  // brief front block
  const { parseBrief } = await lib('brief');
  const brief = parseBrief(readFileSync(briefPath, 'utf8'));
  const cli = CLI.replace(/\\/g, '/');
  assert.equal(brief.cli, cli);
  assert.equal(brief.setup, null);
  const H = home.replace(/\\/g, '/');
  assert.equal(brief.validate, `node "${cli}" handoff validate "${H}/runs/R-000001/handoff.json" --home "${H}"`);
  assert.equal(brief.evidence_cmd, `node "${cli}" evidence run --run R-000001 --home "${H}" --label <label> -- <command>`);
  assert.equal(brief.factory_home, home.replace(/\\/g, '/'));
  for (const k of ['run_id', 'task_id', 'goal_id', 'epic_id', 'role', 'kind', 'tier', 'round', 'constitution', 'overlay', 'goal_outcome', 'acceptance_criteria',
    'files_owned', 'files_shared', 'files_read', 'risk_flags', 'base_ref', 'branch', 'evidence_required', 'commands', 'diff_cmd', 'checks_result', 'integrate',
    'artifacts', 'output_paths', 'feedback', 'answers', 'resume_from', 'handoff_path', 'token_hint']) assert.ok(k in brief, `brief has ${k}`);
  assert.ok(brief.output_paths.every((x) => !/^[A-Za-z]:|^\//.test(x)), 'output paths are relative to H');
  // the run is reserved in the ledger and the task is in progress
  const store = await lib('store');
  assert.equal(store.get(home, 'task', 'T-0001').status, 'in_progress');
  const e = await tick.end(home, { session: 'S1', loop: true });
  assert.equal(e.lines[e.lines.length - 1], 'SCHEDULE 270');
  assert.ok(e.lines.length <= 12);
});

test('code task brief has the exact worktree setup command, overlay inlined to 150 lines', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  const a = await lib('actions');
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  const { parseBrief } = await lib('brief');
  writeFileSync(join(home, 'roles', 'backend-engineer.md'), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  const e = a.newEpic(home, { goal_id: g.id, title: 'Epic one' });
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'Do it', acceptance_criteria: ['x'], files_owned: ['src/a.js'] });
  const cand = dispatch.candidates(home).find((c) => c.task.id === t.id);
  const line = await dispatch.dispatch(home, cand, { session: 'S1' });
  const text = readFileSync(join(home, 'runs', line.run_id, 'brief.md'), 'utf8');
  const brief = parseBrief(text);
  assert.equal(brief.setup, `node "${CLI.replace(/\\/g, '/')}" worktree prepare --run ${line.run_id} --home "${home.replace(/\\/g, '/')}"`);
  assert.equal(brief.branch, `factory/${t.id}-do-it`);
  assert.equal(brief.base_ref, e.branch);
  assert.ok(text.includes('line 150'));
  assert.ok(!text.includes('line 151'));
  assert.equal(brief.evidence_required, true);
});

test('tick begin debounces with SKIP; another session gets exit 3; tick end says NONE when idle', async () => {
  const { home } = await makeHome();
  const tick = await lib('tick');
  (await lib('control')).start(home, { session: 'S1' });
  await tick.begin(home, { session: 'S1', force: true });
  const again = await tick.begin(home, { session: 'S1' });
  assert.match(again.lines[0], /^SKIP \d+$/);
  await assert.rejects(tick.begin(home, { session: 'S2', force: true }), (e) => e.exitCode === 3);
  await assert.rejects(tick.plan(home, { session: 'S2' }), (e) => e.exitCode === 3);
  const end = await tick.end(home, { session: 'S1', loop: true });
  assert.equal(end.lines[end.lines.length - 1], 'NONE');
});

test('cadence: waiting on a human backs off 900 -> 1800 -> 3600; paused uses paused_s', async () => {
  const { home } = await makeHome();
  const tick = await lib('tick');
  const store = await lib('store');
  const control = await lib('control');
  control.start(home, { session: 'S1' });
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'task', 'T-0001', (t) => { t.status = 'blocked'; t.blocked = { reason: 'q', question_id: 'Q-1', needs: 'human', since: new Date().toISOString() }; });
  const s = [];
  for (let i = 0; i < 4; i++) { const e = await tick.end(home, { session: 'S1', loop: true }); s.push(e.lines.at(-1)); }
  assert.deepEqual(s, ['SCHEDULE 900', 'SCHEDULE 1800', 'SCHEDULE 3600', 'SCHEDULE 3600']);
  control.pause(home, { mode: 'drain' });
  const e = await tick.end(home, { session: 'S1', loop: true });
  assert.equal(e.lines.at(-1), 'SCHEDULE 1800');
  assert.equal((await lib('state')).readFactory(home).status, 'paused');
  void g;
});

test('budget block opens one budget gate; override unblocks and work dispatches', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const tick = await lib('tick');
  const store = await lib('store');
  const budget = await lib('budget');
  (await lib('control')).start(home, { session: 'S1' });
  const g = (await lib('actions')).newGoal(home, { title: 'Tiny', outcome: 'o', success_criteria: ['c'], budget_tokens: 100000 });
  await tick.begin(home, { session: 'S1', force: true });
  let p = await tick.plan(home, { session: 'S1' });
  assert.equal(p.dispatches.length, 0);
  assert.ok(p.lines.includes(`BUDGET blocked ${g.id}`));
  assert.equal(store.get(home, 'goal', g.id).status, 'budget_blocked');
  p = await tick.plan(home, { session: 'S1' });
  const gates = store.list(home, 'gate', (x) => x.type === 'budget');
  assert.equal(gates.length, 1, 'budget gate opened once');
  assert.ok(gates[0].request.add_tokens_suggested >= 450000);
  budget.override(home, g.id, 500000, { by: 'human', note: 'more' });
  const after = store.get(home, 'goal', g.id);
  assert.equal(after.status, 'planning');
  assert.equal(after.budget.limit_tokens, 600000);
  assert.equal(store.get(home, 'gate', gates[0].id).status, 'approved');
  p = await tick.plan(home, { session: 'S1' });
  assert.equal(p.dispatches.length, 1);
  const { readLines } = await lib('fsutil');
  assert.ok(readLines(join(home, 'state', 'ledger.jsonl')).some((l) => l.kind === 'override' && l.tokens === 500000));
});

test('budget warn fires once at 80%', async () => {
  const { home } = await makeHome();
  const budget = await lib('budget');
  const store = await lib('store');
  const usage = await lib('usage');
  const g = (await lib('actions')).newGoal(home, { title: 'W', outcome: 'o', success_criteria: ['c'], budget_tokens: 1000 });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: g.id, kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'completed', agent_id: 'ag1' });
  usage.writeSnapshot(home, { scope: 'agent', agent_id: 'ag1', session_id: 's', run_id: 'R-000001', status: 'finished', requests: 1, by_model: { m: { input: 850, output: 0, cache_read: 0, cache_creation: 0 } } });
  const notes = [];
  const r1 = budget.check(home, undefined, (t, b) => notes.push(b));
  const r2 = budget.check(home, undefined, (t, b) => notes.push(b));
  assert.equal(r1.warned.length, 1);
  assert.equal(r2.warned.length, 0);
  assert.equal(notes.length, 1);
});

test('file overlap and slot classes limit the chooser', async () => {
  const { home } = await makeHome();
  const a = await lib('actions');
  const store = await lib('store');
  const dispatch = await lib('dispatch');
  const glob = await lib('glob');
  assert.ok(glob.match('src/**/*.js', 'src/a/b/c.js'));
  assert.ok(glob.match('src/**', 'src/a.js'));
  assert.ok(!glob.match('src/*.js', 'src/a/b.js'));
  assert.ok(glob.match('src/a?.js', 'src/ab.js'));
  assert.ok(glob.overlap(['src/**'], ['src/a.js'], ['src/a.js']));
  assert.ok(!glob.overlap(['src/a.js'], ['src/b.js'], ['src/a.js', 'src/b.js']));
  assert.ok(glob.overlap(['src/new/**'], ['src/new/x.ts'], []));
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.update(home, 'goal', g.id, (x) => { x.status = 'active'; });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const mk = (title, files) => a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title, acceptance_criteria: ['x'], files_owned: files });
  mk('one', ['src/**']); mk('two', ['src/a.js']); mk('three', ['README.md']); mk('four', ['docs/x.md']);
  store.update(home, 'task', 'T-0001', (t) => { t.status = 'cancelled'; }); // drop intake from the race
  const { chosen, skipped } = dispatch.choose(home, { factory: { status: 'running' } });
  assert.deepEqual(chosen.map((c) => c.task.title), ['one', 'three', 'four']);
  assert.ok(skipped.some((s) => /files overlap/.test(s.reason)));
  (await lib('config')).set(home, 'concurrency.builders', 1);
  const r2 = dispatch.choose(home, { factory: { status: 'running' } });
  assert.equal(r2.chosen.length, 1);
  assert.ok(r2.skipped.some((s) => /builders slots full/.test(s.reason)));
  assert.equal(dispatch.choose(home, { factory: { status: 'running', backoff_until: new Date(Date.now() + 60000).toISOString() } }).chosen.length, 0);
});
