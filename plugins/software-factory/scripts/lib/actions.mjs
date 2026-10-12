// Record-level actions shared by the CLI, the inbox and the flow engine.
import { join } from 'node:path';
import { ensureDir, nowIso, withMutex } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { slugify } from './ids.mjs';
import { ROLES, ENUMS } from './schema.mjs';
import { KIND_ROLE, estimateFor, CODE_ROLES } from './roles.mjs';
import { move, setGoalStatus } from './lifecycle.mjs';
import { overlap, lsFiles } from './glob.mjs';
import * as repos from './repos.mjs';

export function fail(msg, exitCode = 1) { const e = new Error(msg); e.exitCode = exitCode; return e; }

export function goalDocsRel(goal) { return `docs/${goal.id}-${goal.slug}`; }
export function goalDocsDir(home, goal) { return join(home, 'docs', `${goal.id}-${goal.slug}`); }

export function tasksOf(home, goalId) { return store.list(home, 'task', (t) => t.goal_id === goalId); }

// ---------------- goals ----------------
export function newGoal(home, input, { via = 'cli', kind = 'human' } = {}) {
  const cfg = loadConfig(home);
  const title = String(input.title || '').trim();
  if (!title) throw fail('goal needs --title', 2);
  const criteria = (input.success_criteria || []).map(String).filter((s) => s.trim());
  if (!criteria.length) throw fail('goal needs at least one --criteria', 2);
  const priority = input.priority || 'P2';
  if (!ENUMS.priority.includes(priority)) throw fail('priority must be P0..P3', 2);
  const userBudget = Number(input.budget_tokens) > 0 ? Number(input.budget_tokens) : null;
  return withMutex(home, () => {
    const goal = store.create(home, 'goal', {
      title: title.slice(0, 80), slug: slugify(title), outcome: String(input.outcome || title).slice(0, 600),
      success_criteria: criteria.slice(0, 7), constraints: (input.constraints || []).map(String), priority,
      status: 'planning', created_by: { kind, via },
      budget: { limit_tokens: userBudget || cfg.budget.tier_defaults.M, warn_pct: cfg.budget.warn_pct, stop_pct: cfg.budget.stop_pct, user_set: !!userBudget },
      notes: input.notes || null,
    });
    ensureDir(goalDocsDir(home, goal));
    emit(home, { type: 'goal.status', goal_id: goal.id, actor: { kind }, msg: `${goal.id} created: ${goal.title}`, data: { from: null, to: 'planning' } });
    createTask(home, {
      goal_id: goal.id, kind: 'intake', title: `Intake: ${goal.title}`.slice(0, 80),
      description: 'Set tier (S|M|L), needs_ui and the pod with `goal set`. Check the budget against the tier.',
      status: 'ready', priority,
    });
    return store.get(home, 'goal', goal.id);
  });
}

export function setGoal(home, goalId, { tier, needs_ui, pod } = {}) {
  const cfg = loadConfig(home);
  if (tier !== undefined && !ENUMS.tier.includes(tier)) throw fail('--tier must be S|M|L', 2);
  return store.update(home, 'goal', goalId, (g) => {
    if (tier !== undefined) {
      g.tier = tier;
      if (!g.budget.user_set) g.budget.limit_tokens = cfg.budget.tier_defaults[tier];
    }
    if (needs_ui !== undefined) g.needs_ui = needs_ui;
    if (pod !== undefined) g.pod = { product: null, tech_lead: null, members: [], ...pod };
  });
}

export function setGoalPaused(home, goalId, paused, reason) {
  const g = store.mustGet(home, 'goal', goalId);
  if (paused) {
    if (['done', 'cancelled', 'paused'].includes(g.status)) return g;
    return setGoalStatus(home, goalId, 'paused', reason || 'paused by user', (x) => { x.status_before_pause = g.status; });
  }
  if (g.status !== 'paused') return g;
  const back = g.status_before_pause || 'active';
  return setGoalStatus(home, goalId, back, reason || 'resumed', (x) => { delete x.status_before_pause; });
}

export function activateGoal(home, goalId) {
  const g = store.mustGet(home, 'goal', goalId);
  if (g.status === 'draft') return setGoalStatus(home, goalId, 'planning', 'activated');
  if (g.status === 'paused') return setGoalPaused(home, goalId, false, 'activated');
  return g;
}

