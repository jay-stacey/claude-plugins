// Linear multi-team sync, projects, linking, stream items, cycles and the team snapshot (contracts §21.3, §21.4.5-6, §21.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncHome, fakeLinear, makeClock, ENV, core, lib, inboxFiles, readSync, approveFirstSync, rawConfig, patchRecord, writeCycles } from './_sync.mjs';

// Distinct ids per team: team-pro, team-eng, team-neo, team-ops (configured) and team-xtr (not configured).
const TEAMS = [
  { id: 'team-pro', key: 'PRO', name: 'Product', parent: null },
  { id: 'team-eng', key: 'ENG', name: 'Engineering', parent: null },
  { id: 'team-neo', key: 'NEO', name: 'Neo', parent: 'ENG' },
  { id: 'team-ops', key: 'OPS', name: 'Backend Services', parent: 'ENG' },
  { id: 'team-xtr', key: 'XTR', name: 'Other', parent: null },
];
const CFG_TEAMS = {
  product: { name: 'Product', kind: 'product', parent: null, repos: [], roles: ['product-manager'], tracker: { team_key: 'PRO' } },
  engineering: { name: 'Engineering', kind: 'engineering', parent: null, repos: [], roles: ['staff-engineer'], tracker: { team_key: 'ENG' } },
  neo: { name: 'NEO', kind: 'engineering', parent: 'engineering', repos: ['r'], roles: [], tracker: { team_key: 'NEO' } },
  api: { name: 'Backend Services', kind: 'engineering', parent: 'engineering', repos: ['api'], roles: [], tracker: { team_key: 'OPS' } },
};
const S = (name, team) => `s-${name}@${team}`;

async function setup({ tracker = {}, streams = null, cycles = null, teams = CFG_TEAMS, approve = true } = {}) {
  const h = await syncHome({ provider: 'linear' });
  await rawConfig(h.home, { teams, tracker, ...(streams ? { streams } : {}), ...(cycles ? { cycles } : {}) });
  const clock = makeClock();
  const fake = fakeLinear({ clock, teams: TEAMS });
  const intake = Object.fromEntries(TEAMS.map((tm) => [tm.id, fake.human.label('factory-intake', tm.id).id]));
  const bug = Object.fromEntries(TEAMS.map((tm) => [tm.id, fake.human.label('bug', tm.id).id]));
  const e = await core('engine');
  if (approve) await approveFirstSync(h.home);
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  const tick = async (mode) => { const r = await e.syncTick({ projectDir: h.repo, ...(mode ? { mode } : {}) }, d); clock.advance(1000); return r; };
  return { ...h, clock, fake, e, d, tick, intake, bug };
}

async function goal(home, fields = {}) {
  const a = await lib('actions');
  const g = a.newGoal(home, { title: fields.title || 'Cross-team export', outcome: fields.outcome || 'Dealers export deals.', success_criteria: ['Export works'] });
  return patchRecord(home, 'goal', g.id, fields);
}

let n = 0;
async function task(home, goalId, fields = {}, kind = 'spec') {
  const a = await lib('actions');
  const t = a.createTask(home, { goal_id: goalId, kind: kind === 'triage' ? 'spec' : kind, title: fields.title || `Task ${++n}`, description: 'Do the work.', status: 'ready', acceptance_criteria: ['Works'] });
  return patchRecord(home, 'task', t.id, { ...fields, ...(kind === 'triage' ? { kind: 'triage', role: 'staff-engineer' } : {}) });
}

async function putEpic(home, id, status) {
  const store = await lib('store');
  const { writeJsonAtomic } = await lib('fsutil');
  writeJsonAtomic(store.fileFor(home, 'epic', id), { schema: 'factory/epic@1', id, rev: 1, goal_id: null, title: id, status, tasks: [] });
}

const created = (fake, m = 'issueCreate') => fake.st.inputs.filter((x) => x.m === m);
const issueOf = (fake, rid) => fake.st.issues.get(rid);

test('multi-team: each issue is created in its own team, labels and status maps are per team, entries carry the team', async () => {
  const s = await setup();
  const g = await goal(s.home, { teams: ['neo', 'product', 'api'], lead_team: 'neo' });
  const prd = await task(s.home, g.id, { team: 'product', title: 'PRD for export' }, 'prd');
  const spec = await task(s.home, g.id, { team: 'api', title: 'Spec for export API' });
  await s.tick(); await s.tick();
  const st = readSync(s.home, 'state.json');
  assert.equal(st.scope_key, 'linear:teams');
  assert.deepEqual(Object.keys(st.status_maps).sort(), ['ENG', 'NEO', 'OPS', 'PRO']);
  assert.equal(st.status_maps.PRO.ready.id, S('todo', 'team-pro'));
  const map = readSync(s.home, 'map.json');
  const gi = issueOf(s.fake, map.goals[g.id].remoteId);
  const pi = issueOf(s.fake, map.items[prd.id].remoteId);
  const si = issueOf(s.fake, map.items[spec.id].remoteId);
  assert.equal(gi.teamId, 'team-neo', 'goal issue in the lead team');
  assert.equal(gi.stateId, S('backlog', 'team-neo'));
  assert.equal(pi.teamId, 'team-pro', 'PRD task in the product team');
  assert.equal(si.teamId, 'team-ops', 'spec task in the api team');
  assert.equal(pi.parentId, gi.id, 'sub-issue of the goal issue across teams');
  assert.equal(si.stateId, S('todo', 'team-ops'), 'ready maps through the OPS status map');
  assert.deepEqual([map.goals[g.id].team, map.items[prd.id].team, map.items[spec.id].team], ['NEO', 'PRO', 'OPS']);
  const labelTeams = created(s.fake, 'issueLabelCreate').filter((x) => x.input.name === 'software-factory').map((x) => x.input.teamId).sort();
  assert.deepEqual(labelTeams, ['team-neo', 'team-ops', 'team-pro'], 'the managed label is ensured per team');
  for (const i of [pi, si]) {
    const names = i.labelIds.map((id) => s.fake.st.labels.find((l) => l.id === id));
    assert.ok(names.every((l) => l.teamId === i.teamId), 'labels come from the issue team');
  }
  // the next tick is quiet (echo suppression across teams)
  const before = s.fake.st.mutations.length;
  await s.tick();
  assert.equal(s.fake.st.mutations.length, before);
  assert.equal(inboxFiles(s.home).length, 0);
});

