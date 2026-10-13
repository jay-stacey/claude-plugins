// Linear adapter: GraphQL over fetch (https://api.linear.app/graphql). No delete or archive mutation.
// One team (scope.team_id) or several (scope.teams [{key, id}], contracts §21.3). Goals may be projects.
import { httpJson } from './http.mjs';
import { SyncHttpError } from '../core/ratelimit.mjs';
import { PRIORITY } from '../core/ownership.mjs';
import { mdToPlain } from '../core/normalize.mjs';

export const ENDPOINT = 'https://api.linear.app/graphql';

const ISSUE_FIELDS = `id identifier url title description priority dueDate updatedAt
  state { id name type } labels { nodes { id name } } assignee { id } parent { id } team { id key } project { id }
  cycle { id number isActive } creator { id }`;
const PROJECT_FIELDS = `id name description content slugId url updatedAt completedAt canceledAt
  labels { nodes { id name } } teams { nodes { id key } } creator { id }`;
const CYCLE_FIELDS = 'id number name startsAt endsAt';
const OPEN_ONLY = 'state: { type: { nin: ["completed", "canceled"] } }';
const MAX_PAGES = 10;

function canonical(n) {
  if (!n) return null;
  return {
    remoteId: n.id, key: n.identifier, url: n.url, kind: 'issue', title: n.title || '', body: n.description || '',
    bodyText: mdToPlain(n.description || ''), statusId: n.state ? n.state.id : null, statusName: n.state ? n.state.name : null,
    statusType: n.state ? n.state.type : null, labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
    assigneeId: n.assignee ? n.assignee.id : null, priority: PRIORITY.fromLinear[n.priority] ?? null, dueDate: n.dueDate || null,
    parentRemoteId: n.parent ? n.parent.id : null, containerId: n.team ? n.team.id : null, updatedAt: n.updatedAt,
    closed: !!n.state && ['completed', 'canceled'].includes(n.state.type),
    teamKey: n.team ? n.team.key || null : null, projectId: n.project ? n.project.id : null,
    cycleId: n.cycle ? n.cycle.id : null, cycleNumber: n.cycle ? n.cycle.number ?? null : null, cycleActive: !!(n.cycle && n.cycle.isActive),
    authorId: n.creator ? n.creator.id : null,
  };
}

function canonicalProject(n) {
  if (!n) return null;
  const teams = (n.teams && n.teams.nodes) || [];
  const body = n.content || n.description || '';
  return {
    remoteId: n.id, key: n.slugId || n.id, url: n.url, kind: 'project', title: n.name || '', body, bodyText: mdToPlain(body),
    statusId: null, statusName: null, statusType: null, labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
    assigneeId: null, priority: null, dueDate: null, parentRemoteId: null, containerId: teams[0] ? teams[0].id : null,
    updatedAt: n.updatedAt, closed: !!(n.completedAt || n.canceledAt), teamKey: teams[0] ? teams[0].key : null,
    teamKeys: teams.map((t) => t.key), teamIds: teams.map((t) => t.id), projectId: null, cycleId: null, cycleNumber: null,
    cycleActive: false, authorId: n.creator ? n.creator.id : null,
  };
}

function cycleOut(c) {
  return c ? { tracker_id: c.id, number: c.number ?? null, name: c.name || null, starts_at: c.startsAt || null, ends_at: c.endsAt || null } : null;
}

/** Linear project description holds at most 255 characters; the full text goes in content. */
function shortDescription(body) {
  const first = mdToPlain(String(body || '').replace(/\n?[^\n]*sf-id:[^\n]*$/i, '')).trim();
  return first.length > 255 ? `${first.slice(0, 252)}...` : first;
}

