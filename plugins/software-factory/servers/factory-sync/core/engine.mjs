// Sync engine: one tick (resolve requests -> pull -> requests -> plan push -> guards -> outbox drain),
// the first-sync preview, discovery and status. Writes only .factory/sync/* and inbox requests.
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findHome, pluginRoot } from '../../../scripts/lib/paths.mjs';
import { isInitialized, leaseLive, readLease } from '../../../scripts/lib/state.mjs';
import { load as loadConfig } from '../../../scripts/lib/config.mjs';
import * as store from '../../../scripts/lib/store.mjs';
import { nowIso, readJson, readLines, writeJsonAtomic, writeTextAtomic } from '../../../scripts/lib/fsutil.mjs';
import { readState, statusLines, updateState } from '../../../scripts/lib/syncstate.mjs';
import { createAdapter, missingCredentials, syncEnabled } from '../adapters/index.mjs';
import { allEntries, ensureEntry, entryFor, loadMap, saveMap, byRemote } from './map.mjs';
import { planPull, planPush, remoteHashes, trackerLabels, bulkCounts, goalBody, taskBody, DEFAULT_PUSH_KINDS, hasRef, pushedGoal, pushedTask } from './planner.mjs';
import { classLabels, configuredKeys, cyclesFromTracker, entryTeam, factoryCycleFor, goalKeys, isMulti, readCycles, refOf, streamKeys, streamsCfg, taskKey } from './teams.mjs';

export { entryTeam };
import { proposeStatusMap, MAP_KEYS } from './ownership.mjs';
import { hashValue, sha, findSfId } from './normalize.mjs';
import { opId as makeOpId } from './echo.mjs';
import * as outbox from './outbox.mjs';
import { Budget } from './ratelimit.mjs';
import { checkOp, scan } from './redact.mjs';
import { knownKeys, outcome, raise } from './requests.mjs';
import { audit } from './log.mjs';
import { emit } from '../../../scripts/lib/events.mjs';

const MAX_LINES = 15;
const NETWORK_FAIL = (s) => !s || s >= 500 || s === 429;

class Stop extends Error { constructor(lines) { super(lines[0]); this.lines = lines; } }

function clock(deps) { return deps.now || (() => Date.now()); }

/** Open the factory home for a project dir. Throws Stop with a one-line answer when unusable. */
export function open(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') throw new Stop(['ERROR projectDir is required (absolute path of the project)']);
  const home = findHome(resolve(projectDir));
  if (!home || !isInitialized(home)) throw new Stop(['NOT_INITIALIZED run /software-factory:setup first']);
  const cfg = loadConfig(home);
  const t = cfg.tracker || { provider: 'none' };
  return { home, cfg, t, provider: t.provider || 'none' };
}

export function scopeKeyOf(provider, scope, cfg, env) {
  const s = scope || {};
  if (provider === 'linear' && isMulti({ ...(cfg || {}), tracker: { ...((cfg && cfg.tracker) || {}), provider } })) return 'linear:teams';
  if (provider === 'linear') return `linear:team:${s.team_key || '?'}${s.project_id ? `:project:${s.project_id}` : ''}`;
  if (provider === 'github') { const r = githubRepo(s, cfg); return `github:${r.owner}/${r.repo}`; }
  if (provider === 'jira') return `jira:${String((env && env.SF_JIRA_SITE) || '').replace(/^https?:\/\//, '')}:${s.project_key || '?'}`;
  return 'none';
}

function githubRepo(scope, cfg) {
  const rem = (cfg && cfg.project && cfg.project.remote) || {};
  return { owner: (scope && scope.owner) || rem.owner, repo: (scope && scope.repo) || rem.repo };
}

/** Adapter scope with resolved ids from discovery. */
export function adapterScope(provider, t, st, cfg) {
  const s = { ...(t.scope || {}) };
  if (provider === 'linear' && cfg && isMulti(cfg)) {
    const disc = (st.discovery && st.discovery.teams) || {};
    s.teams = configuredKeys(cfg).filter((k) => disc[k]).map((k) => ({ key: k, id: disc[k].id }));
    s.team_id = s.teams[0] ? s.teams[0].id : null;
    return s;
  }
  if (provider === 'linear' && st.discovery && st.discovery.team) s.team_id = st.discovery.team.id;
  if (provider === 'github') Object.assign(s, githubRepo(s, cfg));
  return s;
}

/**
 * Effective status map. With a team key (§21.3.3): that team's discovered map, and tracker.status_map either
 * keyed by team key or flat (a flat map applies to every team).
 */
export function statusMapFor(t, st, key = null) {
  const tk = key ? String(key).toUpperCase() : null;
  const team = tk && st.discovery && st.discovery.teams ? st.discovery.teams[tk] : null;
  const base = (tk && st.status_maps && st.status_maps[tk]) || st.status_map || {};
  let over = t.status_map || {};
  const keyed = Object.entries(over).some(([x, v]) => !MAP_KEYS.includes(x) && v && typeof v === 'object' && !v.id);
  if (keyed) over = (tk && (over[tk] || over[key])) || {};
  const states = (team && team.states) || (st.discovery && st.discovery.states) || [];
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!MAP_KEYS.includes(k)) continue;
    const id = typeof v === 'string' ? v : v && v.id;
    if (!id) continue;
    const s = states.find((x) => x.id === id);
    if (team && !s) continue; // a flat map applied to every team: an id from another team keeps this team's proposed state
    if (typeof v === 'string') out[k] = { id: v, name: s ? s.name : v, type: s ? s.type : null }; else out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function guardLines(provider, t, env, deps) {
  if (provider === 'none') throw new Stop(['SYNC off: tracker.provider is none']);
  if (!syncEnabled(env)) throw new Stop(['SYNC disabled on this machine (plugin option sync_enabled is off). No network calls.']);
  const miss = missingCredentials(provider, env);
  if (miss.length) throw new Stop([`PENDING_CREDENTIALS missing: ${miss.join(', ')}`, 'Add them with /plugin configure software-factory@personal-plugins, then run /reload-plugins.']);
  void t; void deps;
}

async function ensureDiscovery(c, st, adapter) {
  if (c.provider === 'linear' && isMulti(c.cfg)) {
    const keys = configuredKeys(c.cfg);
    const disc = st.discovery || {};
    const have = disc.teams || {};
    if (st.status_maps && keys.every((k) => have[k] || (disc.missing || []).includes(k))) return;
    const d = await adapter.discover({ team_keys: keys, partial: true });
    storeMultiDiscovery(st, c, d, keys);
    return;
  }
  const want = c.t.scope && c.t.scope.team_key ? String(c.t.scope.team_key).toUpperCase() : null;
  const needTeam = c.provider === 'linear' && (!(st.discovery && st.discovery.team) || (want && String(st.discovery.team.key).toUpperCase() !== want));
  if (st.discovery && st.status_map && !needTeam) return;
  const d = await adapter.discover(c.t.scope || {});
  storeDiscovery(st, c, d);
}

function storeDiscovery(st, c, d) {
  const scopes = (d.scopes || []).slice(0, 50).map((x) => ({ id: x.id, key: x.key, name: x.name }));
  st.discovery = { viewer: d.viewer, team: d.team || null, scopes, states: d.states || [], labels: (d.labels || []).map((l) => l.name), at: nowIso() };
  st.status_map = d.proposedStatusMap || proposeStatusMap(d.states || []);
  st.provider = c.provider;
}

/** Per-team discovery (§21.3.3): states, labels, cycles and one status map per tracker key. */
function storeMultiDiscovery(st, c, d, keys) {
  const teams = {};
  for (const t of d.teams || []) {
    teams[String(t.key).toUpperCase()] = { id: t.id, key: t.key, name: t.name, parent: t.parentKey || null, states: t.states || [],
      labels: (t.labels || []).map((l) => l.name), cycles: t.cycles || { current: null, next: null } };
  }
  st.discovery = { viewer: d.viewer, teams, missing: (d.missing || []).map((k) => String(k).toUpperCase()),
    scopes: (d.scopes || []).slice(0, 100).map((x) => ({ id: x.id, key: x.key, name: x.name, parent: x.parentKey || null })), at: nowIso() };
  st.status_maps = Object.fromEntries(Object.entries(teams).map(([k, t]) => [k, proposeStatusMap(t.states)]));
  const first = (keys || []).map((k) => String(k).toUpperCase()).find((k) => teams[k]) || Object.keys(teams)[0];
  st.status_map = first ? st.status_maps[first] : null;
  st.provider = c.provider;
}