/** Goal impact: what a remove would touch. */
export function goalImpact(home, goalId) {
  const g = store.mustGet(home, 'goal', goalId);
  const tasks = tasksOf(home, goalId);
  const runs = store.list(home, 'run', (r) => r.goal_id === goalId && ['dispatching', 'running', 'suspect'].includes(r.status));
  const epics = store.list(home, 'epic', (e) => e.goal_id === goalId);
  return {
    goal: g.id, status: g.status, tasks_open: tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).map((t) => t.id),
    runs_active: runs.map((r) => ({ run_id: r.id, agent_id: r.agent_id })),
    branches: [...epics.map((e) => e.branch), ...tasks.map((t) => t.branch)].filter(Boolean),
    prs: epics.filter((e) => e.pr && e.pr.url).map((e) => e.pr.url),
  };
}

export function removeGoal(home, goalId, { discard = false, by = 'human', via = 'cli' } = {}) {
  const impact = goalImpact(home, goalId);
  for (const id of impact.tasks_open) {
    const t = store.get(home, 'task', id);
    store.update(home, 'task', id, (x) => { x.status = 'cancelled'; x.status_reason = 'goal removed'; });
    emit(home, { type: 'task.status', goal_id: goalId, task_id: id, msg: `${id} ${t.status} -> cancelled`, data: { from: t.status, to: 'cancelled' } });
  }
  for (const e of store.list(home, 'epic', (x) => x.goal_id === goalId && x.status !== 'done')) {
    store.update(home, 'epic', e.id, (x) => { x.status = 'cancelled'; });
  }
  for (const gt of store.list(home, 'gate', (x) => x.goal_id === goalId && x.status === 'pending')) {
    store.update(home, 'gate', gt.id, (x) => { x.status = 'superseded'; x.decision = { by, via, at: nowIso(), notes: 'goal removed' }; });
  }
  setGoalStatus(home, goalId, 'cancelled', 'removed');
  let gate = null;
  if (discard && impact.branches.length) {
    gate = store.create(home, 'gate', {
      type: 'destructive', subject: { kind: 'goal', id: goalId }, goal_id: goalId, status: 'pending', opened_at: nowIso(),
      opened_by: { run_id: null, actor: by }, artifact: { paths: [], summary: `Delete ${impact.branches.length} branches of ${goalId}.` },
      request: { action: 'discard_goal_branches', impact: impact.branches },
    });
    emit(home, { type: 'gate.opened', goal_id: goalId, msg: `${gate.id} destructive gate for ${goalId}`, data: { gate_id: gate.id, type: 'destructive' } });
  }
  return { impact, gate };
}

// ---------------- epics ----------------
export function newEpic(home, { goal_id, title, summary = '', depends_on = [], repo = null }) {
  const cfg = loadConfig(home);
  const goal = store.mustGet(home, 'goal', goal_id);
  if (!title) throw fail('epic needs --title', 2);
  for (const d of depends_on) if (!store.get(home, 'epic', d)) throw fail(`depends_on ${d} not found`);
  // Workspace mode: an epic lives in exactly one repo (contracts §20.3). Classic mode ignores --repo.
  const ws = repos.isWorkspace(cfg);
  if (ws && !repo) throw fail(`epic needs --repo (one of: ${repos.names(home, cfg).join(', ')})`, 2);
  const r = repos.get(home, cfg, ws ? repo : null);
  return withMutex(home, () => {
    const id = store.nextId(home, 'epic');
    const slug = slugify(title);
    const epic = store.create(home, 'epic', {
      id, goal_id, title: title.slice(0, 80), slug, summary, depends_on, status: 'draft',
      branch: `factory/${id}-${slug}`, base_branch: r.delivery.base_branch, repo: ws ? r.name : null,
    });
    store.update(home, 'goal', goal.id, (g) => { if (!g.epics.includes(id)) g.epics.push(id); });
    return epic;
  });
}

// ---------------- tasks ----------------
export function reviewsFor(cfg, task, goal = null) {
  const profile = (cfg.reviews && cfg.reviews.profile) || 'lean';
  const risk = (task.risk_flags || []).length > 0;
  switch (task.kind) {
    case 'code': {
      const g1 = ['code-reviewer']; if (risk) g1.push('security-reviewer');
      const groups = [g1];
      if (profile === 'thorough' || task.role === 'frontend-engineer') groups.push(['qa-engineer']);
      return groups;
    }
    case 'prd': return (profile === 'thorough' || (goal && goal.tier === 'L')) ? [['critic']] : [];
    case 'spec': return [risk ? ['critic', 'security-reviewer'] : ['critic']];
    case 'mockup': return [['critic']];
    case 'docs': return profile === 'thorough' ? [['code-reviewer']] : [];
    default: return [];
  }
}

