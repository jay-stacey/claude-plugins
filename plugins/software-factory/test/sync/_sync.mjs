// Sync test helpers: temp factory home with a tracker config, a fresh lease, and fake trackers.
// No network: Linear and Jira use an injected fetch; GitHub uses a fake gh script via FACTORY_GH.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome, lib } from '../core/_helpers.mjs';

export const P = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER = join(P, 'servers', 'factory-sync', 'server.mjs');
export const FAKE_GH = join(dirname(fileURLToPath(import.meta.url)), 'fake-gh.mjs');
export const core = (n) => import(`../../servers/factory-sync/core/${n}.mjs`);
export const adapters = (n) => import(`../../servers/factory-sync/adapters/${n}.mjs`);
export { lib };

export async function syncHome({ provider = 'linear', scope, mode = 'two_way', extra = {} } = {}) {
  const h = await makeHome();
  const cfg = await lib('config');
  const defScope = provider === 'linear' ? { team_key: 'NEO' } : provider === 'jira' ? { project_key: 'SF' } : { owner: 'o', repo: 'r' };
  cfg.merge(h.home, { tracker: { provider, status: 'ready', mode, scope: scope || defScope, ...extra } });
  freshLease(h.home);
  return h;
}

export function freshLease(home, at = Date.now()) {
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'run', 'lease.json'), JSON.stringify({ session_id: 'S1', acquired_at: new Date(at).toISOString(), renewed_at: new Date(at).toISOString(), ttl_s: 4500, host: 'h', pid: process.pid }));
}

export function inboxFiles(home, type) {
  const dir = join(home, 'inbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.') && (!type || n.endsWith(`-${type}.json`)))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}

export function readSync(home, name) {
  try { return JSON.parse(readFileSync(join(home, 'sync', name), 'utf8')); } catch { return null; }
}

/** A goal (planning) plus one spec task in ready. */
export async function seed(home, { taskTitle = 'Write the VIN decoder spec', description = 'Decode VINs with retry.' } = {}) {
  const a = await lib('actions');
  const g = a.newGoal(home, { title: 'VIN decoder', outcome: 'Dealers can decode VINs.', success_criteria: ['Decoder works'] });
  const t = a.createTask(home, { goal_id: g.id, kind: 'spec', title: taskTitle, description, status: 'ready', acceptance_criteria: ['Spec covers retries'] });
  return { g, t };
}

export async function approveFirstSync(home) {
  const ss = await lib('syncstate');
  ss.updateState(home, (s) => { s.first_sync_approved = true; s.preview = s.preview || { id: 'p1' }; });
}

export const ENV = { SF_LINEAR_API_KEY: 'test-key', SF_SYNC_ENABLED: 'true', SF_JIRA_SITE: 'acme.atlassian.net', SF_JIRA_EMAIL: 'bot@example.test', SF_JIRA_API_TOKEN: 'jt' };