/** Team context for the planners and the scope guard (§21.3). In single-team mode multi is false. */
function teamCtx(c, st) {
  const multi = c.provider === 'linear' && isMulti(c.cfg);
  const disc = (st.discovery && st.discovery.teams) || {};
  const configured = multi ? configuredKeys(c.cfg) : [];
  const active = configured.filter((k) => disc[k]);
  const lower = (xs) => new Set((xs || []).map((x) => String(x).toLowerCase()));
  return {
    multi, cfg: c.cfg, configured, keys: new Set(active),
    statusMapFor: (k) => statusMapFor(c.t, st, k),
    knownLabelsFor: (k) => { const kk = String(k).toUpperCase(); return lower([...((disc[kk] && disc[kk].labels) || []), ...(((st.labels_known_by_team || {})[kk]) || [])]); },
    cyclesTracker: cyclesFromTracker(c.cfg), cycles: readCycles(c.home),
    teamList: multi ? active.map((k) => ({ key: k, id: disc[k].id, name: disc[k].name }))
      : (c.provider === 'linear' && st.discovery && st.discovery.team ? [{ key: st.discovery.team.key, id: st.discovery.team.id, name: st.discovery.team.name }] : []),
  };
}

/** Pull options for streams (§21.4.5) and project intake (§21.3.5). */
function pullExtras(c, tc) {
  if (c.provider !== 'linear') return {};
  const s = streamsCfg(c.cfg);
  let streams = null;
  if (s.enabled) {
    const keys = streamKeys(c.cfg);
    const ids = tc.teamList.filter((t) => keys.includes(String(t.key).toUpperCase())).map((t) => t.id);
    streams = { mode: s.pull, labels: classLabels(c.cfg), teamIds: ids };
  }
  return { streams, projects: c.t.goal_mapping === 'project' ? { label: trackerLabels(c.t).intake } : null };
}

function streamCtx(c) {
  const s = streamsCfg(c.cfg);
  return s.enabled && c.provider === 'linear' ? { enabled: true, mode: s.pull, keys: new Set(streamKeys(c.cfg)) } : null;
}

function mappedIds(map) {
  const live = allEntries(map).filter(([, e]) => e.remoteId && !e.unlinked);
  return { issues: live.filter(([, e]) => e.kind !== 'project').map(([, e]) => String(e.remoteId)), projects: live.filter(([, e]) => e.kind === 'project').map(([, e]) => String(e.remoteId)) };
}

function localData(home) {
  return {
    goals: store.list(home, 'goal'),
    tasks: store.list(home, 'task'),
    epics: store.list(home, 'epic'),
  };
}

/** Handoffs of mapped tasks that crossed a role boundary (read-only). */
function handoffsFor(home, tasks, map) {
  const out = [];
  for (const t of tasks) {
    const e = entryFor(map, t.id);
    if (!e || !e.remoteId) continue;
    for (const runId of (t.runs || []).slice(-10)) {
      if ((e.commentedRuns || []).includes(runId)) continue;
      const run = store.get(home, 'run', runId);
      if (!run || run.status !== 'completed') continue;
      const h = readJson(join(home, 'runs', runId, 'handoff.json'), null);
      if (!h) continue;
      let ev = null;
      const first = (h.evidence || [])[0];
      if (first) {
        const line = readLines(join(home, 'runs', runId, 'evidence', 'index.jsonl')).find((x) => x.id === first);
        if (line) ev = { command: line.command, exit_code: line.exit_code };
      }
      out.push({ run_id: runId, task_id: t.id, from_role: h.from_role, to_role: h.to_role, summary: h.summary, evidence: ev, pr_url: h.pr_url || null, ended_at: run.ended_at });
    }
  }
  return out;
}

/** Persist state, keeping an approval the CLI wrote meanwhile. */
function saveState(home, st) {
  return updateState(home, (cur) => {
    const out = { ...st };
    if (cur.first_sync_approved && !st.first_sync_approved && !st._reset_approval) {
      out.first_sync_approved = true; out.approved_at = cur.approved_at; out.approved_by = cur.approved_by; out.cursor = cur.cursor;
    }
    delete out._reset_approval;
    return out;
  });
}

function trackedHold(cls) { return ['cancel', 'done_override', 'rework', 'scope_change', 'conflict'].includes(cls); }

/** Resolve tracked requests: rejected status changes push the mapped status back, and so on. */
function resolveRequests(c, st, map, now) {
  const extra = [];
  for (const [id, p] of Object.entries(st.pending_requests || {})) {
    const o = outcome(c.home, id);
    if (o === 'pending') continue;
    delete st.pending_requests[id];
    const entry = p.localId ? entryFor(map, p.localId) : null;
    if (entry && entry.hold === id) entry.hold = null;
    if (['cancel', 'done_override', 'rework'].includes(p.cls) && o === 'rejected' && entry && entry.remoteId) {
      entry.pushed.status = null; entry.pulled.status = undefined;
      extra.push({ type: 'add_comment', localId: p.localId, kind: entry.kind, remoteId: entry.remoteId, field: 'restore', valueHash: id,
        payload: { text: `[software-factory] ${p.localId}: the status change was not confirmed, so the factory keeps its status.` } });
    }
    if (['scope_change', 'conflict'].includes(p.cls) && o === 'rejected' && entry && entry.remoteId) {
      if (p.field === 'parent') {
        const task = store.get(c.home, 'task', p.localId);
        const ge = task ? entryFor(map, task.goal_id) : null;
        if (ge && ge.remoteId) extra.push({ type: 'set_parent', localId: p.localId, kind: 'task', remoteId: entry.remoteId, field: 'parent', valueHash: ge.remoteId, payload: { parentRemoteId: ge.remoteId } });
      } else if (entry.local) entry.local[p.field] = null; // the planner pushes the local text back
    }
    if (p.cls === 'missing' && entry) { if (o === 'approved') entry.unlinked = true; else entry.missing = false; }
    if (p.cls === 'bulk' && o === 'approved') st.bulk_approved = true;
    if (p.cls === 'cycle' && entry && entry.cycleHold === id) entry.cycleHold = null;
    if (p.cls === 'backlog' && p.key) {
      st.backlog_rejected = st.backlog_rejected || {};
      if (o === 'rejected') { if (st.raised) delete st.raised[p.key]; st.backlog_rejected[p.key] = p.cfg || null; } else delete st.backlog_rejected[p.key];
    }
    audit(c.home, { tick: st.tick_count, dir: 'pull', op: `request:${p.cls || p.type}`, localId: p.localId || null, result: o, fields: p.field ? [p.field] : [] }, now);
  }
  return extra.map((o) => ({ ...o, opId: makeOpId(o.localId, o.type, o.field, o.valueHash, '') }));
}

/** Hash of the stream config: a rejected backlog item is raised again when it changes. */
function streamsHash(c) { return sha(JSON.stringify([streamsCfg(c.cfg), c.cfg.teams || null])).slice(0, 16); }

function raiseAll(c, st, map, descriptors, known, modeName, { full = false } = {}) {
  const ids = [];
  const sh = streamsHash(c);
  for (const d0 of descriptors) {
    let d = d0;
    if (d.type === 'tracker.backlog_item') {
      // rejected by the CLI (streams off, no stream team): raise again only on a full pull or a new stream config
      const rej = (st.backlog_rejected || {})[d.key];
      if (rej && rej === sh && !full) continue;
      d = { ...d, track: { localId: null, field: 'backlog', cls: 'backlog', key: d.key, cfg: sh } };
    }
    const allowed = modeName === 'two_way' || (modeName === 'intake_only' && ['tracker.intake', 'tracker.backlog_item'].includes(d.type))
      || (d.type === 'tracker.cycles' && modeName !== 'dry_run');
    if (!allowed) { audit(c.home, { tick: st.tick_count, dir: 'pull', op: d.type, localId: d.track ? d.track.localId : null, result: modeName === 'dry_run' ? 'dry_run' : 'skipped_mode', fields: [] }); continue; }
    const id = raise(c.home, st, known, { ...d, provider: c.provider });
    if (!id) continue;
    ids.push(id);
    if (d.track && trackedHold(d.track.cls)) { const e = entryFor(map, d.track.localId); if (e) e.hold = id; }
    if (d.track && d.track.cls === 'cycle') { const e = entryFor(map, d.track.localId); if (e) e.cycleHold = id; }
  }
  return ids;
}