function normAcs(list) {
  return (list || []).map((x, i) => (typeof x === 'string' ? { id: `AC-${i + 1}`, text: x } : { id: x.id || `AC-${i + 1}`, text: x.text }));
}

/** Low-level task creation used by the flow engine (trusted input). */
export function createTask(home, fields) {
  const cfg = loadConfig(home);
  const role = fields.role || KIND_ROLE[fields.kind] || 'cto';
  const goal = fields.goal_id ? store.get(home, 'goal', fields.goal_id) : null;
  const t = { ...fields, role, acceptance_criteria: normAcs(fields.acceptance_criteria) };
  if (t.repo === undefined && t.epic_id) { const ep = store.get(home, 'epic', t.epic_id); t.repo = (ep && ep.repo) || null; }
  if (t.priority === undefined && goal) t.priority = goal.priority;
  if (t.reviews_required === undefined) t.reviews_required = reviewsFor(cfg, t, goal);
  if (!t.estimate_tokens) t.estimate_tokens = estimateFor(cfg, { ...t, estimate_tokens: 0 }, 'author');
  const rec = store.create(home, 'task', t);
  if (rec.epic_id) store.update(home, 'epic', rec.epic_id, (e) => { if (!e.tasks.includes(rec.id)) e.tasks.push(rec.id); });
  emit(home, { type: 'task.created', goal_id: rec.goal_id, epic_id: rec.epic_id, task_id: rec.id, msg: `${rec.id} ${rec.kind}: ${rec.title}`, data: { kind: rec.kind, role: rec.role, status: rec.status } });
  return rec;
}

function cycleCheck(all) {
  const graph = new Map(all.map((t) => [t.id, t.depends_on || []]));
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...path, id];
    state.set(id, 1);
    for (const d of graph.get(id) || []) { const c = visit(d, [...path, id]); if (c) return c; }
    state.set(id, 2);
    return null;
  };
  for (const id of graph.keys()) { const c = visit(id, []); if (c) return c; }
  return null;
}

/**
 * `task new --file`: validate and create one task or an array. Items may carry `ref` and depend on other refs.
 * Status: draft until the goal's sequence task is done, then backlog.
 */
