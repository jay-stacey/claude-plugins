// Contracts 21 (A10): reports, cycles and baseline slices, teams in the config slice, goal kinds, stream item status,
// team filters, cycle chips, improvement gates and the demo data that shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FactoryState, REPORTS_CAP } from '../server/state.mjs';
import { Artifacts, ArtifactError } from '../server/artifacts.mjs';
import { startServer } from '../server/server.mjs';
import { validateRequest, diskLookup } from '../server/inbox.mjs';
import { addDemoExtras } from '../server/demo.mjs';
import { tempProject, sse } from './helpers.mjs';
import {
  itemStatus, effectiveStatus, streamItems, goalKind, goalInTeam, inTeam, taskMatches, cycleChips, teamList, changeLines, indexBy,
} from '../public/js/lib/model.mjs';
import { kindWord, itemClassWord } from '../public/js/lib/format.mjs';

const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const T0 = Date.parse('2026-10-10T08:00:00.000Z');
const HOUR = 3600 * 1000;

function load(t) {
  const st = new FactoryState({ home: t.home, projectDir: t.project });
  st.refresh({ full: true });
  return st;
}
// Writes a document with a fixed modified time, `hours` after T0.
function doc(t, rel, text, hours) {
  const f = path.join(t.home, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const when = new Date(T0 + hours * HOUR);
  fs.utimesSync(f, when, when);
}

// ---------- reports slice ----------

test('reports: none in the fixture', () => {
  const t = tempProject();
  try {
    assert.deepEqual(load(t).snapshot().reports, []);
  } finally { t.cleanup(); }
});

test('reports: every document kind is listed newest first with its title, kind, size and a home-relative path', () => {
  const t = tempProject();
  try {
    doc(t, 'docs/reports/2026-10-09-0700-periodic.md', '# CTO report, 9 October\n\nBody.\n', 1);
    doc(t, 'docs/baseline/assessment-2026-10-09.md', 'No heading in this one.\n', 2);
    doc(t, 'docs/cycles/web-3-plan.md', '# Web cycle 3 plan\n', 3);
    doc(t, 'docs/baseline/teams/web.md', '# Web team baseline\n', 4);
    doc(t, 'docs/baseline/factory.md', '# Factory baseline\n', 5);
    doc(t, 'docs/reports/2026-10-10-0700-idle.md', '# CTO report, 10 October (idle)\n', 6);
    // Not listed: wrong extension, wrong name, wrong folder.
    doc(t, 'docs/reports/notes.txt', 'x', 7);
    doc(t, 'docs/baseline/random.md', '# Random\n', 8);
    doc(t, 'docs/G-001-vin-decoder/extra.md', '# Not a report\n', 9);
    const list = load(t).snapshot().reports;
    assert.deepEqual(list.map((r) => r.path), [
      'docs/reports/2026-10-10-0700-idle.md', 'docs/baseline/factory.md', 'docs/baseline/teams/web.md', 'docs/cycles/web-3-plan.md',
      'docs/baseline/assessment-2026-10-09.md', 'docs/reports/2026-10-09-0700-periodic.md']);
    assert.deepEqual(list.map((r) => r.kind), ['report', 'baseline', 'team_baseline', 'cycle', 'assessment', 'report']);
    assert.equal(list[0].title, 'CTO report, 10 October (idle)');
    assert.equal(list[4].title, 'assessment-2026-10-09.md', 'no heading: the file name is the title');
    assert.equal(list[0].mtime, new Date(T0 + 6 * HOUR).toISOString());
    assert.equal(list[0].size, Buffer.byteLength('# CTO report, 10 October (idle)\n'));
    assert.ok(list.every((r) => !r.path.includes('\\') && !path.isAbsolute(r.path)));
  } finally { t.cleanup(); }
});

test('reports: a newer modified time moves a document to the top, and equal times fall back to the path', () => {
  const t = tempProject();
  try {
    doc(t, 'docs/reports/a.md', '# A\n', 1);
    doc(t, 'docs/reports/b.md', '# B\n', 1);
    doc(t, 'docs/reports/c.md', '# C\n', 0);
    assert.deepEqual(load(t).snapshot().reports.map((r) => r.title), ['B', 'A', 'C']);
    doc(t, 'docs/reports/c.md', '# C again\n', 5);
    assert.deepEqual(load(t).snapshot().reports.map((r) => r.title), ['C again', 'B', 'A']);
  } finally { t.cleanup(); }
});

test('reports: the list is capped at 200 and keeps the newest', () => {
  const t = tempProject();
  try {
    for (let i = 0; i < REPORTS_CAP + 5; i++) doc(t, `docs/reports/r-${String(i).padStart(3, '0')}.md`, `# Report ${i}\n`, i);
    const list = load(t).snapshot().reports;
    assert.equal(list.length, REPORTS_CAP);
    assert.equal(list[0].title, `Report ${REPORTS_CAP + 4}`);
    assert.equal(list.at(-1).title, 'Report 5');
  } finally { t.cleanup(); }
});

test('reports: change detection reports the slice only when the listing changes', () => {
  const t = tempProject();
  try {
    const st = load(t);
    assert.equal(st.refresh().slices.reports, undefined, 'nothing changed');
    doc(t, 'docs/reports/new.md', '# New report\n', 1);
    const first = st.refresh().slices.reports;
    assert.deepEqual(first.map((r) => r.title), ['New report']);
    assert.equal(st.snapshot().reports.length, 1);
    assert.equal(st.refresh().slices.reports, undefined, 'settled');
    doc(t, 'docs/unrelated.md', '# Elsewhere\n', 2);
    assert.equal(st.refresh().slices.reports, undefined, 'a file outside the report folders is ignored');
    doc(t, 'docs/reports/new.md', '# New report, edited and longer\n', 3);
    assert.equal(st.refresh().slices.reports[0].title, 'New report, edited and longer', 'an edited title is read again');
  } finally { t.cleanup(); }
});

test('reports: a new report reaches an open stream as a patch', async () => {
  const t = tempProject();
  const s = await startServer({ home: t.home, projectDir: t.project, port: 0, pollMs: 100, log: () => {} });
  const c = sse(s.port, s.token);
  try {
    const snap = await c.waitFor((x) => x.event === 'snapshot');
    assert.deepEqual(snap.data.reports, []);
    doc(t, 'docs/reports/live.md', '# Live report\n', 1);
    const m = await c.waitFor((x) => x.event === 'patch' && x.data.slices.reports?.some((r) => r.title === 'Live report'));
    assert.equal(m.data.slices.reports[0].kind, 'report');
  } finally { c.close(); await s.close(); t.cleanup(); }
});

// ---------- artifacts ----------

test('artifacts: report, assessment, cycle plan and baseline documents open as markdown; state files stay closed', () => {
  const t = tempProject();
  try {
    doc(t, 'docs/reports/2026-10-10-0700-periodic.md', '# CTO report\n\nHeadline.\n', 1);
    doc(t, 'docs/baseline/assessment-2026-10-10.md', '# Assessment\n', 1);
    doc(t, 'docs/cycles/web-3-plan.md', '# Plan\n', 1);
    doc(t, 'docs/baseline/teams/web.md', '# Web\n', 1);
    doc(t, 'docs/baseline/factory.md', '# Factory\n', 1);
    writeJson(path.join(t.home, 'state', 'baseline.json'), { v: 1, at: '2026-10-10T08:00:00.000Z', repos: {} });
    const st = load(t);
    const a = new Artifacts({ home: t.home, projectDir: t.project, referenced: () => st.referencedPaths() });
    for (const r of st.snapshot().reports) {
      const out = a.read(r.path);
      assert.equal(out.kind, 'markdown', r.path);
      assert.match(out.text, /^# /, r.path);
    }
    assert.match(a.read('docs/reports/2026-10-10-0700-periodic.md').text, /Headline\./);
    assert.throws(() => a.read('state/baseline.json'), (e) => e instanceof ArtifactError && e.status === 403);
  } finally { t.cleanup(); }
});

// ---------- cycles and baseline ----------

test('cycles: null when the file is missing, the file as written when present, null again when removed', () => {
  const t = tempProject();
  try {
    const st = load(t);
    assert.equal(st.snapshot().cycles, null);
    const file = path.join(t.home, 'state', 'cycles.json');
    const cycles = { v: 1, updated_at: '2026-10-10T00:00:00.000Z', teams: { web: { previous: null, current: { id: 'web-3', team: 'web', number: 3, name: null,
      starts_at: '2026-10-05T00:00:00.000Z', ends_at: '2026-10-19T00:00:00.000Z', source: 'local', tracker_id: null }, next: null } } };
    writeJson(file, cycles);
    assert.deepEqual(st.refresh().slices.cycles, cycles);
    assert.deepEqual(st.snapshot().cycles, cycles);
    assert.equal(st.refresh().slices.cycles, undefined, 'settled');
    fs.rmSync(file);
    assert.equal(st.refresh().slices.cycles, null);
    assert.equal(st.snapshot().cycles, null);
  } finally { t.cleanup(); }
});

test('baseline_summary: null when missing; time, open PRs, non-factory PRs and branches per repo when present', () => {
  const t = tempProject();
  try {
    const st = load(t);
    assert.equal(st.snapshot().baseline_summary, null);
    writeJson(path.join(t.home, 'state', 'baseline.json'), { v: 1, at: '2026-10-10T07:00:00.000Z', repos: {
      api: { team: 'platform', open_prs: [{ number: 1, factory: false }, { number: 2, factory: true }, { number: 3 }], pr_error: null, branches: [{ name: 'x' }] },
      web: { team: 'web', open_prs: [], pr_error: 'gh is not installed', branches: [] },
      odd: null,
    } });
    const sum = st.refresh().slices.baseline_summary;
    assert.equal(sum.at, '2026-10-10T07:00:00.000Z');
    assert.deepEqual(sum.repos, [
      { repo: 'api', team: 'platform', open_prs: 3, non_factory_prs: 2, branches: 1, pr_error: null },
      { repo: 'web', team: 'web', open_prs: 0, non_factory_prs: 0, branches: 0, pr_error: 'gh is not installed' },
      { repo: 'odd', team: null, open_prs: 0, non_factory_prs: 0, branches: 0, pr_error: null },
    ]);
    assert.deepEqual(st.snapshot().baseline_summary, sum);
    fs.rmSync(path.join(t.home, 'state', 'baseline.json'));
    assert.equal(st.refresh().slices.baseline_summary, null);
  } finally { t.cleanup(); }
});

test('factory slice carries the reports and baseline sections of factory.json, and null when absent', () => {
  const t = tempProject();
  try {
    assert.equal(load(t).factorySlice().reports, null);
    assert.equal(load(t).factorySlice().baseline, null);
    const f = path.join(t.home, 'state', 'factory.json');
    writeJson(f, { ...readJson(f), reports: { last_at: '2026-10-10T07:00:00.000Z', last_path: 'docs/reports/x.md', last_type: 'periodic', last_task_id: 'T-0101' },
      baseline: { last_collect_at: '2026-10-10T06:00:00.000Z', last_assess_at: null, assess_requested: true } });
    const slice = load(t).factorySlice();
    assert.equal(slice.reports.last_path, 'docs/reports/x.md');
    assert.equal(slice.baseline.assess_requested, true);
  } finally { t.cleanup(); }
});

// ---------- config slice ----------

test('config slice: no teams, streams and cycles off and reports on by default', () => {
  const t = tempProject();
  try {
    const c = load(t).snapshot().config;
    assert.deepEqual(c.teams, []);
    assert.deepEqual(c.streams, { enabled: false });
    assert.deepEqual(c.cycles, { enabled: false });
    assert.deepEqual(c.reports, { enabled: true });
    assert.deepEqual(teamList(load(t).snapshot()), []);
  } finally { t.cleanup(); }
});

test('config slice: teams, streams, cycles and reports switches reach the client', () => {
  const t = tempProject();
  try {
    const file = path.join(t.home, 'config.json');
    writeJson(file, { ...readJson(file),
      teams: {
        product: { name: 'Product', kind: 'product', parent: null, repos: [], roles: ['product-manager'], tracker: { team_key: 'PRO' } },
        neo: { name: 'NEO', kind: 'engineering', parent: 'engineering', repos: ['project-neo'], roles: [], tracker: { team_key: null } },
        bare: { kind: 'other' },
      },
      streams: { enabled: true }, cycles: { enabled: true }, reports: { enabled: false } });
    const c = load(t).snapshot().config;
    assert.deepEqual(c.teams, [
      { id: 'product', name: 'Product', kind: 'product', parent: null, repos: [], tracker_key: 'PRO' },
      { id: 'neo', name: 'NEO', kind: 'engineering', parent: 'engineering', repos: ['project-neo'], tracker_key: null },
      { id: 'bare', name: 'bare', kind: 'other', parent: null, repos: [], tracker_key: null },
    ]);
    assert.deepEqual([c.streams.enabled, c.cycles.enabled, c.reports.enabled], [true, true, false]);
  } finally { t.cleanup(); }
});

test('goals, tasks and epics keep their kind, team and item fields', () => {
  const t = tempProject();
  try {
    const g = path.join(t.home, 'goals', 'G-003.json');
    writeJson(g, { ...readJson(g), kind: 'stream', team: 'web', teams: ['web', 'api'] });
    const k = path.join(t.home, 'tasks', 'T-0007.json');
    writeJson(k, { ...readJson(k), kind: 'triage', team: 'web', item: { class: 'bug' }, item_epic_ids: ['E-0001'] });
    const snap = load(t).snapshot();
    assert.deepEqual([snap.goals.find((x) => x.id === 'G-003').kind, snap.goals.find((x) => x.id === 'G-003').team], ['stream', 'web']);
    const task = snap.tasks.find((x) => x.id === 'T-0007');
    assert.deepEqual([task.kind, task.team, task.item.class, task.item_epic_ids], ['triage', 'web', 'bug', ['E-0001']]);
  } finally { t.cleanup(); }
});

// ---------- model: item effective status (contracts 21.4.6) ----------

const epics = (o) => indexBy(Object.entries(o).map(([id, status]) => ({ id, status })));
const item = (status, ids) => ({ id: 'T-1', kind: 'triage', status, item_epic_ids: ids });

test('itemStatus: a triage task that is not done keeps its own status', () => {
  const e = epics({ 'E-1': 'done' });
  for (const s of ['draft', 'backlog', 'ready', 'in_progress', 'blocked', 'failed', 'paused', 'cancelled']) assert.equal(itemStatus(item(s, ['E-1']), e), s);
});

test('itemStatus: done without epics is done', () => {
  assert.equal(itemStatus(item('done', []), epics({})), 'done');
  assert.equal(itemStatus({ id: 'T-1', kind: 'triage', status: 'done' }, epics({})), 'done');
});

test('itemStatus: done with epics: all done is done, all cancelled is cancelled', () => {
  assert.equal(itemStatus(item('done', ['E-1', 'E-2']), epics({ 'E-1': 'done', 'E-2': 'done' })), 'done');
  assert.equal(itemStatus(item('done', ['E-1', 'E-2']), epics({ 'E-1': 'cancelled', 'E-2': 'cancelled' })), 'cancelled');
});

test('itemStatus: done with epics: any pr_open is in_review, otherwise in_progress', () => {
  assert.equal(itemStatus(item('done', ['E-1']), epics({ 'E-1': 'pr_open' })), 'in_review');
  assert.equal(itemStatus(item('done', ['E-1', 'E-2']), epics({ 'E-1': 'done', 'E-2': 'pr_open' })), 'in_review');
  assert.equal(itemStatus(item('done', ['E-1']), epics({ 'E-1': 'building' })), 'in_progress');
  assert.equal(itemStatus(item('done', ['E-1', 'E-2']), epics({ 'E-1': 'done', 'E-2': 'building' })), 'in_progress');
  assert.equal(itemStatus(item('done', ['E-1', 'E-2']), epics({ 'E-1': 'done', 'E-2': 'cancelled' })), 'done', 'done plus cancelled with none open is done');
  assert.equal(itemStatus(item('done', ['E-9']), epics({})), 'in_progress', 'an epic that is not in the snapshot is still open');
});

test('effectiveStatus: only triage tasks take the item status', () => {
  const e = epics({ 'E-1': 'pr_open' });
  assert.equal(effectiveStatus(item('done', ['E-1']), e), 'in_review');
  assert.equal(effectiveStatus({ id: 'T-2', kind: 'code', status: 'done', item_epic_ids: ['E-1'] }, e), 'done');
  assert.equal(effectiveStatus(null, e), null);
});

test('streamItems: only the stream goal items, most urgent first, with their effective status', () => {
  const snap = {
    epics: [{ id: 'E-1', status: 'pr_open' }],
    tasks: [
      { id: 'T-3', goal_id: 'G-5', kind: 'triage', status: 'ready', priority: 'P2' },
      { id: 'T-2', goal_id: 'G-5', kind: 'triage', status: 'done', priority: 'P0', item_epic_ids: ['E-1'] },
      { id: 'T-1', goal_id: 'G-5', kind: 'triage', status: 'ready', priority: 'P2' },
      { id: 'T-4', goal_id: 'G-5', kind: 'code', status: 'ready', priority: 'P0' },
      { id: 'T-5', goal_id: 'G-6', kind: 'triage', status: 'ready', priority: 'P0' },
      { id: 'T-6', goal_id: 'G-5', kind: 'triage', status: 'cancelled', priority: 'P0' },
    ],
  };
  assert.deepEqual(streamItems('G-5', snap).map((i) => [i.task.id, i.status]), [['T-2', 'in_review'], ['T-1', 'ready'], ['T-3', 'ready']]);
});

// ---------- model: kinds, teams, cycles ----------

test('goalKind: stream and ops are kept, anything else is a normal goal', () => {
  assert.equal(goalKind({ kind: 'stream' }), 'stream');
  assert.equal(goalKind({ kind: 'ops' }), 'ops');
  assert.equal(goalKind({ kind: 'goal' }), 'goal');
  assert.equal(goalKind({}), 'goal');
  assert.equal(goalKind({ kind: 'weird' }), 'goal');
  assert.equal(goalKind(undefined), 'goal');
});

test('team filter: tasks and epics use team, goals use teams[] or team', () => {
  assert.equal(taskMatches({ id: 'T-1', team: 'web' }, { team: 'web' }), true);
  assert.equal(taskMatches({ id: 'T-1', team: 'web' }, { team: 'api' }), false);
  assert.equal(taskMatches({ id: 'T-1' }, { team: 'api' }), false);
  assert.equal(taskMatches({ id: 'T-1' }, {}), true);
  assert.equal(inTeam({ team: 'web' }, 'web'), true);
  assert.equal(inTeam({ team: 'web' }, 'api'), false);
  assert.equal(inTeam({}, ''), true);
  assert.equal(goalInTeam({ teams: ['web', 'api'] }, 'api'), true);
  assert.equal(goalInTeam({ team: 'web', teams: [] }, 'web'), true);
  assert.equal(goalInTeam({ teams: ['web'] }, 'api'), false);
  assert.equal(goalInTeam({}, 'api'), false);
  assert.equal(goalInTeam({}, ''), true);
});

test('cycleChips: nothing while cycles are off or the file is missing', () => {
  const teams = { web: { current: { number: 3, ends_at: '2026-10-19T00:00:00.000Z' } } };
  assert.deepEqual(cycleChips({ config: { cycles: { enabled: false } }, cycles: { teams } }), []);
  assert.deepEqual(cycleChips({ config: { cycles: { enabled: true } }, cycles: null }), []);
  assert.deepEqual(cycleChips({ config: {}, cycles: { teams } }), []);
});

test('cycleChips: number and days left per team, in config order, with team names', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const snap = {
    config: { cycles: { enabled: true }, teams: [{ id: 'neo', name: 'NEO' }, { id: 'api', name: 'Backend' }] },
    cycles: { teams: {
      api: { previous: null, current: { number: 7, ends_at: '2026-10-15T00:00:00.000Z' }, next: null },
      neo: { previous: null, current: { number: 4, ends_at: '2026-10-19T00:00:00.000Z' }, next: null },
      ghost: { previous: null, current: { number: 1, ends_at: '2026-10-14T11:00:00.000Z' }, next: null },
      idle: { previous: null, current: null, next: null },
    } },
  };
  assert.deepEqual(cycleChips(snap, now).map((c) => [c.team, c.name, c.number, c.days_left, c.text]), [
    ['neo', 'NEO', 4, 5, '#4, 5 days left'],
    ['api', 'Backend', 7, 1, '#7, 1 day left'],
    ['ghost', 'ghost', 1, 0, '#1, ends today'],
  ]);
});

// ---------- model and format: labels, proposals ----------

test('labels: new task kinds and item classes read as words', () => {
  assert.equal(kindWord('assess'), 'Assessment');
  assert.equal(kindWord('report'), 'CTO report');
  assert.equal(kindWord('cycle_plan'), 'Cycle plan');
  assert.equal(kindWord('triage'), 'Triage');
  assert.equal(kindWord('qa_goal'), 'Cross-repo QA');
  assert.equal(kindWord('code'), 'code');
  assert.equal(itemClassWord('tech_debt'), 'Tech debt');
  assert.equal(itemClassWord('bug'), 'Bug');
  assert.equal(itemClassWord(undefined), '');
});

test('changeLines: a config patch is key = value lines, an overlay note keeps its role, advice has no lines', () => {
  assert.deepEqual(changeLines({ kind: 'config', patch: { 'concurrency.builders': 4, 'reviews.profile': 'strict', 'reports.enabled': true } }),
    { kind: 'config', lines: ['concurrency.builders = 4', 'reviews.profile = "strict"', 'reports.enabled = true'] });
  assert.deepEqual(changeLines({ kind: 'overlay_note', role: 'code-reviewer', note: 'Check lint first.' }), { kind: 'overlay_note', role: 'code-reviewer', lines: ['Check lint first.'] });
  assert.deepEqual(changeLines({ kind: 'advice' }), { kind: 'advice', lines: [] });
  assert.deepEqual(changeLines(undefined), { kind: 'advice', lines: [] });
  assert.deepEqual(changeLines({ kind: 'config' }), { kind: 'config', lines: [] });
});

// ---------- inbox: improvement gates use the existing signed decision ----------

test('gate.decide accepts an improvement gate; reject still needs a reason', () => {
  const t = tempProject();
  try {
    addDemoExtras(t.home, T0);
    const look = diskLookup(t.home);
    assert.equal(look.gate('GATE-0008').type, 'improvement');
    assert.deepEqual(validateRequest('gate.decide', { gate_id: 'GATE-0008', decision: 'approve' }, look).errors, []);
    assert.deepEqual(validateRequest('gate.decide', { gate_id: 'GATE-0008', decision: 'reject', notes: 'Not now.' }, look).errors, []);
    assert.ok(validateRequest('gate.decide', { gate_id: 'GATE-0008', decision: 'reject' }, look).errors.length > 0);
  } finally { t.cleanup(); }
});

// ---------- demo data ----------

test('demo extras show teams, kinds, an item in every effective state, cycles, a baseline, reports and an improvement gate', () => {
  const t = tempProject();
  try {
    addDemoExtras(t.home, T0);
    const snap = load(t).snapshot();
    assert.deepEqual(snap.config.teams.map((x) => x.id), ['web', 'platform']);
    assert.deepEqual([snap.config.streams.enabled, snap.config.cycles.enabled], [true, true]);
    assert.deepEqual(snap.goals.filter((g) => goalKind(g) !== 'goal').map((g) => [g.id, g.kind]), [['G-004', 'ops'], ['G-005', 'stream']]);
    assert.ok(snap.goals.filter((g) => goalKind(g) === 'goal').every((g) => goalInTeam(g, 'web')));
    assert.deepEqual(streamItems('G-005', snap).map((i) => [i.task.id, i.status]), [['T-0102', 'ready'], ['T-0103', 'in_review'], ['T-0105', 'blocked'], ['T-0104', 'done']]);
    const gate = snap.gates.find((g) => g.id === 'GATE-0008');
    assert.equal(gate.status, 'pending');
    assert.equal(gate.request.proposal.change.kind, 'config');
    assert.ok(gate.artifact.paths.every((p) => snap.reports.some((r) => r.path === p)), 'the gate links a listed report');
    assert.deepEqual([...new Set(snap.reports.map((r) => r.kind))].sort(), ['assessment', 'baseline', 'cycle', 'report', 'team_baseline']);
    assert.equal(snap.reports.find((r) => r.kind === 'report').path, gate.artifact.paths[0], 'the latest report is the one the gate links');
    assert.equal(snap.baseline_summary.repos.length, 2);
    assert.equal(cycleChips(snap, T0 + 5 * 24 * HOUR).length, 2);
    assert.equal(snap.factory.reports.last_path, gate.artifact.paths[0]);
    assert.ok(snap.tasks.filter((x) => x.kind === 'report' || x.kind === 'triage').length >= 5);
  } finally { t.cleanup(); }
});