function applyResult(c, st, map, op, res, now) {
  if (op.type === 'ensure_label') {
    if (op.payload.team) {
      const k = String(op.payload.team).toUpperCase();
      st.labels_known_by_team = st.labels_known_by_team || {};
      st.labels_known_by_team[k] = [...new Set([...(st.labels_known_by_team[k] || []), String(op.payload.name).toLowerCase()])];
    } else st.labels_known = [...new Set([...(st.labels_known || []), String(op.payload.name).toLowerCase()])];
    return;
  }
  const entry = ensureEntry(map, op.localId);
  const labels = trackerLabels(c.t);
  const ret = res.returned;
  if (op.type === 'create_item') {
    Object.assign(entry, { remoteId: String(res.remoteId), key: ret ? ret.key : null, url: ret ? ret.url : null, pendingCreate: false, scopeKey: st.scope_key, created_at: nowIso(now) });
    if (op.payload.team) entry.team = String(op.payload.team).toUpperCase();
    if (op.kind === 'project') { entry.kind = 'project'; entry.teams = (ret && ret.teamKeys) || op.payload.teams || []; entry.teamIds = (ret && ret.teamIds) || []; }
    entry.pushed = ret ? remoteHashes(ret, labels) : {};
    entry.pulled = {}; entry.local = { ...(op.local || {}) };
    if (op.kind === 'task' && cyclesFromTracker(c.cfg)) { entry.remoteCycle = ret && ret.cycleId !== undefined ? ret.cycleId : op.payload.cycleId || null; entry.factoryCycle = op.payload.cycleId || null; }
    return;
  }
  if (ret) {
    const h = remoteHashes(ret, labels);
    entry.pushed.remoteUpdatedAt = h.remoteUpdatedAt;
    if (op.type === 'update_fields') { entry.pushed.title = h.title; entry.pushed.body = h.body; entry.pulled.title = undefined; entry.pulled.body = undefined; entry.local = { ...entry.local, ...(op.local || {}) }; }
    if (op.type === 'set_status') { entry.pushed.status = h.status; entry.pulled.status = undefined; entry.driftStatus = null; if (entry.linked) entry.remoteStatusType = ret.statusType || null; }
    if (op.type === 'set_parent') { entry.pushed.parent = h.parent; entry.pulled.parent = undefined; }
  } else {
    if (op.type === 'set_status') { entry.pushed.status = op.payload.statusId; entry.pulled.status = undefined; entry.driftStatus = null; }
    if (op.type === 'set_parent') { entry.pushed.parent = hashValue(op.payload.parentRemoteId, 'id'); entry.pulled.parent = undefined; }
    if (op.type === 'update_fields') entry.local = { ...entry.local, ...(op.local || {}) };
  }
  if (op.type === 'add_comment') {
    if (res.commentId) { entry.ourCommentIds = [...(entry.ourCommentIds || []), String(res.commentId)].slice(-500); }
    if (op.meta && op.meta.runId) entry.commentedRuns = [...(entry.commentedRuns || []), op.meta.runId].slice(-500);
    if (op.meta && op.meta.side) entry.local = { ...entry.local, side: op.meta.side };
  }
  if (op.type === 'add_link') entry.linkedPRs = [...new Set([...(entry.linkedPRs || []), op.payload.url])];
  if (op.type === 'set_teams') { entry.teams = ret && ret.teamKeys ? [...ret.teamKeys] : [...new Set([...(entry.teams || []), ...op.payload.teams])]; if (ret && ret.teamIds) entry.teamIds = [...ret.teamIds]; }
  if (op.type === 'add_comment' && op.meta && op.meta.note === 'cancelled') entry.local = { ...entry.local, noteCancelled: true };
  if (op.type === 'set_cycle') {
    entry.remoteCycle = ret && ret.cycleId !== undefined ? ret.cycleId : op.payload.cycleId || null;
    entry.local = { ...(entry.local || {}), cycleRef: (op.meta && op.meta.cycleRef) ?? null };
    entry.factoryCycle = op.payload.cycleId || null;
  }
}

function linkFound(c, st, map, localId, found, local, now) {
  const labels = trackerLabels(c.t);
  const entry = ensureEntry(map, localId);
  Object.assign(entry, { remoteId: String(found.remoteId), key: found.key, url: found.url, pendingCreate: false, scopeKey: st.scope_key, created_at: entry.created_at || nowIso(now) });
  if (st.scope_key === 'linear:teams' && found.teamKey && found.kind !== 'project') entry.team = String(found.teamKey).toUpperCase();
  if (found.kind === 'project') { entry.kind = 'project'; entry.teams = found.teamKeys || []; }
  entry.pushed = remoteHashes(found, labels); entry.pulled = {};
  entry.local = { ...(local || {}) };
}

function localHashes(r) { return { title: hashValue(r.title), body: hashValue(String(r.id).startsWith('G-') ? goalBody(r) : taskBody(r)) }; }

/** Records with a tracker_ref that still need a map entry (§21.3.6), pushed kinds only. */
function refRecords(c, goals, tasks, map) {
  const pushKinds = c.t.push_kinds || DEFAULT_PUSH_KINDS;
  const byId = new Map(goals.map((g) => [g.id, g]));
  const open = (r) => !['draft', 'cancelled'].includes(r.status) && hasRef(r) && !(entryFor(map, r.id) || {}).remoteId;
  return [...goals.filter((g) => pushedGoal(g) && open(g)), ...tasks.filter((x) => pushedTask(x, byId.get(x.goal_id), pushKinds) && open(x))];
}

/** Link records that carry a tracker_ref to their tracker item: a map entry, never a create. Reads only. */
async function linkRefs(c, st, map, adapter, recs, tc, known, summary, now) {
  const idx = byRemote(map);
  let n = 0;
  for (const r of recs) {
    const ref = refOf(r);
    if (ref.provider && ref.provider !== c.provider) continue;
    const rid = String(ref.remote_id);
    if (idx.has(rid)) { audit(c.home, { tick: st.tick_count, dir: 'push', op: 'link', localId: r.id, remoteKey: ref.key || null, result: 'skipped', reason: `already linked to ${idx.get(rid)}`, fields: [] }, now()); continue; }
    if (++n > 20 || typeof adapter.getItem !== 'function') break;
    let item = null;
    try { item = await adapter.getItem(rid, ref.kind === 'project' ? 'project' : 'issue'); } catch (e) {
      if (e.rateLimited || NETWORK_FAIL(e.status)) throw e;
      audit(c.home, { tick: st.tick_count, dir: 'push', op: 'link', localId: r.id, remoteKey: ref.key || null, result: 'not_found', reason: e.message, fields: [] }, now());
      continue;
    }
    if (!item) continue;
    const teams = item.kind === 'project' ? item.teamKeys || [] : [item.teamKey];
    const allowed = new Set(tc.teamList.map((x) => String(x.key).toUpperCase()));
    if (!teams.some((k) => k && allowed.has(String(k).toUpperCase()))) {
      const id = raise(c.home, st, known, { type: 'sync.scope_blocked', payload: { local_id: r.id, op: 'link', reason: `${item.key} is in a team that is not configured` }, key: sha(`scope\nlink\n${r.id}\n${rid}`).slice(0, 40), provider: c.provider });
      if (id) summary.requests.push(id);
      continue;
    }
    linkFound(c, st, map, r.id, item, localHashes(r), now());
    const e = entryFor(map, r.id);
    e.linked = true;
    if (item.kind !== 'project') e.remoteStatusType = item.statusType || null;
    if (tc.cyclesTracker && String(r.id).startsWith('T-') && item.kind === 'issue') { e.remoteCycle = item.cycleId || null; e.local.cycleRef = r.cycle ? factoryCycleFor(tc.cycles, item.cycleId) : null; } // a set cycle is pushed, a null one never clears the tracker
    idx.set(rid, r.id);
    audit(c.home, { tick: st.tick_count, dir: 'push', op: 'link', localId: r.id, remoteKey: item.key, result: 'ok', fields: ['tracker_ref'] }, now());
  }
}

