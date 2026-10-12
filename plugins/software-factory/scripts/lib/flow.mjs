// Flow engine (contracts §5): deterministic, idempotent rules run by `tick plan` and `collect`.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ensureDir, nowIso } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { move, setGoalStatus, setEpicStatus } from './lifecycle.mjs';
import { createTask, escalate, goalDocsRel, tasksOf, setGoalPaused, reviewsFor } from './actions.mjs';
import { GATE_KINDS } from './roles.mjs';
import * as repos from './repos.mjs';
import * as deps from './deps.mjs';
import * as budget from './budget.mjs';

const OPEN = (t) => !['done', 'cancelled'].includes(t.status);
const DONE = (t) => t && t.status === 'done';

// ---------------- reviews ----------------
export function reviewRound(task) { return (task.rework_count || 0) + 1; }

/** {state: pending|pass|fail|escalate, group, missing[]} for the current round. */
export function reviewState(task) {
  const round = reviewRound(task);
  const groups = task.reviews_required || [];
  for (let i = 0; i < groups.length; i++) {
    const verdicts = groups[i].map((r) => {
      const v = task.reviews && task.reviews[r];
      return v && v.round === round ? v.verdict : null;
    });
    if (verdicts.includes('fail')) return { state: 'fail', group: i, missing: [] };
    if (verdicts.includes('escalate')) return { state: 'escalate', group: i, missing: [] };
    const missing = groups[i].filter((_r, j) => verdicts[j] !== 'pass');
    if (missing.length) return { state: 'pending', group: i, missing };
  }
  return { state: 'pass', group: groups.length, missing: [] };
}

// ---------------- gates ----------------
function gateArtifact(home, task, goal) {
  const rel = goalDocsRel(goal);
  const paths = { prd: [`${rel}/prd.md`], spec: [`${rel}/spec.md`], mockup: [`${rel}/design/`] }[task.kind] || [];
  return { paths, summary: `${task.title}. ${task.description || ''}`.slice(0, 600) };
}

function gateEnabled(cfg, goal, type) {
  const g = cfg.gates && cfg.gates[type];
  if (goal && goal.gate_policy && goal.gate_policy[type] === 'auto') return false;
  return !g || g.enabled !== false;
}

/** Open the gate a task produces. Disabled gates are auto-approved and applied at once. */
export async function openGateForTask(home, taskId, { cfg = loadConfig(home), runId = null } = {}) {
  const task = store.mustGet(home, 'task', taskId);
  const goal = store.mustGet(home, 'goal', task.goal_id);
  const type = task.gate;
  if (!type) return null;
  if (task.gate_id) {
    const cur = store.get(home, 'gate', task.gate_id);
    if (cur && ['pending', 'approved'].includes(cur.status)) return cur;
  }
  const enabled = gateEnabled(cfg, goal, type);
  const gate = store.create(home, 'gate', {
    type, subject: { kind: 'task', id: task.id }, goal_id: goal.id, status: enabled ? 'pending' : 'approved',
    opened_at: nowIso(), opened_by: { run_id: runId, actor: 'factory' }, artifact: gateArtifact(home, task, goal),
    request: {}, auto: !enabled,
    decision: enabled ? null : { by: 'factory', via: 'cli', at: nowIso(), notes: `${type} disabled in config` },
  });
  store.update(home, 'task', task.id, (t) => { t.gate_id = gate.id; });
  store.update(home, 'goal', goal.id, (g) => { g.gates = { ...(g.gates || {}), [type]: gate.id }; });
  emit(home, { type: 'gate.opened', goal_id: goal.id, task_id: task.id, msg: `${gate.id} ${type} for ${task.id}${enabled ? '' : ' (auto)'}`, data: { gate_id: gate.id, type, auto: !enabled } });
  if (enabled) {
    emit(home, { type: 'msg.approval_request', goal_id: goal.id, task_id: task.id, msg: `${type} waits for approval`, data: { from: { role: 'cto' }, to: { role: 'user' }, ref_path: gate.artifact.paths[0] || null } });
    if (type === 'G1' && ['planning', 'draft'].includes(goal.status)) setGoalStatus(home, goal.id, 'awaiting_g1', 'G1 open');
  } else {
    await onGateDecided(home, gate, { cfg });
  }
  return store.get(home, 'gate', gate.id);
}

/** Record a decision and apply it. */
export async function decideGate(home, gateId, { decision, by = 'human', via = 'cli', notes = '', add_tokens } = {}) {
  const map = { approve: 'approved', changes: 'changes_requested', reject: 'rejected' };
  if (!map[decision]) { const e = new Error('--decision must be approve|changes|reject'); e.exitCode = 2; throw e; }
  const cur = store.mustGet(home, 'gate', gateId);
  if (cur.status !== 'pending') { const e = new Error(`${gateId} is ${cur.status}, not pending`); e.exitCode = 1; throw e; }
  if (cur.type === 'budget' && decision === 'approve') {
    const add = Number(add_tokens) || cur.request.add_tokens_suggested || 0;
    budget.override(home, cur.goal_id, add, { by, via, note: notes });
    return store.get(home, 'gate', gateId);
  }
  const gate = store.update(home, 'gate', gateId, (g) => {
    g.status = map[decision];
    g.decision = { by, via, at: nowIso(), notes: notes || '', ...(add_tokens ? { add_tokens: Number(add_tokens) } : {}) };
  });
  emit(home, { type: 'gate.decided', goal_id: gate.goal_id, actor: { kind: 'human' }, msg: `${gateId} ${gate.type} ${decision}`, data: { gate_id: gateId, decision, via } });
  emit(home, { type: 'msg.approval_result', goal_id: gate.goal_id, msg: `${gate.type} ${decision}`, data: { from: { role: 'user' }, to: { role: 'cto' } } });
  await onGateDecided(home, gate);
  return store.get(home, 'gate', gateId);
}