test('goal_mapping project: projectCreate with teamIds (lead first), tasks get projectId in their own team, teams grow by update', async () => {
  const s = await setup({ tracker: { goal_mapping: 'project' } });
  const g = await goal(s.home);
  const t1 = await task(s.home, g.id, { team: 'api' });
  await patchRecord(s.home, 'goal', g.id, { teams: ['product', 'neo'], lead_team: 'neo' }); // after the tasks: the CLI adds task teams to goal.teams
  await s.tick();
  const pc = created(s.fake, 'projectCreate');
  assert.equal(pc.length, 1);
  assert.deepEqual(pc[0].input.teamIds, ['team-neo', 'team-pro']);
  assert.ok(pc[0].input.description.length <= 255);
  assert.match(pc[0].input.content, new RegExp(`sf-id: ${g.id}`));
  const map = readSync(s.home, 'map.json');
  assert.equal(map.goals[g.id].kind, 'project');
  assert.deepEqual(map.goals[g.id].teams, ['NEO', 'PRO']);
  await s.tick();
  const ic = created(s.fake).find((x) => x.input.projectId);
  assert.ok(ic, 'task created with projectId');
  assert.equal(ic.input.teamId, 'team-ops');
  assert.equal(ic.input.projectId, map.goals[g.id].remoteId);
  assert.equal(ic.input.parentId, undefined, 'not a sub-issue');
  assert.equal(readSync(s.home, 'map.json').items[t1.id].team, 'OPS');
  // a human adds a team the factory does not know; the next pull refreshes the project's teams
  s.fake.human.editProject(map.goals[g.id].remoteId, { teamIds: ['team-neo', 'team-pro', 'team-xtr'] });
  await s.tick();
  assert.deepEqual(readSync(s.home, 'map.json').goals[g.id].teams, ['NEO', 'PRO', 'XTR']);
  // goal.teams grows: the project gains the new team and keeps every current one, the human's too
  await patchRecord(s.home, 'goal', g.id, { teams: ['product', 'neo', 'api'] });
  await s.tick();
  const pu = created(s.fake, 'projectUpdate');
  assert.equal(pu.length, 1);
  assert.deepEqual(pu[0].input.teamIds, ['team-neo', 'team-pro', 'team-xtr', 'team-ops']);
  assert.deepEqual(readSync(s.home, 'map.json').goals[g.id].teams, ['NEO', 'PRO', 'XTR', 'OPS']);
  await s.tick();
  assert.equal(created(s.fake, 'projectUpdate').length, 1, 'sent once');
  // redaction covers project names and descriptions
  await goal(s.home, { title: 'Call 555-123-4567', teams: ['neo'], lead_team: 'neo' });
  await s.tick();
  const r = inboxFiles(s.home, 'sync.redaction_blocked');
  assert.equal(r.length, 1);
  assert.equal(r[0].payload.field, 'title');
  assert.equal(created(s.fake, 'projectCreate').length, 1);
});

const refTo = (i, kind = 'issue') => ({ provider: 'linear', remote_id: i.id, key: i.identifier, url: `https://linear.app/x/issue/${i.identifier}`, kind });

test('tracker_ref links existing items instead of creating them; linked text is never overwritten; other teams are scope-blocked', async () => {
  const s = await setup({ streams: { enabled: true, pull: 'intake_label', teams: ['neo', 'api'] } });
  // the human already moved the source issue to In Progress: linking must not move it back
  const src = s.fake.human.create({ title: 'Export deals (from Linear)', description: 'Customer text, no footer', teamId: 'team-neo', stateId: S('prog', 'team-neo') });
  const bugIssue = s.fake.human.create({ title: 'Export button broken', description: 'Steps...', teamId: 'team-ops', stateId: S('backlog', 'team-ops') });
  const foreign = s.fake.human.create({ title: 'Other team', description: 'x', teamId: 'team-xtr', stateId: S('backlog', 'team-xtr') });
  const g = await goal(s.home, { teams: ['neo', 'api'], lead_team: 'neo', tracker_ref: refTo(src) });
  const fresh = await task(s.home, g.id, { team: 'neo' });
  const stream = await goal(s.home, { title: 'Maintenance', kind: 'stream', team: 'api', status: 'active' });
  // stream items keep their ref where the CLI stores it: task.item.tracker_ref
  const linked = await task(s.home, stream.id, { team: 'api', item: { class: 'bug', tracker_ref: refTo(bugIssue), reported_by: 'tracker' } }, 'triage');
  const outside = await task(s.home, stream.id, { team: 'neo', item: { class: 'bug', tracker_ref: refTo(foreign), reported_by: 'tracker' } }, 'triage');
  await s.tick(); await s.tick();
  const map = readSync(s.home, 'map.json');
  assert.equal(map.goals[g.id].remoteId, src.id);
  assert.equal(map.goals[g.id].linked, true);
  assert.equal(map.items[linked.id].remoteId, bugIssue.id);
  assert.equal(map.items[linked.id].team, 'OPS');
  const creates = created(s.fake);
  assert.deepEqual(creates.map((x) => x.input.title), [fresh.title], 'only the record without tracker_ref is created');
  assert.equal(creates[0].input.parentId, src.id, 'and it hangs under the linked goal issue');
  assert.equal(issueOf(s.fake, src.id).description, 'Customer text, no footer', 'linked text untouched');
  assert.equal(issueOf(s.fake, src.id).stateId, S('prog', 'team-neo'), 'a linked goal issue is never moved backward');
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('todo', 'team-ops'), 'a forward status is pushed to the linked item');
  assert.ok(!map.items[outside.id] || !map.items[outside.id].remoteId, 'a ref in an unconfigured team is not linked');
  const blocked = inboxFiles(s.home, 'sync.scope_blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].payload.local_id, outside.id);
  // a local text edit is not pushed over the linked tracker text
  await patchRecord(s.home, 'task', linked.id, { description: 'Factory rewrite' });
  const updates = created(s.fake, 'issueUpdate').length;
  await s.tick();
  assert.equal(created(s.fake, 'issueUpdate').filter((x) => x.input.description !== undefined).length, 0);
  assert.equal(created(s.fake, 'issueUpdate').length, updates);
  // a linked item that goes back in the factory stays where it is in the tracker
  s.fake.human.edit(bugIssue.id, { stateId: S('review', 'team-ops') });
  await s.tick();
  await patchRecord(s.home, 'task', linked.id, { status: 'in_progress' });
  await s.tick();
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('review', 'team-ops'), 'never backward');
  // cancelled in the factory: a comment, never a Canceled state; once
  await patchRecord(s.home, 'task', linked.id, { status: 'cancelled' });
  await patchRecord(s.home, 'goal', g.id, { status: 'cancelled' });
  await s.tick(); await s.tick();
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('review', 'team-ops'));
  assert.equal(issueOf(s.fake, src.id).stateId, S('prog', 'team-neo'));
  const notes = s.fake.st.comments.filter((c) => /was cancelled in the factory/.test(c.body));
  assert.deepEqual(notes.map((c) => c.issueId).sort(), [bugIssue.id, src.id].sort());
});