/** Tracker cycles (§21.6.2) as the tracker.cycles payload. */
function cyclesPayload(byKey) {
  const teams = {};
  for (const [k, v] of Object.entries(byKey || {})) teams[String(k).toUpperCase()] = { current: v.current || null, next: v.next || null };
  return { teams };
}

function cyclesRequest(payload) {
  return { type: 'tracker.cycles', payload, needs_confirmation: false, auto_apply: true, key: `cycles:${sha(JSON.stringify(payload)).slice(0, 32)}`, track: null };
}

/** sync/snapshot.json (§21.3.8). Titles that trip the privacy scan are hidden. */
function writeSnapshot(home, snap, tc, now) {
  const teams = {};
  for (const t of tc.teamList) {
    const s = snap[t.key] || snap[String(t.key).toUpperCase()];
    if (!s) continue;
    teams[String(t.key).toUpperCase()] = {
      name: t.name || t.key, counts: s.counts,
      in_progress: (s.in_progress || []).slice(0, 20).map((x) => { const hit = scan(x.title); return { ...x, title: hit.length ? `(title hidden: ${hit.join(', ')})` : String(x.title).slice(0, 200) }; }),
      cycle: s.cycle || null, ...(s.truncated ? { truncated: true } : {}),
    };
  }
  writeJsonAtomic(join(home, 'sync', 'snapshot.json'), { v: 1, at: nowIso(now), teams });
}

/**
 * Scope guard: updates and comments only to mapped items of the current scope; parents must be mapped too.
 * Multi-team (§21.3.4): an op is blocked only when its team (or its entry's team) is not a configured key.
 */
function scopeViolation(op, map, scopeKey, tc = null) {
  const multi = !!(tc && tc.multi);
  const teamOk = (k) => !k || tc.keys.has(String(k).toUpperCase());
  if (multi) {
    if (op.payload && op.payload.team && !teamOk(op.payload.team)) return `team ${op.payload.team} is not a configured tracker team`;
    const bad = ((op.payload && op.payload.teams) || []).find((k) => !teamOk(k));
    if (bad) return `team ${bad} is not a configured tracker team`;
  }
  if (op.type === 'ensure_label') return null;
  const idx = byRemote(map);
  const check = (rid) => {
    if (!rid) return null;
    const lid = idx.get(String(rid));
    if (!lid) return 'target is not a mapped item';
    const e = entryFor(map, lid);
    if (multi) {
      if (e.kind === 'project') return (e.teams || []).length && !(e.teams || []).some(teamOk) ? `target belongs to teams ${e.teams.join(',')}` : null;
      const team = entryTeam(e);
      if (team && !teamOk(team)) return `target belongs to team ${team}`;
      if (!team && e.scopeKey && e.scopeKey !== scopeKey) return `target belongs to ${e.scopeKey}`;
      return null;
    }
    if (e.scopeKey && e.scopeKey !== scopeKey) return `target belongs to ${e.scopeKey}`;
    return null;
  };
  if (op.type === 'create_item') return check(op.payload.parentRemoteId) || check(op.payload.projectId);
  if (!op.remoteId) return 'no target';
  return check(op.remoteId) || (op.type === 'set_parent' ? check(op.payload.parentRemoteId) : null);
}

