// Work streams (contracts §21.4): one standing `stream` goal per team for bugs, tech debt and chores.
// An item is one `triage` task (staff-engineer) in the team's stream goal; its fixes are epics that
// link back with `item_task_id`.
import { nowIso, withMutex } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { ENUMS } from './schema.mjs';
import * as teams from './teams.mjs';
import * as repos from './repos.mjs';
import * as budget from './budget.mjs';
import * as cycles from './cycles.mjs';
import { createStandingGoal, createTask, goalKind } from './actions.mjs';

const WEEK = 7 * 86400000;
const OPEN = (t) => !['done', 'cancelled'].includes(t.status);

function fail(msg, code = 1) { const e = new Error(msg); e.exitCode = code; return e; }

export function enabled(cfg) { return !!(cfg && cfg.streams && cfg.streams.enabled); }

/** Team ids that get a stream: `streams.teams`, or (empty) every team with repos. */
export function streamTeams(home, cfg) {
  const all = teams.list(home, cfg);
  const listed = (cfg.streams && Array.isArray(cfg.streams.teams)) ? cfg.streams.teams : [];
  if (listed.length) return all.filter((t) => listed.includes(t.id)).map((t) => t.id);
  return all.filter((t) => t.repos.length).map((t) => t.id);
}

/** True when a person removed (cancelled) the team's stream goal: it is never re-created. */
export function streamRemoved(home, teamId) {
  return !store.list(home, 'goal', (g) => goalKind(g) === 'stream' && g.team === teamId && g.status !== 'cancelled').length
    && store.list(home, 'goal', (g) => goalKind(g) === 'stream' && g.team === teamId && g.status === 'cancelled').length > 0;
}

export function streamGoal(home, teamId) {
  return store.list(home, 'goal', (g) => goalKind(g) === 'stream' && g.team === teamId && g.status !== 'cancelled')[0] || null;
}

/** Create the missing stream goals when streams are on (§21.1.3). Returns the goals created. */
export function ensureStreams(home, cfg = loadConfig(home), { now = Date.now() } = {}) {
  if (!enabled(cfg)) return [];
  return withMutex(home, () => {
    const made = [];
    for (const id of streamTeams(home, cfg)) {
      if (streamGoal(home, id) || streamRemoved(home, id)) continue;
      const t = teams.get(home, cfg, id);
      const cur = cycles.currentOf(home, cfg, id);
      made.push(createStandingGoal(home, {
        kind: 'stream', title: `${t.name} maintenance`, team: id,
        outcome: `Bugs, tech debt and chores of ${t.name}: triaged, fixed and shipped within the stream budget.`,
        criteria: [`Items of ${t.name} are triaged and fixed within the stream budget`],
        limit: cfg.streams.budget_tokens_per_window, windowStart: (cur && cur.starts_at) || nowIso(now),
      }));
    }
    return made;
  });
}

/** Start a new budget window for a team's stream goal (a cycle start, or every 7 days without cycles). */
export function rollTeamWindow(home, cfg, teamId, startIso, reason = 'stream budget window rolled') {
  const g = streamGoal(home, teamId);
  if (!g) return null;
  return budget.rollWindow(home, g.id, { windowStart: startIso, limit: cfg.streams.budget_tokens_per_window, reason });
}

/** Without cycles a stream window rolls every 7 days (§21.1.7). Returns the goal ids rolled. */
export function rollWeeklyWindows(home, cfg, now = Date.now()) {
  const out = [];
  for (const g of store.list(home, 'goal', (x) => goalKind(x) === 'stream' && !['done', 'cancelled'].includes(x.status))) {
    if (cycles.currentOf(home, cfg, g.team)) continue; // a team with cycles rolls at each cycle start
    const ws = Date.parse(g.budget.window_start || 0) || 0;
    if (!ws) { budget.rollWindow(home, g.id, { windowStart: nowIso(now), limit: cfg.streams.budget_tokens_per_window }); out.push(g.id); continue; }
    if (now - ws < WEEK) continue;
    const start = ws + Math.floor((now - ws) / WEEK) * WEEK;
    budget.rollWindow(home, g.id, { windowStart: nowIso(start), limit: cfg.streams.budget_tokens_per_window, reason: 'weekly stream budget window' });
    out.push(g.id);
  }
  return out;
}