// ------------------------------------------------------------------ fake Linear (GraphQL)
// Routes on distinct substrings of each query. Teams: the default is the A7 pair (team-1 NEO, team-2 OPS);
// pass `teams` for multi-team tests. Team team-1 keeps the A7 state ids (s-todo ...); other teams get
// `<state>@<team id>` so per-team status maps can be told apart.
export function fakeLinear({ clock, teams } = {}) {
  const BASE_STATES = [
    { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 }, { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    { id: 's-prog', name: 'In Progress', type: 'started', position: 2 }, { id: 's-review', name: 'In Review', type: 'started', position: 3 },
    { id: 's-done', name: 'Done', type: 'completed', position: 4 }, { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 5 },
  ];
  const st = {
    team: { id: 'team-1', key: 'NEO', name: 'Neo' },
    teams: teams || [{ id: 'team-1', key: 'NEO', name: 'Neo', parent: null }, { id: 'team-2', key: 'OPS', name: 'Ops', parent: null }],
    states: BASE_STATES,
    labels: [{ id: 'l-bug', name: 'bug' }], issues: new Map(), projects: new Map(), comments: [], calls: [], mutations: [], inputs: [], n: 0,
    cycles: {}, // teamId -> {current: {id, number, name, startsAt, endsAt}, next}
    failNext: [], // [{match: 'issueCreate', status: 429, headers: {...}}]
  };
  const teamById = (id) => st.teams.find((x) => x.id === id) || null;
  const statesOf = (teamId) => (teamId === 'team-1' || !teamId ? st.states : st.states.map((s) => ({ ...s, id: `${s.id}@${teamId}` })));
  const stateById = (id) => { for (const t of [{ id: 'team-1' }, ...st.teams]) { const s = statesOf(t.id).find((x) => x.id === id); if (s) return s; } return null; };
  const labelsOf = (teamId) => st.labels.filter((l) => (l.teamId || 'team-1') === (teamId || 'team-1'));
  const cycleById = (id) => { for (const c of Object.values(st.cycles)) for (const x of [c.current, c.next]) if (x && x.id === id) return { ...x, isActive: c.current === x }; return null; };
  let last = 0;
  const t = () => { let ms = clock ? clock() : Date.now(); if (ms <= last) ms = last + 1; last = ms; return new Date(ms).toISOString(); };
  const node = (i) => {
    const team = teamById(i.teamId) || { id: i.teamId, key: 'NEO' };
    const cyc = i.cycleId ? cycleById(i.cycleId) : null;
    return {
      id: i.id, identifier: i.identifier, url: `https://linear.app/x/issue/${i.identifier}`, title: i.title, description: i.description, priority: i.priority ?? 0,
      dueDate: i.dueDate || null, updatedAt: i.updatedAt, state: stateById(i.stateId),
      labels: { nodes: i.labelIds.map((id) => st.labels.find((l) => l.id === id)).filter(Boolean) }, assignee: i.assigneeId ? { id: i.assigneeId } : null,
      parent: i.parentId ? { id: i.parentId } : null, team: { id: team.id, key: team.key }, project: i.projectId ? { id: i.projectId } : null,
      cycle: cyc ? { id: cyc.id, number: cyc.number, isActive: cyc.isActive } : null, creator: i.creatorId ? { id: i.creatorId } : null,
      comments: { nodes: st.comments.filter((c) => c.issueId === i.id && (!i._since || c.updatedAt > i._since)).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, user: { id: c.userId, displayName: c.userName } })) },
    };
  };
  const pnode = (p) => ({
    id: p.id, name: p.name, description: p.description || '', content: p.content || '', slugId: p.slugId, url: `https://linear.app/x/project/${p.slugId}`,
    updatedAt: p.updatedAt, completedAt: null, canceledAt: null, creator: p.creatorId ? { id: p.creatorId } : null,
    labels: { nodes: (p.labels || []).map((name, i) => ({ id: `pl${i}`, name })) },
    teams: { nodes: p.teamIds.map((id) => ({ id, key: (teamById(id) || {}).key })) },
  });
  // Linear rewrites markdown: "- " bullets become "* " and it escapes nothing else here.
  const reformat = (md) => String(md || '').replace(/^- /gm, '* ');
  const human = {
    edit(id, patch) { const i = st.issues.get(id); Object.assign(i, patch); i.updatedAt = t(); return i; },
    comment(id, body, userId = 'u-human', userName = 'Pat') { const c = { id: `c${++st.n}`, issueId: id, body, userId, userName, createdAt: t(), updatedAt: t() }; st.comments.push(c); st.issues.get(id).updatedAt = t(); return c; },
    create(fields) {
      const id = `i${++st.n}`;
      const teamId = fields.teamId || 'team-1';
      const key = (teamById(teamId) || { key: 'NEO' }).key;
      const i = { id, identifier: `${key}-${st.n}`, teamId, labelIds: [], stateId: teamId === 'team-1' ? 's-backlog' : `s-backlog@${teamId}`, description: '', updatedAt: t(), ...fields, teamId };
      st.issues.set(id, i); return i;
    },
    project(fields) { const id = `p${++st.n}`; const p = { id, slugId: `proj-${st.n}`, teamIds: [], labels: [], updatedAt: t(), ...fields }; st.projects.set(id, p); return p; },
    editProject(id, patch) { const p = st.projects.get(id); Object.assign(p, patch); p.updatedAt = t(); return p; },
    label(name, teamId = 'team-1') { const l = { id: `l${++st.n}`, name, teamId }; st.labels.push(l); return l; },
  };
  const issues = () => [...st.issues.values()];
  const hasLabel = (i, names) => i.labelIds.some((id) => names.includes((st.labels.find((l) => l.id === id) || {}).name));
  const page = (list, map = node) => ({ issues: { nodes: list.map(map), pageInfo: { hasNextPage: false, endCursor: null } } });
  async function fetchFn(url, init) {
    const body = JSON.parse(init.body);
    const q = body.query; const v = body.variables || {};
    st.calls.push(q.replace(/\s+/g, ' ').slice(0, 60));
    const f = st.failNext.findIndex((x) => q.includes(x.match));
    if (f >= 0) {
      const x = st.failNext.splice(f, 1)[0];
      return { status: x.status, headers: new Map(Object.entries(x.headers || {})), text: async () => JSON.stringify(x.body || { errors: [{ message: 'fail' }] }) };
    }
    const ok = (data) => ({ status: 200, headers: new Map([['x-ratelimit-requests-remaining', '2400']]), text: async () => JSON.stringify({ data }) });
    if (q.includes('issueLabelCreate')) { const l = { id: `l${++st.n}`, name: v.input.name, teamId: v.input.teamId }; st.labels.push(l); st.mutations.push('issueLabelCreate'); st.inputs.push({ m: 'issueLabelCreate', input: v.input }); return ok({ issueLabelCreate: { success: true, issueLabel: l } }); }
    if (q.includes('projectCreate')) {
      st.mutations.push('projectCreate'); st.inputs.push({ m: 'projectCreate', input: v.input });
      const p = human.project({ name: v.input.name, description: v.input.description, content: reformat(v.input.content), teamIds: v.input.teamIds });
      return ok({ projectCreate: { success: true, project: pnode(p) } });
    }
    if (q.includes('projectUpdate')) {
      st.mutations.push('projectUpdate'); st.inputs.push({ m: 'projectUpdate', id: v.id, input: v.input });
      const p = st.projects.get(v.id);
      if (v.input.name !== undefined) p.name = v.input.name;
      if (v.input.content !== undefined) p.content = reformat(v.input.content);
      if (v.input.teamIds) p.teamIds = v.input.teamIds;
      p.updatedAt = t();
      return ok({ projectUpdate: { success: true, project: pnode(p) } });
    }
    if (q.includes('issueCreate')) {
      st.mutations.push('issueCreate'); st.inputs.push({ m: 'issueCreate', input: v.input });
      const i = human.create({ title: v.input.title, description: reformat(v.input.description), teamId: v.input.teamId, stateId: v.input.stateId || (v.input.teamId === 'team-1' ? 's-backlog' : `s-backlog@${v.input.teamId}`), labelIds: v.input.labelIds || [], parentId: v.input.parentId || null, projectId: v.input.projectId || null, cycleId: v.input.cycleId || null, priority: v.input.priority ?? 0 });
      return ok({ issueCreate: { success: true, issue: node(i) } });
    }
    if (q.includes('issueUpdate')) {
      st.mutations.push('issueUpdate'); st.inputs.push({ m: 'issueUpdate', id: v.id, input: v.input });
      const i = st.issues.get(v.id);
      if (v.input.title !== undefined) i.title = v.input.title;
      if (v.input.description !== undefined) i.description = reformat(v.input.description);
      if (v.input.stateId) i.stateId = v.input.stateId;
      if (v.input.parentId) i.parentId = v.input.parentId;
      if ('cycleId' in v.input) i.cycleId = v.input.cycleId;
      i.updatedAt = t();
      return ok({ issueUpdate: { success: true, issue: node(i) } });
    }
    if (q.includes('commentCreate')) { st.mutations.push('commentCreate'); const c = human.comment(v.input.issueId, v.input.body, 'u-bot', 'Bot'); return ok({ commentCreate: { success: true, comment: { id: c.id } } }); }
    if (q.includes('attachmentLinkURL')) { st.mutations.push('attachmentLinkURL'); return ok({ attachmentLinkURL: { success: true } }); }
    if (q.includes('viewer')) return ok({ viewer: { id: 'u-bot', displayName: 'Factory Bot', name: 'bot' }, teams: { nodes: st.teams.map((x) => ({ id: x.id, key: x.key, name: x.name, parent: x.parent ? { id: (st.teams.find((y) => y.key === x.parent) || {}).id, key: x.parent } : null })) } });
    if (q.includes('query TeamCycles')) {
      const team = teamById(v.id) || st.team; const c = st.cycles[team.id] || {};
      return ok({ team: { id: team.id, key: team.key, activeCycle: c.current || null, cycles: { nodes: c.next ? [c.next] : [] } } });
    }
    if (q.includes('query Snapshot')) return ok(page(issues().filter((i) => i.teamId === v.team && i.updatedAt > v.since)));
    if (q.includes('query ProjectById')) { const p = st.projects.get(v.id); return p ? ok({ project: pnode(p) }) : { status: 200, headers: new Map(), text: async () => JSON.stringify({ errors: [{ message: 'Entity not found' }] }) }; }
    if (q.includes('query ProjectsById')) return ok({ projects: { nodes: v.ids.map((id) => st.projects.get(id)).filter(Boolean).map(pnode) } });
    // workspace-wide search (not used by the adapter; kept so a test can show why a team filter is needed)
    if (q.includes('query ProjectByText')) return ok({ projects: { nodes: [...st.projects.values()].filter((p) => String(p.content).includes(v.text)).map(pnode) } });
    if (q.includes('query TeamProjects')) {
      const team = teamById(v.id) || st.team;
      return ok({ team: { id: team.id, projects: { nodes: [...st.projects.values()].filter((p) => p.teamIds.includes(team.id)).map(pnode), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (q.includes('query StreamItems')) {
      const activeOnly = q.includes('isActive: { eq: true }');
      return ok(page(issues().filter((i) => v.teams.includes(i.teamId) && hasLabel(i, v.labels) && !['completed', 'canceled'].includes((stateById(i.stateId) || {}).type)
        && (!activeOnly || (i.cycleId && (cycleById(i.cycleId) || {}).isActive)))));
    }
    if (q.includes('query TeamsByText')) return ok({ issues: { nodes: issues().filter((i) => v.teams.includes(i.teamId) && String(i.description).includes(v.text)).map(node) } });
    if (q.includes('query TeamsDelta')) {
      // 50 per page, newest first (as Linear's orderBy: updatedAt); endCursor is the offset
      const all = issues().filter((i) => v.teams.includes(i.teamId) && i.updatedAt > v.since).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const from = v.after ? Number(v.after) : 0;
      const chunk = all.slice(from, from + 50);
      return ok({ issues: { nodes: chunk.map((i) => node({ ...i, _since: v.since })), pageInfo: { hasNextPage: from + 50 < all.length, endCursor: String(from + 50) } } });
    }
    if (q.includes('query TeamsIntake')) return ok(page(issues().filter((i) => v.teams.includes(i.teamId) && hasLabel(i, [v.label]))));
    if (q.includes('issue(id:')) { const i = st.issues.get(v.id); return i ? ok({ issue: node(i) }) : { status: 200, headers: new Map(), text: async () => JSON.stringify({ errors: [{ message: 'Entity not found' }] }) }; }
    if (q.includes('team(id:')) { const team = teamById(v.id) || st.team; return ok({ team: { id: team.id, key: team.key, states: { nodes: statesOf(team.id) }, labels: { nodes: labelsOf(team.id) } } }); }
    if (q.includes('description: { contains')) { const hit = issues().filter((i) => String(i.description).includes(v.text)); return ok({ issues: { nodes: hit.map(node) } }); }
    if (q.includes('id: { in: $ids }')) return ok({ issues: { nodes: v.ids.map((id) => st.issues.get(id)).filter(Boolean).map(node) } });
    if (q.includes('labels: { name: { eq: $label } }')) {
      const lid = (st.labels.find((l) => l.name === v.label) || {}).id;
      return ok({ issues: { nodes: issues().filter((i) => i.labelIds.includes(lid)).map(node) } });
    }
    if (q.includes('updatedAt: { gt: $since }')) {
      const hit = issues().filter((i) => i.teamId === v.team && i.updatedAt > v.since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return ok({ issues: { nodes: hit.map((i) => node({ ...i, _since: v.since })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    return { status: 400, headers: new Map(), text: async () => JSON.stringify({ errors: [{ message: `fake: unknown query ${q.slice(0, 40)}` }] }) };
  }
  return { fetch: fetchFn, st, human, statesOf };
}

/** Write raw config keys (teams, streams, cycles ...) without the core validator, merged over config.json. */
export async function rawConfig(home, obj) {
  const cfg = await lib('config');
  const { writeJsonAtomic } = await lib('fsutil');
  writeJsonAtomic(join(home, 'config.json'), cfg.deepMerge(cfg.readRaw(home) || {}, obj));
}

/** Patch a record file directly (fields the core validator may not know yet: kind triage, team, cycle, tracker_ref). */
export async function patchRecord(home, kind, id, fields) {
  const store = await lib('store');
  const { writeJsonAtomic } = await lib('fsutil');
  const rec = { ...store.get(home, kind, id), ...fields };
  writeJsonAtomic(store.fileFor(home, kind, id), rec);
  return rec;
}

/** Write state/cycles.json. */
export async function writeCycles(home, teams) {
  const { writeJsonAtomic } = await lib('fsutil');
  writeJsonAtomic(join(home, 'state', 'cycles.json'), { v: 1, updated_at: new Date().toISOString(), teams });
}

/** Controllable clock: real time plus an offset (keeps the lease fresh). */
export function makeClock() {
  let off = 0;
  const f = () => Date.now() + off;
  f.advance = (ms) => { off += ms; };
  return f;
}