export async function onGateDecided(home, gate, { cfg = loadConfig(home) } = {}) {
  const status = gate.status;
  if (['G1', 'G2', 'G3'].includes(gate.type)) {
    const task = store.get(home, 'task', gate.subject.id);
    if (!task) return;
    if (status === 'approved') {
      if (task.status === 'awaiting_approval') move(home, task.id, 'done', { reason: `${gate.type} approved` });
      const goal = store.get(home, 'goal', task.goal_id);
      const docKey = { prd: 'prd', spec: 'spec', mockup: 'design' }[task.kind];
      if (docKey) store.update(home, 'goal', goal.id, (g) => { g.docs[docKey] = gateArtifact(home, task, goal).paths[0]; });
    } else if (status === 'changes_requested') {
      if (task.status === 'awaiting_approval') {
        move(home, task.id, 'changes_requested', {
          reason: `${gate.type} changes requested`,
          data: (t) => {
            t.rework_count += 1; t.gate_id = null;
            t.feedback.push({ source: 'gate', ref: gate.id, path: null, text: (gate.decision && gate.decision.notes) || '', at: nowIso() });
          },
        });
      }
    } else if (status === 'rejected') {
      store.update(home, 'task', task.id, (t) => { t.status = 'cancelled'; t.status_reason = `${gate.type} rejected`; });
      setGoalPaused(home, task.goal_id, true, `${gate.type} rejected; replan needed`);
    }
    await advanceGoal(home, task.goal_id, { cfg });
  } else if (gate.type === 'G4' && status === 'approved' && gate.subject && gate.subject.kind === 'epic') {
    // The human approved the merge: check for it now instead of waiting for the 5-minute poll.
    const epic = store.get(home, 'epic', gate.subject.id);
    if (epic && epic.status === 'pr_open') {
      try { await pollPr(home, epic.id, { cfg, force: true }); } catch (e) { emit(home, { type: 'pr.updated', epic_id: epic.id, msg: `merge check failed: ${e.message}`.slice(0, 140) }); }
    }
  } else if (gate.type === 'budget' && status === 'rejected') {
    setGoalPaused(home, gate.goal_id, true, 'budget increase rejected');
  } else if (gate.type === 'destructive' && status === 'approved' && gate.request && gate.request.action === 'discard_goal_branches') {
    const wt = await deps.load('worktree');
    for (const r of repos.list(home, cfg)) {
      try { wt.pruneBranches({ repoRoot: r.path, branches: gate.request.impact || [] }); } catch (e) { emit(home, { type: 'gate.decided', msg: `prune failed in ${r.name}: ${e.message}`.slice(0, 140) }); }
    }
  } else if (gate.type === 'tracker' && status === 'approved' && gate.request && gate.request.original) {
    const inbox = await import('./inbox.mjs');
    const by = (gate.decision && gate.decision.by) || 'human';
    await inbox.applyRequest(home, { ...gate.request.original, needs_confirmation: false, actor: { kind: 'tracker', ...(gate.request.original.actor || {}), name: by } }, { via: 'gate' });
  }
}

// ---------------- task completion paths ----------------
/** Where a task goes after its reviews pass (or when it has none). */
export async function afterReviews(home, taskId, { cfg = loadConfig(home), runId = null } = {}) {
  const task = store.mustGet(home, 'task', taskId);
  const goal = store.get(home, 'goal', task.goal_id);
  if (task.kind === 'code' || task.kind === 'docs') {
    return move(home, task.id, 'verified', { reason: 'reviews passed' });
  }
  if (task.gate) {
    move(home, task.id, 'awaiting_approval', { reason: `waiting for ${task.gate}` });
    if (goal && goal.tier === 'S' && (task.kind === 'prd' || task.kind === 'spec')) {
      await advanceGoal(home, goal.id, { cfg }); // tier S opens G1 + G2 together
    } else {
      await openGateForTask(home, task.id, { cfg, runId });
    }
    return store.get(home, 'task', task.id);
  }
  move(home, task.id, 'done', { reason: 'handed off' });
  await onTaskDone(home, store.get(home, 'task', task.id), { cfg });
  return store.get(home, 'task', task.id);
}

/** Start review for a task (or skip straight to afterReviews). */
export async function toReviewOrNext(home, taskId, opts = {}) {
  const task = store.mustGet(home, 'task', taskId);
  if ((task.reviews_required || []).length) {
    const t = move(home, task.id, 'in_review', { reason: `review round ${reviewRound(task)}` });
    emit(home, { type: 'msg.review_request', goal_id: t.goal_id, task_id: t.id, msg: `${t.id} ready for review`, data: { from: { role: t.role }, to: { role: (t.reviews_required[0] || []).join('+') } } });
    return t;
  }
  return afterReviews(home, taskId, opts);
}

export async function onTaskDone(home, task, { cfg = loadConfig(home) } = {}) {
  await advanceGoal(home, task.goal_id, { cfg });
}

