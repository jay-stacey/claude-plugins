// Derived view-model logic over the snapshot. Pure: no DOM, no vendor imports.

export const SIDE_STATES = ['blocked', 'paused', 'deferred', 'failed'];

export const COLUMNS = [
  { id: 'stuck', label: 'Stuck', statuses: SIDE_STATES },
  { id: 'backlog', label: 'Backlog', statuses: ['backlog', 'draft'] },
  { id: 'ready', label: 'Ready', statuses: ['ready'] },
  { id: 'in_progress', label: 'In progress', statuses: ['in_progress'] },
  { id: 'checking', label: 'Checks', statuses: ['checking'] },
  { id: 'in_review', label: 'In review', statuses: ['in_review', 'changes_requested'] },
  { id: 'verified', label: 'Verified', statuses: ['verified'] },
  { id: 'integrated', label: 'Integrated', statuses: ['integrated'] },
  { id: 'awaiting_approval', label: 'Awaiting approval', statuses: ['awaiting_approval'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
];

const byStatus = new Map();
for (const c of COLUMNS) for (const s of c.statuses) byStatus.set(s, c.id);
export const columnOf = (status) => byStatus.get(status) || null; // cancelled -> null (hidden)

export function indexBy(list, key = 'id') {
  const m = new Map();
  for (const x of list || []) if (x && x[key] != null) m.set(x[key], x);
  return m;
}

/** Task filter from the global filter bar. */
export function taskMatches(task, { goal, role, q }) {
  if (goal && task.goal_id !== goal) return false;
  if (role && task.role !== role) return false;
  if (q) {
    const hay = `${task.id} ${task.title || ''} ${task.epic_id || ''} ${task.role || ''} ${task.kind || ''}`.toLowerCase();
    if (!hay.includes(q.toLowerCase())) return false;
  }
  return true;
}

/** Map a gate record status to a badge state. */
export function gateState(gate) {
  if (!gate) return 'open';
  switch (gate.status) {
    case 'pending': return 'pending';
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'changes_requested': return 'changes';
    default: return 'open'; // superseded or unknown
  }
}

export const GATE_STATE_WORD = {
  open: 'not reached', pending: 'pending', approved: 'approved', rejected: 'rejected', changes: 'changes requested',
};

/** [{name:'G1', state}] for a task card. */
export function taskGateBadges(task, goalsById, epicsById, gatesById) {
  const goal = goalsById.get(task.goal_id);
  const epic = task.epic_id ? epicsById.get(task.epic_id) : null;
  const out = [];
  for (const g of ['G1', 'G2', 'G3']) {
    const gid = goal && goal.gates ? goal.gates[g] : null;
    out.push({ name: g, state: gateState(gid ? gatesById.get(gid) : null), id: gid || null });
  }
  const g4 = epic && epic.gates ? epic.gates.G4 : null;
  out.push({ name: 'G4', state: gateState(g4 ? gatesById.get(g4) : null), id: g4 || null });
  return out;
}

export const EPIC_STEPS = ['qa', 'review', 'docs', 'pr_open', 'G4'];
const EPIC_STEP_LABEL = { qa: 'QA', review: 'Review', docs: 'Docs', pr_open: 'PR open', G4: 'G4' };

/** Epic progress: [{id, label, state: done|current|todo|failed}]. */
export function epicProgress(epic, gatesById) {
  const order = { draft: -1, building: -1, integrating: -1, qa: 0, review: 1, docs: 2, pr_open: 3, changes_requested: 3, done: 5, cancelled: -1 };
  const at = order[epic.status] ?? -1;
  const g4 = epic.gates && epic.gates.G4 ? gatesById.get(epic.gates.G4) : null;
  const g4s = gateState(g4);
  return EPIC_STEPS.map((s, i) => {
    let state = 'todo';
    if (s === 'G4') {
      state = g4s === 'approved' || epic.status === 'done' ? 'done' : g4s === 'pending' ? 'current' : (g4s === 'rejected' || g4s === 'changes') ? 'failed' : 'todo';
    } else if (i < at) state = 'done';
    else if (i === at) state = epic.status === 'changes_requested' ? 'failed' : 'current';
    return { id: s, label: EPIC_STEP_LABEL[s], state };
  });
}

/** Role status for the Team view. Returns Map(roleId -> {status, tasks[], detail}). */
export function roleStatuses(snap) {
  const out = new Map();
  const roles = snap.roles || [];
  const tasks = snap.tasks || [];
  const runs = snap.runs || [];
  const runningTaskIds = new Set();
  for (const r of runs) if (r.status === 'running' || r.status === 'dispatching') runningTaskIds.add(r.task_id);

  // Unanswered questions: msg.question from X with no later msg.answer back to X on the same task.
  const openQ = new Map();
  for (const e of snap.events_tail || []) {
    if (e.type === 'msg.question') {
      const from = e.data && e.data.from && e.data.from.role;
      if (from) openQ.set(`${from}|${e.task_id || ''}`, from);
    } else if (e.type === 'msg.answer') {
      const to = e.data && e.data.to && e.data.to.role;
      if (to) openQ.delete(`${to}|${e.task_id || ''}`);
    }
  }
  const waitingByQ = new Set(openQ.values());
  const pendingGates = (snap.gates || []).filter((g) => g.status === 'pending').length;

  for (const role of roles) {
    const id = role.id;
    const working = runs.filter((r) => r.role === id && (r.status === 'running' || r.status === 'dispatching' || r.status === 'suspect'));
    const liveOwn = tasks.filter((t) => t.role === id && t.live && !runningTaskIds.has(t.id));
    const owned = tasks.filter((t) => t.role === id);
    const blocked = owned.filter((t) => t.status === 'blocked' || t.status === 'failed');
    const waiting = owned.filter((t) => ['in_review', 'awaiting_approval', 'checking'].includes(t.status));
    let status = 'idle';
    let list = [];
    let detail = '';
    if (working.length || liveOwn.length) {
      status = 'working';
      list = [...new Set([...working.map((r) => r.task_id), ...liveOwn.map((t) => t.id)].filter(Boolean))];
    } else if (blocked.length) {
      status = 'blocked';
      list = blocked.map((t) => t.id);
    } else if (waiting.length || waitingByQ.has(id)) {
      status = 'waiting';
      list = waiting.map((t) => t.id);
      if (waitingByQ.has(id)) detail = 'question open';
    }
    if (id === 'user') {
      status = pendingGates ? 'waiting' : 'idle';
      list = [];
      detail = pendingGates ? `${pendingGates} approval${pendingGates === 1 ? '' : 's'}` : '';
    }
    out.set(id, { status, tasks: list, detail });
  }
  return out;
}

export const STATUS_WORD = { working: 'working', waiting: 'waiting', blocked: 'blocked', idle: 'idle' };

/** Message type -> pulse colour class. */
export function pulseKind(type) {
  const t = String(type || '').replace(/^msg\./, '');
  if (t === 'dispatch') return 'dispatch';
  if (t === 'handoff') return 'handoff';
  if (t === 'question' || t === 'answer') return 'question';
  if (t === 'review_request' || t === 'review_result') return 'review';
  if (t === 'rework' || t === 'escalation') return 'rework';
  if (t.startsWith('approval')) return 'approval';
  return 'dispatch';
}

/** Activity type filter categories. */
export const EVENT_CATEGORIES = [
  { id: 'all', label: 'All', prefixes: null },
  { id: 'messages', label: 'Messages', prefixes: ['msg.'] },
  { id: 'tasks', label: 'Tasks', prefixes: ['task.', 'evidence.', 'epic.', 'pr.'] },
  { id: 'gates', label: 'Gates', prefixes: ['gate.'] },
  { id: 'budget', label: 'Budget', prefixes: ['budget.'] },
  { id: 'runs', label: 'Runs', prefixes: ['run.'] },
  { id: 'factory', label: 'Factory', prefixes: ['tick.', 'factory.', 'inbox.', 'goal.', 'lock.', 'sync.'] },
];

export function eventMatches(e, { cat = 'all', goal, role, task }) {
  const c = EVENT_CATEGORIES.find((x) => x.id === cat);
  if (c && c.prefixes && !c.prefixes.some((p) => String(e.type).startsWith(p))) return false;
  if (goal && e.goal_id !== goal) return false;
  if (task && e.task_id !== task) return false;
  if (role) {
    const d = e.data || {};
    const hit = (e.actor && e.actor.role === role) || (d.from && d.from.role === role) || (d.to && d.to.role === role);
    if (!hit) return false;
  }
  return true;
}

/** Readable sentence for an event. roleName(id) returns a display name. */
export function eventSentence(e, roleName) {
  const d = e.data || {};
  const ids = [e.task_id, e.epic_id && !e.task_id ? e.epic_id : null, e.goal_id && !e.task_id && !e.epic_id ? e.goal_id : null].filter(Boolean).join(' ');
  const msg = e.msg ? String(e.msg) : '';
  const t = String(e.type || '');
  if (t.startsWith('msg.')) {
    const kind = t.slice(4).replace(/_/g, ' ');
    const from = d.from && d.from.role ? roleName(d.from.role) : 'Someone';
    const to = d.to && d.to.role ? roleName(d.to.role) : 'someone';
    return msg ? `${from} to ${to}: ${msg}` : `${from} to ${to}: ${kind}${ids ? ` ${ids}` : ''}`;
  }
  if (t === 'task.status' && d.from && d.to) {
    return `${e.task_id || 'Task'} moved from ${String(d.from).replace(/_/g, ' ')} to ${String(d.to).replace(/_/g, ' ')}${msg ? ` - ${msg}` : ''}`;
  }
  if (msg) return ids && !msg.includes(ids.split(' ')[0]) ? `${ids}: ${msg}` : msg;
  return `${t.replace(/[._]/g, ' ')}${ids ? ` ${ids}` : ''}`;
}

/** Resolve a queued inbox request: {state: 'queued'|'applied'|'rejected'|'superseded'|'gated', reason}. */
export function resolveInbox(id, snap) {
  if (!id || !snap) return { state: 'queued' };
  const recent = (snap.inbox && snap.inbox.recent) || [];
  const r = recent.find((x) => x.id === id);
  if (r) return { state: r.status || 'applied', reason: r.reason || '', tick: r.tick };
  const tail = snap.events_tail || [];
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const e = tail[i];
    if (e.type !== 'inbox.processed') continue;
    const d = e.data || {};
    if (d.inbox_id === id || d.id === id || d.request_id === id) {
      return { state: d.status || 'applied', reason: d.reason || e.msg || '', tick: d.tick };
    }
  }
  return { state: 'queued' };
}

/** Tokens billed-equivalent spend for a goal: {limit, spent, live, pct}. */
export function goalSpend(goal, snap) {
  const s = goal.spend || (snap.budget && snap.budget.goals && snap.budget.goals[goal.id]) || {};
  const limit = Number(s.limit ?? (goal.budget && goal.budget.limit_tokens)) || 0;
  const spent = Number(s.spent) || 0;
  const live = Number(snap.usage && snap.usage.by_goal && snap.usage.by_goal[goal.id] && snap.usage.by_goal[goal.id].live) || 0;
  const pct = limit ? (spent / limit) * 100 : 0;
  return { limit, spent, live, pct, reserved: Number(s.reserved) || 0, warned_at: s.warned_at || null, blocked_at: s.blocked_at || null };
}