test('single team: a tracker_ref to an issue of another team is scope-blocked, not linked', async () => {
  const h = await syncHome({ provider: 'linear' }); // scope NEO = team-1
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await core('engine');
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  const mine = fake.human.create({ title: 'Mine', teamId: 'team-1' });
  const other = fake.human.create({ title: 'Theirs', teamId: 'team-2' });
  const g1 = await goal(h.home, { title: 'Linked here', tracker_ref: refTo(mine) });
  const g2 = await goal(h.home, { title: 'Linked elsewhere', tracker_ref: refTo(other) });
  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, d);
  const map = readSync(h.home, 'map.json');
  assert.equal(map.goals[g1.id].remoteId, mine.id);
  assert.ok(!map.goals[g2.id] || !map.goals[g2.id].remoteId);
  const b = inboxFiles(h.home, 'sync.scope_blocked');
  assert.equal(b.length, 1);
  assert.equal(b[0].payload.local_id, g2.id);
  assert.equal(created(fake).length, 0, 'neither is created');
});

async function streamSetup(pull, enabled = true) {
  const s = await setup({ streams: { enabled, pull, teams: ['neo'] } });
  s.fake.st.cycles['team-neo'] = { current: { id: 'cyc-neo-12', number: 12, name: null, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-19T00:00:00Z' }, next: null };
  const mk = (title, teamId, labels, extra = {}) => s.fake.human.create({ title, description: `Body of ${title}`, teamId, stateId: S('backlog', teamId), labelIds: labels, creatorId: 'u-reporter', priority: 2, ...extra });
  const items = {
    a: mk('A bug with intake', 'team-neo', [s.bug['team-neo'], s.intake['team-neo']]),
    b: mk('B bug in cycle', 'team-neo', [s.bug['team-neo']], { cycleId: 'cyc-neo-12' }),
    c: mk('C bug outside cycle', 'team-neo', [s.bug['team-neo']]),
    d: mk('D bug in a non-stream team', 'team-ops', [s.bug['team-ops'], s.intake['team-ops']]),
    e: mk('E plain intake', 'team-neo', [s.intake['team-neo']]),
    f: mk('F closed bug', 'team-neo', [s.bug['team-neo'], s.intake['team-neo']], { stateId: S('done', 'team-neo') }),
  };
  await s.tick('full');
  const name = (rid) => Object.entries(items).find(([, i]) => i.id === rid)[0];
  return { s, items, backlog: inboxFiles(s.home, 'tracker.backlog_item').map((r) => name(r.payload.remote_id)).sort(), intake: inboxFiles(s.home, 'tracker.intake').map((r) => name(r.payload.remote_id)).sort() };
}

test('stream items: tracker.backlog_item follows streams.pull (intake_label, cycle, all), dedupes by remote id, and stays off when streams are off', async () => {
  const il = await streamSetup('intake_label');
  assert.deepEqual(il.backlog, ['a']);
  assert.deepEqual(il.intake, ['d', 'e'], 'a non-stream team and an unclassified item stay goal intake');
  const r = inboxFiles(il.s.home, 'tracker.backlog_item')[0];
  assert.equal(r.dedupe_key, `backlog:${il.items.a.id}`);
  assert.equal(r.auto_apply, true);
  assert.deepEqual(r.payload, { remote_id: il.items.a.id, key: il.items.a.identifier, url: `https://linear.app/x/issue/${il.items.a.identifier}`, team_key: 'NEO', class: 'bug',
    title: 'A bug with intake', body: 'Body of A bug with intake', author_id: 'u-reporter', priority: 'P1', cycle_tracker_id: null });
  // delta: a new labelled bug arrives on the next tick, an old one is not raised twice
  il.s.fake.human.create({ title: 'G new bug', description: 'x', teamId: 'team-neo', stateId: S('todo', 'team-neo'), labelIds: [il.s.bug['team-neo'], il.s.intake['team-neo']], cycleId: 'cyc-neo-12' });
  await il.s.tick();
  await il.s.tick('full');
  const all = inboxFiles(il.s.home, 'tracker.backlog_item');
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.payload.title === 'G new bug').payload.cycle_tracker_id, 'cyc-neo-12');

  const cy = await streamSetup('cycle');
  assert.deepEqual(cy.backlog, ['b']);
  assert.deepEqual(cy.intake, ['d', 'e'], 'a class-labelled intake item waits for its stream rule, it never becomes a goal');
  const al = await streamSetup('all');
  assert.deepEqual(al.backlog, ['a', 'b', 'c']);
  const off = await streamSetup('all', false);
  assert.deepEqual(off.backlog, []);
  assert.deepEqual(off.intake, ['a', 'd', 'e']);
  const intakeA = inboxFiles(off.s.home, 'tracker.intake').find((x) => x.payload.remote_id === off.items.a.id);
  assert.equal(intakeA.payload.key, off.items.a.identifier);
  assert.equal(intakeA.payload.kind, 'issue');
  assert.deepEqual(intakeA.payload.teams, ['NEO']);
});