/** Apply a review verdict for the current round, then re-evaluate the task. */
export async function applyReviewVerdict(home, taskId, role, verdict, { runId, reportPath = null, findings = [], cfg = loadConfig(home) } = {}) {
  const t0 = store.mustGet(home, 'task', taskId);
  const round = reviewRound(t0);
  store.update(home, 'task', taskId, (t) => {
    t.reviews = { ...(t.reviews || {}), [role]: { verdict, run_id: runId, round, at: nowIso() } };
    if (reportPath) t.feedback.push({ source: role, ref: runId, path: reportPath, at: nowIso() });
    if (findings.length) {
      t.findings = [...(t.findings || []), ...findings.map((f) => ({ ...f, run_id: runId, role, round }))];
    }
  });
  emit(home, { type: 'msg.review_result', goal_id: t0.goal_id, task_id: taskId, run_id: runId, msg: `${taskId} ${role} ${verdict}`, data: { from: { role, run_id: runId }, to: { role: 'cto' }, ref_path: reportPath } });
  const task = store.get(home, 'task', taskId);
  if (task.status !== 'in_review') return task;
  const st = reviewState(task);
  if (st.state === 'fail') return requestChanges(home, taskId, `${role} found problems`, { cfg });
  if (st.state === 'escalate') {
    move(home, taskId, 'blocked', { reason: `${role} escalated`, data: { blocked: { reason: `${role} escalated`, question_id: null, needs: 'cto', since: nowIso() } } });
    escalate(home, task, `${role} escalated the review`, { ref_path: reportPath });
    return store.get(home, 'task', taskId);
  }
  if (st.state === 'pass') return afterReviews(home, taskId, { cfg, runId });
  return task;
}

export async function requestChanges(home, taskId, reason, { cfg = loadConfig(home), feedback = null } = {}) {
  const t = move(home, taskId, 'changes_requested', {
    reason,
    data: (x) => { x.rework_count += 1; if (feedback) x.feedback.push({ ...feedback, at: nowIso() }); },
  });
  emit(home, { type: 'msg.rework', goal_id: t.goal_id, task_id: t.id, msg: `${t.id} rework: ${reason}`.slice(0, 140), data: { from: { role: 'cto' }, to: { role: t.role } } });
  void cfg;
  return t;
}

/** Retry or fail a task after a failed attempt. */
export function failAttempt(home, taskId, reason) {
  const t = store.mustGet(home, 'task', taskId);
  if (t.attempts >= t.max_attempts) {
    const f = move(home, taskId, 'failed', { reason: `${reason} (attempt ${t.attempts}/${t.max_attempts})` });
    escalate(home, f, `failed after ${t.attempts} attempts: ${reason}`);
    return f;
  }
  return move(home, taskId, 'ready', { reason: `retry: ${reason}` });
}

// ---------------- goal rules ----------------
function byKind(tasks, kind) { return tasks.filter((t) => t.kind === kind && t.status !== 'cancelled'); }
function latest(tasks, kind) { const l = byKind(tasks, kind); return l[l.length - 1] || null; }

function gateApproved(home, goal, type) {
  const id = goal.gates && goal.gates[type];
  const g = id ? store.get(home, 'gate', id) : null;
  return !!(g && g.status === 'approved');
}

function depsSatisfied(home, task, goal) {
  for (const d of task.depends_on || []) {
    const dt = store.get(home, 'task', d);
    if (!dt) return false;
    if (dt.kind === 'code' || dt.kind === 'docs') { if (!['integrated', 'done'].includes(dt.status)) return false; } else if (dt.status !== 'done') return false;
  }
  for (const g of task.gate_deps || []) {
    if (g === 'G3' && goal.needs_ui === false) continue;
    if (!gateApproved(home, goal, g)) return false;
  }
  return true;
}