/** One sync tick. Returns {lines, summary}. deps: {env, fetch, ghExec, now, sleep, deadlineMs}. */
export async function syncTick({ projectDir, mode = 'delta' } = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = clock(deps);
  let c;
  try {
    c = open(projectDir);
    if (c.provider !== 'none' && c.t.status !== 'ready') throw new Stop([`SYNC not ready: tracker.status is ${c.t.status || 'unset'} (finish /software-factory:setup --section tracker)`]);
    const lease = readLease(c.home);
    if (!leaseLive(lease, now())) throw new Stop(['REFUSED: the dispatcher lease is not fresh. sync_tick runs only inside a factory tick (/software-factory:tick).']);
    guardLines(c.provider, c.t, env, deps);
  } catch (e) { if (e instanceof Stop) return { lines: e.lines, summary: null }; throw e; }

  const home = c.home;
  const t0 = now();
  const deadline = t0 + (deps.deadlineMs ?? 20000);
  const st = readState(home);
  if (mode === 'rebuild_map') return rebuildMap(c, st, deps, { now, env });
  const modeName = mode === 'dry_run' ? 'dry_run' : (c.t.mode || 'two_way');
  const cursorBefore = st.cursor;
  if (st.backoff_until && Date.parse(st.backoff_until) > now()) return { lines: [`SYNC backoff until ${st.backoff_until}`], summary: null };
  st.tick_count = (st.tick_count || 0) + 1;
  const scopeKey = scopeKeyOf(c.provider, c.t.scope, c.cfg, env);
  // Only this function changes scope_key. Approval stays only while every team it covered is still configured:
  // single X -> teams keeps it when X is configured; adding a team keeps it; dropping one resets it (§21.3.4).
  const configuredNow = scopeKey === 'linear:teams' ? configuredKeys(c.cfg) : [];
  const prevTeam = /^linear:team:([^:]+)$/.exec(st.scope_key || '');
  let prevTeams = null;
  if (st.scope_key === 'linear:teams') prevTeams = Array.isArray(st.scope_teams) ? st.scope_teams : ['?'];
  else if (prevTeam && scopeKey === 'linear:teams') prevTeams = [prevTeam[1].toUpperCase()];
  const kept = st.scope_key === scopeKey || (scopeKey === 'linear:teams' && prevTeams !== null);
  const dropped = prevTeams !== null && scopeKey === 'linear:teams' && !prevTeams.every((k) => configuredNow.includes(k));
  if ((st.scope_key && (!kept || dropped)) || (st.provider && st.provider !== c.provider)) {
    st.first_sync_approved = false; st.preview = null; st.cursor = null; st._reset_approval = true; st.discovery = null; st.status_map = null; st.status_maps = null; st.first_push_done = false;
  }
  st.scope_key = scopeKey; st.provider = c.provider;
  if (scopeKey === 'linear:teams') st.scope_teams = configuredNow; else delete st.scope_teams;
  const map = loadMap(home);
  map.tracker = c.provider; map.scopeKey = scopeKey;
  const summary = { pulled: 0, pushed: 0, requests: [], conflicts: 0, health: st.health, planned: 0 };
  const lines = [];
  let networkFail = null;
  let adapter;
  try {
    adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
    await ensureDiscovery(c, st, adapter);
    if (c.provider === 'linear') adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
  } catch (e) {
    networkFail = e;
  }
  const statusMap = statusMapFor(c.t, st);
  const labels = trackerLabels(c.t);
  const known = knownKeys(home, st);
  const { goals, tasks, epics } = localData(home);
  const tc = teamCtx(c, st);
  if (tc.multi && st.discovery && (st.discovery.missing || []).length) lines.push(`teams not found in the tracker: ${st.discovery.missing.join(', ')}`);
  let extraOps = [];

  // 1. requests resolved since the last tick
  if (!networkFail && modeName !== 'dry_run') extraOps = resolveRequests(c, st, map, now());

  // 2. pull
  const full = mode === 'full' || !st.cursor || ((st.tick_count - (st.last_full_tick || 0)) >= (c.cfg.sync.full_every_ticks || 30));
  if (!networkFail) {
    try {
      const mapped = mappedIds(map);
      const pulled = await adapter.pull({ cursor: st.first_sync_approved ? st.cursor : null, scope: adapterScope(c.provider, c.t, st, c.cfg), mappedRemoteIds: mapped.issues, mappedProjectIds: mapped.projects, full: full || !st.first_sync_approved, intakeLabel: labels.intake, ...pullExtras(c, tc) });
      summary.pulled = pulled.items.length;
      if (st.first_sync_approved) {
        const plan = planPull({ items: pulled.items, comments: pulled.comments, missing: pulled.missing, map, goals, tasks, statusMap, tracker: c.t, provider: c.provider, scopeKey, full,
          multi: tc.multi, keys: tc.keys, statusMapFor: tc.statusMapFor, cfg: c.cfg, streams: streamCtx(c), projectIntake: c.provider === 'linear' && c.t.goal_mapping === 'project', cyclesTracker: tc.cyclesTracker, cycles: tc.cycles });
        for (const l of plan.logs) audit(home, { tick: st.tick_count, ...l });
        summary.conflicts = plan.requests.filter((r) => r.type === 'tracker.conflict').length;
        summary.requests = raiseAll(c, st, map, plan.requests, known, modeName, { full });
        st.cursor = pulled.nextCursor;
        if (pulled.truncated) { lines.push('delta pull hit its page cap; the cursor stays so nothing is skipped'); audit(home, { tick: st.tick_count, dir: 'pull', op: 'delta_truncated', result: 'logged', fields: [] }); }
        if (full) st.last_full_tick = st.tick_count;
      }
      st.last_pull_at = nowIso(now());
    } catch (e) { networkFail = e; }
  }

  // 2b. full pull extras (Linear): tracker cycles (§21.6.2) and the team snapshot (§21.3.8). Best effort: reads only.
  if (!networkFail && full && modeName !== 'dry_run' && c.provider === 'linear' && tc.teamList.length) {
    if (tc.cyclesTracker && st.first_sync_approved && typeof adapter.cycles === 'function') {
      try {
        const ids = raiseAll(c, st, map, [cyclesRequest(cyclesPayload(await adapter.cycles(tc.teamList.map((x) => x.id))))], known, modeName);
        summary.requests.push(...ids);
      } catch (e) { audit(home, { tick: st.tick_count, dir: 'pull', op: 'cycles', result: 'error', reason: e.message, fields: [] }); }
    }
    const snapDue = !st.snapshot_at || now() - Date.parse(st.snapshot_at) >= 10 * 60_000 || mode === 'full';
    if ((c.cfg.baseline || {}).enabled !== false && snapDue && typeof adapter.snapshot === 'function') {
      try { writeSnapshot(home, await adapter.snapshot(tc.teamList.map((x) => ({ id: x.id, key: x.key }))), tc, now()); st.snapshot_at = nowIso(now()); } catch (e) {
        audit(home, { tick: st.tick_count, dir: 'pull', op: 'snapshot', result: 'error', reason: e.message, fields: [] });
      }
    }
  }

  // 3. push
  const pushModes = ['two_way', 'push_only', 'dry_run'];
  if (!networkFail && st.first_sync_approved && pushModes.includes(modeName)) {
    const refs = refRecords(c, goals, tasks, map);
    if (refs.length && modeName !== 'dry_run') {
      try { await linkRefs(c, st, map, adapter, refs, tc, known, summary, now); } catch (e) { networkFail = e; }
    }
  }
  if (!networkFail && st.first_sync_approved && pushModes.includes(modeName)) {
    let ops = [...extraOps, ...planPush({ tracker: c.t, statusMap, map, goals, tasks, epics, handoffs: handoffsFor(home, tasks, map), knownLabels: new Set([...(st.discovery ? st.discovery.labels || [] : []), ...(st.labels_known || [])].map((x) => String(x).toLowerCase())), provider: c.provider, scopeKey,
      multi: tc.multi, keys: tc.keys, cfg: c.cfg, statusMapFor: tc.statusMapFor, knownLabelsFor: tc.knownLabelsFor, cyclesTracker: tc.cyclesTracker, cycles: tc.cycles })];
    // scope guard
    ops = ops.filter((op) => {
      const why = scopeViolation(op, map, scopeKey, tc);
      if (!why) return true;
      audit(home, { tick: st.tick_count, dir: 'push', op: op.type, localId: op.localId, result: 'scope_blocked', reason: why, fields: [] });
      const id = raise(home, st, known, { type: 'sync.scope_blocked', payload: { local_id: op.localId, op: op.type, reason: why }, key: sha(`scope\n${op.opId}`).slice(0, 40), provider: c.provider });
      if (id) summary.requests.push(id);
      return false;
    });
    // redaction
    const extra = (c.t.redaction && c.t.redaction.extra_patterns) || [];
    ops = ops.filter((op) => {
      const r = checkOp(op, extra);
      if (!r.blocked) return true;
      audit(home, { tick: st.tick_count, dir: 'push', op: op.type, localId: op.localId, result: 'redaction_blocked', fields: [r.field] });
      const id = raise(home, st, known, { type: 'sync.redaction_blocked', payload: { local_id: op.localId, op: op.type, field: r.field, kinds: r.kinds }, key: sha(`redact\n${op.opId}`).slice(0, 40), provider: c.provider });
      if (id) summary.requests.push(id);
      return false;
    });
    // bulk guard (the approved first-sync preview counts as the bulk approval)
    const counts = bulkCounts(ops, statusMap, tc.multi ? [...tc.keys].map((k) => tc.statusMapFor(k)) : []);
    const maxOps = c.t.max_ops_before_confirm ?? 50;
    if (st.first_push_done && !st.bulk_approved && (counts.total > maxOps || counts.closing > 5)) {
      const id = raise(home, st, known, { type: 'sync.bulk_confirm', payload: { ops: counts.total, closing: counts.closing, limit: maxOps }, needs_confirmation: true,
        key: sha(`bulk\n${ops.map((o) => o.opId).sort().join(',')}`).slice(0, 40), track: { cls: 'bulk' }, provider: c.provider });
      if (id) summary.requests.push(id);
      audit(home, { tick: st.tick_count, dir: 'push', op: 'bulk_guard', result: 'held', fields: [], reason: `${counts.total} ops, ${counts.closing} closing` });
      lines.push(`bulk guard: ${counts.total} ops (${counts.closing} closing) held for confirmation`);
      ops = [];
    } else if (st.bulk_approved && ops.length) st.bulk_approved = false;
    summary.planned = ops.length;
    if (modeName === 'dry_run') {
      for (const op of ops) audit(home, { tick: st.tick_count, dir: 'push', op: op.type, localId: op.localId, remoteKey: (entryFor(map, op.localId) || {}).key || null, result: 'dry_run', fields: Object.keys(op.payload || {}) });
      lines.push(`dry run: ${ops.length} ops planned, none sent`);
    } else {
      networkFail = await drain(c, st, map, adapter, ops, summary, { now, sleep: deps.sleep, deadline });
      if (ops.length || summary.pushed) st.first_push_done = true;
    }
  }

  // 4. health
  if (networkFail) {
    st.consecutive_failures = (st.consecutive_failures || 0) + 1;
    st.last_error = String(networkFail.message || networkFail).slice(0, 200);
    st.health = st.consecutive_failures >= (c.t.alert_after_failures ?? 5) ? 'failing' : 'degraded';
    if (networkFail.rateLimited) st.backoff_until = nowIso(now() + (networkFail.retryAfterMs || 60000));
  } else { st.consecutive_failures = 0; st.health = 'ok'; st.last_error = null; }
  if (adapter && typeof adapter.rate === 'function') st.rate = adapter.rate() || {};
  summary.health = st.health;
  // Events let the dashboard and notifications see sync health (contracts §18.7). Field names only.
  try {
    const wasFailing = st.last_event_health === 'failing';
    if (st.health === 'failing' && !wasFailing) {
      emit(home, { type: 'sync.failing', source: 'sync', actor: { kind: 'system', role: 'cto' }, msg: `tracker sync failing: ${String(st.last_error || '').slice(0, 100)}`, data: { consecutive_failures: st.consecutive_failures } });
    } else if (modeName !== 'dry_run' && (summary.pulled || summary.pushed || summary.requests.length || summary.conflicts)) {
      emit(home, { type: 'sync.completed', source: 'sync', actor: { kind: 'system', role: 'cto' }, msg: `tracker sync: pulled ${summary.pulled}, pushed ${summary.pushed}, requests ${summary.requests.length}`, data: { pulled: summary.pulled, pushed: summary.pushed, requests: summary.requests.length, conflicts: summary.conflicts } });
    }
    if (summary.conflicts && !wasFailing) {
      emit(home, { type: 'sync.conflict', source: 'sync', actor: { kind: 'system', role: 'cto' }, msg: `tracker sync: ${summary.conflicts} conflict(s) wait for you`, data: { conflicts: summary.conflicts } });
    }
    st.last_event_health = st.health;
  } catch { /* events are best effort */ }
  if (modeName === 'dry_run') st.cursor = cursorBefore; // a dry run consumes nothing: the next real tick sees the same changes
  else saveMap(home, map);
  saveState(home, st);

  const head = { pulled: summary.pulled, pushed: summary.pushed, requests: summary.requests.slice(0, 5), conflicts: summary.conflicts, health: summary.health };
  const out = [JSON.stringify(head)];
  if (!st.first_sync_approved) out.push(st.preview ? `first sync waiting for approval (preview ${st.preview.id}); pull only` : 'first sync not previewed: run /software-factory:sync --preview; pull only');
  if (networkFail) out.push(`error: ${String(networkFail.message || networkFail).slice(0, 120)}`);
  const ob = outbox.load(home).length;
  if (ob) out.push(`outbox ${ob} waiting`);
  if (st.backoff_until && Date.parse(st.backoff_until) > now()) out.push(`backoff until ${st.backoff_until}`);
  return { lines: [...out, ...lines].slice(0, MAX_LINES), summary };
}