/**
 * Effective status of an item (§21.4.6): triage not done -> its own status; done with epics -> all done
 * = done, all cancelled = cancelled, any pr_open = in_review, else in_progress; done without epics = done.
 */
export function itemStatus(home, task) {
  if (!task) return null;
  if (task.status !== 'done') return task.status;
  const ids = task.item_epic_ids || [];
  if (!ids.length) return 'done';
  // An epic id that cannot be read counts as open.
  const epics = ids.map((id) => store.get(home, 'epic', id) || { id, status: 'unknown' });
  if (epics.every((e) => e.status === 'cancelled')) return 'cancelled';
  if (epics.every((e) => ['done', 'cancelled'].includes(e.status)) && epics.some((e) => e.status === 'done')) return 'done';
  if (epics.some((e) => e.status === 'pr_open')) return 'in_review';
  return 'in_progress';
}

export function isOpenItem(home, task) { return !['done', 'cancelled'].includes(itemStatus(home, task)); }

/** Triage tasks (items), optionally by team and class. */
export function items(home, { team = null, cls = null } = {}) {
  return store.list(home, 'task', (t) => t.kind === 'triage' && (!team || t.team === team) && (!cls || (t.item && t.item.class === cls)));
}

export function findByRemoteId(home, remoteId) {
  if (!remoteId) return null;
  return store.list(home, 'task', (t) => t.kind === 'triage' && t.item && t.item.tracker_ref && String(t.item.tracker_ref.remote_id) === String(remoteId))[0] || null;
}

