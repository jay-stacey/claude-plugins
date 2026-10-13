// Teams (contracts §21.2): implicit core team, validation, resolution order, goal teams.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeHome, lib, runCli } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

const TEAMS = {
  product: { name: 'Product', kind: 'product', parent: null, repos: [], roles: ['product-manager', 'ui-ux-designer'], tracker: { team_key: 'PRO' } },
  engineering: { name: 'Engineering', kind: 'engineering', parent: null, repos: [], roles: ['staff-engineer', 'project-manager'], tracker: { team_key: 'ENG' } },
  neo: { name: 'NEO', kind: 'engineering', parent: 'engineering', repos: ['project-neo'], roles: [], tracker: { team_key: 'NEO' } },
  api: { name: 'Backend Services', kind: 'engineering', parent: 'engineering', repos: ['dealerpull-api'], roles: [], tracker: { team_key: null } },
};

async function workspaceTeams(home) {
  const cfg = await lib('config');
  cfg.merge(home, { workspace: { enabled: true, default_repo: 'dealerpull-api' }, repos: { 'dealerpull-api': { path: 'dealerpull-api' }, 'project-neo': { path: 'project-neo' } }, teams: TEAMS });
  return cfg.load(home);
}

test('no teams: one implicit core team owns every repo and takes the tracker scope key', async () => {
  const { home } = await makeHome();
  const config = await lib('config');
  config.merge(home, { project: { name: 'shop' }, tracker: { provider: 'linear', scope: { team_key: 'SHP' } } });
  const cfg = config.load(home);
  const teams = await lib('teams');
  assert.equal(teams.explicit(cfg), false);
  const l = teams.list(home, cfg);
  assert.equal(l.length, 1);
  assert.deepEqual({ id: l[0].id, name: l[0].name, kind: l[0].kind, repos: l[0].repos, key: l[0].tracker.team_key }, { id: 'core', name: 'shop', kind: 'engineering', repos: ['shop'], key: 'SHP' });
  assert.equal(teams.forRepo(home, cfg, 'shop'), 'core');
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const store = await lib('store');
  assert.equal(store.get(home, 'task', 'T-0001').team, 'core');
  assert.deepEqual(store.get(home, 'goal', g.id).teams, ['core']);
  assert.equal(store.get(home, 'goal', g.id).kind, 'goal');
});

test('config validation rejects bad team ids, unknown parents, parent cycles, shared repos and roles, unknown repos', async () => {
  const { validateConfig } = await lib('schema');
  const { defaults, deepMerge } = await lib('config');
  const base = deepMerge(defaults(), { workspace: { enabled: true }, repos: { a: {}, b: {} } });
  const errs = (teams) => validateConfig({ ...base, teams }).errors.join('\n');
  assert.equal(validateConfig({ ...base, teams: { x: { repos: ['a'] }, y: { repos: ['b'], parent: 'x' } } }).ok, true);
  assert.match(errs({ Bad_Id: {} }), /teams\.Bad_Id: id must be lowercase kebab-case/);
  assert.match(errs({ x: { parent: 'nope' } }), /teams\.x\.parent: unknown team nope/);
  assert.match(errs({ x: { parent: 'y' }, y: { parent: 'x' } }), /parent chain has a cycle/);
  assert.match(errs({ x: { repos: ['a'] }, y: { repos: ['a'] } }), /repo a already belongs to team x/);
  assert.match(errs({ x: { roles: ['cto'] }, y: { roles: ['cto'] } }), /role cto already belongs to team x/);
  assert.match(errs({ x: { repos: ['zzz'] } }), /unknown repo zzz/);
  assert.match(errs({ x: { roles: ['wizard'] } }), /unknown role wizard/);
  assert.match(errs({ x: { tracker: { team_key: 5 } } }), /team_key: must be a string or null/);
  assert.match(validateConfig({ ...base, streams: { pull: 'sometimes' } }).errors.join(), /streams\.pull/);
  assert.match(validateConfig({ ...base, cycles: { anchor: '5 Jan' } }).errors.join(), /cycles\.anchor/);
  assert.match(validateConfig({ ...base, tracker: { goal_mapping: 'epic' } }).errors.join(), /tracker\.goal_mapping/);
});