async function drain(c, st, map, adapter, ops, summary, { now, sleep, deadline }) {
  const home = c.home;
  let entries = outbox.enqueue(outbox.load(home), ops, now());
  outbox.save(home, entries);
  const budget = new Budget({ maxWrites: c.t.max_writes_per_tick ?? 20, spacingMs: c.provider === 'github' ? 1000 : 0, now, ...(sleep ? { sleep } : {}) });
  const known = knownKeys(home, st);
  const local = new Map([...store.list(home, 'goal'), ...store.list(home, 'task')].map((r) => [r.id, r]));
  let fail = null;
  const done = new Set();
  for (const e of outbox.due(entries, now())) {
    if (!budget.canWrite() || now() > deadline) break;
    const op = e.op;
    const entry = op.type === 'ensure_label' ? null : ensureEntry(map, op.localId);
    if (entry && (entry.unlinked || (op.type !== 'create_item' && entry.missing))) { done.add(e.opId); audit(home, { tick: st.tick_count, dir: 'push', op: op.type, localId: op.localId, result: 'dropped', reason: 'item unlinked or missing', fields: [] }); continue; }
    if (op.type === 'create_item') {
      if (entry.remoteId) { done.add(e.opId); continue; }
      if (entry.pendingCreate || !st.first_push_done) {
        try {
          const found = await adapter.findByLocalId(op.localId, { kind: op.kind });
          if (found && findSfId(found.body || found.bodyText) === op.localId) {
            linkFound(c, st, map, op.localId, found, op.local, now());
            done.add(e.opId); saveMap(home, map);
            audit(home, { tick: st.tick_count, dir: 'push', op: 'relink', localId: op.localId, remoteKey: found.key, result: 'ok', fields: ['sf-id'] });
            continue;
          }
        } catch (err) { fail = err; outbox.markFailed(e, err.message, now(), err.retryAfterMs); break; }
      }
      entry.pendingCreate = true;
      saveMap(home, map);
    }
    if (op.type !== 'create_item' && op.type !== 'ensure_label' && !op.remoteId) op.remoteId = entry.remoteId;
    await budget.beforeWrite();
    let res;
    try { [res] = await adapter.push([op]); } catch (err) { res = { ok: false, error: err.message, httpStatus: err.status || 0, rateLimited: !!err.rateLimited, retryAfterMs: err.retryAfterMs }; }
    const base = { tick: st.tick_count, dir: 'push', op: op.type, localId: op.localId, remoteKey: (res && res.returned && res.returned.key) || (entry && entry.key) || null, httpStatus: res.httpStatus || null, requestId: res.requestId || null, fields: Object.keys(op.payload || {}) };
    if (res.ok) {
      applyResult(c, st, map, op, res, now());
      done.add(e.opId); summary.pushed += 1;
      saveMap(home, map);
      audit(home, { ...base, result: 'ok', rateRemaining: adapter.rate ? (adapter.rate().requests ?? adapter.rate().core ?? null) : null }, now());
      continue;
    }
    if (res.rateLimited) {
      outbox.markFailed(e, res.error, now(), res.retryAfterMs);
      budget.stop(now() + (res.retryAfterMs || 60000), 'rate limited');
      fail = Object.assign(new Error(res.error || 'rate limited'), { rateLimited: true, retryAfterMs: res.retryAfterMs || 60000 });
      audit(home, { ...base, result: 'rate_limited' }, now());
      break;
    }
    if (res.drift) {
      done.add(e.opId);
      if (entry) entry.driftStatus = op.payload.statusId;
      const id = raise(home, st, known, { type: 'tracker.config_drift', payload: { local_id: op.localId, remote_key: entry && entry.key, target: op.payload.mapKey || null, reason: res.error }, key: sha(`drift\n${op.localId}\n${op.payload.statusId}`).slice(0, 40), provider: c.provider });
      if (id) summary.requests.push(id);
      const rec = local.get(op.localId);
      const cm = { type: 'add_comment', localId: op.localId, kind: op.kind, remoteId: op.remoteId, field: 'drift', valueHash: op.payload.statusId, payload: { text: `[software-factory] ${op.localId} is ${rec ? rec.status : 'updated'} in the factory; the tracker workflow has no direct move to that status (${res.error}).` } };
      cm.opId = makeOpId(cm.localId, cm.type, cm.field, cm.valueHash, '');
      entries = outbox.enqueue(entries, [cm], now());
      audit(home, { ...base, result: 'drift', reason: res.error }, now());
      continue;
    }
    outbox.markFailed(e, res.error, now());
    audit(home, { ...base, result: 'error', reason: res.error }, now());
    if (e.attempts >= 8) { done.add(e.opId); audit(home, { ...base, result: 'gave_up' }, now()); }
    if (NETWORK_FAIL(res.httpStatus)) { fail = new Error(res.error || 'network error'); break; }
  }
  entries = entries.filter((x) => !done.has(x.opId));
  outbox.save(home, entries);
  if (summary.pushed) st.last_push_at = nowIso(now());
  return fail;
}