export async function advanceGoal(home, goalId, { cfg = loadConfig(home) } = {}) {
  let goal = store.get(home, 'goal', goalId);
  if (!goal || ['done', 'cancelled', 'paused'].includes(goal.status)) return;
  let tasks = tasksOf(home, goalId);
  const docs = goalDocsRel(goal);

  // R1 intake
  if (!byKind(tasks, 'intake').length) {
    createTask(home, { goal_id: goalId, kind: 'intake', title: `Intake: ${goal.title}`.slice(0, 80), status: 'ready' });
    return;
  }
  const intake = latest(tasks, 'intake');
  // R2 prd after intake
  if (DONE(intake) && !byKind(tasks, 'prd').length) {
    if (!goal.tier) goal = store.update(home, 'goal', goalId, (g) => { g.tier = 'M'; g.status_reason = 'tier defaulted to M'; });
    if (!goal.budget.user_set && goal.budget.limit_tokens !== cfg.budget.tier_defaults[goal.tier]) {
      goal = store.update(home, 'goal', goalId, (g) => { g.budget.limit_tokens = cfg.budget.tier_defaults[g.tier]; });
    }
    createTask(home, {
      goal_id: goalId, kind: 'prd', gate: 'G1', status: 'ready', title: `PRD: ${goal.title}`.slice(0, 80),
      description: `Write the PRD at ${docs}/prd.md for: ${goal.outcome}`.slice(0, 1200),
      acceptance_criteria: goal.success_criteria.slice(0, 5),
    });
    tasks = tasksOf(home, goalId);
  }
  const prd = latest(tasks, 'prd');
  let spec = latest(tasks, 'spec');
  const newSpec = () => createTask(home, {
    goal_id: goalId, kind: 'spec', gate: 'G2', status: 'ready', title: `Spec: ${goal.title}`.slice(0, 80),
    description: `Write the technical spec (with a Data section) at ${docs}/spec.md from ${docs}/prd.md.`,
    acceptance_criteria: goal.success_criteria.slice(0, 5),
  });
  // Tier S: spec right after prd hands off; G1 + G2 open together
  if (goal.tier === 'S' && prd && prd.status === 'awaiting_approval' && !spec) { spec = newSpec(); tasks = tasksOf(home, goalId); }
  {
    // Tier S presents G1 and G2 together: hold each until the other is also awaiting (or done).
    const settled = (t) => !!t && ['awaiting_approval', 'done'].includes(store.get(home, 'task', t.id).status);
    for (const t of tasks.filter((x) => x.status === 'awaiting_approval' && x.gate && !x.gate_id)) {
      if (goal.tier === 'S' && t.kind === 'prd' && !settled(spec)) continue;
      if (goal.tier === 'S' && t.kind === 'spec' && !settled(prd)) continue;
      await openGateForTask(home, t.id, { cfg });
    }
    goal = store.get(home, 'goal', goalId); tasks = tasksOf(home, goalId);
  }
  goal = store.get(home, 'goal', goalId);
  if (!goal || ['done', 'cancelled', 'paused'].includes(goal.status)) return;
  // R4 G1 approved -> active, spec
  if (DONE(store.get(home, 'task', prd && prd.id)) && gateApproved(home, goal, 'G1')) {
    if (['planning', 'awaiting_g1', 'draft'].includes(goal.status)) goal = setGoalStatus(home, goalId, 'active', 'G1 approved');
    if (!spec) { spec = newSpec(); tasks = tasksOf(home, goalId); }
  }
  spec = spec && store.get(home, 'task', spec.id);
  // R5 G2 approved (and G1) -> breakdown (+ mockup)
  if (DONE(spec) && gateApproved(home, goal, 'G2') && gateApproved(home, goal, 'G1')) {
    if (!byKind(tasks, 'breakdown').length) {
      createTask(home, {
        goal_id: goalId, kind: 'breakdown', status: 'ready', title: `Breakdown: ${goal.title}`.slice(0, 80),
        description: `Create epics (epic new) and code tasks (task new --file) from ${docs}/spec.md. Copy spec risk flags onto code tasks.`,
      });
    }
    if (goal.needs_ui && !byKind(tasks, 'mockup').length) {
      createTask(home, {
        goal_id: goalId, kind: 'mockup', gate: 'G3', status: 'ready', title: `Mockups: ${goal.title}`.slice(0, 80),
        description: `Design the UI in ${docs}/design/ from the PRD and spec.`,
      });
    }
    tasks = tasksOf(home, goalId);
  }
  // R6 breakdown -> sequence -> backlog
  const breakdown = latest(tasks, 'breakdown');
  if (DONE(breakdown) && !byKind(tasks, 'sequence').length) {
    createTask(home, {
      goal_id: goalId, kind: 'sequence', status: 'ready', title: `Sequence: ${goal.title}`.slice(0, 80),
      description: `Set depends_on and estimates with task replan; write ${docs}/plan.md.`,
    });
    tasks = tasksOf(home, goalId);
  }
  const sequence = latest(tasks, 'sequence');
  if (DONE(sequence)) {
    for (const t of tasks.filter((x) => x.status === 'draft' && (x.kind === 'code' || x.kind === 'docs'))) {
      move(home, t.id, 'backlog', {
        reason: 'sequenced',
        data: (x) => { if (goal.needs_ui && x.role === 'frontend-engineer' && !x.gate_deps.includes('G3')) x.gate_deps.push('G3'); },
      });
    }
    for (const e of store.list(home, 'epic', (x) => x.goal_id === goalId && x.status === 'draft')) {
      await ensureEpicBranch(home, e, cfg);
      setEpicStatus(home, e.id, 'building');
    }
    tasks = tasksOf(home, goalId);
  }
  // R7 backlog -> ready; changes_requested -> ready (rework) or escalate
  for (const t of tasks) {
    if (t.status === 'backlog' && depsSatisfied(home, t, goal)) move(home, t.id, 'ready', { reason: 'dependencies met' });
    else if (t.status === 'changes_requested') {
      if (t.rework_count > t.max_rework) {
        const b = move(home, t.id, 'blocked', { reason: 'rework limit reached', data: { blocked: { reason: 'rework limit reached', question_id: null, needs: 'cto', since: nowIso() } } });
        escalate(home, b, `rework limit (${t.max_rework}) reached`);
      } else {
        move(home, t.id, 'ready', { reason: 'rework', data: (x) => { x.pending_kind = x.pending_kind === 'integrate' ? 'integrate' : 'rework'; x.gate_id = null; } });
      }
    }
  }
  // epics
  for (const e of store.list(home, 'epic', (x) => x.goal_id === goalId && !['done', 'cancelled'].includes(x.status))) {
    await advanceEpic(home, e.id, { cfg });
  }
  await advanceGoalQa(home, goalId, { cfg });
  // R12 goal done
  goal = store.get(home, 'goal', goalId);
  const epics = store.list(home, 'epic', (x) => x.goal_id === goalId && x.status !== 'cancelled');
  if (goal.status === 'active' && epics.length && epics.every((x) => x.status === 'done')) {
    for (const t of tasksOf(home, goalId).filter(OPEN)) {
      if (['intake', 'prd', 'spec', 'mockup', 'breakdown', 'sequence'].includes(t.kind)) continue;
      if (t.status === 'integrated') move(home, t.id, 'done', { reason: 'goal done' });
    }
    setGoalStatus(home, goalId, 'done', 'all epics merged');
  }
}

// ---------------- cross-repo goal QA (contracts §20.6) ----------------
function liveEpics(home, goalId) { return store.list(home, 'epic', (x) => x.goal_id === goalId && x.status !== 'cancelled'); }

