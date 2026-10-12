// Jira Cloud adapter: REST v3 over fetch with Basic auth (email:api token). Status changes go through
// transitions; a missing direct transition or a screen with required fields is reported as drift.
// No delete or archive call.
import { httpJson } from './http.mjs';
import { SyncHttpError } from '../core/ratelimit.mjs';
import { PRIORITY } from '../core/ownership.mjs';
import { adfToPlain, mdToAdf } from '../core/normalize.mjs';

const FIELDS = ['summary', 'description', 'status', 'labels', 'assignee', 'priority', 'duedate', 'parent', 'updated', 'project', 'comment', 'issuetype'];

function isoJira(s) { return s ? String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : s; }

function stateType(status) {
  const cat = status && status.statusCategory ? status.statusCategory.key : null;
  const name = String((status && status.name) || '').toLowerCase();
  if (cat === 'done') return /won.?t|cancel|not planned|rejected|declined/.test(name) ? 'canceled' : 'completed';
  if (cat === 'indeterminate') return 'started';
  if (cat === 'new') return /backlog/.test(name) ? 'backlog' : 'unstarted';
  return null;
}

export function createJira({ site, email, token, fetch: fetchFn = globalThis.fetch, scope = {}, now = () => Date.now() } = {}) {
  if (!site || !email || !token) throw new SyncHttpError('missing credentials: jira_site, jira_email, jira_api_token', { code: 'NO_CREDENTIALS' });
  const host = String(site).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const base = `https://${host}/rest/api/3`;
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const transitionCache = new Map(); // `${fromStatusId}>${toStatusId}` -> transition id
  let lastRate = {};

  async function call(method, path, body) {
    const r = await httpJson(fetchFn, `${base}${path}`, { method, headers: { Authorization: auth }, body, now: now() });
    lastRate = r.rate || {};
    return r.json;
  }

  function canonical(i) {
    const f = i.fields || {};
    return {
      remoteId: String(i.id), key: i.key, url: `https://${host}/browse/${i.key}`, kind: f.issuetype && /epic/i.test(f.issuetype.name) ? 'epic' : 'issue',
      title: f.summary || '', body: f.description || null, bodyText: adfToPlain(f.description),
      statusId: f.status ? String(f.status.id) : null, statusName: f.status ? f.status.name : null, statusType: stateType(f.status),
      labels: f.labels || [], assigneeId: f.assignee ? f.assignee.accountId : null,
      priority: f.priority ? (PRIORITY.fromJira[String(f.priority.name).toLowerCase()] ?? null) : null,
      dueDate: f.duedate || null, parentRemoteId: f.parent ? String(f.parent.id) : null,
      containerId: f.project ? f.project.key : null, updatedAt: isoJira(f.updated),
      closed: ['completed', 'canceled'].includes(stateType(f.status)),
      _comments: (f.comment && f.comment.comments) || [],
    };
  }

  async function getIssue(id) { return canonical(await call('GET', `/issue/${encodeURIComponent(id)}?fields=${FIELDS.join(',')}`)); }

  const self = {
    name: 'jira',
    rate: () => lastRate,
    capabilities() {
      return { statusModel: 'workflow', goalModels: ['epic'], deltaPull: 'jql_minute', comments: true, links: 'remote_link', subIssues: true, maxWritesPerTick: 20 };
    },

    async discover(scopeHint = {}) {
      const key = scopeHint.project_key || scope.project_key;
      const me = await call('GET', '/myself');
      const out = { viewer: { id: me.accountId, handle: me.displayName }, scopes: [], states: [], labels: [], fields: { priority: true } };
      if (key) {
        const p = await call('GET', `/project/${encodeURIComponent(key)}`);
        out.scopes.push({ id: String(p.id), key: p.key, name: p.name });
        const byType = await call('GET', `/project/${encodeURIComponent(key)}/statuses`);
        const seen = new Map();
        for (const t of byType || []) for (const s of t.statuses || []) if (!seen.has(String(s.id))) seen.set(String(s.id), { id: String(s.id), name: s.name, type: stateType(s), position: seen.size });
        out.states = [...seen.values()];
      }
      return out;
    },

    async pull({ cursor = null, mappedRemoteIds = [], full = false, intakeLabel = 'factory-intake' } = {}) {
      const key = scope.project_key;
      const items = new Map(); const comments = []; const missing = []; let maxUpdated = cursor;
      const take = (raw) => {
        const c = canonical(raw); items.set(c.remoteId, c);
        if (!maxUpdated || Date.parse(c.updatedAt) > Date.parse(maxUpdated)) maxUpdated = c.updatedAt;
        return c;
      };
      const search = async (jql) => {
        let token = null;
        for (let page = 0; page < 4; page++) {
          const r = await call('POST', '/search/jql', { jql, fields: FIELDS, maxResults: 50, ...(token ? { nextPageToken: token } : {}) });
          for (const raw of (r && r.issues) || []) {
            const c = take(raw);
            if (!full && cursor) {
              for (const cm of c._comments) {
                if (Date.parse(isoJira(cm.updated || cm.created)) > Date.parse(cursor)) {
                  comments.push({ remoteId: c.remoteId, id: String(cm.id), body: adfToPlain(cm.body), authorId: cm.author ? cm.author.accountId : null, author: cm.author ? cm.author.displayName : null, createdAt: isoJira(cm.created), updatedAt: isoJira(cm.updated) });
                }
              }
            }
          }
          if (!r || r.isLast !== false || !r.nextPageToken) break;
          token = r.nextPageToken;
        }
      };
      if (!full && cursor) {
        // JQL dates are minute-precise and in the user's time zone: use a relative window with 2 minutes of overlap.
        const mins = Math.max(2, Math.ceil((now() - Date.parse(cursor)) / 60000) + 2);
        await search(`project = "${key}" AND updated >= -${mins}m ORDER BY updated ASC`);
        for (const c of items.values()) if (mappedRemoteIds.includes(c.remoteId) && c.containerId !== key) missing.push(c.remoteId);
      } else {
        for (const id of mappedRemoteIds.slice(0, 200)) {
          try { const c = await getIssue(id); items.set(c.remoteId, c); if (c.containerId !== key) missing.push(id); } catch (e) { if (e.status === 404) missing.push(id); else throw e; }
        }
        await search(`project = "${key}" AND labels = "${intakeLabel}" ORDER BY updated ASC`);
      }
      for (const c of items.values()) c._comments = undefined;
      return { items: [...items.values()], comments, missing, nextCursor: maxUpdated || cursor || new Date(now() - 300000).toISOString() };
    },

    /** Pick the transition into statusId. Returns {id} or {drift: reason}. */
    async pickTransition(remoteId, fromStatusId, toStatusId) {
      const ck = `${fromStatusId}>${toStatusId}`;
      if (transitionCache.has(ck)) return { id: transitionCache.get(ck) };
      const r = await call('GET', `/issue/${encodeURIComponent(remoteId)}/transitions?expand=transitions.fields`);
      const t = ((r && r.transitions) || []).find((x) => x.to && String(x.to.id) === String(toStatusId));
      if (!t) return { drift: 'no direct transition' };
      const required = Object.values(t.fields || {}).filter((f) => f && f.required && !f.hasDefaultValue);
      if (required.length) return { drift: 'transition screen has required fields' };
      transitionCache.set(ck, t.id);
      return { id: t.id };
    },

    async push(ops) { const out = []; for (const op of ops) out.push(await self.pushOne(op)); return out; },

    async pushOne(op) {
      const p = op.payload || {};
      try {
        switch (op.type) {
          case 'ensure_label': return { opId: op.opId, ok: true }; // Jira labels are free-form
          case 'create_item': {
            const fields = {
              project: { key: scope.project_key }, summary: p.title, description: mdToAdf(p.body),
              issuetype: { name: op.kind === 'goal' ? 'Epic' : (scope.issue_type || 'Task') }, labels: (p.labels || []).map((l) => String(l).replace(/\s+/g, '-')),
            };
            if (p.parentRemoteId) fields.parent = { id: p.parentRemoteId };
            if (p.priority && PRIORITY.toJira[p.priority]) fields.priority = { name: PRIORITY.toJira[p.priority] };
            const r = await call('POST', '/issue', { fields });
            let c = await getIssue(r.id);
            if (p.statusId && c.statusId !== String(p.statusId)) {
              const t = await self.pickTransition(c.remoteId, c.statusId, p.statusId);
              if (t.id) { await call('POST', `/issue/${r.id}/transitions`, { transition: { id: t.id } }); c = await getIssue(r.id); }
            }
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'update_fields': case 'set_parent': {
            const fields = {};
            if (p.title !== undefined) fields.summary = p.title;
            if (p.body !== undefined) fields.description = mdToAdf(p.body);
            if (op.type === 'set_parent') fields.parent = { id: p.parentRemoteId };
            await call('PUT', `/issue/${encodeURIComponent(op.remoteId)}`, { fields });
            const c = await getIssue(op.remoteId);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'set_status': {
            const cur = await getIssue(op.remoteId);
            if (cur.statusId === String(p.statusId)) return { opId: op.opId, ok: true, remoteId: cur.remoteId, remoteUpdatedAt: cur.updatedAt, returned: cur };
            const t = await self.pickTransition(op.remoteId, cur.statusId, p.statusId);
            if (!t.id) return { opId: op.opId, ok: false, drift: true, error: t.drift };
            await call('POST', `/issue/${encodeURIComponent(op.remoteId)}/transitions`, { transition: { id: t.id } });
            const c = await getIssue(op.remoteId);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'add_comment': {
            const r = await call('POST', `/issue/${encodeURIComponent(op.remoteId)}/comment`, { body: mdToAdf(p.text) });
            return { opId: op.opId, ok: true, remoteId: op.remoteId, commentId: String(r.id) };
          }
          case 'add_link': {
            await call('POST', `/issue/${encodeURIComponent(op.remoteId)}/remotelink`, { globalId: p.url, object: { url: p.url, title: p.linkTitle || 'Pull request' } });
            return { opId: op.opId, ok: true, remoteId: op.remoteId };
          }
          default:
            return { opId: op.opId, ok: false, error: `unsupported op ${op.type}` };
        }
      } catch (e) {
        if (e instanceof SyncHttpError) return { opId: op.opId, ok: false, error: e.message, httpStatus: e.status, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs, requestId: e.requestId };
        throw e;
      }
    },

    async findByLocalId(localId) {
      const r = await call('POST', '/search/jql', { jql: `project = "${scope.project_key}" AND text ~ "\\"sf-id: ${localId}\\""`, fields: FIELDS, maxResults: 2 });
      const raw = r && r.issues && r.issues[0];
      if (!raw) return null;
      const c = canonical(raw); c._comments = undefined; return c;
    },
  };
  return self;
}
