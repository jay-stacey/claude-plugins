// Work chooser (slot classes, file overlap, budget, backoff) and run dispatch (record, reserve, brief).
import { nowIso, ensureDir } from './fsutil.mjs';
import { join } from 'node:path';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { ROLE_INFO, BRANCH_KINDS, EPIC_CHECK_KINDS, subagentType, estimateFor, GATE_KINDS } from './roles.mjs';
import { reviewState, reviewRound } from './flow.mjs';
import { move } from './lifecycle.mjs';
import { slugify } from './ids.mjs';
import { overlap, lsFiles } from './glob.mjs';
import { repoRoot, fwd } from './paths.mjs';
import * as budget from './budget.mjs';
import { render, outputPaths } from './brief.mjs';
import * as deps from './deps.mjs';

export const ACTIVE_RUN = new Set(['dispatching', 'running', 'suspect']);
const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PLANNING_OK = new Set(['intake', 'prd', 'escalation', 'research']);

export function activeRuns(home) { return store.list(home, 'run', (r) => ACTIVE_RUN.has(r.status)); }

function authorKind(task) {
  if (task.pending_kind === 'integrate') return 'integrate';
  if (task.pending_kind === 'fixup') return 'fixup';
  if (task.kind === 'escalation') return 'escalation';
  if (task.kind === 'qa_epic') return 'qa';
  if (task.kind === 'review_epic') return 'review';
  return 'author';
}

function stageOf(task, runKind, isReview) {
  if (runKind === 'integrate') return 0;
  if (isReview || EPIC_CHECK_KINDS.has(task.kind)) return 1;
  if (runKind === 'fixup' || task.pending_kind === 'rework') return 2;
  if (GATE_KINDS[task.kind]) return 3;
  if (BRANCH_KINDS.has(task.kind)) return 4;
  return 5;
}

export function goalAllows(goal, task) {
  if (!goal) return false;
  if (goal.status === 'active') return true;
  if (['planning', 'awaiting_g1'].includes(goal.status)) { // draft goals (tracker intake) wait for goal.activate
    if (PLANNING_OK.has(task.kind)) return true;
    if (task.kind === 'spec' && goal.tier === 'S') return true;
  }
  return false;
}

/** All dispatchable candidates, sorted. */
export function candidates(home, cfg = loadConfig(home)) {
  const tasks = store.list(home, 'task');
  const goals = new Map(store.list(home, 'goal').map((g) => [g.id, g]));
  const active = activeRuns(home);
  const dependents = new Map();
  for (const t of tasks) for (const d of t.depends_on || []) dependents.set(d, (dependents.get(d) || 0) + 1);
  const out = [];
  for (const t of tasks) {
    const goal = goals.get(t.goal_id);
    if (!goalAllows(goal, t)) continue;
    if (t.status === 'ready') {
      if (active.some((r) => r.task_id === t.id && !r.review_role)) continue;
      const kind = authorKind(t);
      const role = kind === 'integrate' ? 'devops-release' : t.role;
      out.push({ task: t, goal, kind, role, review_role: null, stage: stageOf(t, kind, false) });
    } else if (t.status === 'in_review') {
      const st = reviewState(t);
      if (st.state !== 'pending') continue;
      for (const role of st.missing) {
        if (active.some((r) => r.task_id === t.id && r.review_role === role)) continue;
        out.push({ task: t, goal, kind: role === 'qa-engineer' ? 'qa' : 'review', role, review_role: role, stage: 1 });
      }
    }
  }
  out.sort((a, b) => (PRIO[a.goal.priority] ?? 9) - (PRIO[b.goal.priority] ?? 9)
    || a.stage - b.stage
    || (dependents.get(b.task.id) || 0) - (dependents.get(a.task.id) || 0)
    || String(a.task.created_at).localeCompare(String(b.task.created_at))
    || a.task.id.localeCompare(b.task.id));
  return out;
}

function filesOf(t) { return [...(t.files_owned || []), ...(t.files_shared || [])]; }
function isBuilderRun(c) { return !c.review_role && (BRANCH_KINDS.has(c.task.kind) || c.kind === 'integrate'); }

/**
 * Pick candidates within limits. Returns {chosen[], skipped[{task_id, reason}], blocked_goals[]}.
 * Side effect: goals that would pass their budget get blocked (gate opened once).
 */