/** True when the goal's non-cancelled epics live in two or more repos. */
export function goalSpansRepos(home, goalId, cfg = loadConfig(home)) {
  return new Set(liveEpics(home, goalId).map((e) => repos.nameFor(home, cfg, { epic: e }))).size >= 2;
}

/**
 * Cross-repo QA (§20.6). Epics that still need delivery are those not pr_open, done, changes_requested or
 * cancelled. When all of them wait in goal_qa, one qa_goal task is made; its pass opens a PR for every
 * waiting epic. After a failed (or escalated) qa_goal, a new one is made once every pending epic is back
 * in goal_qa and at least one of them re-entered goal_qa after that QA was created (`epic.goal_qa_at`).
 * Epics that got no rework never leave goal_qa, so they do not have to re-enter. A goal that no longer
 * spans two repos (e.g. the other repo's epic was cancelled) sends waiting epics straight to their PR.
 */
async function advanceGoalQa(home, goalId, { cfg }) {
  const epics = liveEpics(home, goalId);
  const waiting = epics.filter((e) => e.status === 'goal_qa');
  if (!waiting.length) return;
  const openPrs = async (qa) => {
    for (const e of waiting) { // also retries an epic whose PR failed to open last time
      try { await createPr(home, e.id, { cfg, goalQa: qa }); } catch (err) {
        emit(home, { type: 'pr.updated', goal_id: goalId, epic_id: e.id, msg: `pr create failed: ${err.message}`.slice(0, 140) });
      }
    }
  };
  if (!goalSpansRepos(home, goalId, cfg)) { await openPrs(null); return; }
  const goal = store.get(home, 'goal', goalId);
  const pending = epics.filter((e) => !['pr_open', 'done', 'changes_requested'].includes(e.status));
  const qa = latest(tasksOf(home, goalId), 'qa_goal');
  const enteredAt = waiting.reduce((m, e) => (String(e.goal_qa_at || '') > m ? String(e.goal_qa_at || '') : m), '');
  const current = !!qa && String(qa.created_at) >= enteredAt;
  if (current && qa.status === 'done' && qa.verdict === 'pass') { await openPrs(qa); return; }
  if (waiting.length !== pending.length) return;
  if (qa && OPEN(qa) && qa.status !== 'failed') return;
  if (current) return; // failed or escalated: wait until rework brings an epic back through goal_qa
  const docs = goalDocsRel(goal);
  createTask(home, {
    goal_id: goalId, epic_id: null, repo: null, kind: 'qa_goal', status: 'ready',
    title: `Cross-repo QA for ${goalId}`,
    description: `Test the joined flow across ${waiting.map((e) => `${e.id} (${repos.nameFor(home, cfg, { epic: e })}, ${e.branch})`).join(', ')} against the goal's success criteria. Report at ${docs}/qa/${goalId}-goal.md.`.slice(0, 1200),
    acceptance_criteria: goal.success_criteria.slice(0, 5),
  });
}

// ---------------- epic rules ----------------
function epicRepo(home, cfg, epic) { return repos.forRecord(home, cfg, { epic }); }

async function baseRef(home, cfg, epic) {
  const git = await deps.load('git');
  const repo = epicRepo(home, cfg, epic);
  const base = repo.delivery.base_branch;
  const remoteRef = `${repo.delivery.remote}/${base}`;
  try {
    if (repo.delivery.mode !== 'local' && git.headSha(repo.path, `refs/remotes/${remoteRef}`)) return remoteRef;
  } catch { /* fall through */ }
  return base;
}

export async function ensureEpicBranch(home, epic, cfg = loadConfig(home)) {
  const git = await deps.load('git');
  try {
    const root = epicRepo(home, cfg, epic).path;
    if (git.branchExists(root, epic.branch)) return true;
    const ref = await baseRef(home, cfg, epic);
    const r = git.git(['branch', epic.branch, ref], { cwd: root });
    return r.code === 0;
  } catch (e) {
    emit(home, { type: 'epic.status', epic_id: epic.id, goal_id: epic.goal_id, msg: `epic branch failed: ${e.message}`.slice(0, 140) });
    return false;
  }
}

function epicTasks(home, epicId) { return store.list(home, 'task', (t) => t.epic_id === epicId && t.status !== 'cancelled'); }

/** Merge verified task branches whose code deps are integrated. */
export async function integrateEpic(home, epicId, { cfg = loadConfig(home) } = {}) {
  const epic = store.mustGet(home, 'epic', epicId);
  const tasks = epicTasks(home, epicId);
  const ready = tasks.filter((t) => t.status === 'verified' && !t.pending_kind && t.branch
    && (t.depends_on || []).every((d) => { const dt = store.get(home, 'task', d); return dt && (dt.epic_id !== epicId || ['integrated', 'done'].includes(dt.status)); }));
  if (!ready.length) return { merged: [], conflict: null };
  // dependency order inside the batch
  const ids = new Set(ready.map((t) => t.id));
  const ordered = []; const seen = new Set();
  const visit = (t) => { if (seen.has(t.id)) return; seen.add(t.id); for (const d of t.depends_on || []) if (ids.has(d)) visit(ready.find((x) => x.id === d)); ordered.push(t); };
  ready.forEach(visit);
  await ensureEpicBranch(home, epic, cfg);
  const integ = await deps.load('integrate');
  const repo = epicRepo(home, cfg, epic);
  const res = integ.mergeTasks({
    repoRoot: repo.path, home, epicBranch: epic.branch, baseRef: await baseRef(home, cfg, epic),
    taskBranches: ordered.map((t) => t.branch), postMerge: repo.checks.post_merge || [],
  });
  const merged = new Set(res.merged || []);
  for (const t of ordered.filter((x) => merged.has(x.branch))) move(home, t.id, 'integrated', { reason: `merged into ${epic.branch}` });
  if (res.conflict) {
    const t = ordered.find((x) => x.branch === res.conflict.branch);
    if (t) {
      move(home, t.id, 'ready', {
        reason: 'merge conflict with the epic branch',
        data: (x) => { x.pending_kind = 'integrate'; x.conflict_files = res.conflict.files || []; },
      });
    }
  }
  if (res.post_merge && res.post_merge.status === 'fail') {
    const exists = epicTasks(home, epicId).some((x) => x.kind === 'code' && x.role === 'devops-release' && OPEN(x) && /post-merge/.test(x.title));
    if (!exists) {
      createTask(home, {
        goal_id: epic.goal_id, epic_id: epicId, kind: 'code', role: 'devops-release', status: 'ready', size: 'S',
        title: `Fix post-merge checks on ${epicId}`, description: `Post-merge check failed: ${res.post_merge.failed_command}`.slice(0, 1200),
        acceptance_criteria: [`\`${res.post_merge.failed_command}\` passes on ${epic.branch}`], files_owned: ['**'],
      });
    }
  }
  if (res.head_sha) store.update(home, 'epic', epicId, (e) => { e.head_sha = res.head_sha; });
  return res;
}

