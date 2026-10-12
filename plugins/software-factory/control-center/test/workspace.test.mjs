// Workspace mode (contracts 20): repo passthrough, the goal_qa epic status and the qa_goal task kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FactoryState } from '../server/state.mjs';
import { tempProject } from './helpers.mjs';
import { isWorkspace, workspaceRepos, goalRepos, taskMatches, epicProgress } from '../public/js/lib/model.mjs';
import { statusWord, kindWord } from '../public/js/lib/format.mjs';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');

function load(t) {
  const st = new FactoryState({ home: t.home, projectDir: t.project });
  st.refresh({ full: true });
  return st;
}

// Turns the classic fixture into a two-repo workspace: E-0001 in api, E-0002 in web (goal_qa), plus a qa_goal task.
function makeWorkspace(t) {
  const cfgFile = path.join(t.home, 'config.json');
  writeJson(cfgFile, { ...readJson(cfgFile), workspace: { enabled: true, default_repo: 'api' }, repos: { api: { path: 'api' }, web: { path: 'web' } } });
  const setEpic = (id, patch) => { const f = path.join(t.home, 'epics', `${id}.json`); writeJson(f, { ...readJson(f), ...patch }); };
  setEpic('E-0001', { repo: 'api' });
  setEpic('E-0002', { repo: 'web', status: 'goal_qa' });
  const tdir = path.join(t.home, 'tasks');
  for (const n of fs.readdirSync(tdir)) {
    const f = path.join(tdir, n);
    const task = readJson(f);
    if (task.epic_id) writeJson(f, { ...task, repo: task.epic_id === 'E-0001' ? 'api' : 'web' });
  }
  const base = readJson(path.join(tdir, 'T-0001.json'));
  writeJson(path.join(tdir, 'T-0100.json'), { ...base, id: 'T-0100', goal_id: 'G-001', epic_id: null, repo: null, kind: 'qa_goal', role: 'qa-engineer',
    title: 'Cross-repo QA for G-001', status: 'ready', runs: [], current_run_id: null });
  return readJson(path.join(tdir, 'T-0007.json')).runs.at(-1);
}

test('classic config: workspace is off and no repo is exposed', () => {
  const t = tempProject();
  try {
    const snap = load(t).snapshot();
    assert.deepEqual(snap.config.workspace, { enabled: false, default_repo: null, repos: [] });
    assert.equal(isWorkspace(snap), false);
    assert.deepEqual(workspaceRepos(snap), []);
  } finally { t.cleanup(); }
});

test('workspace config reaches the client slice; repo passes through epics, tasks and runs', () => {
  const t = tempProject();
  try {
    const runId = makeWorkspace(t);
    const runFile = path.join(t.home, 'runs', runId, 'run.json');
    writeJson(runFile, { ...readJson(runFile), repo: 'api' });
    const st = load(t);
    const snap = st.snapshot();
    assert.deepEqual(snap.config.workspace, { enabled: true, default_repo: 'api', repos: ['api', 'web'] });
    assert.equal(isWorkspace(snap), true);
    assert.deepEqual(workspaceRepos(snap), ['api', 'web']);
    assert.equal(snap.epics.find((e) => e.id === 'E-0001').repo, 'api');
    assert.equal(snap.epics.find((e) => e.id === 'E-0002').status, 'goal_qa');
    assert.equal(snap.tasks.find((x) => x.id === 'T-0007').repo, 'api');
    const qa = snap.tasks.find((x) => x.id === 'T-0100');
    assert.equal(qa.kind, 'qa_goal');
    assert.equal(qa.epic_id, null);
    assert.equal(qa.repo, null);
    assert.equal(st.records.runs.get(runId).repo, 'api');
    assert.deepEqual(goalRepos('G-001', snap).sort(), ['api', 'web']);
  } finally { t.cleanup(); }
});

test('workspace needs at least one repo to count as on', () => {
  const t = tempProject();
  try {
    const f = path.join(t.home, 'config.json');
    writeJson(f, { ...readJson(f), workspace: { enabled: true }, repos: {} });
    assert.equal(load(t).snapshot().config.workspace.enabled, false);
  } finally { t.cleanup(); }
});

test('repo filter keeps only matching tasks', () => {
  assert.equal(taskMatches({ goal_id: 'G-1', role: 'x', repo: 'api' }, { repo: 'api' }), true);
  assert.equal(taskMatches({ goal_id: 'G-1', role: 'x', repo: 'web' }, { repo: 'api' }), false);
  assert.equal(taskMatches({ goal_id: 'G-1', role: 'x', repo: null }, { repo: 'api' }), false);
  assert.equal(taskMatches({ goal_id: 'G-1', role: 'x', repo: null }, {}), true);
});

test('goal_qa and qa_goal have plain labels', () => {
  assert.equal(statusWord('goal_qa'), 'Cross-repo QA');
  assert.equal(kindWord('qa_goal'), 'Cross-repo QA');
  assert.equal(kindWord('code'), 'code');
});

test('epic progress: classic steps are unchanged, workspace adds a cross-repo QA step', () => {
  const none = new Map();
  const ids = (e, o) => epicProgress(e, none, o).map((s) => `${s.id}:${s.state}`);
  assert.deepEqual(ids({ status: 'docs' }), ['qa:done', 'review:done', 'docs:current', 'pr_open:todo', 'G4:todo']);
  assert.deepEqual(ids({ status: 'building' }), ['qa:todo', 'review:todo', 'docs:todo', 'pr_open:todo', 'G4:todo']);
  assert.deepEqual(ids({ status: 'done' }), ['qa:done', 'review:done', 'docs:done', 'pr_open:done', 'G4:done']);
  assert.deepEqual(ids({ status: 'goal_qa' }, { workspace: true }), ['qa:done', 'review:done', 'docs:done', 'goal_qa:current', 'pr_open:todo', 'G4:todo']);
  assert.deepEqual(ids({ status: 'pr_open' }, { workspace: true }), ['qa:done', 'review:done', 'docs:done', 'goal_qa:done', 'pr_open:current', 'G4:todo']);
  assert.equal(epicProgress({ status: 'goal_qa' }, none)[3].label, 'Cross-repo QA', 'an epic in goal_qa always shows its step');
});
