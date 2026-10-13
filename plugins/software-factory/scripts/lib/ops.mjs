// The ops goal (contracts §21.1.2) and the CTO's standing work in it: baseline assessments (§21.5.5),
// cycle plans (§21.6) and reports with improvement proposals (§21.7).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, withMutex, writeTextAtomic } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit, eventsFile, tail } from './events.mjs';
import { load as loadConfig, setMany, safeKey } from './config.mjs';
import { readFactory, updateFactory } from './state.mjs';
import { ROLES } from './schema.mjs';
import * as budget from './budget.mjs';
import { createStandingGoal, createTask, goalKind } from './actions.mjs';
import { notifier } from './notify.mjs';

const HOUR = 3600000;
const OPEN = (t) => !['done', 'cancelled', 'failed'].includes(t.status);
/** Standing work counts as open until done or cancelled: a failed report or assess waits for its escalation. */
const NOT_CLOSED = (t) => !['done', 'cancelled'].includes(t.status);
/**
 * Events that do not count as "something happened" (contracts §21.1.8): tick and lock events, the
 * factory's own bookkeeping (baseline, reports, proposals, cycles, budget windows, report requests) and
 * everything about the ops goal itself (its tasks, runs and gates).
 */
const NOISE = /^(tick|lock|baseline|report|improvement|cycle)\./;

export function isNoise(e, opsId = null) {
  if (!e || NOISE.test(e.type || '')) return true;
  const d = e.data || {};
  if (d.window || d.report_requested || d.error) return true;
  return !!opsId && e.goal_id === opsId;
}

/** Config keys an approved `improvement` proposal may change (§21.7.6). */
export const IMPROVEMENT_PREFIXES = ['concurrency.', 'cadence.', 'budget.estimates.', 'budget.warn_pct', 'reviews.profile', 'models.by_role.',
  'models.all', 'streams.capacity_pct', 'streams.budget_tokens_per_window', 'streams.pull', 'streams.epic_review', 'ops.budget_tokens_per_day',
  'reports.', 'baseline.', 'cycles.plan_at_start', 'cycles.review_at_end'];

export function keyAllowed(key) {
  if (!safeKey(key)) return false;
  return IMPROVEMENT_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) && key.length > p.length : key === p || key.startsWith(`${p}.`)));
}