export function choose(home, { cfg = loadConfig(home), factory = null, notifyFn = null, now = Date.now() } = {}) {
  const res = { chosen: [], skipped: [], blocked_goals: [] };
  if (factory && factory.status !== 'running') { res.reason = `factory ${factory.status}`; return res; }
  if (factory && factory.backoff_until && Date.parse(factory.backoff_until) > now) { res.reason = `backoff until ${factory.backoff_until}`; return res; }
  const cands = candidates(home, cfg);
  if (!cands.length) return res;
  const active = activeRuns(home);
  const cc = cfg.concurrency;
  const count = { total: active.length, builders: 0, reviewers: 0, planners: 0 };
  const perRole = {};
  const buildingGoals = new Set();
  const busyFiles = [];
  for (const r of active) {
    const slot = (ROLE_INFO[r.role] || {}).slot || 'planners';
    count[slot] += 1;
    perRole[r.role] = (perRole[r.role] || 0) + 1;
    if (slot === 'builders') buildingGoals.add(r.goal_id);
    const t = store.get(home, 'task', r.task_id);
    if (t && !r.review_role && (BRANCH_KINDS.has(t.kind) || r.kind === 'integrate')) busyFiles.push({ id: t.id, files: r.kind === 'integrate' ? (t.conflict_files || []) : filesOf(t) });
  }
  let files = null;
  const b = budget.compute(home, cfg);
  const blocked = new Set();
  const seenTask = new Set();
  for (const c of cands) {
    const key = `${c.task.id}:${c.review_role || ''}`;
    if (seenTask.has(key)) continue;
    const slot = (ROLE_INFO[c.role] || {}).slot || 'planners';
    const skip = (reason) => res.skipped.push({ task_id: c.task.id, role: c.role, reason });
    if (blocked.has(c.goal.id)) { skip('budget blocked'); continue; }
    if (count.total >= cc.total) { skip('total slots full'); continue; }
    if (count[slot] >= (cc[slot] ?? 99)) { skip(`${slot} slots full`); continue; }
    if (cc.per_role && cc.per_role[c.role] !== undefined && (perRole[c.role] || 0) >= cc.per_role[c.role]) { skip(`${c.role} limit`); continue; }
    if (slot === 'builders' && !buildingGoals.has(c.goal.id) && buildingGoals.size >= (cc.max_goals_building ?? 99)) { skip('max goals building'); continue; }
    if (isBuilderRun(c)) {
      const mine = c.kind === 'integrate' ? (c.task.conflict_files || []) : filesOf(c.task);
      if (mine.length && busyFiles.length) {
        files = files || lsFiles(repoRoot(home));
        const hit = busyFiles.find((x) => x.id !== c.task.id && overlap(mine, x.files, files));
        if (hit) { skip(`files overlap ${hit.id}`); continue; }
      }
    }
    const estimate = estimateFor(cfg, c.task, c.kind === 'author' || c.kind === 'escalation' ? 'author' : c.kind === 'qa' && !c.review_role ? 'author' : c.kind);
    const slotB = b.goals[c.goal.id];
    if (budget.wouldExceed(c.goal, slotB, estimate)) {
      budget.block(home, c.goal.id, estimate, { notifyFn });
      blocked.add(c.goal.id); res.blocked_goals.push(c.goal.id);
      skip('budget blocked');
      continue;
    }
    if (slotB) slotB.reserved += estimate;
    c.estimate = estimate;
    res.chosen.push(c);
    seenTask.add(key);
    count.total += 1; count[slot] += 1; perRole[c.role] = (perRole[c.role] || 0) + 1;
    if (slot === 'builders') buildingGoals.add(c.goal.id);
    if (isBuilderRun(c)) busyFiles.push({ id: c.task.id, files: c.kind === 'integrate' ? (c.task.conflict_files || []) : filesOf(c.task) });
  }
  return res;
}

export function modelFor(cfg, task, role, kind, review_role) {
  if (task.model_override && !review_role) return task.model_override;
  // config.models: {all?: model, by_role?: {role: model}} lets a repo trade quality for cost.
  const models = cfg.models || {};
  if (models.by_role && typeof models.by_role[role] === 'string') return models.by_role[role];
  if (typeof models.all === 'string' && models.all) return models.all;
  if (role === 'code-reviewer' && (task.kind === 'review_epic' || (cfg.reviews && cfg.reviews.profile === 'thorough'))) return 'opus';
  return (ROLE_INFO[role] || {}).model || 'sonnet';
}