test('resolution order: role team for planners, repo team for code, lead team, deepest repo team, inherited tracker key', async () => {
  const { home } = await makeHome();
  const cfg = await workspaceTeams(home);
  const teams = await lib('teams');
  const a = await lib('actions');
  const store = await lib('store');
  assert.deepEqual(teams.ancestors(home, cfg, 'neo'), ['engineering']);
  assert.equal(teams.trackerKey(home, cfg, 'api'), 'ENG', 'api has no key: the parent key is used');
  assert.equal(teams.trackerKey(home, cfg, 'neo'), 'NEO');
  assert.deepEqual(teams.forTrackerKey(home, cfg, 'ENG'), ['engineering', 'api']);
  assert.throws(() => teams.get(home, cfg, 'ghost'), (e) => e.exitCode === 1);
  const g = a.newGoal(home, { title: 'Cross team', outcome: 'o', success_criteria: ['c'] });
  // intake (cto): no repo, no role team, no lead -> the team of the default repo
  assert.equal(store.get(home, 'task', 'T-0001').team, 'api');
  const prd = a.createTask(home, { goal_id: g.id, kind: 'prd', status: 'ready', title: 'PRD' });
  assert.equal(prd.team, 'product');
  const spec = a.createTask(home, { goal_id: g.id, kind: 'spec', status: 'ready', title: 'Spec' });
  assert.equal(spec.team, 'engineering');
  a.setGoal(home, g.id, { teams: ['neo', 'api'], lead_team: 'api' });
  assert.deepEqual(store.get(home, 'goal', g.id).teams, ['api', 'neo']);
  const esc = a.createTask(home, { goal_id: g.id, kind: 'escalation', status: 'ready', title: 'E' });
  assert.equal(esc.team, 'api', 'cto work goes to the lead team');
  const e = a.newEpic(home, { goal_id: g.id, title: 'UI', repo: 'project-neo' });
  assert.equal(e.team, 'neo');
  const [t] = a.newTasks(home, [{ epic_id: e.id, kind: 'code', role: 'frontend-engineer', title: 'Screen', size: 'S', acceptance_criteria: ['x'], files_owned: ['src/x.ts'] }]);
  assert.equal(t.team, 'neo');
  const given = a.newEpic(home, { goal_id: g.id, title: 'API part', repo: 'dealerpull-api', team: 'engineering' });
  assert.equal(given.team, 'engineering');
  assert.throws(() => a.newEpic(home, { goal_id: g.id, title: 'x', repo: 'dealerpull-api', team: 'ghost' }), /unknown team/);
  assert.throws(() => a.setGoal(home, g.id, { teams: ['ghost'] }), /unknown team/);
  // the CLI adds the team of every new epic or task to goal.teams
  a.setGoal(home, g.id, { teams: ['api'], lead_team: 'api' });
  a.newEpic(home, { goal_id: g.id, title: 'More UI', repo: 'project-neo' });
  assert.deepEqual(store.get(home, 'goal', g.id).teams, ['api', 'neo']);
});

test('CLI: goal set --teams --lead-team and epic new --team print and store the teams', async () => {
  const { home } = await makeHome();
  await workspaceTeams(home);
  const a = await lib('actions');
  const store = await lib('store');
  const g = a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: g.id, kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running' });
  const r = runCli(['goal', 'set', g.id, '--teams', 'neo,api', '--lead-team', 'neo'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^SET G-001 tier null needs_ui null budget \d+ teams neo,api lead neo$/m);
  const bad = runCli(['goal', 'set', g.id, '--teams', 'nope'], { home });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown team "nope"/);
  const e = runCli(['epic', 'new', '--goal', g.id, '--title', 'X', '--repo', 'project-neo', '--team', 'api', '--json'], { home });
  assert.equal(e.code, 0, e.stderr);
  assert.equal(JSON.parse(e.stdout).team, 'api');
});

test('tracker.intake links the source item (tracker_ref) and maps tracker team keys to goal.teams; the same remote item is never a second goal', async () => {
  const { home } = await makeHome();
  const cfg = await lib('config');
  cfg.merge(home, { workspace: { enabled: true, default_repo: 'dealerpull-api' }, repos: { 'dealerpull-api': { path: 'dealerpull-api' }, 'project-neo': { path: 'project-neo' } }, teams: { ...TEAMS, neo: { ...TEAMS.neo, tracker: { team_key: 'neo' } } }, tracker: { provider: 'linear' } });
  const inbox = await lib('inbox');
  const store = await lib('store');
  const payload = { remote_id: 'prj-9', remote_key: 'Checkout', key: 'Checkout', url: 'https://linear.app/p/9', kind: 'project', teams: ['NEO', 'PRO'], title: 'Checkout v2', labels: ['factory'], body: '' };
  inbox.write(home, { type: 'tracker.intake', payload, source: 'tracker', actor: { kind: 'tracker' } });
  inbox.write(home, { type: 'tracker.intake', payload, source: 'tracker', actor: { kind: 'tracker' } });
  const res = await inbox.process(home, { tick: 1 });
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied']);
  assert.match(res[1].reason, /already linked as G-001/);
  const g = store.get(home, 'goal', 'G-001');
  assert.equal(g.status, 'draft');
  assert.deepEqual(g.tracker_ref, { provider: 'linear', remote_id: 'prj-9', key: 'Checkout', url: 'https://linear.app/p/9', kind: 'project' });
  assert.deepEqual(g.teams.slice(0, 2), ['neo', 'product'], 'lower-case config key neo matches NEO');
  assert.equal(store.list(home, 'goal').length, 1);
  void cfg;
});