export async function advanceEpic(home, epicId, { cfg = loadConfig(home), forcePoll = false } = {}) {
  let epic = store.get(home, 'epic', epicId);
  if (!epic) return;
  const goal = store.get(home, 'goal', epic.goal_id);
  const docs = goalDocsRel(goal);
  const tasks = () => epicTasks(home, epicId);
  const codeTasks = () => tasks().filter((t) => t.kind === 'code');
  const openEsc = () => tasks().some((t) => t.kind === 'escalation' && OPEN(t) && t.status !== 'failed');
  const multi = goalSpansRepos(home, epic.goal_id, cfg);

  // §20.6.7: rework code tasks added to an epic that waits in goal_qa send it back to building.
  if (epic.status === 'goal_qa' && codeTasks().some((t) => !['integrated', 'done'].includes(t.status))) {
    epic = setEpicStatus(home, epicId, 'building', 'rework after cross-repo QA');
  }

  if (['building', 'docs', 'changes_requested', 'integrating'].includes(epic.status)) {
    try { await integrateEpic(home, epicId, { cfg }); } catch (e) {
      emit(home, { type: 'epic.status', epic_id: epicId, goal_id: epic.goal_id, msg: `integrate failed: ${e.message}`.slice(0, 140) });
    }
    epic = store.get(home, 'epic', epicId);
  }
  const allIntegrated = () => { const c = codeTasks(); return c.length > 0 && c.every((t) => ['integrated', 'done'].includes(t.status)); };

  if (epic.status === 'building' && allIntegrated() && !openEsc()) {
    setEpicStatus(home, epicId, 'qa');
    createTask(home, {
      goal_id: epic.goal_id, epic_id: epicId, kind: 'qa_epic', status: 'ready', title: `QA ${epicId}: ${epic.title}`.slice(0, 80),
      description: `Test the integrated branch ${epic.branch} against the goal criteria. Report at ${docs}/qa/${epicId}.md.`,
    });
    epic = store.get(home, 'epic', epicId);
  }
  if (epic.status === 'qa') {
    const qa = latest(tasks(), 'qa_epic');
    if (qa && qa.status === 'done' && qa.verdict === 'pass') {
      setEpicStatus(home, epicId, 'review');
      createTask(home, {
        goal_id: epic.goal_id, epic_id: epicId, kind: 'review_epic', status: 'ready', model_override: 'opus',
        title: `Review ${epicId}: ${epic.title}`.slice(0, 80),
        description: `Review the whole diff of ${epic.branch}. Report at ${docs}/reviews/${epicId}.md.`,
      });
      epic = store.get(home, 'epic', epicId);
    }
  }
  if (epic.status === 'review') {
    const rv = latest(tasks(), 'review_epic');
    // Cross-repo rework: keep the docs task that is already integrated (§20.6.7).
    const docsDone = multi && tasks().some((t) => t.kind === 'docs' && ['integrated', 'done'].includes(t.status));
    if (rv && rv.status === 'done' && rv.verdict === 'pass' && docsDone) {
      epic = setEpicStatus(home, epicId, 'docs', 'docs already written');
    } else if (rv && rv.status === 'done' && rv.verdict === 'pass') {
      setEpicStatus(home, epicId, 'docs');
      createTask(home, {
        goal_id: epic.goal_id, epic_id: epicId, kind: 'docs', status: 'ready', size: 'S',
        title: `Docs ${epicId}: ${epic.title}`.slice(0, 80),
        description: `Update user and developer docs for ${epicId}. Write release notes at ${docs}/release-notes.md.`,
        acceptance_criteria: ['Docs describe the new behavior', 'Release notes written'],
        files_owned: ['docs/**', '**/*.md'],
      });
      epic = store.get(home, 'epic', epicId);
    }
  }
  if (epic.status === 'docs') {
    const d = latest(tasks(), 'docs');
    if (d && ['integrated', 'done'].includes(d.status)) {
      // A goal across repos waits for cross-repo QA before any PR (§20.6.2).
      if (multi) setEpicStatus(home, epicId, 'goal_qa', 'waiting for cross-repo QA', (x) => { x.goal_qa_at = nowIso(); });
      else await createPr(home, epicId, { cfg });
      epic = store.get(home, 'epic', epicId);
    }
  }
  if (epic.status === 'changes_requested') {
    const fb = latest(tasks(), 'pr_feedback');
    if (fb && fb.status === 'done' && allIntegrated() && !openEsc()) {
      const gh = await deps.load('gh');
      const repo = epicRepo(home, cfg, epic);
      if (repo.delivery.mode !== 'local') gh.push({ cwd: repo.path, remote: repo.delivery.remote, branch: epic.branch });
      setEpicStatus(home, epicId, 'pr_open', 'feedback addressed');
      emit(home, { type: 'pr.updated', goal_id: epic.goal_id, epic_id: epicId, msg: `${epicId} PR updated` });
    }
  }
  if (store.get(home, 'epic', epicId).status === 'pr_open') await pollPr(home, epicId, { cfg, force: forcePoll });
}

