// Team, stream and cycle helpers for the sync (contracts §21.2-21.6). Read-only. They mirror the rules in
// scripts/lib/teams.mjs and streams.itemStatus, kept local so the sync does not depend on core internals.
import { join } from 'node:path';
import { readJson } from '../../../scripts/lib/fsutil.mjs';

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const up = (k) => String(k).toUpperCase();

export function teamsOf(cfg) { return isObj(cfg && cfg.teams) ? cfg.teams : {}; }

/** The team's tracker key (upper case), else the nearest parent's key, else null. The implicit team "core" uses scope.team_key. */
export function trackerKey(cfg, teamId) {
  const teams = teamsOf(cfg);
  if (!Object.keys(teams).length) {
    const k = cfg && cfg.tracker && cfg.tracker.scope && cfg.tracker.scope.team_key;
    return k ? up(k) : null;
  }
  const seen = new Set();
  let id = teamId;
  while (id && teams[id] && !seen.has(id)) {
    seen.add(id);
    const k = teams[id].tracker && teams[id].tracker.team_key;
    if (k) return up(k);
    id = teams[id].parent;
  }
  return null;
}

/** Tracker keys set on teams, in config order, unique, upper case (Linear keys are upper case). */
export function configuredKeys(cfg) {
  const out = [];
  for (const t of Object.values(teamsOf(cfg))) {
    const k = t && t.tracker && t.tracker.team_key;
    if (k && !out.includes(up(k))) out.push(up(k));
  }
  return out;
}

/** Multi-team mode (§21.3.1): Linear and at least one team with tracker.team_key. */
export function isMulti(cfg) {
  return !!(cfg && cfg.tracker && cfg.tracker.provider === 'linear' && configuredKeys(cfg).length);
}

function depth(cfg, id) {
  const teams = teamsOf(cfg); let n = 0; const seen = new Set();
  while (id && teams[id] && !seen.has(id)) { seen.add(id); n++; id = teams[id].parent; }
  return n;
}

export function forRepo(cfg, repo) {
  if (!repo) return null;
  let best = null;
  for (const [id, t] of Object.entries(teamsOf(cfg))) {
    if ((t.repos || []).includes(repo) && (!best || depth(cfg, id) > depth(cfg, best))) best = id;
  }
  return best;
}

export function forRole(cfg, role) {
  if (!role) return null;
  for (const [id, t] of Object.entries(teamsOf(cfg))) if ((t.roles || []).includes(role)) return id;
  return null;
}

/** Team id of a task (resolution order of §21.2). */
export function teamOfTask(cfg, task, { goal = null, epic = null } = {}) {
  const teams = teamsOf(cfg);
  const known = (id) => (id && teams[id] ? id : null);
  return known(task && task.team) || known(epic && epic.team) || forRepo(cfg, (task && task.repo) || (epic && epic.repo))
    || forRole(cfg, task && task.role) || known(goal && goal.lead_team) || known(goal && goal.team)
    || known(goal && (goal.teams || [])[0]) || null;
}

/** Tracker key for a task: its team's key, else the goal's lead key, else the first configured key. */
export function taskKey(cfg, task, ctx = {}) {
  const k = trackerKey(cfg, teamOfTask(cfg, task, ctx));
  if (k) return k;
  return ctx.goal ? goalKeys(cfg, ctx.goal)[0] : (configuredKeys(cfg)[0] || null);
}

/** Tracker keys of a goal: lead team first, then goal.teams; at least the first configured key. */
export function goalKeys(cfg, goal) {
  const out = [];
  for (const id of [goal && goal.lead_team, ...((goal && goal.teams) || []), goal && goal.team]) {
    const k = id ? trackerKey(cfg, id) : null;
    if (k && !out.some((x) => up(x) === up(k))) out.push(k);
  }
  if (!out.length) { const k = configuredKeys(cfg)[0]; if (k) out.push(k); }
  return out;
}

export function goalKind(goal) { return (goal && goal.kind) || 'goal'; }

// ---- streams (§21.4)
export const DEFAULT_CLASSES = { bug: { labels: ['bug', 'Bug'] }, tech_debt: { labels: ['tech-debt', 'Tech Debt', 'tech debt'] }, chore: { labels: [] } };

