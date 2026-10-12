import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, lib, readFileSync, join, existsSync } from './_helpers.mjs';

test('init is idempotent and writes the gitignore allow-list', async () => {
  const { home } = await makeHome();
  const st = await lib('state');
  assert.deepEqual(st.init(home), []);
  const gi = readFileSync(join(home, '.gitignore'), 'utf8');
  assert.match(gi, /^\*\n!\.gitignore\n!config\.json/);
  assert.ok(gi.includes('!sync/map.json'));
  assert.equal(st.readFactory(home).status, 'stopped');
  assert.ok(existsSync(join(home, 'config.schema.json')));
});

test('create assigns ids, rev and timestamps; update bumps rev and patches the index', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  const g = store.create(home, 'goal', { title: 'Add login', slug: 'add-login', outcome: 'Users log in', success_criteria: ['works'], budget: { limit_tokens: 100 } });
  assert.equal(g.id, 'G-001');
  assert.equal(g.rev, 1);
  assert.equal(g.schema, 'factory/goal@1');
  const g2 = store.update(home, 'goal', g.id, (x) => { x.priority = 'P1'; });
  assert.equal(g2.rev, 2);
  const idx = JSON.parse(readFileSync(join(home, 'state', 'index.json'), 'utf8'));
  assert.equal(idx.goals['G-001'].priority, 'P1');
  assert.equal(store.create(home, 'goal', { title: 'B', slug: 'b', outcome: 'b', success_criteria: ['x'], budget: { limit_tokens: 1 } }).id, 'G-002');
});

test('expectRev mismatch throws a rev conflict (exit 5)', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  const g = store.create(home, 'goal', { title: 'A', slug: 'a', outcome: 'a', success_criteria: ['x'], budget: { limit_tokens: 1 } });
  assert.throws(() => store.update(home, 'goal', g.id, () => {}, { expectRev: 7 }), (e) => e.exitCode === 5);
  store.update(home, 'goal', g.id, () => {}, { expectRev: 1 });
});

test('validation rejects bad records (exit 1)', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  assert.throws(() => store.create(home, 'goal', { title: 'x'.repeat(81), slug: 'a', outcome: 'a', success_criteria: ['x'], budget: { limit_tokens: 1 } }), /title: longer than 80/);
  assert.throws(() => store.create(home, 'goal', { title: 'a', slug: 'a', outcome: 'a', success_criteria: [], budget: { limit_tokens: 1 } }), /success_criteria/);
  const g = store.create(home, 'goal', { title: 'a', slug: 'a', outcome: 'a', success_criteria: ['x'], budget: { limit_tokens: 1 } });
  assert.throws(() => store.create(home, 'task', { goal_id: g.id, kind: 'code', title: 't', role: 'backend-engineer', size: 'L', acceptance_criteria: [{ id: 'AC-1', text: 'x' }] }), /split it/);
  assert.throws(() => store.update(home, 'goal', g.id, (x) => { x.status = 'nope'; }), (e) => e.exitCode === 1);
  assert.equal(store.get(home, 'goal', g.id).rev, 1);
});

test('index rebuild matches incremental patches', async () => {
  const { home } = await makeHome();
  const store = await lib('store');
  const idxLib = await lib('index');
  const g = store.create(home, 'goal', { title: 'a', slug: 'a', outcome: 'a', success_criteria: ['x'], budget: { limit_tokens: 1 } });
  store.create(home, 'task', { goal_id: g.id, kind: 'intake', title: 'i', role: 'cto', status: 'ready' });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: g.id, kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running' });
  const before = idxLib.readIndex(home);
  const after = idxLib.rebuild(home);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(after.runs_active, ['R-000001']);
});

test('config: commands.extra string[] and new command keys validate; bad values rejected', async () => {
  const { home } = await makeHome();
  const cfg = await lib('config');
  const d = cfg.defaults();
  assert.deepEqual(d.commands.extra, []);
  assert.equal(d.commands.migrate_up, null);
  assert.equal(d.commands.screenshot, null);
  cfg.merge(home, { commands: { extra: ['npm run fmt', 'make docs'], migrate_up: 'npm run db:up' }, tracker: { provider: 'linear', mode: 'two-way', status: 'pending_credentials', labels: { x: 1 } } });
  assert.ok(cfg.validateHome(home).ok);
  assert.throws(() => cfg.set(home, 'commands.extra', 'npm x'), /commands.extra/);
  assert.throws(() => cfg.set(home, 'commands.build', 5), /commands.build/);
  cfg.set(home, 'commands.test', 'npm test');
  assert.deepEqual(cfg.load(home).checks.pre_review, ['npm test']);
});