/** Re-link local items to tracker items by their sf-id footer (after map.json was lost). */
async function rebuildMap(c, st, deps, { now, env }) {
  if (!st.first_sync_approved) return { lines: ['first sync not approved yet; nothing to re-link'], summary: null };
  const map = loadMap(c.home);
  let adapter;
  try {
    adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
    await ensureDiscovery(c, st, adapter);
    adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
  } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`], summary: null }; }
  const { goals, tasks } = localData(c.home);
  const pushKinds = c.t.push_kinds || DEFAULT_PUSH_KINDS;
  const byId = new Map(goals.map((g) => [g.id, g]));
  const projectMode = c.provider === 'linear' && c.t.goal_mapping === 'project';
  const todo = [...goals.filter((g) => pushedGoal(g) && g.status !== 'draft'), ...tasks.filter((x) => pushedTask(x, byId.get(x.goal_id), pushKinds) && x.status !== 'draft')]
    .filter((r) => !(entryFor(map, r.id) || {}).remoteId).slice(0, 60);
  let linked = 0; let err = null;
  for (const r of todo) {
    try {
      const found = await adapter.findByLocalId(r.id, { kind: projectMode && r.id.startsWith('G-') ? 'project' : r.id.startsWith('G-') ? 'goal' : 'task' });
      if (found && findSfId(found.body || found.bodyText) === r.id) {
        linkFound(c, st, map, r.id, found, { title: hashValue(r.title), body: hashValue(r.id.startsWith('G-') ? goalBody(r) : taskBody(r)) }, now());
        linked += 1;
        audit(c.home, { tick: st.tick_count, dir: 'pull', op: 'relink', localId: r.id, remoteKey: found.key, result: 'ok', fields: ['sf-id'] }, now());
      }
    } catch (e) { err = e; break; }
  }
  saveMap(c.home, map);
  saveState(c.home, st);
  return { lines: [`REBUILT map: re-linked ${linked} of ${todo.length} unmapped items by footer`, ...(err ? [`stopped: ${String(err.message || err).slice(0, 120)}`] : [])], summary: null };
}

/** First-sync preview: writes sync/preview.md and raises sync.first_sync. */
export async function preview({ projectDir } = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = clock(deps);
  let c;
  try { c = open(projectDir); guardLines(c.provider, c.t, env, deps); } catch (e) { if (e instanceof Stop) return { lines: e.lines }; throw e; }
  const home = c.home;
  const st = readState(home);
  const scopeKey = scopeKeyOf(c.provider, c.t.scope, c.cfg, env);
  st.scope_key = st.scope_key || scopeKey;
  let adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
  let pulled = { items: [] };
  let tc;
  try {
    await ensureDiscovery(c, st, adapter);
    adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
    tc = teamCtx(c, st);
    pulled = await adapter.pull({ cursor: null, scope: adapterScope(c.provider, c.t, st, c.cfg), mappedRemoteIds: [], full: true, intakeLabel: trackerLabels(c.t).intake, ...pullExtras(c, tc) });
  } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`] }; }
  const map = loadMap(home);
  const { goals, tasks, epics } = localData(home);
  const labels = trackerLabels(c.t);
  const pushKinds = c.t.push_kinds || DEFAULT_PUSH_KINDS;
  const goalsById = new Map(goals.map((g) => [g.id, g]));
  const epicsById = new Map(epics.map((e) => [e.id, e]));
  const projectMode = c.provider === 'linear' && c.t.goal_mapping === 'project';
  const unmapped = (r) => !(entryFor(map, r.id) || {}).remoteId;
  const live = (r) => !['draft', 'cancelled'].includes(r.status);
  const goalsOut = goals.filter((g) => pushedGoal(g) && live(g) && unmapped(g));
  const tasksOut = tasks.filter((x) => pushedTask(x, goalsById.get(x.goal_id), pushKinds) && live(x) && unmapped(x));
  const creates = [
    ...goalsOut.filter((g) => !hasRef(g)).map((g) => `${g.id} ${projectMode ? 'project' : 'goal'}: ${g.title}`),
    ...tasksOut.filter((x) => !hasRef(x)).map((x) => `${x.id} ${x.kind}${tc.multi ? ` (${taskKey(c.cfg, x, { goal: goalsById.get(x.goal_id), epic: epicsById.get(x.epic_id) })})` : ''}: ${x.title}`),
  ];
  const links = [...goalsOut, ...tasksOut].filter(hasRef).map((r) => `${r.id} -> ${refOf(r).key || refOf(r).remote_id}`);
  let newLabels;
  if (tc.multi) {
    const need = new Set();
    if (!projectMode) for (const g of goalsOut.filter((x) => !hasRef(x))) need.add(`${goalKeys(c.cfg, g)[0]}\n${labels.managed}`);
    for (const x of tasks.filter((t) => pushedTask(t, goalsById.get(t.goal_id), pushKinds) && t.status !== 'draft')) {
      const k = taskKey(c.cfg, x, { goal: goalsById.get(x.goal_id), epic: epicsById.get(x.epic_id) });
      need.add(`${k}\n${labels.managed}`); need.add(`${k}\n${labels.rolePrefix}${x.role}`);
    }
    newLabels = [...need].map((s) => s.split('\n')).filter(([k, n]) => !tc.knownLabelsFor(k).has(n.toLowerCase())).map(([k, n]) => `${k}: ${n}`);
  } else {
    const knownLabels = new Set(((st.discovery && st.discovery.labels) || []).map((x) => String(x).toLowerCase()));
    const roles = [...new Set(tasks.filter((x) => pushedTask(x, goalsById.get(x.goal_id), pushKinds) && x.status !== 'draft').map((x) => `${labels.rolePrefix}${x.role}`))];
    newLabels = [labels.managed, ...(c.provider === 'github' ? [labels.goal] : []), ...roles].filter((l) => !knownLabels.has(l.toLowerCase()));
  }
  const localIds = new Set([...goals, ...tasks].map((r) => r.id));
  const relinks = [];
  for (const it of pulled.items) {
    const sf = findSfId(typeof it.body === 'string' ? it.body : it.bodyText);
    if (sf && localIds.has(sf)) relinks.push(`${sf} -> ${it.key}`);
  }
  // intake, stream items and project intake: the same rules as a pull (planPull on a copy of the map)
  const plan = planPull({ items: pulled.items, comments: [], missing: [], map: structuredClone(map), goals, tasks, statusMap: statusMapFor(c.t, st), tracker: c.t, provider: c.provider, scopeKey, full: true,
    multi: tc.multi, keys: tc.keys, statusMapFor: tc.statusMapFor, cfg: c.cfg, streams: streamCtx(c), projectIntake: projectMode, cyclesTracker: false, cycles: tc.cycles });
  const intake = plan.requests.filter((r) => r.type === 'tracker.intake' && r.payload.kind !== 'project').map((r) => `${r.payload.key} ${r.payload.title}`);
  const projectIntake = plan.requests.filter((r) => r.type === 'tracker.intake' && r.payload.kind === 'project').map((r) => `${r.payload.title} (${r.payload.teams.join(', ')})`);
  const streamItems = plan.requests.filter((r) => r.type === 'tracker.backlog_item').map((r) => `${r.payload.key} [${r.payload.class}] ${r.payload.title}`);
  const streams = streamCtx(c);
  const statusLinesFor = (sm) => MAP_KEYS.map((k) => `- ${k} -> ${sm[k] ? `${sm[k].name} (${sm[k].type || 'state'})` : 'not mapped (no status push)'}`);
  const statusSection = tc.multi
    ? [...tc.keys].flatMap((k) => [`## Status map ${k}`, ...statusLinesFor(statusMapFor(c.t, st, k) || {}), ''])
    : ['## Status map', ...statusLinesFor(statusMapFor(c.t, st) || {}), ''];
  const body = [
    `Tracker: ${c.provider} (${scopeKey}); mode ${c.t.mode || 'two_way'}`, ...(tc.multi ? [`Teams: ${[...tc.keys].join(', ')}${projectMode ? '; goals are Linear projects' : ''}`] : []), '',
    `## Items to create (${creates.length})`, ...creates.slice(0, 60).map((x) => `- ${x}`), ...(creates.length > 60 ? [`- ... and ${creates.length - 60} more`] : []), '',
    ...(links.length ? [`## Records to link, not create (${links.length})`, ...links.slice(0, 40).map((x) => `- ${x}`), ''] : []),
    `## Labels to create (${newLabels.length})`, ...newLabels.map((x) => `- ${x}`), '',
    ...statusSection,
    `## Intake candidates labelled ${labels.intake} (${intake.length})`, ...intake.slice(0, 20).map((x) => `- ${x}`), '',
    ...(streams ? [`## Stream items (streams.pull ${streams.mode}) (${streamItems.length})`, ...streamItems.slice(0, 30).map((x) => `- ${x}`), ''] : []),
    ...(projectMode ? [`## Project intake candidates labelled ${labels.intake} (${projectIntake.length})`, ...projectIntake.slice(0, 20).map((x) => `- ${x}`), ''] : []),
    `## Existing items to re-link by footer (${relinks.length})`, ...relinks.slice(0, 20).map((x) => `- ${x}`), '',
    'Nothing is ever deleted in the tracker. Approve with /software-factory:sync --approve-preview, or approve the tracker gate in the control center.',
  ].join('\n');
  const id = sha(body).slice(0, 12);
  writeTextAtomic(join(home, 'sync', 'preview.md'), `# Tracker sync preview\n\nPreview id: ${id}\n\n${body}\n`);
  st.preview = { id, at: nowIso(now()), creates: creates.length, labels: newLabels.length };
  const lines = [`PREVIEW ${id} written to .factory/sync/preview.md`, `create ${creates.length} items, ${newLabels.length} labels; ${intake.length} intake candidates; ${relinks.length} re-links`];
  if (links.length || streams || projectMode) lines.push(`link ${links.length} records; ${streams ? streamItems.length : 0} stream items; ${projectIntake.length} project intake candidates`);
  if (st.first_sync_approved) lines.push('first sync is already approved');
  else {
    const known = knownKeys(home, st);
    const rid = raise(home, st, known, { type: 'sync.first_sync', payload: { preview_id: id, creates: creates.length, labels: newLabels.length }, needs_confirmation: true, key: sha(`first_sync\n${id}`).slice(0, 40), track: { cls: 'first_sync' }, provider: c.provider });
    if (rid) lines.push(`approval request ${rid} raised`);
    lines.push('Approve with /software-factory:sync --approve-preview');
  }
  saveState(home, st);
  return { lines };
}