export function streamsCfg(cfg) {
  const s = (cfg && cfg.streams) || {};
  return { enabled: !!s.enabled, pull: s.pull || 'intake_label', classes: isObj(s.classes) ? s.classes : DEFAULT_CLASSES, teams: Array.isArray(s.teams) ? s.teams : [] };
}

/** Tracker keys whose issues may become stream items. */
export function streamKeys(cfg) {
  const s = streamsCfg(cfg);
  const teams = teamsOf(cfg);
  if (!Object.keys(teams).length) { const k = trackerKey(cfg, 'core'); return k ? [k] : []; }
  const ids = s.teams.length ? s.teams : Object.entries(teams).filter(([, t]) => (t.repos || []).length).map(([id]) => id);
  const out = [];
  for (const id of ids) { const k = trackerKey(cfg, id); if (k && !out.some((x) => up(x) === up(k))) out.push(k); }
  return out;
}

/** Item class from labels, or null. */
export function classOf(cfg, labels) {
  const have = new Set((labels || []).map((l) => String(l).toLowerCase()));
  for (const [cls, def] of Object.entries(streamsCfg(cfg).classes)) {
    if (((def && def.labels) || []).some((l) => have.has(String(l).toLowerCase()))) return cls;
  }
  return null;
}

export function classLabels(cfg) {
  return [...new Set(Object.values(streamsCfg(cfg).classes).flatMap((d) => (d && d.labels) || []).map(String))];
}

/** Effective status of a stream item (§21.4.6). */
export function itemStatus(task, epicsById) {
  if (!task) return null;
  if (task.status !== 'done') return task.status;
  const ids = task.item_epic_ids || [];
  if (!ids.length) return 'done';
  // an epic that cannot be read counts as open
  const st = ids.map((id) => { const e = epicsById && epicsById.get ? epicsById.get(id) : null; return e ? e.status : null; });
  if (st.every((s) => s === 'done' || s === 'cancelled') && st.includes('done')) return 'done';
  if (st.every((s) => s === 'cancelled')) return 'cancelled';
  if (st.includes('pr_open')) return 'in_review';
  return 'in_progress';
}

// ---- cycles (§21.6)
export function cyclesFromTracker(cfg) {
  const c = (cfg && cfg.cycles) || {};
  if (!c.enabled) return false;
  const src = c.source || (cfg.tracker && cfg.tracker.provider === 'linear' ? 'tracker' : 'local');
  return src === 'tracker' && !!(cfg.tracker && cfg.tracker.provider === 'linear');
}

export function readCycles(home) { return readJson(join(home, 'state', 'cycles.json'), null) || { teams: {} }; }

function allCycles(cycles) {
  const out = [];
  for (const t of Object.values((cycles && cycles.teams) || {})) for (const k of ['previous', 'current', 'next']) if (t && t[k]) out.push(t[k]);
  return out;
}

/** Factory cycle id -> tracker cycle id (null when unknown or local). */
export function cycleTrackerId(cycles, cycleId) {
  if (!cycleId) return null;
  const c = allCycles(cycles).find((x) => x.id === cycleId);
  return c && c.tracker_id ? String(c.tracker_id) : null;
}

/** Tracker cycle id -> factory cycle id (null when not a known cycle). */
export function factoryCycleFor(cycles, trackerId) {
  if (!trackerId) return null;
  const c = allCycles(cycles).find((x) => x.tracker_id && String(x.tracker_id) === String(trackerId));
  return c ? c.id : null;
}

// ---- records and map entries
/** The tracker_ref of a record: goals keep it at goal.tracker_ref, stream items at task.item.tracker_ref. */
export function refOf(rec) {
  if (!rec) return null;
  const r = rec.tracker_ref || (rec.item && rec.item.tracker_ref) || null;
  return r && r.remote_id ? r : null;
}

/** The tracker team of a map entry: its team, or the key in an A7 single-team scope key. */
export function entryTeam(e) {
  if (!e) return null;
  if (e.team) return String(e.team).toUpperCase();
  const m = /^linear:team:([^:]+)/.exec(e.scopeKey || '');
  return m ? m[1].toUpperCase() : null;
}