/** Create the run, move the task, reserve tokens, render the brief. Returns the DISPATCH object. */
export async function dispatch(home, c, { cfg = loadConfig(home), session = null } = {}) {
  let task = store.mustGet(home, 'task', c.task.id);
  const epic = task.epic_id ? store.get(home, 'epic', task.epic_id) : null;
  if (BRANCH_KINDS.has(task.kind) && !task.branch) {
    task = store.update(home, 'task', task.id, (t) => {
      t.branch = `factory/${t.id}-${slugify(t.title)}`;
      t.base_ref = epic ? epic.branch : cfg.delivery.base_branch;
    });
  }
  let headSha = null;
  if (c.review_role && BRANCH_KINDS.has(task.kind)) headSha = task.head_sha || null;
  if (EPIC_CHECK_KINDS.has(task.kind) && epic) {
    try { const git = await deps.load('git'); headSha = git.headSha(repoRoot(home), epic.branch); } catch { headSha = null; }
  }
  const id = store.nextId(home, 'run');
  const round = c.review_role ? reviewRound(task) : (task.rework_count || 0) + 1;
  const runFields = {
    id, task_id: task.id, goal_id: task.goal_id, epic_id: task.epic_id, kind: c.kind, role: c.role,
    subagent_type: subagentType(c.role), model: modelFor(cfg, task, c.role, c.kind, c.review_role), status: 'dispatching',
    session_id: session, dispatched_at: nowIso(), isolation: (ROLE_INFO[c.role] || {}).isolation || 'none',
    branch: c.review_role || EPIC_CHECK_KINDS.has(task.kind) ? null : task.branch, head_sha: headSha,
    handoff_path: fwd(join(home, 'runs', id, 'handoff.json')), brief_path: fwd(join(home, 'runs', id, 'brief.md')),
    estimate_tokens: c.estimate ?? estimateFor(cfg, task, c.kind), round, review_role: c.review_role || null,
    merge_first: c.kind === 'integrate' && epic ? [epic.branch] : [],
  };
  if (EPIC_CHECK_KINDS.has(task.kind) && epic) runFields.detach_ref = epic.branch;
  ensureDir(join(home, 'runs', id, 'evidence'));
  const goal = store.get(home, 'goal', task.goal_id);
  runFields.output_paths = outputPaths(home, runFields, task, goal);
  const run = store.create(home, 'run', runFields);
  if (!c.review_role) {
    task = move(home, task.id, 'in_progress', {
      reason: `${c.kind} run ${id}`,
      data: (t) => {
        if (c.kind === 'author' || c.kind === 'qa' || c.kind === 'review' || c.kind === 'escalation') t.attempts += 1;
        t.current_run_id = id; t.runs.push(id); t.pending_kind_run = t.pending_kind; t.pending_kind = null;
      },
    });
  } else {
    task = store.update(home, 'task', task.id, (t) => { t.runs.push(id); });
  }
  budget.ledger(home, { kind: 'reserve', goal_id: task.goal_id, run_id: id, tokens: run.estimate_tokens, by: 'tick' });
  render(home, run, { cfg });
  emit(home, {
    type: 'run.dispatched', session_id: session, goal_id: task.goal_id, epic_id: task.epic_id, task_id: task.id, run_id: id,
    actor: { kind: 'system', role: 'cto' }, msg: `${id} ${c.role} ${c.kind} for ${task.id}`, data: { role: c.role, kind: c.kind, model: run.model },
  });
  return dispatchLine(home, run, task);
}

export function dispatchLine(home, run, task) {
  const attempt = run.review_role ? run.round : task.attempts;
  return {
    run_id: run.id,
    subagent_type: run.subagent_type,
    model: run.model,
    description: `[${task.id}] ${task.title}`.slice(0, 100),
    prompt: `FACTORY_RUN=${run.id} task=${task.id} goal=${task.goal_id} role=${run.role} attempt=${attempt}\n`
      + `Read and follow your brief: ${run.brief_path}\n`
      + 'When done, write your handoff file, run the validate command in the brief, then reply with one line: HANDOFF <path> <status>',
  };
}