function prBody(home, epic, goal, cfg, goalQa = null) {
  const tasks = epicTasks(home, epic.id);
  const lines = [`## ${epic.id} ${epic.title}`, '', `Goal ${goal.id}: ${goal.outcome}`, '', '### Tasks', ''];
  for (const t of tasks.filter((x) => x.kind === 'code' || x.kind === 'docs')) {
    lines.push(`- ${t.id} ${t.title} (${t.status})`);
    for (const ac of t.acceptance_criteria) lines.push(`  - ${ac.id}: ${ac.text}`);
    const verdicts = Object.entries(t.reviews || {}).map(([r, v]) => `${r}: ${v.verdict}`).join(', ');
    if (verdicts) lines.push(`  - Reviews: ${verdicts}`);
    for (const w of t.waivers || []) lines.push(`  - Waived ${w.finding}: ${w.reason}`);
  }
  lines.push('', '### Success criteria', '', ...goal.success_criteria.map((c) => `- ${c}`));
  // §20.5: list the goal's epics in other repos (PR url when one exists).
  const mine = repos.nameFor(home, cfg, { epic });
  const others = liveEpics(home, goal.id).filter((e) => e.id !== epic.id && repos.nameFor(home, cfg, { epic: e }) !== mine);
  if (others.length) {
    lines.push('', '### Same goal, other repos', '');
    for (const e of others) lines.push(`- ${repos.nameFor(home, cfg, { epic: e })}: ${e.id} ${e.title}${e.pr && e.pr.url ? ` (${e.pr.url})` : ''}`);
  }
  if (goalQa) lines.push('', `Cross-repo QA ${goalQa.id} passed. Report: ${goalQa.report_path || `${goalDocsRel(goal)}/qa/${goal.id}-goal.md`}`);
  lines.push('', `Refs ${goal.id}, ${epic.id}`, '', 'Generated by software-factory. Rollback: revert the merge commit.');
  return lines.join('\n') + '\n';
}

export async function createPr(home, epicId, { cfg = loadConfig(home), goalQa = null } = {}) {
  const epic = store.mustGet(home, 'epic', epicId);
  const goal = store.mustGet(home, 'goal', epic.goal_id);
  const repo = epicRepo(home, cfg, epic);
  const root = repo.path;
  const git = await deps.load('git');
  let pr; let artifact;
  if (repo.delivery.mode === 'local') {
    const log = git.git(['log', '--oneline', `${epic.base_branch}..${epic.branch}`], { cwd: root });
    const stat = git.git(['diff', '--stat', `${epic.base_branch}...${epic.branch}`], { cwd: root });
    pr = { number: null, url: null, state: 'OPEN', head_sha: git.headSha(root, epic.branch), review_decision: null, mergeable: null, merged_at: null };
    artifact = { paths: [], summary: `Merge ${epic.branch} into ${epic.base_branch} locally.\n${(log.stdout || '').slice(0, 450)}`.slice(0, 600), diffstat: (stat.stdout || '').slice(-2000) };
  } else {
    const gh = await deps.load('gh');
    const push = gh.push({ cwd: root, remote: repo.delivery.remote, branch: epic.branch });
    if (push && push.ok === false) throw new Error(`push failed: ${push.stderr || ''}`.slice(0, 300));
    const bodyFile = join(home, 'run', `pr-body-${epicId}.md`);
    ensureDir(join(home, 'run'));
    writeFileSync(bodyFile, prBody(home, epic, goal, cfg, goalQa));
    const r = gh.prCreate({ cwd: root, base: epic.base_branch, head: epic.branch, title: `[factory] ${epicId} ${epic.title}`, bodyFile });
    pr = { number: r.number, url: r.url, state: 'OPEN', head_sha: git.headSha(root, epic.branch), review_decision: null, mergeable: null, merged_at: null };
    artifact = { paths: [], pr_url: r.url, summary: `PR for ${epicId}: ${epic.title}`.slice(0, 600) };
  }
  if (goalQa) {
    const note = ` Cross-repo QA ${goalQa.id} passed: ${goalQa.report_path || `${goalDocsRel(goal)}/qa/${goal.id}-goal.md`}.`;
    artifact.summary = `${artifact.summary.slice(0, Math.max(0, 600 - note.length))}${note}`.slice(0, 600);
    if (goalQa.report_path) artifact.paths = [...(artifact.paths || []), goalQa.report_path];
  }
  if (repos.isWorkspace(cfg)) artifact.summary = `[${repo.name}] ${artifact.summary}`.slice(0, 600);
  setEpicStatus(home, epicId, 'pr_open', null, (e) => { e.pr = pr; });
  emit(home, { type: 'pr.opened', goal_id: goal.id, epic_id: epicId, msg: `${epicId} PR ${pr.url || '(local)'}`, data: { url: pr.url, number: pr.number } });
  const enabled = gateEnabled(cfg, goal, 'G4');
  const gate = store.create(home, 'gate', {
    type: 'G4', subject: { kind: 'epic', id: epicId }, goal_id: goal.id, status: 'pending', opened_at: nowIso(),
    opened_by: { run_id: null, actor: 'factory' }, artifact, request: { action: 'merge' }, auto: !enabled,
  });
  store.update(home, 'epic', epicId, (e) => { e.gates = { ...(e.gates || {}), G4: gate.id }; });
  emit(home, { type: 'gate.opened', goal_id: goal.id, epic_id: epicId, msg: `${gate.id} G4 merge ${epicId}`, data: { gate_id: gate.id, type: 'G4' } });
  emit(home, { type: 'msg.approval_request', goal_id: goal.id, epic_id: epicId, msg: `G4: merge ${epicId}`, data: { from: { role: 'cto' }, to: { role: 'user' } } });
  return store.get(home, 'epic', epicId);
}

