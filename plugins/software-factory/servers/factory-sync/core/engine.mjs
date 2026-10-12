// Sync engine: one tick (resolve requests -> pull -> requests -> plan push -> guards -> outbox drain),
// the first-sync preview, discovery and status. Writes only .factory/sync/* and inbox requests.
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findHome, pluginRoot } from '../../../scripts/lib/paths.mjs';
import { isInitialized, leaseLive, readLease } from '../../../scripts/lib/state.mjs';
import { load as loadConfig } from '../../../scripts/lib/config.mjs';
import * as store from '../../../scripts/lib/store.mjs';
import { nowIso, readJson, readLines, writeTextAtomic } from '../../../scripts/lib/fsutil.mjs';
import { readState, statusLines, updateState } from '../../../scripts/lib/syncstate.mjs';
import { createAdapter, missingCredentials, syncEnabled } from '../adapters/index.mjs';
import { allEntries, ensureEntry, entryFor, loadMap, saveMap, byRemote } from './map.mjs';
import { planPull, planPush, remoteHashes, trackerLabels, bulkCounts, goalBody, taskBody, DEFAULT_PUSH_KINDS } from './planner.mjs';
import { proposeStatusMap, MAP_KEYS } from './ownership.mjs';
import { hashValue, sha, findSfId } from './normalize.mjs';
import { opId as makeOpId } from './echo.mjs';
import * as outbox from './outbox.mjs';
import { Budget } from './ratelimit.mjs';
import { checkOp } from './redact.mjs';
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
  if (provider === 'linear' && st.discovery && st.discovery.team) s.team_id = st.discovery.team.id;
  if (provider === 'github') Object.assign(s, githubRepo(s, cfg));
  return s;
}

export function statusMapFor(t, st) {
  const base = st.status_map || {};
  const over = t.status_map || {};
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!MAP_KEYS.includes(k)) continue;
    if (typeof v === 'string') { const s = ((st.discovery && st.discovery.states) || []).find((x) => x.id === v); out[k] = { id: v, name: s ? s.name : v, type: s ? s.type : null }; } else if (v && v.id) out[k] = v;
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
  const needTeam = c.provider === 'linear' && !(st.discovery && st.discovery.team);
  if (st.discovery && st.status_map && !needTeam) return;
  const d = await adapter.discover(c.t.scope || {});
  storeDiscovery(st, c, d);
}

function storeDiscovery(st, c, d) {
  st.discovery = { viewer: d.viewer, team: d.team || null, scopes: (d.scopes || []).slice(0, 50), states: d.states || [], labels: (d.labels || []).map((l) => l.name), at: nowIso() };
  st.status_map = d.proposedStatusMap || proposeStatusMap(d.states || []);
  st.provider = c.provider;
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
    audit(c.home, { tick: st.tick_count, dir: 'pull', op: `request:${p.cls || p.type}`, localId: p.localId || null, result: o, fields: p.field ? [p.field] : [] }, now);
  }
  return extra.map((o) => ({ ...o, opId: makeOpId(o.localId, o.type, o.field, o.valueHash, '') }));
}

function raiseAll(c, st, map, descriptors, known, modeName) {
  const ids = [];
  for (const d of descriptors) {
    const allowed = modeName === 'two_way' || (modeName === 'intake_only' && d.type === 'tracker.intake');
    if (!allowed) { audit(c.home, { tick: st.tick_count, dir: 'pull', op: d.type, localId: d.track ? d.track.localId : null, result: modeName === 'dry_run' ? 'dry_run' : 'skipped_mode', fields: [] }); continue; }
    const id = raise(c.home, st, known, { ...d, provider: c.provider });
    if (!id) continue;
    ids.push(id);
    if (d.track && trackedHold(d.track.cls)) { const e = entryFor(map, d.track.localId); if (e) e.hold = id; }
  }
  return ids;
}