export function newTasks(home, input, { actor = 'cli' } = {}) {
  const cfg = loadConfig(home);
  const ws = repos.isWorkspace(cfg);
  const repoNames = repos.names(home, cfg);
  const items = Array.isArray(input) ? input : [input];
  if (!items.length) throw fail('no tasks in file');
  return withMutex(home, () => {
    const errors = [];
    const refs = new Map();
    const planned = [];
    for (const [i, raw] of items.entries()) {
      const where = `task[${i}]`;
      const kind = raw.kind || 'code';
      let goalId = raw.goal_id;
      let ep = null;
      if (raw.epic_id) {
        ep = store.get(home, 'epic', raw.epic_id);
        if (!ep) { errors.push(`${where}: epic ${raw.epic_id} not found`); continue; }
        goalId = goalId || ep.goal_id;
      }
      // Repo (contracts §20.3): task file, else the epic; must match the epic. Classic mode stores null.
      let repo = null;
      if (ws) {
        repo = raw.repo || (ep && ep.repo) || null;
        if (raw.repo && ep && ep.repo && raw.repo !== ep.repo) errors.push(`${where}: repo ${raw.repo} does not match epic ${ep.id} repo ${ep.repo}`);
        if (repo && !repoNames.includes(repo)) errors.push(`${where}: unknown repo ${repo}; known: ${repoNames.join(', ')}`);
        if (!repo && (kind === 'code' || kind === 'docs')) errors.push(`${where}: ${kind} tasks need a repo (an epic with a repo, or "repo")`);
      }
      const goal = goalId ? store.get(home, 'goal', goalId) : null;
      if (!goal) { errors.push(`${where}: goal_id missing or not found`); continue; }
      if (!raw.title) errors.push(`${where}: title required`);
      const role = raw.role || KIND_ROLE[kind];
      if (!ROLES.includes(role)) errors.push(`${where}: unknown role ${role}`);
      if (kind === 'code') {
        if (!raw.epic_id) errors.push(`${where}: code tasks need epic_id`);
        if (!CODE_ROLES.includes(role)) errors.push(`${where}: code tasks need a builder role (${CODE_ROLES.join(', ')})`);
        if (raw.size === 'L') errors.push(`${where}: size L is too big; split it`);
        const n = (raw.acceptance_criteria || []).length;
        if (n < 1 || n > 5) errors.push(`${where}: needs 1-5 acceptance criteria`);
      }
      const id = store.nextId(home, 'task');
      if (raw.ref) refs.set(raw.ref, id);
      planned.push({ id, raw, kind, role, goal, repo });
    }
    if (errors.length) throw Object.assign(fail(errors.join('\n')), { errors });
    // resolve refs
    for (const p of planned) {
      p.deps = (p.raw.depends_on || []).map((d) => refs.get(d) || d);
      for (const d of p.deps) {
        if (!refs.has(d) && ![...refs.values()].includes(d) && !store.get(home, 'task', d)) errors.push(`${p.id}: depends_on ${d} not found`);
      }
    }
    // file ownership overlap with other open code tasks of the same goal and repo, and within the batch
    const repoOf = (t) => repos.nameFor(home, cfg, { task: t, epic: t.epic_id ? store.get(home, 'epic', t.epic_id) : null });
    const fileCache = new Map();
    const filesIn = (name) => { if (!fileCache.has(name)) fileCache.set(name, lsFiles(repos.get(home, cfg, name).path)); return fileCache.get(name); };
    const open = store.list(home, 'task', (t) => t.kind === 'code' && !['done', 'cancelled', 'integrated'].includes(t.status));
    for (const [i, p] of planned.entries()) {
      if (p.kind !== 'code' || !(p.raw.files_owned || []).length) continue;
      const pr = p.repo || repos.defaultName(home, cfg);
      for (const t of open.filter((x) => x.goal_id === p.goal.id && repoOf(x) === pr)) {
        if (overlap(p.raw.files_owned, t.files_owned, filesIn(pr))) errors.push(`${p.id}: files_owned overlaps ${t.id}`);
      }
      for (const q of planned.slice(i + 1)) {
        if (q.kind === 'code' && (q.repo || repos.defaultName(home, cfg)) === pr && overlap(p.raw.files_owned, q.raw.files_owned || [], filesIn(pr))) errors.push(`${p.id}: files_owned overlaps ${q.id}`);
      }
    }
    const existing = store.list(home, 'task');
    const cyc = cycleCheck([...existing, ...planned.map((p) => ({ id: p.id, depends_on: p.deps }))]);
    if (cyc) errors.push(`dependency cycle: ${cyc.join(' -> ')}`);
    if (errors.length) throw Object.assign(fail(errors.join('\n')), { errors });

    const out = [];
    for (const p of planned) {
      const tasks = tasksOf(home, p.goal.id);
      const sequenced = tasks.some((t) => t.kind === 'sequence' && t.status === 'done');
      const gateDeps = [...(p.raw.gate_deps || [])];
      if (p.role === 'frontend-engineer' && p.goal.needs_ui && !gateDeps.includes('G3')) gateDeps.push('G3');
      const fields = {
        id: p.id, goal_id: p.goal.id, epic_id: p.raw.epic_id || null, repo: p.repo, kind: p.kind, role: p.role,
        title: String(p.raw.title).slice(0, 80), description: String(p.raw.description || '').slice(0, 1200),
        size: p.raw.size || 'M', acceptance_criteria: p.raw.acceptance_criteria || [],
        files_owned: p.raw.files_owned || [], files_shared: p.raw.files_shared || [], files_read: p.raw.files_read || [],
        depends_on: p.deps, gate_deps: gateDeps, risk_flags: p.raw.risk_flags || [],
        estimate_tokens: Number(p.raw.estimate_tokens) || 0, model_override: p.raw.model_override || null,
        status: p.kind === 'code' || p.kind === 'docs' ? (sequenced ? 'backlog' : 'draft') : 'ready',
        created_by: actor,
      };
      if (p.raw.priority) fields.priority = p.raw.priority;
      if (p.raw.reviews_required) fields.reviews_required = p.raw.reviews_required;
      out.push(createTask(home, fields));
    }
    return out;
  });
}

