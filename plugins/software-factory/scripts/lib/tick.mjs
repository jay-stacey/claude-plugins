// tick begin | plan | end (contracts §4, design §5). Output stays tiny: begin <= 8 lines, end <= 12.
import { join } from 'node:path';
import { nowIso, readJson } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit, rotate } from './events.mjs';
import { load as loadConfig, machine } from './config.mjs';
import { acquireLease, holdsLease, isInitialized, readFactory, updateFactory, readLease } from './state.mjs';
import * as inbox from './inbox.mjs';
import * as flow from './flow.mjs';
import { collect, pendingCollect } from './collect.mjs';
import { reconcile } from './telemetry.mjs';
import { recover } from './recovery.mjs';
import * as budget from './budget.mjs';
import { choose, dispatch, activeRuns } from './dispatch.mjs';
import { maybePaused } from './control.mjs';
import { notifier } from './notify.mjs';

export const DEBOUNCE_S = 20;

function notInit() { const e = new Error('NOT_INITIALIZED run /software-factory:setup (or factory init)'); e.exitCode = 4; return e; }
function leaseErr(holder) { const e = new Error(`LEASE held by ${holder}`); e.exitCode = 3; return e; }

function stepErr(home, step, e, lines) {
  lines.push(`error in ${step}: ${String(e.message || e).slice(0, 100)}`);
  updateFactory(home, (s) => { s.tick.last_error = `${step}: ${String(e.message || e).slice(0, 300)}`; });
  emit(home, { type: 'tick.finished', msg: `error in ${step}: ${e.message}`.slice(0, 140), data: { step, error: String(e.stack || e).slice(0, 1500) } });
}

export async function begin(home, { session, force = false, now = Date.now() } = {}) {
  if (!isInitialized(home)) throw notInit();
  const l = acquireLease(home, session, { source: 'cli' });
  if (!l.ok) throw leaseErr(l.holder);
  const f = readFactory(home);
  const last = Date.parse(f.tick.last_begin_at || 0) || 0;
  if (!force && now - last < DEBOUNCE_S * 1000 && !inbox.pending(home).length && !pendingCollect(home)) {
    const next = f.tick.next_wakeup_at ? Math.round((Date.parse(f.tick.next_wakeup_at) - now) / 1000) : 0;
    const n = Math.max(60, next || f.tick.cadence_s || 270);
    return { lines: [`SKIP ${n}`] };
  }
  const cfg = loadConfig(home);
  const st = updateFactory(home, (s) => { s.tick.count += 1; s.tick.last_begin_at = nowIso(now); s.tick.last_error = null; });
  emit(home, { type: 'tick.started', session_id: session, msg: `tick ${st.tick.count}`, data: { count: st.tick.count } });
  const lines = [`TICK ${st.tick.count} factory ${st.status}${l.stolen ? ' (lease taken over)' : ''}`];
  let mtimes = {};
  try {
    const r = reconcile(home, { session });
    mtimes = r.mtimes;
    if (r.bound.length || r.finished.length) lines.push(`reconcile: bound ${r.bound.length}, ended ${r.finished.length}, snapshots ${r.snapshots}`);
  } catch (e) { stepErr(home, 'reconcile', e, lines); }
  try {
    const r = await recover(home, { session, mtimes, cfg, now });
    const lost = r.filter((x) => ['orphaned', 'never_started'].includes(x.outcome));
    if (r.length) lines.push(`recovery: ${r.map((x) => `${x.run_id} ${x.outcome}`).slice(0, 4).join(', ')}${lost.length ? '' : ''}`);
  } catch (e) { stepErr(home, 'recovery', e, lines); }
  try {
    const r = await collect(home, { cfg });
    if (r.length) lines.push(`collected ${r.length}: ${r.map((x) => `${x.run_id || x.task_id} ${x.outcome}`).slice(0, 4).join(', ')}`);
  } catch (e) { stepErr(home, 'collect', e, lines); }
  try {
    const { warned } = budget.check(home, cfg, notifier(home));
    for (const w of warned.slice(0, 2)) lines.push(`budget: ${w.goal_id} at ${w.pct}%`);
  } catch (e) { stepErr(home, 'budget', e, lines); }
  try { if (rotate(home)) lines.push('events rotated'); } catch { /* ignore */ }
  const f2 = readFactory(home);
  if (f2.backoff_until && Date.parse(f2.backoff_until) > now) lines.push(`backoff until ${f2.backoff_until}`);
  updateFactory(home, (s) => { s.tick.consecutive_errors = s.tick.last_error ? s.tick.consecutive_errors + 1 : 0; });
  return { lines: lines.slice(0, 8) };
}

export function syncDue(home, cfg, f, now = Date.now()) {
  if (!cfg.tracker || !cfg.tracker.provider || cfg.tracker.provider === 'none') return false;
  if (cfg.tracker.status !== 'ready') return false;
  const opts = machine(home).options || {};
  if (opts.sync_enabled === false || opts.sync_enabled === 'false') return false;
  if (f.sync_requested_at) return true;
  const st = readJson(join(home, 'sync', 'state.json'), {}) || {};
  if (st.backoff_until && Date.parse(st.backoff_until) > now) return false;
  const last = Date.parse(st.last_pull_at || st.last_sync_at || 0) || 0;
  return now - last >= (cfg.sync.min_interval_s || 60) * 1000;
}