test('item effective status: mixed done and cancelled epics are done; an unreadable epic counts as open', async () => {
  const { itemStatus } = await core('teams');
  const epics = new Map([['E-1', { status: 'done' }], ['E-2', { status: 'cancelled' }], ['E-3', { status: 'pr_open' }], ['E-4', { status: 'building' }], ['E-5', { status: 'cancelled' }]]);
  const st = (status, ids) => itemStatus({ status, item_epic_ids: ids }, epics);
  assert.equal(st('in_progress', ['E-1']), 'in_progress', 'not done: its own status');
  assert.equal(st('done', []), 'done');
  assert.equal(st('done', ['E-1', 'E-2']), 'done', 'done + cancelled = done');
  assert.equal(st('done', ['E-2', 'E-5']), 'cancelled');
  assert.equal(st('done', ['E-1', 'E-3']), 'in_review');
  assert.equal(st('done', ['E-1', 'E-4']), 'in_progress');
  assert.equal(st('done', ['E-1', 'E-404']), 'in_progress', 'an epic that cannot be read is open');
});

test('stream and ops goals are never pushed; a linked stream item gets its effective status; an unlinked triage item is created in its team', async () => {
  const s = await setup({ streams: { enabled: true, pull: 'intake_label', teams: ['neo', 'api'] } });
  const stream = await goal(s.home, { title: 'NEO maintenance', kind: 'stream', team: 'neo', status: 'active' });
  const ops = await goal(s.home, { title: 'Factory operations', kind: 'ops', status: 'active' });
  const bugIssue = s.fake.human.create({ title: 'Login bug', description: 'Human report', teamId: 'team-neo', stateId: S('backlog', 'team-neo'), labelIds: [s.bug['team-neo']] });
  const item = await task(s.home, stream.id, { team: 'neo', status: 'in_progress', item: { class: 'bug', tracker_ref: { provider: 'linear', remote_id: bugIssue.id, key: bugIssue.identifier, url: 'u', kind: 'issue' }, reported_by: 'tracker' } }, 'triage');
  const local = await task(s.home, stream.id, { team: 'api', title: 'Slow report query', item: { class: 'tech_debt', reported_by: 'agent' } }, 'triage');
  const code = await task(s.home, stream.id, { team: 'neo', title: 'Fix login' });
  const opsTask = await task(s.home, ops.id, { title: 'Ops work' });
  await s.tick();
  const map = readSync(s.home, 'map.json');
  assert.equal(map.goals[stream.id], undefined, 'stream goal not pushed');
  assert.equal(map.goals[ops.id], undefined, 'ops goal not pushed');
  assert.equal(map.items[code.id], undefined, 'stream code task not pushed');
  assert.equal(map.items[opsTask.id], undefined, 'ops task not pushed');
  assert.equal(map.items[item.id].remoteId, bugIssue.id);
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('prog', 'team-neo'));
  const lc = created(s.fake);
  assert.equal(lc.length, 1);
  assert.equal(lc[0].input.title, 'Slow report query');
  assert.equal(lc[0].input.teamId, 'team-ops');
  assert.equal(lc[0].input.parentId, undefined);
  void local;
  // triage done with epics: pr_open -> in_review; done + cancelled -> done
  await putEpic(s.home, 'E-0901', 'pr_open'); await putEpic(s.home, 'E-0902', 'done');
  await patchRecord(s.home, 'task', item.id, { status: 'done', item_epic_ids: ['E-0901', 'E-0902'] });
  await s.tick();
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('review', 'team-neo'));
  await putEpic(s.home, 'E-0901', 'cancelled');
  await s.tick();
  assert.equal(issueOf(s.fake, bugIssue.id).stateId, S('done', 'team-neo'));
  // push_kinds without triage: an unlinked item is not created
  const s2 = await setup({ tracker: { push_kinds: ['spec'] } });
  const st2 = await goal(s2.home, { kind: 'stream', team: 'neo', status: 'active' });
  await task(s2.home, st2.id, { team: 'neo' }, 'triage');
  await s2.tick();
  assert.equal(created(s2.fake).length, 0);
});

