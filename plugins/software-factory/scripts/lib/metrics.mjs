// Report metrics (contracts §21.7.3): `factory report data` builds metrics.json from records, the event
// log and usage snapshots. Read-only (budget numbers come from state/budget.json).
import { nowIso, readLines } from './fsutil.mjs';
import * as store from './store.mjs';
import { eventsFile } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { readFactory } from './state.mjs';
import { billed, latestSnapshots } from './usage.mjs';
import * as budget from './budget.mjs';
import { goalKind } from './actions.mjs';
import { ENUMS } from './schema.mjs';

const HOUR = 3600000;
const r1 = (n) => Math.round(n * 10) / 10;

function pct(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return r1(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
}

function inc(o, k, n = 1) { o[k] = (o[k] || 0) + n; }

/** Build the metrics object. opts: {since ISO, team, now}. */
export function build(home, { since = null, team = null, now = Date.now(), cfg = loadConfig(home) } = {}) {
  const events = readLines(eventsFile(home));
  const f = readFactory(home) || {};
  const from = since || (f.reports && f.reports.last_at) || (events[0] && events[0].ts) || nowIso(now);
  const to = nowIso(now);
  const inP = (iso) => !!iso && String(iso) >= from && String(iso) <= to;
  const tasks = store.list(home, 'task');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const goals = store.list(home, 'goal');
  const mine = (t) => !team || (t && (t.team || null) === team);
  const evs = events.filter((e) => inP(e.ts) && (!e.task_id || mine(byId.get(e.task_id))));
  const statusEv = evs.filter((e) => e.type === 'task.status' && e.data && e.data.to);

  const perGoal = {}; const perTeam = {};
  const slot = (o, k) => (o[k] = o[k] || { tasks_created: 0, done: 0, open_by_status: {}, items_opened: {}, items_closed: {} });
  for (const t of tasks.filter(mine)) {
    const g = slot(perGoal, t.goal_id); const tm = slot(perTeam, t.team || 'none');
    if (inP(t.created_at)) { g.tasks_created++; tm.tasks_created++; if (t.kind === 'triage') inc(tm.items_opened, (t.item && t.item.class) || 'bug'); }
    if (!['done', 'cancelled'].includes(t.status)) { inc(g.open_by_status, t.status); inc(tm.open_by_status, t.status); }
  }
  for (const e of statusEv.filter((x) => x.data.to === 'done')) {
    const t = byId.get(e.task_id);
    if (!t) continue;
    slot(perGoal, t.goal_id).done++; slot(perTeam, t.team || 'none').done++;
    if (t.kind === 'triage') inc(slot(perTeam, t.team || 'none').items_closed, (t.item && t.item.class) || 'bug');
  }
  for (const [id, g] of Object.entries(perGoal)) { const gg = goals.find((x) => x.id === id); g.kind = goalKind(gg); g.title = gg ? gg.title : null; delete g.items_opened; delete g.items_closed; }

  // ready -> done hours for code tasks done in the period
  const firstReady = new Map();
  for (const e of events.filter((x) => x.type === 'task.status' && x.data && x.data.to === 'ready')) if (!firstReady.has(e.task_id)) firstReady.set(e.task_id, e.ts);
  const hours = [];
  for (const e of statusEv.filter((x) => x.data.to === 'done')) {
    const t = byId.get(e.task_id);
    if (!t || t.kind !== 'code' || !firstReady.has(t.id)) continue;
    hours.push((Date.parse(e.ts) - Date.parse(firstReady.get(t.id))) / HOUR);
  }
  const codeDone = [...new Set(statusEv.filter((x) => x.data.to === 'done').map((e) => e.task_id))].map((id) => byId.get(id)).filter((t) => t && t.kind === 'code');
  const runs = store.list(home, 'run', (r) => inP(r.dispatched_at) && mine(byId.get(r.task_id)));
  const snaps = latestSnapshots(home);
  const w = cfg.budget.weights;
  const tokens = { total: 0, by_role: {}, by_kind: {}, by_goal: {}, dispatcher_overhead: 0, unattributed: 0 };
  const est = {};
  const runAgents = new Set(store.list(home, 'run').map((r) => r.agent_id).filter(Boolean));
  for (const r of runs) {
    const s = r.agent_id ? snaps.get(r.agent_id) : null;
    const n = s ? billed(s.by_model, w) : 0;
    const t = byId.get(r.task_id);
    const kind = (t && t.kind) || 'unknown';
    tokens.total += n; inc(tokens.by_role, r.role, n); inc(tokens.by_kind, kind, n); inc(tokens.by_goal, r.goal_id, n);
    if (r.collected_at && s && r.estimate_tokens) { const e = (est[kind] = est[kind] || { actual: 0, estimate: 0, runs: 0 }); e.actual += n; e.estimate += r.estimate_tokens; e.runs++; }
  }
  if (!team) {
    for (const [k, s] of snaps) {
      if (!inP(s.ts)) continue;
      if (s.scope === 'session') tokens.dispatcher_overhead += billed(s.by_model, w);
      else if (!s.run_id && !runAgents.has(k)) tokens.unattributed += billed(s.by_model, w);
    }
    tokens.total += tokens.dispatcher_overhead + tokens.unattributed;
  }
  const ratio = {};
  for (const [k, e] of Object.entries(est)) ratio[k] = { ratio: e.estimate ? r1(e.actual / e.estimate) : null, runs: e.runs };

  // ticks: a tick is idle when no run was dispatched between its start and finish
  let ticks = 0; let idle = 0; let open = false; let dispatched = false;
  for (const e of evs) {
    if (e.type === 'tick.started') { if (open && !dispatched) idle++; ticks++; open = true; dispatched = false; } else if (e.type === 'run.dispatched') dispatched = true;
    else if (e.type === 'tick.finished' && open) { if (!dispatched) idle++; open = false; }
  }
  const b = budget.read(home);
  const budgetPct = {};
  for (const g of goals.filter((x) => !['done', 'cancelled'].includes(x.status))) if (b.goals && b.goals[g.id]) budgetPct[g.id] = b.goals[g.id].pct;
  const reviewed = codeDone.length;
  return {
    v: 1, period: { from, to }, team: team || null, generated_at: to,
    goals: perGoal, teams: perTeam,
    code_cycle_hours: { n: hours.length, median: pct(hours, 50), p90: pct(hours, 90) },
    first_pass_review_rate: reviewed ? r1(codeDone.filter((t) => !t.rework_count).length / reviewed) : null,
    rework_count: evs.filter((e) => e.type === 'msg.rework').length,
    fixup_runs: runs.filter((r) => r.kind === 'fixup').length,
    failed_tasks: statusEv.filter((e) => e.data.to === 'failed').length,
    escalations: tasks.filter((t) => t.kind === 'escalation' && inP(t.created_at) && mine(t)).length,
    blocked: tasks.filter((t) => t.status === 'blocked' && mine(t)).map((t) => ({ task_id: t.id, title: t.title, needs: (t.blocked && t.blocked.needs) || null, age_h: Math.round((now - Date.parse((t.blocked && t.blocked.since) || t.updated_at)) / HOUR) })).slice(0, 30),
    gates_pending: store.list(home, 'gate', (g) => g.status === 'pending').map((g) => ({ id: g.id, type: g.type, goal_id: g.goal_id, age_h: Math.round((now - Date.parse(g.opened_at || g.created_at)) / HOUR) })),
    prs: { opened: evs.filter((e) => e.type === 'pr.opened').length, merged: evs.filter((e) => e.type === 'pr.merged').length },
    tokens, estimate_vs_actual: ratio, budget_pct: budgetPct, ticks: { count: ticks, idle },
  };
}

const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** Text form, <= 40 lines. */
export function textLines(m) {
  const L = [`METRICS ${m.period.from} .. ${m.period.to}${m.team ? ` team ${m.team}` : ''}`];
  for (const [id, g] of Object.entries(m.goals).slice(0, 8)) {
    L.push(`${id} ${g.kind}: created ${g.tasks_created}, done ${g.done}, open ${Object.entries(g.open_by_status).map(([k, v]) => `${k} ${v}`).join(' ') || '0'}`);
  }
  for (const [id, t] of Object.entries(m.teams).slice(0, 6)) {
    const cls = (o) => ENUMS.item_class.map((c) => `${c} ${o[c] || 0}`).join(' ');
    L.push(`team ${id}: created ${t.tasks_created}, done ${t.done}; items opened ${cls(t.items_opened)}; closed ${cls(t.items_closed)}`);
  }
  L.push(`code ready->done hours: median ${m.code_cycle_hours.median ?? '-'}, p90 ${m.code_cycle_hours.p90 ?? '-'} (n ${m.code_cycle_hours.n})`);
  L.push(`first-pass review rate ${m.first_pass_review_rate ?? '-'}; rework ${m.rework_count}; fixup runs ${m.fixup_runs}; failed ${m.failed_tasks}; escalations ${m.escalations}`);
  L.push(`blocked ${m.blocked.length}: ${m.blocked.slice(0, 5).map((b) => `${b.task_id} ${b.age_h}h`).join(', ') || 'none'}`);
  L.push(`gates pending ${m.gates_pending.length}: ${m.gates_pending.slice(0, 5).map((g) => `${g.id} ${g.type} ${g.age_h}h`).join(', ') || 'none'}`);
  L.push(`PRs opened ${m.prs.opened}, merged ${m.prs.merged}`);
  L.push(`tokens ${fmtK(m.tokens.total)}; dispatcher ${fmtK(m.tokens.dispatcher_overhead)}; unattributed ${fmtK(m.tokens.unattributed)}`);
  L.push(`by role: ${Object.entries(m.tokens.by_role).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${fmtK(v)}`).join(', ') || 'none'}`);
  L.push(`by kind: ${Object.entries(m.tokens.by_kind).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${fmtK(v)}`).join(', ') || 'none'}`);
  L.push(`estimate vs actual: ${Object.entries(m.estimate_vs_actual).slice(0, 6).map(([k, v]) => `${k} x${v.ratio ?? '-'}`).join(', ') || 'none'}`);
  L.push(`budget: ${Object.entries(m.budget_pct).slice(0, 6).map(([k, v]) => `${k} ${v}%`).join(', ') || 'none'}`);
  L.push(`ticks ${m.ticks.count}, idle ${m.ticks.idle}`);
  return L.slice(0, 40);
}
