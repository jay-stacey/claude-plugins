// GitHub Issues adapter: `gh api` via execFile (FACTORY_GH overrides the executable for tests).
// GH_TOKEN is passed only when the github_token option is set; otherwise gh uses its own login.
// Status model: open / closed(completed) / closed(not_planned). No delete or archive call.
import { execFile } from 'node:child_process';
import { SyncHttpError } from '../core/ratelimit.mjs';
import { mdToPlain } from '../core/normalize.mjs';

export const STATES = [
  { id: 'open', name: 'Open', type: 'unstarted', position: 0 },
  { id: 'closed:completed', name: 'Closed (completed)', type: 'completed', position: 1 },
  { id: 'closed:not_planned', name: 'Closed (not planned)', type: 'canceled', position: 2 },
];

export const STATUS_MAP = {
  backlog: STATES[0], ready: STATES[0], in_progress: STATES[0], in_review: STATES[0], verified: STATES[0],
  awaiting_approval: STATES[0], done: STATES[1], cancelled: STATES[2],
};

/** Default gh runner. Resolves {code, stdout, stderr}. */
export function defaultGhExec(token) {
  return (args, { input } = {}) => new Promise((resolve) => {
    const exe = process.env.FACTORY_GH || 'gh';
    const isJs = /\.(mjs|cjs|js)$/i.test(exe);
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    if (token) env.GH_TOKEN = token;
    const child = execFile(isJs ? process.execPath : exe, isJs ? [exe, ...args] : args, { env, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input !== undefined) { child.stdin.end(input); } else child.stdin.end();
  });
}

function statusOf(issue) {
  if (issue.state === 'closed') return issue.state_reason === 'not_planned' ? STATES[2] : STATES[1];
  return STATES[0];
}

function canonical(i, repoFull) {
  const s = statusOf(i);
  return {
    remoteId: String(i.number), nodeId: i.node_id || null, dbId: i.id ?? null, key: `#${i.number}`, url: i.html_url,
    kind: 'issue', title: i.title || '', body: i.body || '', bodyText: mdToPlain(i.body || ''),
    statusId: s.id, statusName: s.name, statusType: s.type,
    labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    assigneeId: i.assignee ? i.assignee.login : null, priority: null, dueDate: null, parentRemoteId: null,
    containerId: i.repository_url ? i.repository_url.replace(/^.*\/repos\//, '') : repoFull,
    updatedAt: i.updated_at, closed: i.state === 'closed',
  };
}

export function createGithub({ token = null, ghExec = defaultGhExec(token), scope = {} } = {}) {
  const repo = `${scope.owner}/${scope.repo}`;
  if (!scope.owner || !scope.repo) throw new SyncHttpError('github scope needs owner and repo', { code: 'NO_SCOPE' });

  async function api(method, path, body) {
    const args = ['api', '--method', method, path, '-H', 'Accept: application/vnd.github+json'];
    if (body !== undefined) args.push('--input', '-');
    const r = await ghExec(args, { input: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.code !== 0) {
      const err = `${r.stderr}\n${r.stdout}`;
      const limited = /rate limit|HTTP 429|secondary/i.test(err);
      const m = /HTTP (\d{3})/.exec(err);
      throw new SyncHttpError((r.stderr || r.stdout || 'gh api failed').split('\n')[0].slice(0, 200), { status: m ? Number(m[1]) : 0, rateLimited: limited, retryAfterMs: limited ? 60000 : 0 });
    }
    try { return r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { return null; }
  }

  const self = {
    name: 'github',
    rate: () => ({}),
    capabilities() {
      return { statusModel: 'open_closed', goalModels: ['parent_issue', 'milestone'], deltaPull: 'since', comments: true, links: 'body_ref', subIssues: true, maxWritesPerTick: 20 };
    },

    async discover() {
      const user = await api('GET', 'user');
      const r = await api('GET', `repos/${repo}`);
      const labels = await api('GET', `repos/${repo}/labels?per_page=100`);
      return {
        viewer: { id: user ? String(user.id) : null, handle: user ? user.login : null },
        scopes: r ? [{ id: r.full_name, key: r.full_name, name: r.full_name }] : [],
        states: STATES, labels: (labels || []).map((l) => ({ id: l.name, name: l.name })), fields: {},
        proposedStatusMap: STATUS_MAP,
      };
    },

    async pull({ cursor = null, mappedRemoteIds = [], full = false, intakeLabel = 'factory-intake' } = {}) {
      const items = new Map(); const comments = []; const missing = []; let maxUpdated = cursor;
      const take = (i) => {
        if (i.pull_request) return;
        const c = canonical(i, repo);
        items.set(c.remoteId, c);
        if (!maxUpdated || Date.parse(c.updatedAt) > Date.parse(maxUpdated)) maxUpdated = c.updatedAt;
      };
      if (!full && cursor) {
        const list = await api('GET', `repos/${repo}/issues?since=${encodeURIComponent(cursor)}&state=all&per_page=100`);
        for (const i of list || []) take(i);
        const cms = await api('GET', `repos/${repo}/issues/comments?since=${encodeURIComponent(cursor)}&per_page=100`);
        for (const c of cms || []) {
          const n = /\/issues\/(\d+)$/.exec(c.issue_url || '');
          if (n) comments.push({ remoteId: n[1], id: String(c.id), body: c.body || '', authorId: c.user ? c.user.login : null, author: c.user ? c.user.login : null, createdAt: c.created_at, updatedAt: c.updated_at });
        }
        for (const c of items.values()) if (mappedRemoteIds.includes(c.remoteId) && c.containerId !== repo) missing.push(c.remoteId);
      } else {
        for (const id of mappedRemoteIds.slice(0, 200)) {
          try { const i = await api('GET', `repos/${repo}/issues/${id}`); if (i) take(i); else missing.push(id); } catch (e) {
            if ([404, 410, 301].includes(e.status)) missing.push(id); else throw e;
          }
        }
        for (const id of mappedRemoteIds) if (items.has(id) && items.get(id).containerId !== repo && !missing.includes(id)) missing.push(id);
        const list = await api('GET', `repos/${repo}/issues?labels=${encodeURIComponent(intakeLabel)}&state=open&per_page=50`);
        for (const i of list || []) take(i);
      }
      return { items: [...items.values()], comments, missing, nextCursor: maxUpdated || cursor || new Date(Date.now() - 300000).toISOString() };
    },

    async push(ops) { const out = []; for (const op of ops) out.push(await self.pushOne(op)); return out; },

    async pushOne(op) {
      const p = op.payload || {};
      try {
        switch (op.type) {
          case 'ensure_label': {
            try { await api('POST', `repos/${repo}/labels`, { name: p.name, color: p.color || 'ededed' }); } catch (e) { if (e.status !== 422) throw e; }
            return { opId: op.opId, ok: true };
          }
          case 'create_item': {
            let i = await api('POST', `repos/${repo}/issues`, { title: p.title, body: p.body, labels: p.labels || [] });
            if (p.parentRemoteId) {
              try { await api('POST', `repos/${repo}/issues/${p.parentRemoteId}/sub_issues`, { sub_issue_id: i.id }); } catch { /* sub-issues optional */ }
            }
            const st = STATES.find((s) => s.id === p.statusId);
            if (st && st.id !== 'open') i = await api('PATCH', `repos/${repo}/issues/${i.number}`, { state: 'closed', state_reason: st.id.split(':')[1] });
            const c = canonical(i, repo);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'update_fields': {
            const body = {};
            if (p.title !== undefined) body.title = p.title;
            if (p.body !== undefined) body.body = p.body;
            const c = canonical(await api('PATCH', `repos/${repo}/issues/${op.remoteId}`, body), repo);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'set_status': {
            const body = p.statusId === 'open' ? { state: 'open' } : { state: 'closed', state_reason: String(p.statusId).split(':')[1] || 'completed' };
            const c = canonical(await api('PATCH', `repos/${repo}/issues/${op.remoteId}`, body), repo);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'set_parent': {
            const child = await api('GET', `repos/${repo}/issues/${op.remoteId}`);
            await api('POST', `repos/${repo}/issues/${p.parentRemoteId}/sub_issues`, { sub_issue_id: child.id });
            return { opId: op.opId, ok: true, remoteId: op.remoteId };
          }
          case 'add_comment': {
            const c = await api('POST', `repos/${repo}/issues/${op.remoteId}/comments`, { body: p.text });
            return { opId: op.opId, ok: true, remoteId: op.remoteId, commentId: String(c.id) };
          }
          case 'add_link': // PR bodies carry "Refs #n" (delivery PR template); nothing to write here
            return { opId: op.opId, ok: true, remoteId: op.remoteId };
          default:
            return { opId: op.opId, ok: false, error: `unsupported op ${op.type}` };
        }
      } catch (e) {
        if (e instanceof SyncHttpError) return { opId: op.opId, ok: false, error: e.message, httpStatus: e.status, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs };
        throw e;
      }
    },

    async findByLocalId(localId) {
      const q = `"sf-id: ${localId}" repo:${repo} in:body`;
      const r = await api('GET', `search/issues?q=${encodeURIComponent(q)}`);
      const i = r && r.items && r.items.find((x) => !x.pull_request);
      return i ? canonical(i, repo) : null;
    },
  };
  return self;
}
