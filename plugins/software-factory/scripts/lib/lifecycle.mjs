// Task lifecycle: the transition table and the single move() entry point.
import * as store from './store.mjs';
import { emit } from './events.mjs';

export const TRANSITIONS = {
  draft: ['backlog', 'cancelled'],
  backlog: ['ready', 'draft', 'blocked', 'paused', 'cancelled'],
  ready: ['in_progress', 'backlog', 'blocked', 'paused', 'deferred', 'cancelled', 'failed'],
  in_progress: ['checking', 'in_review', 'verified', 'awaiting_approval', 'done', 'ready', 'changes_requested',
    'blocked', 'paused', 'deferred', 'failed', 'cancelled'],
  checking: ['in_review', 'verified', 'changes_requested', 'paused', 'failed', 'cancelled'],
  in_review: ['in_review', 'changes_requested', 'verified', 'awaiting_approval', 'done', 'blocked', 'paused', 'failed', 'cancelled'],
  changes_requested: ['ready', 'blocked', 'paused', 'failed', 'cancelled'],
  verified: ['integrated', 'changes_requested', 'ready', 'done', 'paused', 'cancelled'],
  integrated: ['done', 'changes_requested', 'cancelled'],
  awaiting_approval: ['done', 'changes_requested', 'in_review', 'cancelled', 'paused'],
  done: [],
  blocked: ['ready', 'backlog', 'paused', 'failed', 'cancelled'],
  paused: ['ready', 'backlog', 'blocked', 'cancelled'],
  deferred: ['ready', 'paused', 'cancelled'],
  failed: ['ready', 'cancelled'],
  cancelled: [],
};

/** Statuses only the flow engine may set (proof-backed). */
const FLOW_ONLY = new Set(['in_progress', 'checking', 'in_review', 'verified', 'integrated', 'awaiting_approval', 'done']);

export function canMove(task, to, actor = 'flow') {
  if (!task) return { ok: false, reason: 'task not found' };
  const from = task.status;
  if (!TRANSITIONS[from]) return { ok: false, reason: `unknown status ${from}` };
  if (!TRANSITIONS[to]) return { ok: false, reason: `unknown status ${to}` };
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: `${from} -> ${to} is not allowed` };
  if (actor !== 'flow' && FLOW_ONLY.has(to)) return { ok: false, reason: `only the flow engine sets ${to}` };
  return { ok: true, reason: null };
}

/**
 * Move a task. `data` may be a function(task) for extra field changes in the same write,
 * or an object merged into the record.
 */
export function move(home, taskId, to, { actor = 'flow', reason = null, data = null, source = 'cli', session_id } = {}) {
  let from = null;
  const rec = store.update(home, 'task', taskId, (t) => {
    const chk = canMove(t, to, actor);
    if (!chk.ok) {
      const e = new Error(`${taskId}: ${chk.reason}`); e.exitCode = 1; e.code = 'BAD_TRANSITION'; throw e;
    }
    from = t.status;
    t.status = to;
    t.status_reason = reason;
    if (typeof data === 'function') data(t);
    else if (data) Object.assign(t, data);
  });
  if (from !== to) {
    emit(home, {
      type: 'task.status', source, session_id, actor: { kind: actor === 'human' ? 'human' : 'system', role: 'cto' },
      goal_id: rec.goal_id, epic_id: rec.epic_id, task_id: rec.id, msg: `${rec.id} ${from} -> ${to}${reason ? `: ${reason}` : ''}`,
      data: { from, to },
    });
  }
  return rec;
}

export function setGoalStatus(home, goalId, status, reason = null, extra = null) {
  let from = null;
  const g = store.update(home, 'goal', goalId, (x) => {
    from = x.status; x.status = status; x.status_reason = reason;
    if (extra) extra(x);
  });
  if (from !== status) {
    emit(home, { type: 'goal.status', goal_id: goalId, msg: `${goalId} ${from} -> ${status}${reason ? `: ${reason}` : ''}`, data: { from, to: status } });
  }
  return g;
}

export function setEpicStatus(home, epicId, status, reason = null, extra = null) {
  let from = null;
  const e = store.update(home, 'epic', epicId, (x) => {
    from = x.status; x.status = status; x.status_reason = reason;
    if (extra) extra(x);
  });
  if (from !== status) {
    emit(home, { type: 'epic.status', goal_id: e.goal_id, epic_id: epicId, msg: `${epicId} ${from} -> ${status}`, data: { from, to: status } });
  }
  return e;
}