function applyResult(c, st, map, op, res, now) {
  if (op.type === 'ensure_label') { st.labels_known = [...new Set([...(st.labels_known || []), String(op.payload.name).toLowerCase()])]; return; }
  const entry = ensureEntry(map, op.localId);
  const labels = trackerLabels(c.t);
  const ret = res.returned;
  if (op.type === 'create_item') {
    Object.assign(entry, { remoteId: String(res.remoteId), key: ret ? ret.key : null, url: ret ? ret.url : null, pendingCreate: false, scopeKey: st.scope_key, created_at: nowIso(now) });
    entry.pushed = ret ? remoteHashes(ret, labels) : {};
    entry.pulled = {}; entry.local = { ...(op.local || {}) };
    return;
  }
  if (ret) {
    const h = remoteHashes(ret, labels);
    entry.pushed.remoteUpdatedAt = h.remoteUpdatedAt;
    if (op.type === 'update_fields') { entry.pushed.title = h.title; entry.pushed.body = h.body; entry.pulled.title = undefined; entry.pulled.body = undefined; entry.local = { ...entry.local, ...(op.local || {}) }; }
    if (op.type === 'set_status') { entry.pushed.status = h.status; entry.pulled.status = undefined; entry.driftStatus = null; }
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
}

function linkFound(c, st, map, localId, found, local, now) {
  const labels = trackerLabels(c.t);
  const entry = ensureEntry(map, localId);
  Object.assign(entry, { remoteId: String(found.remoteId), key: found.key, url: found.url, pendingCreate: false, scopeKey: st.scope_key, created_at: entry.created_at || nowIso(now) });
  entry.pushed = remoteHashes(found, labels); entry.pulled = {};
  entry.local = { ...(local || {}) };
}

/** Scope guard: updates and comments only to mapped items of the current scope; parents must be mapped too. */
function scopeViolation(op, map, scopeKey) {
  if (op.type === 'ensure_label') return null;
  const idx = byRemote(map);
  const check = (rid) => {
    if (!rid) return null;
    const lid = idx.get(String(rid));
    if (!lid) return 'target is not a mapped item';
    const e = entryFor(map, lid);
    if (e.scopeKey && e.scopeKey !== scopeKey) return `target belongs to ${e.scopeKey}`;
    return null;
  };
  if (op.type === 'create_item') return check(op.payload.parentRemoteId);
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
  if ((st.scope_key && st.scope_key !== scopeKey) || (st.provider && st.provider !== c.provider)) {
    st.first_sync_approved = false; st.preview = null; st.cursor = null; st._reset_approval = true; st.discovery = null; st.status_map = null; st.first_push_done = false;
  }
  st.scope_key = scopeKey; st.provider = c.provider;
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
  let extraOps = [];

  // 1. requests resolved since the last tick
  if (!networkFail && modeName !== 'dry_run') extraOps = resolveRequests(c, st, map, now());

  // 2. pull
  const full = mode === 'full' || !st.cursor || ((st.tick_count - (st.last_full_tick || 0)) >= (c.cfg.sync.full_every_ticks || 30));
  if (!networkFail) {
    try {
      const mapped = allEntries(map).filter(([, e]) => e.remoteId && !e.unlinked).map(([, e]) => String(e.remoteId));
      const pulled = await adapter.pull({ cursor: st.first_sync_approved ? st.cursor : null, scope: adapterScope(c.provider, c.t, st, c.cfg), mappedRemoteIds: mapped, full: full || !st.first_sync_approved, intakeLabel: labels.intake });
      summary.pulled = pulled.items.length;
      if (st.first_sync_approved) {
        const plan = planPull({ items: pulled.items, comments: pulled.comments, missing: pulled.missing, map, goals, tasks, statusMap, tracker: c.t, provider: c.provider, scopeKey, full });
        for (const l of plan.logs) audit(home, { tick: st.tick_count, ...l });
        summary.conflicts = plan.requests.filter((r) => r.type === 'tracker.conflict').length;
        summary.requests = raiseAll(c, st, map, plan.requests, known, modeName);
        st.cursor = pulled.nextCursor;
        if (full) st.last_full_tick = st.tick_count;
      }
      st.last_pull_at = nowIso(now());
    } catch (e) { networkFail = e; }
  }

  // 3. push
  const pushModes = ['two_way', 'push_only', 'dry_run'];
  if (!networkFail && st.first_sync_approved && pushModes.includes(modeName)) {
    let ops = [...extraOps, ...planPush({ tracker: c.t, statusMap, map, goals, tasks, epics, handoffs: handoffsFor(home, tasks, map), knownLabels: new Set([...(st.discovery ? st.discovery.labels || [] : []), ...(st.labels_known || [])].map((x) => String(x).toLowerCase())), provider: c.provider, scopeKey })];
    // scope guard
    ops = ops.filter((op) => {
      const why = scopeViolation(op, map, scopeKey);
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
    const counts = bulkCounts(ops, statusMap);
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
          const found = await adapter.findByLocalId(op.localId);
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
  const todo = [...goals.filter((g) => g.status !== 'draft'), ...tasks.filter((x) => pushKinds.includes(x.kind) && x.status !== 'draft')]
    .filter((r) => !(entryFor(map, r.id) || {}).remoteId).slice(0, 60);
  let linked = 0; let err = null;
  for (const r of todo) {
    try {
      const found = await adapter.findByLocalId(r.id);
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
  try {
    await ensureDiscovery(c, st, adapter);
    adapter = createAdapter(c.provider, adapterScope(c.provider, c.t, st, c.cfg), { env, fetch: deps.fetch, ghExec: deps.ghExec, now });
    pulled = await adapter.pull({ cursor: null, scope: adapterScope(c.provider, c.t, st, c.cfg), mappedRemoteIds: [], full: true, intakeLabel: trackerLabels(c.t).intake });
  } catch (e) { return { lines: [`ERROR ${String(e.message || e).slice(0, 150)}`] }; }
  const map = loadMap(home);
  const { goals, tasks } = localData(home);
  const labels = trackerLabels(c.t);
  const pushKinds = c.t.push_kinds || DEFAULT_PUSH_KINDS;
  const creates = [
    ...goals.filter((g) => !['draft', 'cancelled'].includes(g.status) && !(entryFor(map, g.id) || {}).remoteId).map((g) => `${g.id} goal: ${g.title}`),
    ...tasks.filter((x) => pushKinds.includes(x.kind) && !['draft', 'cancelled'].includes(x.status) && !(entryFor(map, x.id) || {}).remoteId).map((x) => `${x.id} ${x.kind}: ${x.title}`),
  ];
  const knownLabels = new Set(((st.discovery && st.discovery.labels) || []).map((x) => String(x).toLowerCase()));
  const roles = [...new Set(tasks.filter((x) => pushKinds.includes(x.kind) && x.status !== 'draft').map((x) => `${labels.rolePrefix}${x.role}`))];
  const newLabels = [labels.managed, ...(c.provider === 'github' ? [labels.goal] : []), ...roles].filter((l) => !knownLabels.has(l.toLowerCase()));
  const localIds = new Set([...goals, ...tasks].map((r) => r.id));
  const relinks = []; const intake = [];
  for (const it of pulled.items) {
    const sf = findSfId(typeof it.body === 'string' ? it.body : it.bodyText);
    if (sf && localIds.has(sf)) relinks.push(`${sf} -> ${it.key}`);
    else if (!sf && (it.labels || []).some((l) => String(l).toLowerCase() === labels.intake.toLowerCase())) intake.push(`${it.key} ${it.title}`);
  }
  const sm = statusMapFor(c.t, st) || {};
  const body = [
    `Tracker: ${c.provider} (${scopeKey}); mode ${c.t.mode || 'two_way'}`, '',
    `## Items to create (${creates.length})`, ...creates.slice(0, 60).map((x) => `- ${x}`), ...(creates.length > 60 ? [`- ... and ${creates.length - 60} more`] : []), '',
    `## Labels to create (${newLabels.length})`, ...newLabels.map((x) => `- ${x}`), '',
    '## Status map', ...MAP_KEYS.map((k) => `- ${k} -> ${sm[k] ? `${sm[k].name} (${sm[k].type || 'state'})` : 'not mapped (no status push)'}`), '',
    `## Intake candidates labelled ${labels.intake} (${intake.length})`, ...intake.slice(0, 20).map((x) => `- ${x}`), '',
    `## Existing items to re-link by footer (${relinks.length})`, ...relinks.slice(0, 20).map((x) => `- ${x}`), '',
    'Nothing is ever deleted in the tracker. Approve with /software-factory:sync --approve-preview, or approve the tracker gate in the control center.',
  ].join('\n');
  const id = sha(body).slice(0, 12);
  writeTextAtomic(join(home, 'sync', 'preview.md'), `# Tracker sync preview\n\nPreview id: ${id}\n\n${body}\n`);
  st.preview = { id, at: nowIso(now()), creates: creates.length, labels: newLabels.length };
  const lines = [`PREVIEW ${id} written to .factory/sync/preview.md`, `create ${creates.length} items, ${newLabels.length} labels; ${intake.length} intake candidates; ${relinks.length} re-links`];
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
  const run = deps.runCli || ((args) => {
    const r = spawnSync(process.execPath, [join(pluginRoot(), 'scripts', 'factory.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  });
  const r = run(['sync', 'approve-preview', '--preview', st.preview.id, '--home', c.home]);
  if (r.code !== 0) return { lines: [`NOT_APPROVED ${(r.stderr || r.stdout).trim().split('\n').pop().replace(/^error:\s*/, '').slice(0, 160)}`] };
  return { lines: [`APPROVED first sync (preview ${st.preview.id}). The next factory tick creates ${st.preview.creates ?? 0} items.`] };
}

/** Discovery for setup: credentials check, scope lookup, proposed status map. */
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
      st.status_map = sm;
      st.scope_key = scopeKeyOf(provider, hint, cfg, env);
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