export async function pollPr(home, epicId, { cfg = loadConfig(home), force = false } = {}) {
  const epic = store.mustGet(home, 'epic', epicId);
  if (!epic.pr) return null;
  if (!force && epic.pr.polled_at && Date.now() - Date.parse(epic.pr.polled_at) < 300000) return null;
  const repo = epicRepo(home, cfg, epic);
  const root = repo.path;
  let merged = false; let view = null;
  if (repo.delivery.mode === 'local' || !epic.pr.number) {
    const git = await deps.load('git');
    const head = git.headSha(root, epic.branch) || epic.pr.head_sha;
    merged = !!head && git.isAncestor(root, head, epic.base_branch);
  } else {
    const gh = await deps.load('gh');
    view = gh.prView({ cwd: root, number: epic.pr.number });
    merged = String(view.state).toUpperCase() === 'MERGED' || !!view.mergedAt;
  }
  store.update(home, 'epic', epicId, (e) => {
    e.pr = { ...e.pr, polled_at: nowIso(), ...(view ? { state: view.state, review_decision: view.reviewDecision || null, mergeable: view.mergeable ?? null, head_sha: view.headRefOid || e.pr.head_sha, merged_at: view.mergedAt || null } : {}) };
  });
  if (merged) return markMerged(home, epicId, { cfg, via: view ? 'github' : 'cli' });
  if (view && String(view.reviewDecision).toUpperCase() === 'CHANGES_REQUESTED') {
    const sha = view.headRefOid;
    const handled = epicTasks(home, epicId).some((t) => t.kind === 'pr_feedback' && t.pr_head === sha);
    if (!handled) {
      setEpicStatus(home, epicId, 'changes_requested', 'PR changes requested');
      createTask(home, {
        goal_id: epic.goal_id, epic_id: epicId, kind: 'pr_feedback', status: 'ready', pr_head: sha,
        title: `PR feedback ${epicId}`, description: `Read the review on ${epic.pr.url} and create rework tasks (task new) in ${epicId}.`,
      });
      emit(home, { type: 'pr.updated', goal_id: epic.goal_id, epic_id: epicId, msg: `${epicId} PR changes requested` });
    }
  }
  return store.get(home, 'epic', epicId);
}

export async function markMerged(home, epicId, { cfg = loadConfig(home), via = 'github' } = {}) {
  const epic = store.mustGet(home, 'epic', epicId);
  const branches = [];
  for (const t of epicTasks(home, epicId).filter(OPEN)) {
    if (t.branch) branches.push(t.branch);
    if (['integrated', 'verified', 'done'].includes(t.status)) {
      if (t.status !== 'done') {
        try { move(home, t.id, 'done', { reason: 'epic PR merged' }); } catch { /* not in a movable state */ }
      }
    } else {
      store.update(home, 'task', t.id, (x) => { x.status = 'done'; x.status_reason = 'epic PR merged'; });
    }
  }
  setEpicStatus(home, epicId, 'done', 'PR merged', (e) => { e.pr = { ...(e.pr || {}), state: 'MERGED', merged_at: (e.pr && e.pr.merged_at) || nowIso() }; });
  const gid = epic.gates && epic.gates.G4;
  const gate = gid && store.get(home, 'gate', gid);
  if (gate && gate.status === 'pending') {
    store.update(home, 'gate', gid, (g) => { g.status = 'approved'; g.decision = { by: 'human', via, at: nowIso(), notes: 'merged' }; });
    emit(home, { type: 'gate.decided', goal_id: epic.goal_id, epic_id: epicId, msg: `${gid} G4 merged`, data: { gate_id: gid, decision: 'approve', via } });
  }
  emit(home, { type: 'pr.merged', goal_id: epic.goal_id, epic_id: epicId, msg: `${epicId} merged` });
  try {
    const wt = await deps.load('worktree');
    wt.pruneBranches({ repoRoot: epicRepo(home, cfg, epic).path, branches });
  } catch { /* best effort */ }
  await advanceGoal(home, epic.goal_id, { cfg });
  return store.get(home, 'epic', epicId);
}

/** Run every goal's rules. */
export async function advance(home, { cfg = loadConfig(home) } = {}) {
  for (const g of store.list(home, 'goal', (x) => !['done', 'cancelled'].includes(x.status))) {
    try { await advanceGoal(home, g.id, { cfg }); } catch (e) {
      emit(home, { type: 'goal.status', goal_id: g.id, msg: `flow error: ${e.message}`.slice(0, 140), data: { error: String(e.stack || e).slice(0, 1500) } });
    }
  }
}

export { reviewsFor };
