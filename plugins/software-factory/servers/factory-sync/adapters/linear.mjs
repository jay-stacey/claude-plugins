// Linear adapter: GraphQL over fetch (https://api.linear.app/graphql). No delete or archive mutation.
import { httpJson } from './http.mjs';
import { SyncHttpError } from '../core/ratelimit.mjs';
import { PRIORITY } from '../core/ownership.mjs';
import { mdToPlain } from '../core/normalize.mjs';

export const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `id identifier url title description priority dueDate updatedAt
  state { id name type } labels { nodes { id name } } assignee { id } parent { id } team { id key } project { id }`;

function canonical(n) {
  if (!n) return null;
  return {
    remoteId: n.id, key: n.identifier, url: n.url, kind: 'issue', title: n.title || '', body: n.description || '',
    bodyText: mdToPlain(n.description || ''), statusId: n.state ? n.state.id : null, statusName: n.state ? n.state.name : null,
    statusType: n.state ? n.state.type : null, labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
    assigneeId: n.assignee ? n.assignee.id : null, priority: PRIORITY.fromLinear[n.priority] ?? null, dueDate: n.dueDate || null,
    parentRemoteId: n.parent ? n.parent.id : null, containerId: n.team ? n.team.id : null, updatedAt: n.updatedAt,
    closed: !!n.state && ['completed', 'canceled'].includes(n.state.type),
  };
}