/** Approve the preview through the CLI (it checks the human intent and supersedes the pending gate). */
export async function applyPreview({ projectDir, previewId } = {}, deps = {}) {
  let c;
  try { c = open(projectDir); } catch (e) { if (e instanceof Stop) return { lines: e.lines }; throw e; }
  const st = readState(c.home);
  if (!st.preview) return { lines: ['NO_PREVIEW run /software-factory:sync --preview first'] };
  if (previewId && previewId !== st.preview.id) return { lines: [`STALE preview ${previewId}; the current preview is ${st.preview.id}`] };
  // This server keeps the session id it was started with. After /resume the person types in another
  // session, so a matching intent would be refused. Drop the stale id: the CLI then accepts any fresh
  // (15-minute) intent, which only the UserPromptSubmit hook writes when a person types the command.
  const { CLAUDE_CODE_SESSION_ID, ...cliEnv } = deps.env || process.env;
  const run = deps.runCli || ((args) => {
    const r = spawnSync(process.execPath, [join(pluginRoot(), 'scripts', 'factory.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: cliEnv });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  const r = run(['sync', 'approve-preview', '--preview', st.preview.id, '--home', c.home]);
  if (r.code !== 0) return { lines: [`NOT_APPROVED ${(r.stderr || r.stdout).trim().split('\n').pop().replace(/^error:\s*/, '').slice(0, 160)}`] };
  return { lines: [`APPROVED first sync (preview ${st.preview.id}). The next factory tick creates ${st.preview.creates ?? 0} items.`] };
}

/**
 * Discovery for setup: credentials check, scope lookup, proposed status map. Linear also takes
 * scopeHint.list_teams (every team with its parent) and scopeHint.team_keys (per-team discovery, §21.3.9).
 */
export async function discover({ projectDir, tracker, scopeHint } = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = clock(deps);
  let home = null; let cfg = null;
  try { const c = open(projectDir); home = c.home; cfg = c.cfg; } catch { home = null; }
  const t = (cfg && cfg.tracker) || {};
  const provider = tracker || t.provider || 'none';
  let hint = scopeHint || t.scope || {};
  if (typeof hint === 'string') hint = provider === 'linear' ? { team_key: hint } : provider === 'jira' ? { project_key: hint } : (() => { const [owner, repo] = hint.split('/'); return { owner, repo }; })();
  try { guardLines(provider, t, env, deps); } catch (e) { if (e instanceof Stop) return { lines: e.lines }; throw e; }
  if (provider === 'linear' && (hint.list_teams === true || Array.isArray(hint.team_keys))) return discoverTeams({ home, cfg, hint, env, deps, now });
  let d;
  try {
    const scope = provider === 'github' ? { ...githubRepo(hint, cfg) } : hint;
    d = await createAdapter(provider, scope, { env, fetch: deps.fetch, ghExec: deps.ghExec, now }).discover(hint);
  } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`] }; }
  const want = hint.team_key || hint.project_key || (hint.owner && hint.repo ? `${hint.owner}/${hint.repo}` : null);
  const found = want ? (d.scopes || []).find((s) => String(s.key).toLowerCase() === String(want).toLowerCase()) : null;
  if (!found) {
    return { lines: [`SCOPE_NOT_FOUND ${want || '(none given)'}`, `available: ${(d.scopes || []).slice(0, 12).map((s) => s.key).join(', ') || 'none'}`] };
  }
  const sm = d.proposedStatusMap || proposeStatusMap(d.states || []);
  if (home) {
    updateState(home, (st) => {
      storeDiscovery(st, { provider }, d);
      st.status_map = sm; // scope_key is set by the next sync tick, which applies the approval rules
    });
  }
  const unmapped = MAP_KEYS.filter((k) => !sm[k]);
  return { lines: [
    `READY ${provider} ${found.key} (${found.name}); signed in as ${d.viewer && d.viewer.handle ? d.viewer.handle : 'unknown'}`,
    `status map: ${MAP_KEYS.filter((k) => sm[k]).map((k) => `${k}=${sm[k].name}`).join(', ')}`,
    ...(unmapped.length ? [`not mapped: ${unmapped.join(', ')}`] : []),
    `states found: ${(d.states || []).length}; labels found: ${(d.labels || []).length}`,
    'Set tracker.status to "ready". The first sync is preview only: /software-factory:sync --preview',
  ] };
}

async function discoverTeams({ home, cfg, hint, env, deps, now }) {
  const adapter = createAdapter('linear', {}, { env, fetch: deps.fetch, now });
  if (hint.list_teams === true) {
    let d;
    try { d = await adapter.discover({ list_teams: true }); } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`] }; }
    const teams = d.scopes || [];
    const lines = [`TEAMS ${teams.length}`, ...teams.map((s) => `TEAM ${s.key} ${s.name} parent=${s.parentKey || '-'} id=${s.id}`)];
    return { lines, maxLines: lines.length };
  }
  const keys = [...new Set(hint.team_keys.map((k) => String(k || '').trim().toUpperCase()).filter(Boolean))];
  let d;
  try { d = await adapter.discover({ team_keys: keys }); } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`] }; }
  const avail = `available: ${(d.scopes || []).slice(0, 30).map((s) => s.key).join(', ') || 'none'}`;
  if (!keys.length) return { lines: ['SCOPE_NOT_FOUND (none given)', avail] };
  if ((d.missing || []).length) return { lines: [`SCOPE_NOT_FOUND ${d.missing[0]}`, avail] };
  const st = home ? readState(home) : null;
  const scratch = st || {};
  storeMultiDiscovery(scratch, { provider: 'linear' }, d, keys);
  const lines = [`READY linear ${d.teams.length} teams (${d.teams.map((x) => x.key).join(', ')})`];
  for (const x of d.teams) {
    const sm = scratch.status_maps[String(x.key).toUpperCase()] || {};
    const unmapped = MAP_KEYS.filter((k) => !sm[k]);
    const cyc = x.cycles && x.cycles.current ? `cycle ${x.cycles.current.number}` : 'no active cycle';
    lines.push(`${x.key} ${x.name}: ${x.states.length} states, ${x.labels.length} labels, ${cyc}${unmapped.length ? `; not mapped: ${unmapped.join(', ')}` : ''}`);
  }
  lines.push(`signed in as ${d.viewer && d.viewer.handle ? d.viewer.handle : 'unknown'}`);
  lines.push('Set tracker.status to "ready". The first sync is preview only: /software-factory:sync --preview');
  if (home) {
    if (cfg && cyclesFromTracker({ ...cfg, tracker: { ...(cfg.tracker || {}), provider: 'linear' } })) {
      const payload = cyclesPayload(Object.fromEntries(d.teams.map((x) => [x.key, x.cycles || {}])));
      raise(home, st, knownKeys(home, st), { ...cyclesRequest(payload), provider: 'linear' });
    }
    saveState(home, st);
  }
  return { lines, maxLines: lines.length };
}

/** Health check, no network. */
export async function status({ projectDir } = {}, deps = {}) {
  const env = deps.env || process.env;
  let c;
  try { c = open(projectDir); } catch (e) { if (e instanceof Stop) return { lines: e.lines }; throw e; }
  const lines = [`tracker ${c.provider}; status ${c.t.status || 'unset'}; mode ${c.t.mode || 'two_way'}`];
  if (!syncEnabled(env)) lines.push('sync disabled on this machine (sync_enabled is off)');
  const miss = missingCredentials(c.provider, env);
  if (c.provider !== 'none' && miss.length) lines.push(`missing credentials: ${miss.join(', ')}`);
  const lease = readLease(c.home);
  lines.push(`dispatcher lease ${leaseLive(lease) ? 'fresh' : 'not held'}`);
  lines.push(...statusLines(c.home));
  if (existsSync(join(c.home, 'sync', 'preview.md'))) lines.push('preview: .factory/sync/preview.md');
  return { lines: lines.slice(0, MAX_LINES) };
}

export { Stop };