test('cycles: tracker.cycles on full pulls (deduped), cycleId on create and on change, a human cycle change becomes tracker.field_update', async () => {
  const s = await setup({ cycles: { enabled: true } });
  s.fake.st.cycles['team-neo'] = { current: { id: 'cyc-neo-12', number: 12, name: 'Sprint 12', startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-19T00:00:00Z' }, next: { id: 'cyc-neo-13', number: 13, name: null, startsAt: '2026-10-19T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' } };
  await writeCycles(s.home, { neo: {
    previous: null,
    current: { id: 'neo-12', team: 'neo', number: 12, name: 'Sprint 12', starts_at: '2026-10-05T00:00:00Z', ends_at: '2026-10-19T00:00:00Z', source: 'tracker', tracker_id: 'cyc-neo-12' },
    next: { id: 'neo-13', team: 'neo', number: 13, name: null, starts_at: '2026-10-19T00:00:00Z', ends_at: '2026-11-02T00:00:00Z', source: 'tracker', tracker_id: 'cyc-neo-13' },
  } });
  const g = await goal(s.home, { teams: ['neo'], lead_team: 'neo' });
  const t = await task(s.home, g.id, { team: 'neo', cycle: 'neo-12' });
  await s.tick('full'); await s.tick();
  const cyc = inboxFiles(s.home, 'tracker.cycles');
  assert.equal(cyc.length, 1);
  assert.equal(cyc[0].auto_apply, true);
  assert.match(cyc[0].dedupe_key, /^cycles:[0-9a-f]{32}$/);
  assert.deepEqual(cyc[0].payload.teams.NEO, { current: { tracker_id: 'cyc-neo-12', number: 12, name: 'Sprint 12', starts_at: '2026-10-05T00:00:00Z', ends_at: '2026-10-19T00:00:00Z' },
    next: { tracker_id: 'cyc-neo-13', number: 13, name: null, starts_at: '2026-10-19T00:00:00Z', ends_at: '2026-11-02T00:00:00Z' } });
  assert.equal(cyc[0].payload.teams.PRO.current, null);
  await s.tick('full');
  assert.equal(inboxFiles(s.home, 'tracker.cycles').length, 1, 'same content is not raised again');
  const rid = readSync(s.home, 'map.json').items[t.id].remoteId;
  assert.equal(created(s.fake).find((x) => x.input.title === t.title).input.cycleId, 'cyc-neo-12');
  // the factory commits the task to the next cycle
  await patchRecord(s.home, 'task', t.id, { cycle: 'neo-13' });
  await s.tick();
  assert.equal(issueOf(s.fake, rid).cycleId, 'cyc-neo-13');
  const pushes = created(s.fake, 'issueUpdate').filter((x) => 'cycleId' in x.input).length;
  assert.equal(pushes, 1);
  // a human moves it back: field_update, and no push back while the CLI has not applied it
  s.fake.human.edit(rid, { cycleId: 'cyc-neo-12' });
  await s.tick();
  const fu = inboxFiles(s.home, 'tracker.field_update').filter((x) => x.payload.field === 'cycle');
  assert.equal(fu.length, 1);
  assert.equal(fu[0].payload.value, 'cyc-neo-12');
  assert.equal(fu[0].payload.task_id, t.id);
  assert.equal(fu[0].auto_apply, true);
  await s.tick();
  assert.equal(created(s.fake, 'issueUpdate').filter((x) => 'cycleId' in x.input).length, pushes, 'not pushed back');
  await patchRecord(s.home, 'task', t.id, { cycle: 'neo-12' }); // the CLI applied it
  await s.tick();
  assert.equal(created(s.fake, 'issueUpdate').filter((x) => 'cycleId' in x.input).length, pushes, 'already there: no write');
  assert.equal(issueOf(s.fake, rid).cycleId, 'cyc-neo-12');
  // a human picks a cycle the factory does not know: the CLI sets task.cycle to null; the sync keeps the human's cycle
  s.fake.st.cycles['team-xtr'] = { current: { id: 'cyc-other', number: 3, name: null, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-19T00:00:00Z' }, next: null };
  s.fake.human.edit(rid, { cycleId: 'cyc-other' });
  await s.tick();
  assert.equal(inboxFiles(s.home, 'tracker.field_update').filter((x) => x.payload.value === 'cyc-other').length, 1);
  assert.equal(readSync(s.home, 'map.json').items[t.id].local.cycleRef, null, 'the sync expects what the CLI will write: no known cycle');
  await (await lib('inbox')).process(s.home, { tick: 1 });
  assert.equal((await lib('store')).get(s.home, 'task', t.id).cycle, null, 'the CLI applied it');
  await s.tick(); await s.tick();
  assert.equal(issueOf(s.fake, rid).cycleId, 'cyc-other', 'not cleared');
  assert.equal(created(s.fake, 'issueUpdate').filter((x) => 'cycleId' in x.input && x.input.cycleId === null).length, 0);
});

test('team move: an issue moved between configured teams is not missing; moved out of the teams it is; a team taken out of config blocks, not missing', async () => {
  const s = await setup();
  const g = await goal(s.home, { teams: ['neo'], lead_team: 'neo' });
  const t = await task(s.home, g.id, { team: 'neo' });
  await s.tick(); await s.tick();
  const rid = readSync(s.home, 'map.json').items[t.id].remoteId;
  s.fake.human.edit(rid, { teamId: 'team-ops', stateId: S('todo', 'team-ops') });
  await s.tick('full');
  assert.equal(inboxFiles(s.home, 'tracker.missing').length, 0, 'moved inside the configured teams');
  assert.equal(readSync(s.home, 'map.json').items[t.id].team, 'OPS');
  assert.equal(inboxFiles(s.home, 'tracker.status_change').length, 0, 'the equivalent state in the new team is consistent');
  s.fake.human.edit(rid, { teamId: 'team-xtr', stateId: S('todo', 'team-xtr') });
  await s.tick('full');
  assert.equal(inboxFiles(s.home, 'tracker.missing').length, 1, 'moved out of the configured teams');

  const s2 = await setup();
  const g2 = await goal(s2.home, { teams: ['neo', 'api'], lead_team: 'neo' });
  const t2 = await task(s2.home, g2.id, { team: 'api' });
  await s2.tick(); await s2.tick();
  await rawConfig(s2.home, { teams: { api: { tracker: { team_key: null } } } }); // OPS removed
  await patchRecord(s2.home, 'task', t2.id, { status: 'in_progress' });
  await s2.tick('full');
  assert.equal(readSync(s2.home, 'state.json').first_sync_approved, false, 'dropping an approved team needs a new preview');
  await approveFirstSync(s2.home);
  await s2.tick('full');
  assert.equal(inboxFiles(s2.home, 'tracker.missing').length, 0, 'not missing: its team left the config');
  const b = inboxFiles(s2.home, 'sync.scope_blocked');
  assert.equal(b.length, 1);
  assert.match(b[0].payload.reason, /team OPS/);
});

test('scope: tracker_discover never changes scope_key; a tick resets approval when an approved team is no longer configured', async () => {
  const h = await syncHome({ provider: 'linear', scope: { team_key: 'ENG' } });
  const clock = makeClock();
  const fake = fakeLinear({ clock, teams: TEAMS });
  const e = await core('engine');
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  assert.equal(readSync(h.home, 'state.json').scope_key, 'linear:team:ENG');
  await rawConfig(h.home, { teams: { neo: CFG_TEAMS.neo, api: CFG_TEAMS.api } }); // ENG is not among them
  const r = await e.discover({ projectDir: h.repo, tracker: 'linear', scopeHint: { team_keys: ['NEO', 'OPS'] } }, d);
  assert.match(r.lines[0], /^READY linear 2 teams/);
  assert.equal(readSync(h.home, 'state.json').scope_key, 'linear:team:ENG', 'discover leaves the scope key to the tick');
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  const st = readSync(h.home, 'state.json');
  assert.equal(st.scope_key, 'linear:teams');
  assert.equal(st.first_sync_approved, false, 'ENG was approved; NEO+OPS were not');
  assert.deepEqual(st.scope_teams, ['NEO', 'OPS']);
});

test('adding teams keeps first-sync approval: single team -> teams that include it -> one more team', async () => {
  const h = await syncHome({ provider: 'linear' }); // A7 scope NEO
  const clock = makeClock();
  const fake = fakeLinear({ clock, teams: TEAMS });
  const e = await core('engine');
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  const a = await lib('actions');
  const g = a.newGoal(h.home, { title: 'Single team goal', outcome: 'x', success_criteria: ['y'] });
  await approveFirstSync(h.home);
  // single team: discovery picks team NEO by scope
  fake.st.team = { id: 'team-neo', key: 'NEO', name: 'Neo' };
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  assert.equal(readSync(h.home, 'state.json').scope_key, 'linear:team:NEO');
  const rid = readSync(h.home, 'map.json').goals[g.id].remoteId;
  await rawConfig(h.home, { teams: { engineering: CFG_TEAMS.engineering, neo: CFG_TEAMS.neo } }); // the old team is NOT first
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  let st = readSync(h.home, 'state.json');
  assert.equal(st.scope_key, 'linear:teams');
  assert.equal(st.first_sync_approved, true);
  await rawConfig(h.home, { teams: { product: CFG_TEAMS.product } });
  await patchRecord(h.home, 'goal', g.id, { status: 'active' });
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  st = readSync(h.home, 'state.json');
  assert.equal(st.first_sync_approved, true);
  assert.ok(st.status_maps.PRO, 'the new team is discovered');
  assert.equal(fake.st.issues.get(rid).stateId, S('prog', 'team-neo'), 'an A7 entry (no team field) still pushes');
  assert.equal(inboxFiles(h.home, 'sync.scope_blocked').length, 0);
});

test('snapshot: each full pull writes sync/snapshot.json with counts, started issues, the active cycle; private titles are hidden', async () => {
  const s = await setup();
  s.fake.st.cycles['team-neo'] = { current: { id: 'cyc-neo-12', number: 12, name: null, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-19T00:00:00Z' }, next: null };
  s.fake.human.create({ title: 'Build export', teamId: 'team-neo', stateId: S('prog', 'team-neo'), cycleId: 'cyc-neo-12' });
  s.fake.human.create({ title: 'Mail pat@example.com back', teamId: 'team-neo', stateId: S('review', 'team-neo') });
  s.fake.human.create({ title: 'Old', teamId: 'team-neo', stateId: S('done', 'team-neo') });
  s.fake.human.create({ title: 'Ops thing', teamId: 'team-ops', stateId: S('backlog', 'team-ops') });
  await s.tick('full');
  const snap = readSync(s.home, 'snapshot.json');
  assert.equal(snap.v, 1);
  assert.deepEqual(Object.keys(snap.teams).sort(), ['ENG', 'NEO', 'OPS', 'PRO']);
  assert.deepEqual(snap.teams.NEO.counts, { triage: 0, backlog: 0, unstarted: 0, started: 2, completed: 1, canceled: 0 });
  assert.equal(snap.teams.NEO.name, 'Neo');
  assert.deepEqual(snap.teams.NEO.cycle, { tracker_id: 'cyc-neo-12', number: 12, starts_at: '2026-10-05T00:00:00Z', ends_at: '2026-10-19T00:00:00Z' });
  assert.equal(snap.teams.NEO.in_progress.length, 2);
  assert.equal(snap.teams.NEO.in_progress.find((x) => x.state === 'In Progress').cycle_number, 12);
  assert.match(snap.teams.NEO.in_progress.find((x) => x.state === 'In Review').title, /^\(title hidden: email\)$/);
  assert.equal(snap.teams.OPS.counts.backlog, 1);
  assert.equal(snap.teams.OPS.cycle, null);
});

test('goal_mapping project: projects in the teams with the intake label become tracker.intake {kind: project}', async () => {
  const s = await setup({ tracker: { goal_mapping: 'project' } });
  const p = s.fake.human.project({ name: 'Q4 export project', content: 'Plan text', teamIds: ['team-neo', 'team-xtr'], labels: ['factory-intake'] });
  s.fake.human.project({ name: 'Unlabelled', teamIds: ['team-neo'], labels: [] });
  await s.tick('full');
  const r = inboxFiles(s.home, 'tracker.intake');
  assert.equal(r.length, 1);
  assert.equal(r[0].payload.remote_id, p.id);
  assert.equal(r[0].payload.kind, 'project');
  assert.equal(r[0].payload.key, p.slugId);
  assert.deepEqual(r[0].payload.teams, ['NEO'], 'only configured teams');
});

test('preview lists per-team status maps and labels, records to link, stream items and project intake candidates', async () => {
  const s = await setup({ approve: false, tracker: { goal_mapping: 'project' }, streams: { enabled: true, pull: 'intake_label', teams: ['neo'] } });
  const g = await goal(s.home, { teams: ['neo', 'api'], lead_team: 'neo' });
  await task(s.home, g.id, { team: 'api', title: 'API spec' });
  const ex = s.fake.human.create({ title: 'Existing', teamId: 'team-neo' });
  await task(s.home, g.id, { team: 'neo', title: 'Linked item', item: { class: 'bug', tracker_ref: { provider: 'linear', remote_id: ex.id, key: ex.identifier, url: 'u', kind: 'issue' }, reported_by: 'tracker' } }, 'triage');
  s.fake.human.create({ title: 'Crash on save', teamId: 'team-neo', labelIds: [s.bug['team-neo'], s.intake['team-neo']] });
  s.fake.human.project({ name: 'Intake project', teamIds: ['team-ops'], labels: ['factory-intake'] });
  const r = await s.e.preview({ projectDir: s.repo }, s.d);
  assert.match(r.lines[0], /^PREVIEW /);
  assert.match(r.lines[2], /^link 1 records; 1 stream items; 1 project intake candidates/);
  const md = readFileSync(join(s.home, 'sync', 'preview.md'), 'utf8');
  assert.match(md, /Tracker: linear \(linear:teams\)/);
  assert.match(md, new RegExp(`- ${g.id} project: Cross-team export`));
  assert.match(md, /- T-\d+ spec \(OPS\): API spec/);
  assert.match(md, /## Records to link, not create \(1\)/);
  assert.match(md, /- OPS: software-factory/);
  assert.match(md, /## Status map NEO\n- backlog -> Backlog/);
  assert.match(md, /## Stream items \(streams\.pull intake_label\) \(1\)\n- NEO-\d+ \[bug\] Crash on save/);
  assert.match(md, /## Project intake candidates labelled factory-intake \(1\)\n- Intake project \(OPS\)/);
  assert.equal(s.fake.st.mutations.length, 0, 'preview writes nothing to the tracker');
});

test('tracker_discover: list_teams and team_keys print the exact lines; a missing key is SCOPE_NOT_FOUND; the MCP reply keeps every team line', async () => {
  const s = await setup({ approve: false, cycles: { enabled: true } });
  s.fake.st.cycles['team-neo'] = { current: { id: 'cyc-neo-12', number: 12, name: null, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-19T00:00:00Z' }, next: null };
  let r = await s.e.discover({ projectDir: s.repo, tracker: 'linear', scopeHint: { list_teams: true } }, s.d);
  assert.deepEqual(r.lines, [
    'TEAMS 5',
    'TEAM PRO Product parent=- id=team-pro',
    'TEAM ENG Engineering parent=- id=team-eng',
    'TEAM NEO Neo parent=ENG id=team-neo',
    'TEAM OPS Backend Services parent=ENG id=team-ops',
    'TEAM XTR Other parent=- id=team-xtr',
  ]);
  r = await s.e.discover({ projectDir: s.repo, tracker: 'linear', scopeHint: { team_keys: ['NEO', 'nope', 'OPS'] } }, s.d);
  assert.deepEqual(r.lines, ['SCOPE_NOT_FOUND NOPE', 'available: PRO, ENG, NEO, OPS, XTR']);
  assert.equal(s.fake.st.calls.filter((c) => c.includes('states')).length, 0, 'no detail calls before every key is found');
  r = await s.e.discover({ projectDir: s.repo, tracker: 'linear', scopeHint: { team_keys: ['neo', 'OPS'] } }, s.d);
  assert.deepEqual(r.lines, [
    'READY linear 2 teams (NEO, OPS)',
    'NEO Neo: 6 states, 2 labels, cycle 12',
    'OPS Backend Services: 6 states, 2 labels, no active cycle',
    'signed in as Factory Bot',
    'Set tracker.status to "ready". The first sync is preview only: /software-factory:sync --preview',
  ]);
  const st = readSync(s.home, 'state.json');
  assert.equal(st.scope_key ?? null, null, 'only a sync tick sets the scope key');
  assert.deepEqual(Object.keys(st.status_maps).sort(), ['NEO', 'OPS']);
  assert.equal(st.status_maps.OPS.in_progress.id, S('prog', 'team-ops'));
  assert.equal(st.discovery.teams.NEO.parent, 'ENG');
  assert.equal(inboxFiles(s.home, 'tracker.cycles').length, 1, 'cycles raised after discovery');
  // through the MCP handler: more than 15 teams are all listed
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `team-${i}`, key: `T${i}`, name: `Team ${i}`, parent: null }));
  const fake2 = fakeLinear({ teams: many });
  const { handle } = await import('../../servers/factory-sync/server.mjs');
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tracker_discover', arguments: { projectDir: s.repo, tracker: 'linear', scopeHint: { list_teams: true } } } }, { env: ENV, fetch: fake2.fetch });
  const lines = res.result.content[0].text.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], 'TEAMS 20');
});

test('single-team compatibility: no team fields, flat status map and labels, A7 discovery shape, A7 create input', async () => {
  const h = await syncHome({ provider: 'linear' });
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await core('engine');
  const d = { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} };
  const a = await lib('actions');
  const g = a.newGoal(h.home, { title: 'VIN decoder', outcome: 'Decode.', success_criteria: ['ok'] });
  a.createTask(h.home, { goal_id: g.id, kind: 'spec', title: 'Spec', description: 'x', status: 'ready', acceptance_criteria: ['y'] });
  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, d); clock.advance(1000);
  await e.syncTick({ projectDir: h.repo, mode: 'full' }, d);
  const st = readSync(h.home, 'state.json');
  assert.equal(st.scope_key, 'linear:team:NEO');
  assert.equal(st.status_maps, undefined);
  assert.equal(st.labels_known_by_team, undefined);
  assert.deepEqual(Object.keys(st.discovery).sort(), ['at', 'labels', 'scopes', 'states', 'team', 'viewer']);
  assert.deepEqual(st.discovery.scopes.map((x) => Object.keys(x).sort().join(',')), ['id,key,name', 'id,key,name']);
  const map = readSync(h.home, 'map.json');
  for (const [, en] of [...Object.entries(map.goals), ...Object.entries(map.items)]) {
    assert.deepEqual(['team', 'teams', 'remoteCycle', 'linked'].filter((k) => k in en), []);
    assert.equal(en.scopeKey, 'linear:team:NEO');
  }
  const ic = created(fake);
  assert.deepEqual(Object.keys(ic[1].input).sort(), ['description', 'labelIds', 'parentId', 'priority', 'stateId', 'teamId', 'title']);
  assert.ok(ic.every((x) => x.input.teamId === 'team-1'));
  assert.ok(created(fake, 'issueLabelCreate').every((x) => x.input.teamId === 'team-1'));
  assert.deepEqual(inboxFiles(h.home).map((x) => x.type), [], 'no new request types without new config');
  const logFile = readdirSync(join(h.home, 'sync')).find((x) => x.startsWith('log-'));
  assert.ok(logFile);
});

test('project relink by footer only finds projects of the configured teams', async () => {
  const s = await setup({ tracker: { goal_mapping: 'project' } });
  const g = await goal(s.home, { teams: ['neo'], lead_team: 'neo' });
  // another factory's project in an unconfigured team carries the same footer text
  s.fake.human.project({ name: 'Theirs', content: `x\n\nsf-id: ${g.id} · managed by software-factory`, teamIds: ['team-xtr'] });
  const { writeJsonAtomic } = await lib('fsutil');
  writeJsonAtomic(join(s.home, 'sync', 'map.json'), { version: 1, items: {}, goals: { [g.id]: { kind: 'goal', remoteId: null, pendingCreate: true, pushed: {}, pulled: {}, local: {}, ourCommentIds: [], linkedPRs: [], commentedRuns: [] } } });
  await s.tick();
  const map = readSync(s.home, 'map.json');
  assert.equal(created(s.fake, 'projectCreate').length, 1, 'not linked to the other team\'s project');
  assert.deepEqual(s.fake.st.projects.get(map.goals[g.id].remoteId).teamIds, ['team-neo']);
  // a project of a configured team with the footer is relinked, no second create
  const g2 = await goal(s.home, { title: 'Second', teams: ['neo'], lead_team: 'neo' });
  const mine = s.fake.human.project({ name: 'Second', content: `y\n\nsf-id: ${g2.id} · managed by software-factory`, teamIds: ['team-neo'] });
  const m2 = readSync(s.home, 'map.json');
  m2.goals[g2.id] = { kind: 'goal', remoteId: null, pendingCreate: true, pushed: {}, pulled: {}, local: {}, ourCommentIds: [], linkedPRs: [], commentedRuns: [] };
  writeJsonAtomic(join(s.home, 'sync', 'map.json'), m2);
  await s.tick();
  assert.equal(readSync(s.home, 'map.json').goals[g2.id].remoteId, mine.id);
  assert.equal(created(s.fake, 'projectCreate').length, 1);
});

test('single team + goal_mapping project: the project is created in the scope team', async () => {
  const h = await syncHome({ provider: 'linear' });
  await rawConfig(h.home, { tracker: { goal_mapping: 'project' } });
  const clock = makeClock();
  const fake = fakeLinear({ clock });
  const e = await core('engine');
  await goal(h.home);
  await approveFirstSync(h.home);
  await e.syncTick({ projectDir: h.repo }, { env: ENV, fetch: fake.fetch, now: clock, sleep: async () => {} });
  const pc = created(fake, 'projectCreate');
  assert.equal(pc.length, 1);
  assert.deepEqual(pc[0].input.teamIds, ['team-1']);
});

test('status map: a flat tracker.status_map of state ids applies to a team only where the ids are its own states', async () => {
  const e = await core('engine');
  const { proposeStatusMap } = await core('ownership');
  const fake = fakeLinear({ teams: TEAMS });
  const st = { discovery: { teams: { NEO: { states: fake.statesOf('team-neo') }, OPS: { states: fake.statesOf('team-ops') } } },
    status_maps: { NEO: proposeStatusMap(fake.statesOf('team-neo')), OPS: proposeStatusMap(fake.statesOf('team-ops')) } };
  const t = { status_map: { ready: S('prog', 'team-neo') } };
  assert.equal(e.statusMapFor(t, st, 'NEO').ready.id, S('prog', 'team-neo'), 'the override applies to its own team');
  assert.equal(e.statusMapFor(t, st, 'OPS').ready.id, S('todo', 'team-ops'), 'another team keeps its proposed state');
  const keyed = { status_map: { OPS: { ready: S('prog', 'team-ops') } } };
  assert.equal(e.statusMapFor(keyed, st, 'OPS').ready.id, S('prog', 'team-ops'));
  assert.equal(e.statusMapFor(keyed, st, 'NEO').ready.id, S('todo', 'team-neo'));
});

test('delta pull: when the page cap is hit the cursor stays, so no update is skipped', async () => {
  const s = await setup();
  const g = await goal(s.home, { teams: ['neo'], lead_team: 'neo' });
  await s.tick(); await s.tick();
  const before = readSync(s.home, 'state.json').cursor;
  assert.ok(before);
  for (let i = 0; i < 230; i++) s.fake.human.create({ title: `Busy ${i}`, teamId: 'team-neo' });
  const r = await s.tick();
  assert.equal(readSync(s.home, 'state.json').cursor, before, 'not advanced past unread updates');
  assert.match(r.lines.join('\n'), /page cap/);
  // once the burst is read in time, the cursor moves on
  s.fake.st.issues.clear();
  s.fake.human.create({ title: 'Late', teamId: 'team-neo' });
  await s.tick();
  assert.notEqual(readSync(s.home, 'state.json').cursor, before);
  void g;
});

test('backlog item: a request the CLI rejected is raised again on a later full pull or a new stream config, not on every delta', async () => {
  const s = await setup({ streams: { enabled: true, pull: 'intake_label', teams: ['neo'] } });
  const bug = s.fake.human.create({ title: 'Crash', teamId: 'team-neo', labelIds: [s.bug['team-neo'], s.intake['team-neo']] });
  await s.tick('full');
  assert.equal(inboxFiles(s.home, 'tracker.backlog_item').length, 1);
  await rawConfig(s.home, { streams: { enabled: false } }); // the CLI rejects it: streams are off
  const res = await (await lib('inbox')).process(s.home, { tick: 1 });
  assert.equal(res.find((x) => x.type === 'tracker.backlog_item').status, 'rejected');
  await rawConfig(s.home, { streams: { enabled: true } }); // same stream config as when it was raised
  await s.tick(); // resolves the rejection
  s.fake.human.edit(bug.id, { title: 'Crash on save' });
  await s.tick();
  assert.equal(inboxFiles(s.home, 'tracker.backlog_item').length, 0, 'a delta does not raise it again');
  await s.tick('full');
  const again = inboxFiles(s.home, 'tracker.backlog_item');
  assert.equal(again.length, 1, 'a full pull raises it again');
  assert.equal(again[0].dedupe_key, `backlog:${bug.id}`);
});

test('cycle push never clears a cycle the factory did not set', async () => {
  const { planPush } = await core('planner');
  const cycles = { teams: { neo: { current: { id: 'neo-12', tracker_id: 'cyc-neo-12' } } } };
  const entry = (factoryCycle) => ({ kind: 'task', remoteId: 'i1', pushed: { status: 's' }, pulled: {}, local: { cycleRef: 'neo-12' }, remoteCycle: 'cyc-other', factoryCycle });
  const run = (e) => planPush({ tracker: {}, provider: 'linear', map: { goals: {}, items: { 'T-0001': e } }, goals: [{ id: 'G-001', status: 'active' }],
    tasks: [{ id: 'T-0001', goal_id: 'G-001', kind: 'spec', role: 'staff-engineer', status: 'ready', title: 'x', cycle: null, rev: 1 }],
    cyclesTracker: true, cycles }).filter((o) => o.type === 'set_cycle');
  assert.equal(run(entry('cyc-neo-12')).length, 0, 'the remote cycle is a human choice');
  assert.equal(run({ ...entry('cyc-other') }).length, 1, 'the factory set it, so the factory may clear it');
});
