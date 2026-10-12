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
export function fakeLinear({ clock } = {}) {
  const st = {
    team: { id: 'team-1', key: 'NEO', name: 'Neo' },
    states: [
      { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 }, { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
      { id: 's-prog', name: 'In Progress', type: 'started', position: 2 }, { id: 's-review', name: 'In Review', type: 'started', position: 3 },
      { id: 's-done', name: 'Done', type: 'completed', position: 4 }, { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 5 },
    ],
    labels: [{ id: 'l-bug', name: 'bug' }], issues: new Map(), comments: [], calls: [], mutations: [], n: 0,
    failNext: [], // [{match: 'issueCreate', status: 429, headers: {...}}]
  };
  let last = 0;
  const t = () => { let ms = clock ? clock() : Date.now(); if (ms <= last) ms = last + 1; last = ms; return new Date(ms).toISOString(); };
  const node = (i) => ({
    id: i.id, identifier: i.identifier, url: `https://linear.app/x/issue/${i.identifier}`, title: i.title, description: i.description, priority: i.priority ?? 0,
    dueDate: i.dueDate || null, updatedAt: i.updatedAt, state: st.states.find((s) => s.id === i.stateId),
    labels: { nodes: i.labelIds.map((id) => st.labels.find((l) => l.id === id)).filter(Boolean) }, assignee: i.assigneeId ? { id: i.assigneeId } : null,
    parent: i.parentId ? { id: i.parentId } : null, team: { id: i.teamId, key: 'NEO' }, project: null,
    comments: { nodes: st.comments.filter((c) => c.issueId === i.id && (!i._since || c.updatedAt > i._since)).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, user: { id: c.userId, displayName: c.userName } })) },
  });
  // Linear rewrites markdown: "- " bullets become "* " and it escapes nothing else here.
  const reformat = (md) => String(md || '').replace(/^- /gm, '* ');
  const human = {
    edit(id, patch) { const i = st.issues.get(id); Object.assign(i, patch); i.updatedAt = t(); return i; },
    comment(id, body, userId = 'u-human', userName = 'Pat') { const c = { id: `c${++st.n}`, issueId: id, body, userId, userName, createdAt: t(), updatedAt: t() }; st.comments.push(c); st.issues.get(id).updatedAt = t(); return c; },
    create(fields) { const id = `i${++st.n}`; const i = { id, identifier: `NEO-${st.n}`, teamId: 'team-1', labelIds: [], stateId: 's-backlog', description: '', updatedAt: t(), ...fields }; st.issues.set(id, i); return i; },
  };
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
    if (q.includes('issueLabelCreate')) { const l = { id: `l${++st.n}`, name: v.input.name }; st.labels.push(l); st.mutations.push('issueLabelCreate'); return ok({ issueLabelCreate: { success: true, issueLabel: l } }); }
    if (q.includes('issueCreate')) {
      st.mutations.push('issueCreate');
      const i = human.create({ title: v.input.title, description: reformat(v.input.description), stateId: v.input.stateId || 's-backlog', labelIds: v.input.labelIds || [], parentId: v.input.parentId || null, priority: v.input.priority ?? 0 });
      return ok({ issueCreate: { success: true, issue: node(i) } });
    }
    if (q.includes('issueUpdate')) {
      st.mutations.push('issueUpdate');
      const i = st.issues.get(v.id);
      if (v.input.title !== undefined) i.title = v.input.title;
      if (v.input.description !== undefined) i.description = reformat(v.input.description);
      if (v.input.stateId) i.stateId = v.input.stateId;
      if (v.input.parentId) i.parentId = v.input.parentId;
      i.updatedAt = t();
      return ok({ issueUpdate: { success: true, issue: node(i) } });
    }
    if (q.includes('commentCreate')) { st.mutations.push('commentCreate'); const c = human.comment(v.input.issueId, v.input.body, 'u-bot', 'Bot'); return ok({ commentCreate: { success: true, comment: { id: c.id } } }); }
    if (q.includes('attachmentLinkURL')) { st.mutations.push('attachmentLinkURL'); return ok({ attachmentLinkURL: { success: true } }); }
    if (q.includes('viewer')) return ok({ viewer: { id: 'u-bot', displayName: 'Factory Bot', name: 'bot' }, teams: { nodes: [st.team, { id: 'team-2', key: 'OPS', name: 'Ops' }] } });
    if (q.includes('team(id:')) return ok({ team: { id: 'team-1', key: 'NEO', states: { nodes: st.states }, labels: { nodes: st.labels } } });
    if (q.includes('description: { contains')) { const hit = [...st.issues.values()].filter((i) => String(i.description).includes(v.text)); return ok({ issues: { nodes: hit.map(node) } }); }
    if (q.includes('id: { in: $ids }')) return ok({ issues: { nodes: v.ids.map((id) => st.issues.get(id)).filter(Boolean).map(node) } });
    if (q.includes('labels: { name: { eq: $label } }')) {
      const lid = (st.labels.find((l) => l.name === v.label) || {}).id;
      return ok({ issues: { nodes: [...st.issues.values()].filter((i) => i.labelIds.includes(lid)).map(node) } });
    }
    if (q.includes('updatedAt: { gt: $since }')) {
      const hit = [...st.issues.values()].filter((i) => i.teamId === v.team && i.updatedAt > v.since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return ok({ issues: { nodes: hit.map((i) => node({ ...i, _since: v.since })), pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    return { status: 400, headers: new Map(), text: async () => JSON.stringify({ errors: [{ message: `fake: unknown query ${q.slice(0, 40)}` }] }) };
  }
  return { fetch: fetchFn, st, human };
}

/** Controllable clock: real time plus an offset (keeps the lease fresh). */
export function makeClock() {
  let off = 0;
  const f = () => Date.now() + off;
  f.advance = (ms) => { off += ms; };
  return f;
}