function utcDayStart(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function stamp(now) { const iso = new Date(now).toISOString(); return { date: iso.slice(0, 10), hhmm: iso.slice(11, 13) + iso.slice(14, 16) }; }
const later = (...isos) => isos.filter(Boolean).sort().pop() || null;

export function opsGoal(home) {
  return store.list(home, 'goal', (g) => goalKind(g) === 'ops' && g.status !== 'cancelled')[0] || null;
}

/** True when a person removed the ops goal: reports, assessments and cycle plans are then off. */
export function opsRemoved(home) {
  return !opsGoal(home) && store.list(home, 'goal', (g) => goalKind(g) === 'ops' && g.status === 'cancelled').length > 0;
}

/** The single ops goal, created on demand (§21.1.2). Null when it was removed (never re-created). */
export function ensureOps(home, cfg = loadConfig(home), { now = Date.now() } = {}) {
  return withMutex(home, () => {
    const cur = opsGoal(home);
    if (cur) return cur;
    if (opsRemoved(home)) return null;
    return createStandingGoal(home, {
      kind: 'ops', title: 'Factory operations',
      outcome: 'Standing CTO work: baseline assessments, cycle plans and reports with improvement proposals.',
      criteria: ['The team gets a baseline, plans and reports on time'],
      limit: cfg.ops.budget_tokens_per_day, windowStart: nowIso(utcDayStart(now)),
    });
  });
}

/**
 * Roll budget windows (§21.1.7): the ops goal at each UTC midnight; stream goals every 7 days when their
 * team has no cycle (cycle starts roll them in `cycle roll`). Returns the goal ids rolled.
 */
export async function rollWindows(home, cfg = loadConfig(home), { now = Date.now() } = {}) {
  const rolled = [];
  const ops = opsGoal(home);
  if (ops) {
    const start = nowIso(utcDayStart(now));
    if (!ops.budget.window_start || ops.budget.window_start < start) {
      budget.rollWindow(home, ops.id, { windowStart: start, limit: cfg.ops.budget_tokens_per_day, reason: 'daily ops budget window' });
      rolled.push(ops.id);
    }
  }
  const streams = await import('./streams.mjs');
  rolled.push(...streams.rollWeeklyWindows(home, cfg, now));
  return rolled;
}

// ---------------------------------------------------------------- events helpers
function firstEventTs(home) {
  try {
    const txt = readFileSync(eventsFile(home), 'utf8');
    const line = txt.slice(0, txt.indexOf('\n') > 0 ? txt.indexOf('\n') : txt.length);
    return line ? JSON.parse(line).ts || null : null;
  } catch { return null; }
}

/** Events after `sinceIso` that are not noise (reads the last 500 events). */
export function eventsSince(home, sinceIso, n = 500) {
  const og = store.list(home, 'goal', (g) => goalKind(g) === 'ops')[0];
  return tail(home, n).filter((e) => e && String(e.ts) > String(sinceIso || '') && !isNoise(e, og ? og.id : null));
}

function hasRunTask(home) {
  for (const r of store.list(home, 'run', (x) => x.collected_at && x.status === 'completed')) {
    const t = store.get(home, 'task', r.task_id);
    if (t && !['report', 'assess', 'cycle_plan'].includes(t.kind)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- task creation
function openOf(home, kind, pred = () => true) { return store.list(home, 'task', (t) => t.kind === kind && NOT_CLOSED(t) && pred(t)); }

/**
 * One open (or failed) report per team (null = factory-wide) at most (§21.7.1). A factory-wide report
 * records reports.last_attempt_at; a cycle review records reports.last_cycle_review_attempt_at[team].
 * Returns the task or null.
 */
export function createReport(home, cfg, { type, team = null, now = Date.now(), from = null } = {}) {
  if (!cfg.reports || cfg.reports.enabled === false) return null;
  if (openOf(home, 'report', (t) => (t.team || null) === (team || null)).length) return null;
  const ops = ensureOps(home, cfg, { now });
  if (!ops) return null;
  const f = readFactory(home) || {};
  const fromIso = from || (f.reports && f.reports.last_at) || firstEventTs(home) || nowIso(now);
  const s = stamp(now);
  const rel = `docs/reports/${s.date}-${s.hhmm}-${type}${team ? `-${team}` : ''}.md`;
  const task = createTask(home, {
    goal_id: ops.id, kind: 'report', role: 'cto', status: 'ready', team: team || null,
    title: `CTO report (${type.replace('_', ' ')})${team ? ` ${team}` : ''} ${s.date}`.slice(0, 80),
    description: `Write the ${type.replace('_', ' ')} report at ${rel} from metrics_path, the baseline and the last report: headline, progress, work in flight and blockers, cost, quality, process review, proposals.`.slice(0, 1200),
    report_type: type, report_period: { from: fromIso, to: nowIso(now) }, output_rel: rel,
  });
  updateFactory(home, (x) => {
    if (type === 'cycle_review') x.reports.last_cycle_review_attempt_at = { ...(x.reports.last_cycle_review_attempt_at || {}), [team || 'none']: nowIso(now) };
    else x.reports.last_attempt_at = nowIso(now);
  });
  return task;
}

/** One open cycle_plan per team (§21.6.3). The plan's cycle is in plan_cycle (ops tasks carry no `cycle`). */
export function createCyclePlan(home, cfg, teamId, { now = Date.now() } = {}) {
  if (openOf(home, 'cycle_plan', (t) => t.team === teamId).length) return null;
  const cycles = readCycle(home, teamId);
  const cur = cycles.current;
  if (!cur) return null;
  const ops = ensureOps(home, cfg, { now });
  if (!ops) return null;
  const rel = `docs/cycles/${teamId}-${cur.number}-plan.md`;
  return createTask(home, {
    goal_id: ops.id, kind: 'cycle_plan', role: 'cto', status: 'ready', team: teamId, plan_cycle: cur.id,
    title: `Cycle plan: ${teamId} cycle ${cur.number}`.slice(0, 80),
    description: `Plan cycle ${cur.id} for team ${teamId}: commit items and goal tasks with cycle commit, write ${rel}.`.slice(0, 1200),
    output_rel: rel,
  });
}

function readCycle(home, teamId) {
  try {
    const s = JSON.parse(readFileSync(join(home, 'state', 'cycles.json'), 'utf8'));
    return (s.teams && s.teams[teamId]) || {};
  } catch { return {}; }
}

/**
 * Assessment (§21.5.5): when the baseline is on and exists, and either `start` requested one or the last
 * assessment (or attempt) is older than assess_every_h and something happened since. One open (or failed)
 * assess at most; creating it clears the request and records baseline.last_assess_attempt_at.
 */
export function planAssess(home, cfg = loadConfig(home), { now = Date.now() } = {}) {
  if (!cfg.baseline || cfg.baseline.enabled === false) return null;
  if (!existsSync(join(home, 'state', 'baseline.json'))) return null;
  const b = (readFactory(home) || {}).baseline || {};
  const last = later(b.last_assess_at, b.last_assess_attempt_at);
  const stale = !!last && now - Date.parse(last) >= (Number(cfg.baseline.assess_every_h) || 24) * HOUR && eventsSince(home, last).length > 0;
  if (!b.assess_requested && !stale) return null;
  let task = null;
  if (!openOf(home, 'assess').length && !opsRemoved(home)) {
    const ops = ensureOps(home, cfg, { now });
    const s = stamp(now);
    const rel = `docs/baseline/assessment-${s.date}.md`;
    task = createTask(home, {
      goal_id: ops.id, kind: 'assess', role: 'cto', status: 'ready', team: null,
      title: `Assess the baseline ${s.date}`,
      description: `Reconcile plans with work in flight (human PRs that overlap planned files, in-progress tracker issues that duplicate factory tasks, stale factory branches, blocked work). Write ${rel}.`,
      output_rel: rel,
    });
    updateFactory(home, (f) => { f.baseline.last_assess_attempt_at = nowIso(now); });
  }
  if (b.assess_requested) updateFactory(home, (f) => { f.baseline.assess_requested = false; });
  return task;
}

/** The later of the last factory-wide report and the last attempt (a failed report counts as an attempt). */
function lastReport(st) { return later(st.last_at, st.last_attempt_at); }

/**
 * Report creation in `tick plan` after `choose` (§21.7.2): requested, periodic, idle. cycle_review comes
 * from `cycle roll`. Returns the tasks created.
 */
export function planReports(home, cfg = loadConfig(home), { chosen = 0, activeRuns = 0, now = Date.now() } = {}) {
  const r = cfg.reports || {};
  if (r.enabled === false || opsRemoved(home)) return [];
  const st = (readFactory(home) || {}).reports || {};
  const out = [];
  if (st.requested_at) {
    const t = createReport(home, cfg, { type: 'requested', now });
    if (t) { out.push(t); updateFactory(home, (f) => { f.reports.requested_at = null; }); }
  }
  const lastIso = lastReport(st);
  const last = Date.parse(lastIso || 0) || 0;
  if (!out.length && (lastIso ? now - last >= (Number(r.every_h) || 24) * HOUR && eventsSince(home, lastIso).length > 0 : hasRunTask(home))) {
    const t = createReport(home, cfg, { type: 'periodic', now });
    if (t) out.push(t);
  } else if (!out.length && lastIso && chosen === 0 && activeRuns === 0 && now - last >= (Number(r.idle_min_h) || 4) * HOUR
    && !store.list(home, 'task', (t) => t.role === 'cto' && OPEN(t)).length
    && eventsSince(home, lastIso).length >= (Number(r.idle_min_events) || 10)) {
    const t = createReport(home, cfg, { type: 'idle', now });
    if (t) out.push(t);
  }
  return out;
}

/** `report request` / inbox `report.request {}`: the next tick plan creates a `requested` report. */
export function requestReport(home) {
  updateFactory(home, (f) => { f.reports.requested_at = nowIso(); });
  emit(home, { type: 'factory.status', msg: 'CTO report requested', data: { report_requested: true } });
  return true;
}

/**
 * Seconds until the next report is due (§21.1.8), or null when none can come due by waiting: reports
 * off or removed, no run yet, or nothing happened since the last report (or attempt).
 */
export function nextReportDueS(home, cfg = loadConfig(home), { now = Date.now() } = {}) {
  const r = cfg.reports || {};
  if (r.enabled === false || opsRemoved(home)) return null;
  const st = (readFactory(home) || {}).reports || {};
  if (st.requested_at) return 0;
  const lastIso = lastReport(st);
  if (!lastIso) return hasRunTask(home) ? 0 : null;
  const n = eventsSince(home, lastIso).length;
  if (!n) return null;
  const last = Date.parse(lastIso);
  let due = last + (Number(r.every_h) || 24) * HOUR;
  if (n >= (Number(r.idle_min_events) || 10)) due = Math.min(due, last + (Number(r.idle_min_h) || 4) * HOUR);
  return Math.max(0, Math.round((due - now) / 1000));
}

// ---------------------------------------------------------------- collect
/**
 * After a valid `report` or `assess` handoff (§21.7.5): record it in state/factory.json, emit
 * report.published, notify, and open one `improvement` gate per proposal. A cycle review records
 * reports.last_cycle_review_at[team] and leaves the factory-wide last_at alone.
 */
export function onOpsHandoff(home, cfg, run, task, h) {
  const rel = task.output_rel || (run.output_paths || [])[0] || null;
  const ops = store.get(home, 'goal', task.goal_id);
  const proposals = Array.isArray(h.proposals) ? h.proposals.slice(0, Number(cfg.reports && cfg.reports.max_proposals) || 5) : [];
  const gates = [];
  for (const p of proposals) {
    const gate = store.create(home, 'gate', {
      type: 'improvement', subject: { kind: 'task', id: task.id }, goal_id: ops ? ops.id : task.goal_id, status: 'pending', opened_at: nowIso(),
      opened_by: { run_id: run.id, actor: 'cto' }, artifact: { paths: rel ? [rel] : [], summary: `${p.id} ${p.title}: ${p.why}`.slice(0, 600) },
      request: { action: 'proposal', proposal: p },
    });
    gates.push(gate.id);
    emit(home, { type: 'gate.opened', goal_id: gate.goal_id, task_id: task.id, msg: `${gate.id} improvement ${p.id}: ${p.title}`.slice(0, 140), data: { gate_id: gate.id, type: 'improvement', proposal_id: p.id } });
  }
  if (task.kind === 'report') {
    emit(home, { type: 'report.published', goal_id: task.goal_id, task_id: task.id, run_id: run.id, msg: `CTO report ${task.report_type}: ${rel}`.slice(0, 140), data: { path: rel, report_type: task.report_type, proposals: proposals.length, team: task.team || null } });
    try { notifier(home)('CTO report ready', `${rel}${gates.length ? `; ${gates.length} proposal${gates.length > 1 ? 's' : ''} to approve` : ''}`); } catch { /* best effort */ }
    if (task.report_type === 'cycle_review') {
      updateFactory(home, (f) => { f.reports = { ...f.reports, last_cycle_review_at: { ...(f.reports.last_cycle_review_at || {}), [task.team || 'none']: nowIso() } }; });
    } else {
      updateFactory(home, (f) => { f.reports = { ...f.reports, last_at: nowIso(), last_path: rel, last_type: task.report_type || null, last_task_id: task.id }; });
    }
  } else if (task.kind === 'assess') {
    updateFactory(home, (f) => { f.baseline = { ...f.baseline, last_assess_at: nowIso(), last_assess_path: rel }; });
  }
  return { gates };
}

// ---------------------------------------------------------------- improvement gates
/** Append `- <date> <note> (from <report>)` under `## Local notes` in roles/<role>.md. */
export function appendOverlayNote(home, role, note, from) {
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  const file = join(home, 'roles', `${role}.md`);
  const line = `- ${new Date().toISOString().slice(0, 10)} ${String(note).replace(/\s+/g, ' ').trim()}${from ? ` (from ${from})` : ''}`;
  const cur = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : `# ${role} overlay\n`;
  const lines = cur.replace(/\n+$/, '').split('\n');
  const h = lines.findIndex((l) => /^##\s+Local notes\s*$/i.test(l));
  if (h < 0) {
    lines.push('', '## Local notes', '', line);
  } else {
    let end = lines.length;
    for (let i = h + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
    let at = end;
    while (at > h + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, ...(at === h + 1 ? ['', line] : [line]));
  }
  writeTextAtomic(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Apply a decided `improvement` gate (§21.7.6). approve: config (allow-listed keys, validated, all or
 * nothing), overlay_note (append to the role overlay) or advice (recorded). reject/changes: recorded.
 * Emits improvement.decided {gate_id, proposal_id, decision, applied}.
 */
export function applyImprovement(home, gate) {
  const p = (gate.request && gate.request.proposal) || {};
  const ch = p.change || {};
  const decision = { approved: 'approve', rejected: 'reject', changes_requested: 'changes' }[gate.status] || gate.status;
  let applied = false; let note = null;
  if (gate.status === 'approved') {
    if (ch.kind === 'config') {
      const keys = Object.keys(ch.patch || {});
      const bad = keys.filter((k) => !keyAllowed(k));
      if (!keys.length) note = 'not applied: the patch is empty';
      else if (bad.length) note = `not applied: ${bad.join(', ')} not in the allowed config keys`;
      else {
        try { setMany(home, ch.patch); applied = true; } catch (e) { note = `not applied: ${String(e.message || e).slice(0, 300)}`; }
      }
    } else if (ch.kind === 'overlay_note') {
      try { appendOverlayNote(home, ch.role, ch.note || '', (gate.artifact.paths || [])[0] || null); applied = true; } catch (e) { note = `not applied: ${e.message}`; }
    } else {
      note = 'advice recorded';
    }
  }
  if (note) {
    store.update(home, 'gate', gate.id, (g) => { g.decision = { ...(g.decision || { by: 'factory', via: 'cli', at: nowIso() }), notes: `${(g.decision && g.decision.notes) ? `${g.decision.notes}; ` : ''}${note}`.slice(0, 1000) }; });
  }
  emit(home, { type: 'improvement.decided', goal_id: gate.goal_id, msg: `${gate.id} ${p.id || ''} ${decision}${applied ? ' (applied)' : ''}`.replace(/\s+/g, ' ').slice(0, 140), data: { gate_id: gate.id, proposal_id: p.id || null, decision, applied, ...(note ? { note } : {}) } });
  return { applied, note };
}

// ---------------------------------------------------------------- reading
/** `report list`: reports, assessments and cycle plans under docs/, newest first. */
export function listReports(home, { n = 20 } = {}) {
  const out = [];
  const add = (dir, kind) => {
    let names = [];
    try { names = readdirSafe(join(home, dir)); } catch { names = []; }
    for (const name of names.filter((x) => x.endsWith('.md'))) {
      const rel = `${dir}/${name}`;
      let mtime = 0;
      try { mtime = statMtime(join(home, rel)); } catch { mtime = 0; }
      out.push({ path: rel, kind, mtime });
    }
  };
  add('docs/reports', 'report');
  add('docs/baseline', 'assessment');
  add('docs/cycles', 'cycle_plan');
  return out.filter((x) => x.kind !== 'assessment' || /assessment-/.test(x.path)).sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path)).slice(0, n);
}

function readdirSafe(d) { return existsSync(d) ? readdirSync(d) : []; }
function statMtime(f) { return statSync(f).mtimeMs; }

/** Ops summary for `status` and `tick end`. */
export function summary(home, { now = Date.now() } = {}) {
  const f = readFactory(home) || {};
  const r = f.reports || {}; const b = f.baseline || {};
  const age = (iso) => (iso ? `${Math.max(0, Math.round((now - Date.parse(iso)) / HOUR))}h ago` : 'never');
  return { removed: opsRemoved(home), last_report_at: r.last_at || null, last_report_path: r.last_path || null, last_assess_at: b.last_assess_at || null, report_age: age(r.last_at), assess_age: age(b.last_assess_at) };
}