export async function plan(home, { session } = {}) {
  if (!isInitialized(home)) throw notInit();
  if (!holdsLease(home, session)) { const l = readLease(home); throw leaseErr(l ? l.session_id : 'nobody (run tick begin)'); }
  const cfg = loadConfig(home);
  const lines = [];
  let f = readFactory(home);
  try {
    const res = await inbox.process(home, { tick: f.tick.count, session });
    if (res.length) {
      const applied = res.filter((r) => r.status === 'applied').length;
      lines.push(`INBOX ${res.length}: ${applied} applied, ${res.length - applied} other`);
    }
  } catch (e) { lines.push(`inbox error: ${e.message}`.slice(0, 120)); }
  try { await flow.advance(home, { cfg }); } catch (e) { lines.push(`flow error: ${e.message}`.slice(0, 120)); }
  f = readFactory(home);
  const dispatches = [];
  if (f.status === 'running') {
    const res = choose(home, { cfg, factory: f, notifyFn: notifier(home) });
    for (const c of res.chosen) {
      try { dispatches.push(await dispatch(home, c, { cfg, session })); } catch (e) { lines.push(`dispatch error ${c.task.id}: ${e.message}`.slice(0, 120)); }
    }
    if (res.blocked_goals.length) lines.push(`BUDGET blocked ${res.blocked_goals.join(', ')}`);
  }
  for (const d of dispatches) lines.push(`DISPATCH ${JSON.stringify(d)}`);
  const due = syncDue(home, cfg, f);
  if (due && f.sync_requested_at) updateFactory(home, (s) => { s.sync_requested_at = null; });
  lines.push(`SYNC ${due ? 'due' : 'skip'}`);
  return { lines, dispatches };
}

/** Next wakeup in seconds, or null for NONE. Mutates the waiting streak. */
export function schedule(home, cfg, f, { now = Date.now() } = {}) {
  const c = cfg.cadence;
  if (f.status === 'stopped') return { s: null, why: 'stopped' };
  if (inbox.pending(home).length) return { s: c.inbox_s, why: 'inbox' };
  if (f.status === 'paused') return { s: c.paused_s, why: 'paused' };
  const active = activeRuns(home).length;
  if (active || f.status === 'pausing') return { s: c.active_s, why: 'runs active', reset: true };
  if (f.backoff_until && Date.parse(f.backoff_until) > now) {
    return { s: Math.max(c.active_s, Math.round((Date.parse(f.backoff_until) - now) / 1000) + 5), why: 'backoff' };
  }
  const goals = store.list(home, 'goal', (g) => !['done', 'cancelled'].includes(g.status));
  if (!goals.length) return { s: null, why: 'idle' };
  const tasks = store.list(home, 'task', (t) => goals.some((g) => g.id === t.goal_id));
  const workable = tasks.some((t) => ['ready', 'in_review', 'checking', 'backlog', 'changes_requested', 'verified'].includes(t.status));
  if (workable && tasks.some((t) => ['ready', 'in_review', 'checking', 'changes_requested'].includes(t.status))) return { s: c.active_s, why: 'work queued', reset: true };
  const streak = f.tick.waiting_streak || 0;
  const w = c.waiting_s || [900, 1800, 3600];
  return { s: w[Math.min(streak, w.length - 1)], why: 'waiting on you', inc: true };
}

export async function end(home, { session, loop = false, now = Date.now() } = {}) {
  if (!isInitialized(home)) throw notInit();
  const cfg = loadConfig(home);
  maybePaused(home);
  const lines = [];
  let f = readFactory(home);
  const gates = store.list(home, 'gate', (g) => g.status === 'pending');
  const notified = new Set(f.tick.notified_gates || []);
  const fresh = gates.filter((g) => !notified.has(g.id));
  if (fresh.length) notifier(home)('Factory needs you', `${fresh.length} approval${fresh.length > 1 ? 's' : ''} waiting: ${fresh.map((g) => `${g.type} ${g.id}`).slice(0, 3).join(', ')}`);
  const goals = store.list(home, 'goal', (g) => !['done', 'cancelled'].includes(g.status));
  const b = readJson(join(home, 'state', 'budget.json'), { goals: {} }) || { goals: {} };
  const active = activeRuns(home);
  lines.push(`factory ${f.status}; ${active.length} runs active; ${gates.length} gates waiting`);
  for (const g of goals.slice(0, 5)) {
    const slot = b.goals && b.goals[g.id];
    lines.push(`${g.id} ${g.status} ${g.title.slice(0, 40)}${slot ? ` (${slot.pct}% budget)` : ''}`);
  }
  if (gates.length) lines.push(`waiting on you: ${gates.slice(0, 4).map((g) => `${g.id} ${g.type}`).join(', ')} (run /software-factory:approve)`);
  const blocked = store.list(home, 'task', (t) => t.status === 'blocked' && t.blocked && t.blocked.needs === 'human');
  if (blocked.length) lines.push(`questions for you: ${blocked.slice(0, 4).map((t) => t.id).join(', ')}`);
  if (f.tick.last_error) lines.push(`last error: ${f.tick.last_error.slice(0, 100)}`);
  const sch = schedule(home, cfg, f, { now });
  f = updateFactory(home, (s) => {
    s.tick.last_end_at = nowIso(now);
    s.tick.cadence_s = sch.s;
    s.tick.next_wakeup_at = sch.s ? nowIso(now + sch.s * 1000) : null;
    if (sch.reset) s.tick.waiting_streak = 0;
    if (sch.inc && loop) s.tick.waiting_streak = (s.tick.waiting_streak || 0) + 1;
    s.tick.notified_gates = gates.map((g) => g.id);
  });
  emit(home, { type: 'tick.finished', session_id: session, msg: `tick ${f.tick.count} done; next ${sch.s ? `${sch.s}s (${sch.why})` : 'none'}`, data: { cadence_s: sch.s, why: sch.why } });
  const out = lines.slice(0, 11);
  out.push(sch.s ? `SCHEDULE ${sch.s}` : 'NONE');
  return { lines: out };
}
