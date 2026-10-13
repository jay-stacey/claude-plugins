// Cycles (contracts §21.6): state/cycles.json, local cycles from an anchor date, tracker cycles from the
// sync, transitions (`cycle roll`, run inside `tick begin`), `cycle commit` and `cycle show`.
import { join } from 'node:path';
import { nowIso, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import * as teams from './teams.mjs';

const DAY = 86400000;

export function cyclesPath(home) { return join(home, 'state', 'cycles.json'); }

export function enabled(cfg) { return !!(cfg && cfg.cycles && cfg.cycles.enabled); }

export function sourceOf(cfg) {
  const s = cfg.cycles && cfg.cycles.source;
  if (s === 'tracker' || s === 'local') return s;
  return cfg.tracker && cfg.tracker.provider === 'linear' ? 'tracker' : 'local';
}

/** Tracker sync configured and ready (Linear, tracker.status ready). */
export function trackerReady(cfg) { return !!(cfg && cfg.tracker && cfg.tracker.provider === 'linear' && cfg.tracker.status === 'ready'); }

export function readState(home) {
  const s = readJson(cyclesPath(home), null) || {};
  return { v: 1, updated_at: s.updated_at || null, teams: s.teams || {}, tracker: s.tracker || {}, rolled: s.rolled || {}, rolled_at: s.rolled_at || null };
}

function fail(msg, code = 1) { const e = new Error(msg); e.exitCode = code; return e; }

/** Local cycles: `length_days` from `anchor` (00:00 UTC), numbered from 1, the same dates for every team. */
export function localCycles(cfg, teamId, now = Date.now()) {
  const c = cfg.cycles || {};
  const anchor = Date.parse(`${c.anchor || '2026-01-05'}T00:00:00Z`);
  const len = Math.max(1, Number(c.length_days) || 14) * DAY;
  const mk = (n) => (n < 1 ? null : {
    id: `${teamId}-${n}`, team: teamId, number: n, name: null,
    starts_at: new Date(anchor + (n - 1) * len).toISOString(), ends_at: new Date(anchor + n * len).toISOString(), source: 'local', tracker_id: null,
  });
  if (now < anchor) return { previous: null, current: null, next: mk(1) };
  const n = Math.floor((now - anchor) / len) + 1;
  return { previous: mk(n - 1), current: mk(n), next: mk(n + 1) };
}

function fromTracker(teamId, c) {
  if (!c || typeof c !== 'object' || c.number === undefined || c.number === null) return null;
  return {
    id: `${teamId}-${c.number}`, team: teamId, number: Number(c.number), name: c.name || null,
    starts_at: c.starts_at || null, ends_at: c.ends_at || null, source: 'tracker', tracker_id: c.tracker_id || null,
  };
}

/** Recompute every team's previous/current/next and write state/cycles.json. Returns the state. */
export function refresh(home, cfg, now = Date.now()) {
  return withMutex(home, () => {
    const st = readState(home);
    const src = sourceOf(cfg);
    const out = {};
    for (const t of teams.list(home, cfg)) {
      const old = st.teams[t.id] || {};
      const key = teams.trackerKey(home, cfg, t.id);
      const tr = src === 'tracker' && key ? st.tracker[key] : null;
      if (tr && (tr.current || tr.next)) {
        const current = fromTracker(t.id, tr.current);
        const next = fromTracker(t.id, tr.next);
        // The tracker sends current and next only: the previous cycle is the current one we held before.
        let previous = old.previous || null;
        if (old.current && (!current || old.current.id !== current.id)) previous = old.current;
        out[t.id] = { previous, current, next };
      } else if (src === 'tracker' && key && trackerReady(cfg)) {
        // Tracker cycles have not arrived yet: no local stand-in (it would roll falsely later).
        out[t.id] = { previous: old.previous || null, current: null, next: null, pending: true };
      } else {
        out[t.id] = localCycles(cfg, t.id, now); // no tracker key or no ready tracker sync: local cycles
      }
    }
    const next = { ...st, v: 1, updated_at: nowIso(now), teams: out };
    writeJsonAtomic(cyclesPath(home), next);
    return next;
  });
}

/** Current cycle of a team from state/cycles.json (null when cycles are off or unknown). */
export function currentOf(home, cfg, teamId, st = null) {
  if (!enabled(cfg) || !teamId) return null;
  const s = st || readState(home);
  return (s.teams[teamId] && s.teams[teamId].current) || null;
}

/** Map of team id -> current cycle id (cycles on only). */
export function currentIds(home, cfg) {
  if (!enabled(cfg)) return {};
  const s = readState(home);
  const out = {};
  for (const [id, v] of Object.entries(s.teams)) out[id] = (v && v.current && v.current.id) || null;
  return out;
}

/**
 * Detect cycle transitions per team (current id changed since the last roll) and act on them:
 * cycle.ended -> a cycle_review report (review_at_end); cycle.started -> roll the team's stream budget
 * window and a cycle_plan task (plan_at_start). The first roll only records cycles and plans them.
 */
export async function roll(home, cfg, { now = Date.now() } = {}) {
  if (!enabled(cfg)) return { lines: [], transitions: [] };
  const ops = await import('./ops.mjs');
  const streams = await import('./streams.mjs');
  const st = refresh(home, cfg, now);
  const first = !st.rolled_at;
  const transitions = [];
  const rolled = { ...st.rolled };
  for (const t of teams.list(home, cfg)) {
    if (st.teams[t.id] && st.teams[t.id].pending) continue; // wait for tracker cycles; record nothing
    const cur = st.teams[t.id] ? st.teams[t.id].current : null;
    const curId = cur ? cur.id : null;
    const known = Object.prototype.hasOwnProperty.call(rolled, t.id);
    if (first || !known) {
      rolled[t.id] = curId;
      if (cur && cfg.cycles.plan_at_start !== false) ops.createCyclePlan(home, cfg, t.id, { now });
      continue;
    }
    const prevId = rolled[t.id];
    if (prevId === curId) continue;
    transitions.push({ team: t.id, from: prevId, to: curId });
    if (prevId) {
      const prev = st.teams[t.id].previous && st.teams[t.id].previous.id === prevId ? st.teams[t.id].previous : null;
      emit(home, { type: 'cycle.ended', msg: `${t.id} cycle ${prevId} ended`, data: { team: t.id, cycle: prevId } });
      if (cfg.cycles.review_at_end !== false) ops.createReport(home, cfg, { type: 'cycle_review', team: t.id, now, from: prev ? prev.starts_at : null });
    }
    if (curId) {
      emit(home, { type: 'cycle.started', msg: `${t.id} cycle ${curId} started`, data: { team: t.id, cycle: curId, starts_at: cur.starts_at, ends_at: cur.ends_at } });
      streams.rollTeamWindow(home, cfg, t.id, cur.starts_at || nowIso(now));
      if (cfg.cycles.plan_at_start !== false) ops.createCyclePlan(home, cfg, t.id, { now });
    }
    rolled[t.id] = curId;
  }
  withMutex(home, () => {
    const s = readState(home);
    writeJsonAtomic(cyclesPath(home), { ...s, rolled, rolled_at: nowIso(now) });
  });
  const lines = transitions.length ? [`cycles: ${transitions.map((x) => `${x.team} ${x.to || 'none'}`).join(', ')}`.slice(0, 120)] : [];
  return { lines, transitions, first };
}

/** Resolve `current|next|none|<cycle id>` for a team to a cycle id (or null). */
export function resolveRef(home, cfg, teamId, ref) {
  if (ref === 'none' || ref === null || ref === '') return null;
  const s = readState(home);
  const t = s.teams[teamId] || refresh(home, cfg).teams[teamId] || {};
  if (ref === 'current' || ref === 'next') {
    const c = t[ref];
    if (!c) throw fail(`${teamId} has no ${ref} cycle`);
    return c.id;
  }
  const knownIds = ['previous', 'current', 'next'].map((k) => t[k] && t[k].id).filter(Boolean);
  if (knownIds.includes(ref)) return ref;
  if (new RegExp(`^${teamId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(String(ref))) return ref; // a later cycle of this team
  throw fail(`unknown cycle ${ref} for team ${teamId}; use current, next, none or one of: ${knownIds.join(', ') || 'none known'}`);
}

/** `cycle commit <T> --cycle current|next|none|<id>`: set task.cycle for the task's team. */
export function commit(home, cfg, taskId, ref, { by = 'cto' } = {}) {
  if (!enabled(cfg)) throw fail('cycles are off (cycles.enabled is false)');
  const task = store.mustGet(home, 'task', taskId);
  if (['done', 'cancelled'].includes(task.status)) throw fail(`${taskId} is ${task.status}`);
  const goal = store.get(home, 'goal', task.goal_id);
  const teamId = task.team || teams.resolve(home, cfg, { task, goal });
  const id = resolveRef(home, cfg, teamId, ref);
  const t = store.update(home, 'task', taskId, (x) => { x.cycle = id; if (!x.team) x.team = teamId; });
  emit(home, { type: 'task.status', goal_id: t.goal_id, task_id: t.id, msg: `${t.id} committed to cycle ${id || 'none'} by ${by}`, data: { from: t.status, to: t.status, cycle: id } });
  return t;
}

/** A tracker cycle id -> the factory cycle id of a team (null when it is not a known cycle). */
export function fromTrackerId(home, cfg, teamId, trackerId) {
  if (!trackerId) return null;
  const s = readState(home);
  const t = s.teams[teamId] || {};
  for (const k of ['current', 'next', 'previous']) if (t[k] && t[k].tracker_id && String(t[k].tracker_id) === String(trackerId)) return t[k].id;
  return null;
}

/**
 * Inbox `tracker.cycles {teams: {<team_key>: {current, next}}}` from the sync (§21.6.2): store the tracker
 * cycles per key and recompute team cycles (keys map to every team whose trackerKey is that key).
 */
export function applyTrackerCycles(home, cfg, payload) {
  const byKey = (payload && payload.teams) || {};
  withMutex(home, () => {
    const s = readState(home);
    for (const [key, v] of Object.entries(byKey)) {
      if (!v || typeof v !== 'object') continue;
      s.tracker[String(key).toUpperCase()] = { current: v.current || null, next: v.next || null, at: nowIso() };
    }
    writeJsonAtomic(cyclesPath(home), s);
  });
  const st = refresh(home, cfg);
  const mapped = Object.keys(byKey).flatMap((k) => teams.forTrackerKey(home, cfg, k));
  return { keys: Object.keys(byKey).length, teams: [...new Set(mapped)], state: st };
}

function daysLeft(c, now) { return c && c.ends_at ? Math.max(0, Math.ceil((Date.parse(c.ends_at) - now) / DAY)) : null; }

/** Team cycle summary for `cycle show` and `status`. */
export function summary(home, cfg, teamId, { now = Date.now(), st = null } = {}) {
  const s = st || readState(home);
  const t = s.teams[teamId] || {};
  const cur = t.current || null;
  const tasks = cur ? store.list(home, 'task', (x) => x.cycle === cur.id && x.status !== 'cancelled' && !['assess', 'report', 'cycle_plan'].includes(x.kind)) : [];
  return {
    team: teamId, current: cur, next: t.next || null, previous: t.previous || null, days_left: daysLeft(cur, now),
    committed: tasks.length, done: tasks.filter((x) => x.status === 'done').length, open: tasks.filter((x) => x.status !== 'done').length,
  };
}

/** `cycle show [--team T]` lines (read-only; refreshes nothing). */
export function showLines(home, cfg, { team = null, now = Date.now() } = {}) {
  if (!enabled(cfg)) return ['cycles off (set cycles.enabled true)'];
  const st = readState(home);
  const ids = team ? [teams.get(home, cfg, team).id] : teams.ids(home, cfg);
  const out = [];
  for (const id of ids) {
    const sm = summary(home, cfg, id, { now, st });
    const c = sm.current;
    out.push(c
      ? `${id} current ${c.id}${c.name ? ` "${c.name}"` : ''} ${c.starts_at.slice(0, 10)}..${(c.ends_at || '').slice(0, 10)} (${sm.days_left}d left; ${c.source}): committed ${sm.committed}, done ${sm.done}, open ${sm.open}`
      : `${id} current none${(st.teams[id] || {}).pending ? ' (waiting for tracker cycles)' : ''}`);
    if (sm.next) out.push(`${id} next ${sm.next.id} starts ${String(sm.next.starts_at).slice(0, 10)}`);
  }
  if (!st.updated_at) out.push('no cycles recorded yet; the next tick runs cycle roll');
  return out.slice(0, 40);
}