export function createLinear({ apiKey, fetch: fetchFn = globalThis.fetch, scope = {}, now = () => Date.now() } = {}) {
  if (!apiKey) throw new SyncHttpError('missing credentials: linear_api_key', { code: 'NO_CREDENTIALS' });
  const labelIds = new Map(); // name(lower) -> id
  let lastRate = {};

  async function gql(query, variables = {}) {
    const r = await httpJson(fetchFn, ENDPOINT, { method: 'POST', headers: { Authorization: apiKey }, body: { query, variables }, now: now() });
    lastRate = r.rate || {};
    if (r.json && Array.isArray(r.json.errors) && r.json.errors.length) {
      throw new SyncHttpError(r.json.errors.map((e) => e.message).join('; ').slice(0, 200), { status: r.status, requestId: r.requestId });
    }
    return r.json ? r.json.data : null;
  }

  function rememberLabels(nodes) { for (const l of nodes || []) labelIds.set(String(l.name).toLowerCase(), l.id); }
  let labelsLoaded = false;
  async function loadLabels(names) {
    if (labelsLoaded || (names || []).every((n) => labelIds.has(String(n).toLowerCase()))) return;
    const d = await gql(`query($id: String!) { team(id: $id) { id key labels(first: 250) { nodes { id name } } } }`, { id: scope.team_id });
    rememberLabels(d && d.team && d.team.labels ? d.team.labels.nodes : []);
    labelsLoaded = true;
  }

  async function getIssue(id) {
    const d = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
    return d && d.issue ? canonical(d.issue) : null;
  }

  const api = {
    name: 'linear',
    rate: () => lastRate,
    capabilities() {
      return { statusModel: 'workflow', goalModels: ['parent_issue', 'project'], deltaPull: 'updatedAt', comments: true, links: 'attachment', subIssues: true, maxWritesPerTick: 20 };
    },

    async discover(scopeHint = {}) {
      const key = scopeHint.team_key || scope.team_key || null;
      const d = await gql(`query { viewer { id displayName name } teams(first: 100) { nodes { id key name } } }`);
      const scopes = ((d && d.teams && d.teams.nodes) || []).map((t) => ({ id: t.id, key: t.key, name: t.name }));
      const out = { viewer: { id: d.viewer.id, handle: d.viewer.displayName || d.viewer.name }, scopes, states: [], labels: [], fields: { priority: true } };
      const team = key ? scopes.find((t) => t.key.toLowerCase() === String(key).toLowerCase()) : null;
      if (team) {
        const t = await gql(`query($id: String!) { team(id: $id) { id key states { nodes { id name type position } } labels(first: 250) { nodes { id name } } } }`, { id: team.id });
        out.team = team;
        out.states = ((t.team.states && t.team.states.nodes) || []).map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position }));
        out.labels = (t.team.labels && t.team.labels.nodes) || [];
        rememberLabels(out.labels);
      }
      return out;
    },

    async pull({ cursor = null, scope: sc = {}, mappedRemoteIds = [], full = false, intakeLabel = 'factory-intake' } = {}) {
      const teamId = sc.team_id || scope.team_id;
      const items = new Map(); const comments = []; let maxUpdated = cursor;
      const take = (n) => {
        const c = canonical(n); items.set(c.remoteId, c);
        if (!maxUpdated || Date.parse(c.updatedAt) > Date.parse(maxUpdated)) maxUpdated = c.updatedAt;
        for (const cm of (n.comments && n.comments.nodes) || []) {
          comments.push({ remoteId: c.remoteId, id: cm.id, body: cm.body || '', authorId: cm.user ? cm.user.id : null, author: cm.user ? cm.user.displayName : null, createdAt: cm.createdAt, updatedAt: cm.updatedAt });
        }
      };
      const since = cursor || new Date(now() - 24 * 3600 * 1000).toISOString();
      if (!full && cursor) {
        let after = null;
        for (let page = 0; page < 4; page++) {
          const d = await gql(`query($team: ID!, $since: DateTimeOrDuration!, $after: String) {
            issues(filter: { team: { id: { eq: $team } }, updatedAt: { gt: $since } }, orderBy: updatedAt, first: 50, after: $after) {
              nodes { ${ISSUE_FIELDS} comments(filter: { updatedAt: { gt: $since } }) { nodes { id body createdAt updatedAt user { id displayName } } } }
              pageInfo { hasNextPage endCursor } } }`, { team: teamId, since, after });
          for (const n of d.issues.nodes) take(n);
          if (!d.issues.pageInfo.hasNextPage) break;
          after = d.issues.pageInfo.endCursor;
        }
      } else {
        // Full reconcile (or first pull): every mapped item by id, plus intake candidates in the team.
        for (let i = 0; i < mappedRemoteIds.length; i += 50) {
          const ids = mappedRemoteIds.slice(i, i + 50);
          const d = await gql(`query($ids: [ID!]) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`, { ids });
          for (const n of d.issues.nodes) take(n);
        }
        const d = await gql(`query($team: ID!, $label: String!) { issues(filter: { team: { id: { eq: $team } }, labels: { name: { eq: $label } } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`, { team: teamId, label: intakeLabel });
        for (const n of d.issues.nodes) take(n);
      }
      const missing = full ? mappedRemoteIds.filter((id) => !items.has(id) || items.get(id).containerId !== teamId) : [...items.values()].filter((c) => mappedRemoteIds.includes(c.remoteId) && c.containerId !== teamId).map((c) => c.remoteId);
      return { items: [...items.values()], comments, missing, nextCursor: maxUpdated || cursor || new Date(now() - 300000).toISOString() };
    },

    async push(ops) {
      const out = [];
      for (const op of ops) out.push(await api.pushOne(op));
      return out;
    },

    async pushOne(op) {
      const p = op.payload || {};
      const teamId = scope.team_id;
      const ids = (names) => (names || []).map((n) => labelIds.get(String(n).toLowerCase())).filter(Boolean);
      try {
        switch (op.type) {
          case 'ensure_label': {
            await loadLabels([p.name]);
            if (labelIds.has(String(p.name).toLowerCase())) return { opId: op.opId, ok: true };
            const d = await gql(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`, { input: { name: p.name, teamId } });
            rememberLabels([d.issueLabelCreate.issueLabel]);
            return { opId: op.opId, ok: true };
          }
          case 'create_item': {
            await loadLabels(p.labels);
            const input = { teamId, title: p.title, description: p.body, labelIds: ids(p.labels) };
            if (p.statusId) input.stateId = p.statusId;
            if (p.parentRemoteId) input.parentId = p.parentRemoteId;
            if (p.priority && PRIORITY.toLinear[p.priority]) input.priority = PRIORITY.toLinear[p.priority];
            const d = await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { input });
            const c = canonical(d.issueCreate.issue);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'update_fields': case 'set_status': case 'set_parent': {
            const input = {};
            if (op.type === 'update_fields') { if (p.title !== undefined) input.title = p.title; if (p.body !== undefined) input.description = p.body; }
            if (op.type === 'set_status') input.stateId = p.statusId;
            if (op.type === 'set_parent') input.parentId = p.parentRemoteId;
            const d = await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { id: op.remoteId, input });
            const c = canonical(d.issueUpdate.issue);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'add_comment': {
            const d = await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, { input: { issueId: op.remoteId, body: p.text } });
            return { opId: op.opId, ok: true, remoteId: op.remoteId, commentId: d.commentCreate.comment.id };
          }
          case 'add_link': {
            await gql(`mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }`, { issueId: op.remoteId, url: p.url, title: p.linkTitle || 'Pull request' });
            return { opId: op.opId, ok: true, remoteId: op.remoteId };
          }
          case 'add_to_container':
            return { opId: op.opId, ok: false, error: 'add_to_container is not used for Linear parent_issue mapping' };
          default:
            return { opId: op.opId, ok: false, error: `unsupported op ${op.type}` };
        }
      } catch (e) {
        if (e instanceof SyncHttpError) return { opId: op.opId, ok: false, error: e.message, httpStatus: e.status, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs, requestId: e.requestId };
        throw e;
      }
    },

    async findByLocalId(localId) {
      const d = await gql(`query($text: String!, $team: ID!) { issues(filter: { description: { contains: $text }, team: { id: { eq: $team } } }, first: 2) { nodes { ${ISSUE_FIELDS} } } }`, { text: `sf-id: ${localId}`, team: scope.team_id });
      const n = d && d.issues && d.issues.nodes[0];
      return n ? canonical(n) : null;
    },

    getIssue,
  };
  return api;
}