export function createLinear({ apiKey, fetch: fetchFn = globalThis.fetch, scope = {}, now = () => Date.now() } = {}) {
  if (!apiKey) throw new SyncHttpError('missing credentials: linear_api_key', { code: 'NO_CREDENTIALS' });
  const multi = Array.isArray(scope.teams) && scope.teams.length > 0;
  const idByKey = new Map((scope.teams || []).map((t) => [String(t.key).toUpperCase(), t.id]));
  const teamIds = () => (multi ? scope.teams.map((t) => t.id) : [scope.team_id]);
  const labelsByTeam = new Map(); // teamId -> Map(name(lower) -> id)
  const labelsLoaded = new Set();
  let lastRate = {};

  async function gql(query, variables = {}) {
    const r = await httpJson(fetchFn, ENDPOINT, { method: 'POST', headers: { Authorization: apiKey }, body: { query, variables }, now: now() });
    lastRate = r.rate || {};
    if (r.json && Array.isArray(r.json.errors) && r.json.errors.length) {
      throw new SyncHttpError(r.json.errors.map((e) => e.message).join('; ').slice(0, 200), { status: r.status, requestId: r.requestId });
    }
    return r.json ? r.json.data : null;
  }

  function teamIdOf(key) {
    if (!key) return scope.team_id;
    const id = idByKey.get(String(key).toUpperCase());
    if (!id) throw new SyncHttpError(`team ${key} is not a configured tracker team`, { status: 400 });
    return id;
  }

  function labelMap(teamId) { if (!labelsByTeam.has(teamId)) labelsByTeam.set(teamId, new Map()); return labelsByTeam.get(teamId); }
  function rememberLabels(teamId, nodes) { const m = labelMap(teamId); for (const l of nodes || []) m.set(String(l.name).toLowerCase(), l.id); }
  async function loadLabels(teamId, names) {
    const m = labelMap(teamId);
    if (labelsLoaded.has(teamId) || (names || []).every((n) => m.has(String(n).toLowerCase()))) return;
    const d = await gql(`query($id: String!) { team(id: $id) { id key labels(first: 250) { nodes { id name } } } }`, { id: teamId });
    rememberLabels(teamId, d && d.team && d.team.labels ? d.team.labels.nodes : []);
    labelsLoaded.add(teamId);
  }

  async function getIssue(id) {
    const d = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id });
    return d && d.issue ? canonical(d.issue) : null;
  }

  async function getProject(id) {
    const d = await gql(`query ProjectById($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`, { id });
    return d && d.project ? canonicalProject(d.project) : null;
  }

  /** Paginated issue query (variable $after). Returns true when more pages were left unread. */
  async function pages(query, variables, take, max = MAX_PAGES) {
    let after = null;
    for (let page = 0; page < max; page++) {
      const d = await gql(query, { ...variables, after });
      for (const n of d.issues.nodes) take(n);
      if (!d.issues.pageInfo || !d.issues.pageInfo.hasNextPage) return false;
      after = d.issues.pageInfo.endCursor;
    }
    return true; // truncated
  }

  /**
   * Projects of the given teams, listed per team (Team.projects) and filtered here: no reliance on ProjectFilter
   * fields. Returns canonical projects, unique by id.
   */
  async function teamProjects(ids, maxPages = 4) {
    const out = new Map();
    for (const id of ids) {
      let after = null;
      for (let page = 0; page < maxPages; page++) {
        const d = await gql(`query TeamProjects($id: String!, $after: String) { team(id: $id) { id projects(first: 50, after: $after) { nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } } } }`, { id, after });
        const conn = d && d.team && d.team.projects;
        for (const n of (conn && conn.nodes) || []) if (!out.has(n.id)) out.set(n.id, canonicalProject(n));
        if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
        after = conn.pageInfo.endCursor;
      }
    }
    return [...out.values()];
  }
  const configuredProject = (c) => (c.teamIds || []).some((id) => teamIds().includes(id));

  async function teamCycles(ids) {
    const out = {};
    for (const id of ids) {
      const d = await gql(`query TeamCycles($id: String!) { team(id: $id) { id key activeCycle { ${CYCLE_FIELDS} } cycles(filter: { isNext: { eq: true } }, first: 1) { nodes { ${CYCLE_FIELDS} } } } }`, { id });
      const t = d && d.team;
      if (!t) continue;
      out[t.key] = { current: cycleOut(t.activeCycle), next: cycleOut(((t.cycles && t.cycles.nodes) || [])[0]) };
    }
    return out;
  }

  const api = {
    name: 'linear',
    rate: () => lastRate,
    capabilities() {
      return { statusModel: 'workflow', goalModels: ['parent_issue', 'project'], deltaPull: 'updatedAt', comments: true, links: 'attachment', subIssues: true, maxWritesPerTick: 20 };
    },

    /**
     * scopeHint: {team_key} (one team, A7), {list_teams: true} (teams only), or {team_keys: [...], partial?} (per-team
     * states, labels and cycles; `missing` lists keys not found; without partial a missing key stops before details).
     */
    async discover(scopeHint = {}) {
      const d = await gql(`query Teams { viewer { id displayName name } teams(first: 100) { nodes { id key name parent { id key } } } }`);
      const all = ((d && d.teams && d.teams.nodes) || []);
      const scopes = all.map((t) => ({ id: t.id, key: t.key, name: t.name, parentKey: t.parent ? t.parent.key || null : null }));
      const out = { viewer: { id: d.viewer.id, handle: d.viewer.displayName || d.viewer.name }, scopes, states: [], labels: [], fields: { priority: true } };
      if (scopeHint.list_teams) return out;
      const detail = async (team) => {
        const t = await gql(`query($id: String!) { team(id: $id) { id key states { nodes { id name type position } } labels(first: 250) { nodes { id name } } } }`, { id: team.id });
        const states = ((t.team.states && t.team.states.nodes) || []).map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position }));
        const labels = (t.team.labels && t.team.labels.nodes) || [];
        rememberLabels(team.id, labels);
        return { states, labels };
      };
      const find = (key) => scopes.find((t) => t.key.toLowerCase() === String(key).toLowerCase()) || null;
      if (Array.isArray(scopeHint.team_keys)) {
        out.teams = []; out.missing = [];
        for (const k of scopeHint.team_keys) { if (!find(k)) out.missing.push(String(k)); }
        if (out.missing.length && !scopeHint.partial) return out; // setup checks every key before any detail call
        const found = scopeHint.team_keys.map(find).filter(Boolean);
        const cyc = await teamCycles(found.map((t) => t.id));
        for (const team of found) {
          const { states, labels } = await detail(team);
          out.teams.push({ ...team, states, labels, cycles: cyc[team.key] || { current: null, next: null } });
        }
        return out;
      }
      const key = scopeHint.team_key || scope.team_key || null;
      const team = key ? find(key) : null;
      if (team) {
        const { states, labels } = await detail(team);
        out.team = { id: team.id, key: team.key, name: team.name };
        out.states = states;
        out.labels = labels;
      }
      return out;
    },

    /**
     * opts: cursor, mappedRemoteIds (issues), mappedProjectIds, full, intakeLabel,
     * streams {mode: intake_label|cycle|all, labels: [...], teamIds: [...]}|null, projects {label}|null.
     */
    async pull({ cursor = null, scope: sc = {}, mappedRemoteIds = [], mappedProjectIds = [], full = false, intakeLabel = 'factory-intake', streams = null, projects = null } = {}) {
      const teamId = sc.team_id || scope.team_id;
      const ids = teamIds();
      const inScope = (c) => (multi ? ids.includes(c.containerId) : c.containerId === teamId);
      const items = new Map(); const comments = []; let maxUpdated = cursor;
      const bump = (u) => { if (u && (!maxUpdated || Date.parse(u) > Date.parse(maxUpdated))) maxUpdated = u; };
      const take = (n) => {
        const c = canonical(n); items.set(c.remoteId, c);
        bump(c.updatedAt);
        for (const cm of (n.comments && n.comments.nodes) || []) {
          comments.push({ remoteId: c.remoteId, id: cm.id, body: cm.body || '', authorId: cm.user ? cm.user.id : null, author: cm.user ? cm.user.displayName : null, createdAt: cm.createdAt, updatedAt: cm.updatedAt });
        }
      };
      const takeProject = (n) => { const c = canonicalProject(n); items.set(c.remoteId, c); bump(c.updatedAt); };
      const since = cursor || new Date(now() - 24 * 3600 * 1000).toISOString();
      const COMMENTS = 'comments(filter: { updatedAt: { gt: $since } }) { nodes { id body createdAt updatedAt user { id displayName } } }';
      let truncated = false;
      if (!full && cursor) {
        if (!multi) {
          let after = null;
          for (let page = 0; page < 4; page++) {
            const d = await gql(`query($team: ID!, $since: DateTimeOrDuration!, $after: String) {
            issues(filter: { team: { id: { eq: $team } }, updatedAt: { gt: $since } }, orderBy: updatedAt, first: 50, after: $after) {
              nodes { ${ISSUE_FIELDS} ${COMMENTS} }
              pageInfo { hasNextPage endCursor } } }`, { team: teamId, since, after });
            for (const n of d.issues.nodes) take(n);
            if (!d.issues.pageInfo.hasNextPage) break;
            if (page === 3) truncated = true;
            after = d.issues.pageInfo.endCursor;
          }
        } else {
          truncated = await pages(`query TeamsDelta($teams: [ID!], $since: DateTimeOrDuration!, $after: String) {
            issues(filter: { team: { id: { in: $teams } }, updatedAt: { gt: $since } }, orderBy: updatedAt, first: 50, after: $after) {
              nodes { ${ISSUE_FIELDS} ${COMMENTS} } pageInfo { hasNextPage endCursor } } }`, { teams: ids, since }, take, 4);
        }
        if (projects) {
          for (const c of await teamProjects(ids)) if (Date.parse(c.updatedAt) > Date.parse(since)) { items.set(c.remoteId, c); bump(c.updatedAt); }
        }
      } else {
        // Full reconcile (or first pull): every mapped item by id (any team), plus intake candidates in the teams.
        for (let i = 0; i < mappedRemoteIds.length; i += 50) {
          const chunk = mappedRemoteIds.slice(i, i + 50);
          const d = await gql(`query($ids: [ID!]) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`, { ids: chunk });
          for (const n of d.issues.nodes) take(n);
        }
        if (!multi) {
          const d = await gql(`query($team: ID!, $label: String!) { issues(filter: { team: { id: { eq: $team } }, labels: { name: { eq: $label } } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`, { team: teamId, label: intakeLabel });
          for (const n of d.issues.nodes) take(n);
        } else {
          await pages(`query TeamsIntake($teams: [ID!], $label: String!, $after: String) { issues(filter: { team: { id: { in: $teams } }, labels: { name: { eq: $label } } }, first: 50, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { teams: ids, label: intakeLabel }, take);
        }
        if (streams && streams.mode !== 'intake_label' && (streams.labels || []).length && (streams.teamIds || []).length) {
          const cyc = streams.mode === 'cycle' ? ', cycle: { isActive: { eq: true } }' : '';
          await pages(`query StreamItems($teams: [ID!], $labels: [String!], $after: String) { issues(filter: { team: { id: { in: $teams } }, labels: { name: { in: $labels } }, ${OPEN_ONLY}${cyc} }, first: 50, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`, { teams: streams.teamIds, labels: streams.labels }, take);
        }
        if (projects) {
          for (let i = 0; i < mappedProjectIds.length; i += 50) {
            const d = await gql(`query ProjectsById($ids: [ID!]) { projects(filter: { id: { in: $ids } }, first: 50) { nodes { ${PROJECT_FIELDS} } } }`, { ids: mappedProjectIds.slice(i, i + 50) });
            for (const n of d.projects.nodes) takeProject(n);
          }
          const label = String(projects.label || intakeLabel).toLowerCase();
          for (const c of await teamProjects(ids)) if (c.labels.some((l) => String(l).toLowerCase() === label)) items.set(c.remoteId, c);
        }
      }
      const issueMissing = full
        ? mappedRemoteIds.filter((id) => !items.has(id) || !inScope(items.get(id)))
        : [...items.values()].filter((c) => c.kind === 'issue' && mappedRemoteIds.includes(c.remoteId) && !inScope(c)).map((c) => c.remoteId);
      const projectMissing = full && projects ? mappedProjectIds.filter((id) => !items.has(id)) : [];
      return { items: [...items.values()], comments, missing: [...issueMissing, ...projectMissing], nextCursor: (truncated && cursor) || maxUpdated || cursor || new Date(now() - 300000).toISOString(), ...(truncated ? { truncated: true } : {}) };
    },

    /** Current and next cycle per team key. */
    async cycles(ids = teamIds()) { return teamCycles(ids); },

    /** Per-team snapshot (§21.3.8) for teams [{id, key}]: issues updated in the last 90 days by state type, started issues. */
    async snapshot(teams) {
      const list = teams || (multi ? scope.teams : [{ id: scope.team_id, key: scope.team_key }]);
      const since = new Date(now() - 90 * 24 * 3600 * 1000).toISOString();
      const cyc = await teamCycles(list.map((t) => t.id));
      const out = {};
      for (const { id, key } of list) {
        const counts = { triage: 0, backlog: 0, unstarted: 0, started: 0, completed: 0, canceled: 0 };
        const started = [];
        const take = (n) => {
          const type = n.state ? n.state.type : null;
          if (type in counts) counts[type] += 1;
          if (type === 'started' && started.length < 20) started.push({ key: n.identifier, title: n.title || '', state: n.state.name, url: n.url, cycle_number: n.cycle ? n.cycle.number ?? null : null });
        };
        const truncated = await pages(`query Snapshot($team: ID!, $since: DateTimeOrDuration!, $after: String) { issues(filter: { team: { id: { eq: $team } }, updatedAt: { gt: $since } }, first: 100, after: $after) { nodes { id identifier title url state { name type } cycle { number } } pageInfo { hasNextPage endCursor } } }`, { team: id, since }, take);
        const c = (cyc[key] || {}).current || null;
        out[key] = { counts, in_progress: started, cycle: c ? { tracker_id: c.tracker_id, number: c.number, starts_at: c.starts_at, ends_at: c.ends_at } : null, ...(truncated ? { truncated: true } : {}) };
      }
      return out;
    },

    async push(ops) {
      const out = [];
      for (const op of ops) out.push(await api.pushOne(op));
      return out;
    },

    async pushOne(op) {
      const p = op.payload || {};
      try {
        const teamId = op.type === 'ensure_label' || (op.type === 'create_item' && op.kind !== 'project') ? teamIdOf(p.team) : null;
        const ids = (names) => (names || []).map((n) => labelMap(teamId).get(String(n).toLowerCase())).filter(Boolean);
        const project = op.kind === 'project';
        switch (op.type) {
          case 'ensure_label': {
            await loadLabels(teamId, [p.name]);
            if (labelMap(teamId).has(String(p.name).toLowerCase())) return { opId: op.opId, ok: true };
            const d = await gql(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`, { input: { name: p.name, teamId } });
            rememberLabels(teamId, [d.issueLabelCreate.issueLabel]);
            return { opId: op.opId, ok: true };
          }
          case 'create_item': {
            if (project) {
              const input = { name: p.title, description: shortDescription(p.body), content: p.body, teamIds: (p.teams || []).length ? p.teams.map(teamIdOf) : [scope.team_id] };
              const d = await gql(`mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } } }`, { input });
              const c = canonicalProject(d.projectCreate.project);
              return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
            }
            await loadLabels(teamId, p.labels);
            const input = { teamId, title: p.title, description: p.body, labelIds: ids(p.labels) };
            if (p.statusId) input.stateId = p.statusId;
            if (p.parentRemoteId) input.parentId = p.parentRemoteId;
            if (p.projectId) input.projectId = p.projectId;
            if (p.cycleId) input.cycleId = p.cycleId;
            if (p.priority && PRIORITY.toLinear[p.priority]) input.priority = PRIORITY.toLinear[p.priority];
            const d = await gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { input });
            const c = canonical(d.issueCreate.issue);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'update_fields': case 'set_teams': {
            if (project) {
              const input = {};
              if (op.type === 'update_fields') {
                if (p.title !== undefined) input.name = p.title;
                if (p.body !== undefined) { input.content = p.body; input.description = shortDescription(p.body); }
              } else input.teamIds = [...new Set([...(p.keepIds || []), ...(p.teams || []).map(teamIdOf)])];
              const d = await gql(`mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { ${PROJECT_FIELDS} } } }`, { id: op.remoteId, input });
              const c = canonicalProject(d.projectUpdate.project);
              return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
            }
            if (op.type === 'set_teams') return { opId: op.opId, ok: false, error: 'set_teams applies to projects only' };
          }
          // falls through for issues
          case 'set_status': case 'set_parent': case 'set_cycle': {
            if (project) return { opId: op.opId, ok: false, error: `${op.type} is not used for projects` };
            const input = {};
            if (op.type === 'update_fields') { if (p.title !== undefined) input.title = p.title; if (p.body !== undefined) input.description = p.body; }
            if (op.type === 'set_status') input.stateId = p.statusId;
            if (op.type === 'set_parent') input.parentId = p.parentRemoteId;
            if (op.type === 'set_cycle') input.cycleId = p.cycleId || null;
            const d = await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { id: op.remoteId, input });
            const c = canonical(d.issueUpdate.issue);
            return { opId: op.opId, ok: true, remoteId: c.remoteId, remoteUpdatedAt: c.updatedAt, returned: c };
          }
          case 'add_comment': {
            if (project) return { opId: op.opId, ok: false, error: 'comments on projects are not supported' };
            const d = await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, { input: { issueId: op.remoteId, body: p.text } });
            return { opId: op.opId, ok: true, remoteId: op.remoteId, commentId: d.commentCreate.comment.id };
          }
          case 'add_link': {
            await gql(`mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }`, { issueId: op.remoteId, url: p.url, title: p.linkTitle || 'Pull request' });
            return { opId: op.opId, ok: true, remoteId: op.remoteId };
          }
          case 'add_to_container':
            return { opId: op.opId, ok: false, error: 'add_to_container is not used for Linear (projectId is set on create)' };
          default:
            return { opId: op.opId, ok: false, error: `unsupported op ${op.type}` };
        }
      } catch (e) {
        if (e instanceof SyncHttpError) return { opId: op.opId, ok: false, error: e.message, httpStatus: e.status, rateLimited: e.rateLimited, retryAfterMs: e.retryAfterMs, requestId: e.requestId };
        throw e;
      }
    },

    /** Find an item by its sf-id footer: issues in the configured teams, or projects ({kind: 'project'}). */
    async findByLocalId(localId, { kind = null } = {}) {
      const text = `sf-id: ${localId}`;
      if (kind === 'project') {
        return (await teamProjects(teamIds())).find((c) => configuredProject(c) && String(c.body).includes(text)) || null;
      }
      const d = multi
        ? await gql(`query TeamsByText($text: String!, $teams: [ID!]) { issues(filter: { description: { contains: $text }, team: { id: { in: $teams } } }, first: 2) { nodes { ${ISSUE_FIELDS} } } }`, { text, teams: teamIds() })
        : await gql(`query($text: String!, $team: ID!) { issues(filter: { description: { contains: $text }, team: { id: { eq: $team } } }, first: 2) { nodes { ${ISSUE_FIELDS} } } }`, { text, team: scope.team_id });
      const n = d && d.issues && d.issues.nodes[0];
      return n ? canonical(n) : null;
    },

    /** One issue or project by id (used to link records that carry tracker_ref). */
    async getItem(id, kind = 'issue') { return kind === 'project' ? getProject(id) : getIssue(id); },

    getIssue,
  };
  return api;
}