/** Map a tracker priority (P0..P3, or Linear 0-4 where 1 is urgent) to P0..P3. */
export function mapPriority(p) {
  if (ENUMS.priority.includes(p)) return p;
  const n = Number(p);
  if (Number.isFinite(n)) return { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3' }[n] || 'P2';
  const s = String(p || '').toLowerCase();
  return { urgent: 'P0', high: 'P1', medium: 'P2', normal: 'P2', low: 'P3' }[s] || 'P2';
}

/**
 * Create an item (`item new`, inbox `item.add`, tracker backlog, agent follow-ups). Returns
 * {task, created}. A tracker item (same tracker_ref.remote_id) is never created twice; `dedupeTitle`
 * skips an item whose title already exists in the team (agent follow-ups).
 */
export function newItem(home, input, { cfg = loadConfig(home), dedupeTitle = false } = {}) {
  if (!enabled(cfg)) throw fail('streams are off; set streams.enabled true');
  const team = String(input.team || '').trim();
  if (!team) throw fail('item needs --team', 2);
  teams.get(home, cfg, team);
  if (!streamTeams(home, cfg).includes(team)) throw fail(`team ${team} has no stream (streams.teams: ${streamTeams(home, cfg).join(', ') || 'none'})`);
  const cls = input.class;
  if (!ENUMS.item_class.includes(cls)) throw fail('--class must be bug|tech_debt|chore', 2);
  const title = String(input.title || '').trim();
  if (!title) throw fail('item needs --title', 2);
  const priority = input.priority ? mapPriority(input.priority) : 'P2';
  let repo = null;
  if (input.repo) {
    const names = repos.names(home, cfg);
    if (repos.isWorkspace(cfg)) { if (!names.includes(input.repo)) throw fail(`unknown repo ${input.repo}; known: ${names.join(', ')}`); repo = input.repo; }
  }
  const ref = input.tracker_ref && typeof input.tracker_ref === 'object' ? input.tracker_ref : null;
  return withMutex(home, () => {
    const dup = ref && ref.remote_id ? findByRemoteId(home, ref.remote_id) : null;
    if (dup) return { task: dup, created: false, reason: `already linked as ${dup.id}` };
    if (dedupeTitle) {
      const same = items(home, { team }).find((t) => t.status !== 'cancelled' && t.title.toLowerCase() === title.slice(0, 80).toLowerCase());
      if (same) return { task: same, created: false, reason: `same title as ${same.id}` };
    }
    if (streamRemoved(home, team)) throw fail(`the stream of team ${team} was removed`);
    ensureStreams(home, cfg);
    const goal = streamGoal(home, team);
    if (!goal) throw fail(`no stream goal for team ${team}`);
    const task = createTask(home, {
      goal_id: goal.id, kind: 'triage', role: 'staff-engineer', status: 'ready', title: title.slice(0, 80),
      description: String(input.description || '').slice(0, 1200), priority, team, repo, cycle: input.cycle || null,
      item: { class: cls, tracker_ref: ref, reported_by: ['human', 'tracker', 'agent'].includes(input.reported_by) ? input.reported_by : 'human' },
      item_epic_ids: [], created_by: input.reported_by || 'human',
    });
    emit(home, { type: 'item.created', goal_id: goal.id, task_id: task.id, msg: `${task.id} ${cls} for ${team}: ${task.title}`.slice(0, 140), data: { team, class: cls, priority, reported_by: task.item.reported_by, remote_id: ref ? ref.remote_id || null : null } });
    return { task, created: true };
  });
}

/**
 * Agent follow-ups with kind bug|tech_debt|chore become items in the team of the reporting task
 * (or the first stream team when that team has none), deduped by title within the team.
 */
export function itemsFromFollowUps(home, cfg, task, handoff) {
  if (!enabled(cfg) || !handoff || !Array.isArray(handoff.follow_ups)) return [];
  const out = [];
  const st = streamTeams(home, cfg);
  if (!st.length) return out;
  const goal = store.get(home, 'goal', task.goal_id);
  const team0 = task.team || teams.resolve(home, cfg, { task, goal });
  const team = st.includes(team0) ? team0 : st[0];
  for (const f of handoff.follow_ups.slice(0, 10)) {
    if (!f || !ENUMS.item_class.includes(f.kind) || typeof f.title !== 'string' || !f.title.trim()) continue;
    try {
      const r = newItem(home, {
        team, class: f.kind, title: f.title, reported_by: 'agent',
        description: `${String(f.reason || '').slice(0, 900)}\n(follow-up from ${task.id} by ${handoff.from_role || task.role})`,
      }, { cfg, dedupeTitle: true });
      if (r.created) out.push(r.task.id);
    } catch (e) { // a bad follow-up never breaks collect, but it is reported
      emit(home, { type: 'factory.status', goal_id: task.goal_id, task_id: task.id, msg: `follow-up "${String(f.title).slice(0, 60)}" not added as an item: ${e.message}`.slice(0, 140), data: { error: String(e.message || e).slice(0, 300), follow_up: String(f.title).slice(0, 80) } });
    }
  }
  return out;
}

/** One status line part per stream: "<team> N open, M building", or "<team> removed". */
export function countsText(sc) {
  return sc.map((x) => (x.removed ? `${x.team} removed` : `${x.team} ${x.open} open, ${x.building} building${x.status === 'budget_blocked' ? ' (budget blocked)' : ''}`)).join('; ');
}

/** Stream builder slots (§21.4.7): max(1, floor(builders * capacity_pct / 100)). */
export function capacity(cfg) {
  const b = Number(cfg.concurrency && cfg.concurrency.builders) || 0;
  const pct = Number(cfg.streams && cfg.streams.capacity_pct);
  return Math.max(1, Math.floor((b * (Number.isFinite(pct) ? pct : 30)) / 100));
}

/** Compact per-team stream counts for `status` and `tick end`: [{team, open, building}]. */
export function counts(home, cfg) {
  const out = [];
  const all = store.list(home, 'goal', (x) => goalKind(x) === 'stream');
  for (const g of all.filter((x) => x.status === 'cancelled' && !all.some((y) => y.team === x.team && y.status !== 'cancelled'))) {
    if (!out.some((o) => o.team === g.team)) out.push({ team: g.team, goal_id: g.id, status: 'cancelled', removed: true, open: 0, building: 0, open_tasks: 0 });
  }
  for (const g of all.filter((x) => x.status !== 'cancelled')) {
    const tasks = store.list(home, 'task', (t) => t.goal_id === g.id);
    const open = tasks.filter((t) => t.kind === 'triage' && isOpenItem(home, t)).length;
    const building = tasks.filter((t) => t.kind === 'code' && ['in_progress', 'checking', 'in_review', 'changes_requested', 'verified', 'integrated'].includes(t.status)).length;
    out.push({ team: g.team, goal_id: g.id, status: g.status, open, building, open_tasks: tasks.filter(OPEN).length });
  }
  void cfg;
  return out;
}