const REPLAN_FIELDS = ['title', 'description', 'depends_on', 'estimate_tokens', 'priority', 'files_owned', 'files_shared',
  'files_read', 'acceptance_criteria', 'size', 'model_override', 'risk_flags', 'reviews_required', 'gate_deps', 'role'];

export function replanTask(home, taskId, patch) {
  const bad = Object.keys(patch).filter((k) => !REPLAN_FIELDS.includes(k));
  if (bad.length) throw fail(`replan cannot change: ${bad.join(', ')}`);
  if (patch.depends_on) {
    const all = store.list(home, 'task').map((t) => (t.id === taskId ? { id: t.id, depends_on: patch.depends_on } : t));
    const c = cycleCheck(all);
    if (c) throw fail(`dependency cycle: ${c.join(' -> ')}`);
  }
  return store.update(home, 'task', taskId, (t) => {
    for (const k of Object.keys(patch)) t[k] = k === 'acceptance_criteria' ? normAcs(patch[k]) : patch[k];
    if (patch.acceptance_criteria) t.ac_version = (t.ac_version || 1) + 1;
  });
}

export function retryTask(home, taskId, { reason = 'retry requested' } = {}) {
  const t = store.mustGet(home, 'task', taskId);
  const from = t.status;
  if (!['failed', 'blocked', 'deferred', 'paused', 'changes_requested'].includes(from)) throw fail(`${taskId} is ${from}; only failed, blocked, deferred, paused or changes_requested tasks retry`);
  return move(home, taskId, 'ready', { actor: 'human', reason, data: (x) => { if (from === 'failed') x.attempts = 0; x.blocked = null; } });
}

export function cancelTask(home, taskId, reason = 'cancelled') {
  const t = store.mustGet(home, 'task', taskId);
  if (['done', 'cancelled'].includes(t.status)) return t;
  return store.update(home, 'task', taskId, (x) => { x.status = 'cancelled'; x.status_reason = reason; });
}

export function pauseTask(home, taskId, reason = 'paused by user') {
  const t = store.mustGet(home, 'task', taskId);
  if (t.status === 'paused') return t;
  return move(home, taskId, 'paused', { actor: 'human', reason, data: (x) => { x.paused_from = t.status; } });
}

export function answerTask(home, taskId, questionId, text, { by = 'human' } = {}) {
  const t = store.mustGet(home, 'task', taskId);
  const rec = store.update(home, 'task', taskId, (x) => {
    x.answers.push({ question_id: questionId || null, text, by, at: nowIso() });
  });
  emit(home, { type: 'msg.answer', goal_id: t.goal_id, task_id: taskId, msg: `${taskId} answer ${questionId || ''}`.trim(), data: { from: { role: by === 'human' ? 'user' : by }, to: { role: t.role } } });
  if (t.status === 'blocked' && (!questionId || !t.blocked || !t.blocked.question_id || t.blocked.question_id === questionId)) {
    return move(home, taskId, 'ready', { actor: 'human', reason: 'question answered', data: { blocked: null } });
  }
  return rec;
}

export function noteTask(home, taskId, text, { by = 'human' } = {}) {
  const t = store.mustGet(home, 'task', taskId);
  return store.update(home, 'task', taskId, (x) => { x.feedback.push({ source: 'note', ref: by, path: null, text, at: nowIso() }); void t; });
}

export function escalate(home, task, reason, { ref_path = null } = {}) {
  const open = store.list(home, 'task', (t) => t.kind === 'escalation' && t.subject_task_id === task.id && !['done', 'cancelled', 'failed'].includes(t.status));
  if (open.length) return open[0];
  const esc = createTask(home, {
    goal_id: task.goal_id, epic_id: task.epic_id, kind: 'escalation', role: 'cto', status: 'ready',
    title: `Escalation: ${task.id} ${reason}`.slice(0, 80),
    description: `Task ${task.id} (${task.kind}, ${task.role}) needs a decision: ${reason}. Decide with the CLI (task retry, task replan, task new, task cancel).`.slice(0, 1200),
    subject_task_id: task.id, feedback: ref_path ? [{ source: 'escalation', ref: task.id, path: ref_path, at: nowIso() }] : [],
  });
  emit(home, { type: 'msg.escalation', goal_id: task.goal_id, task_id: esc.id, msg: `${task.id} escalated: ${reason}`.slice(0, 140), data: { from: { role: task.role }, to: { role: 'cto' }, ref_path } });
  return esc;
}
