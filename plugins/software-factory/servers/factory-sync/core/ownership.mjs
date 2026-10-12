// Field ownership and status classification (design C §7-§8).

/** Owner per field: factory | shared | human. */
export const FIELD_OWNER = {
  title: 'shared', body: 'shared', status: 'factory', priority: 'human', dueDate: 'human',
  assigneeId: 'human', labels: 'human', factoryLabels: 'factory', parent: 'factory', comments: 'human',
};

/** Status-map keys in flow order. */
export const MAP_KEYS = ['backlog', 'ready', 'in_progress', 'in_review', 'verified', 'awaiting_approval', 'done', 'cancelled'];
const RANK = { backlog: 0, ready: 1, in_progress: 2, in_review: 3, verified: 4, awaiting_approval: 5, done: 6 };

/** Local task status -> status-map key, or null for side states (no status push). */
export function mapKeyForTask(status) {
  switch (status) {
    case 'draft': case 'backlog': return 'backlog';
    case 'ready': return 'ready';
    case 'in_progress': case 'checking': case 'changes_requested': return 'in_progress';
    case 'in_review': return 'in_review';
    case 'verified': case 'integrated': return 'verified';
    case 'awaiting_approval': return 'awaiting_approval';
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
    default: return null; // blocked, paused, deferred, failed
  }
}

/** Local goal status -> status-map key. */
export function mapKeyForGoal(status) {
  switch (status) {
    case 'draft': case 'planning': return 'backlog';
    case 'awaiting_g1': return 'ready';
    case 'active': return 'in_progress';
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
    default: return null; // paused, budget_blocked
  }
}

/** Preferred remote names per key, used by the status-map proposer (type first, name second). */
const PREFER = {
  backlog: { types: ['backlog', 'unstarted'], names: ['backlog', 'to do', 'todo'] },
  ready: { types: ['unstarted'], names: ['todo', 'to do', 'ready', 'selected', 'selected for development'] },
  in_progress: { types: ['started'], names: ['in progress', 'doing'] },
  in_review: { types: ['started'], names: ['in review', 'code review', 'review'] },
  verified: { types: ['started'], names: ['qa', 'ready for qa', 'testing', 'in review'] },
  awaiting_approval: { types: ['started'], names: ['ready to merge', 'approval', 'ready for release', 'in review'] },
  done: { types: ['completed'], names: ['done', 'closed', 'complete'] },
  cancelled: { types: ['canceled'], names: ['canceled', 'cancelled', "won't do", 'wont do', 'not planned'] },
};

/** Propose {key: {id, name, type}} from discovered states [{id, name, type, position}]. */
export function proposeStatusMap(states) {
  const out = {};
  const byPos = [...(states || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const key of MAP_KEYS) {
    const pref = PREFER[key];
    const typed = byPos.filter((s) => pref.types.includes(s.type));
    const named = (list) => {
      for (const n of pref.names) { const hit = list.find((s) => String(s.name).trim().toLowerCase() === n); if (hit) return hit; }
      return null;
    };
    let pick = named(typed) || null;
    if (!pick && ['in_review', 'verified', 'awaiting_approval'].includes(key)) pick = out.in_review || out.in_progress || null;
    if (!pick) pick = typed[0] || named(byPos) || null;
    if (pick) out[key] = { id: pick.id, name: pick.name, type: pick.type };
  }
  return out;
}

/** Rank of a remote state for classification: mapped keys first, then by state type. */
function remoteRank(statusMap, remote) {
  let best = null;
  for (const [k, v] of Object.entries(statusMap || {})) {
    if (v && v.id === remote.statusId && RANK[k] !== undefined) best = best === null ? RANK[k] : Math.min(best, RANK[k]);
  }
  if (best !== null) return best;
  return { backlog: 0, triage: 0, unstarted: 1, started: 2, completed: 6 }[remote.statusType] ?? null;
}

/**
 * Classify a human status change on a mapped task.
 * Returns consistent | cancel | done_override | rework | pause | promote | demote | ignored_forward | unknown.
 */
export function classifyStatusChange({ localStatus, remote, statusMap }) {
  const key = mapKeyForTask(localStatus);
  const isMapped = (k) => statusMap && statusMap[k] && statusMap[k].id === remote.statusId;
  if (key && isMapped(key)) return 'consistent';
  if (remote.statusType === 'canceled') return localStatus === 'cancelled' ? 'consistent' : 'cancel';
  if (remote.statusType === 'completed') return localStatus === 'done' ? 'consistent' : 'done_override';
  if (!key) return 'ignored_forward'; // local side state: the factory keeps its last mapped state
  if (localStatus === 'cancelled' || localStatus === 'done') return 'ignored_forward';
  const r = remoteRank(statusMap, remote);
  const l = RANK[key];
  if (r === null) return 'unknown';
  if (r === l) return 'consistent';
  if (l === 0 && r === 1) return 'promote';
  if (l === 1 && r === 0) return 'demote';
  if (l <= 1) return 'ignored_forward';
  if (l === 2 && r < 2) return 'pause';
  if (r < l) return 'rework';
  return 'ignored_forward';
}

/** Default policy per class: auto | confirm | log. Config tracker.human_status_changes overrides. */
export const DEFAULT_CLASS_POLICY = {
  promote: 'auto', demote: 'auto', pause: 'auto', rework: 'confirm', cancel: 'confirm', done_override: 'confirm',
  ignored_forward: 'log', unknown: 'log',
};

export function classPolicy(cfgTracker, cls) {
  const o = (cfgTracker && cfgTracker.human_status_changes) || {};
  const v = o[cls] || DEFAULT_CLASS_POLICY[cls] || 'log';
  if (['cancel', 'done_override'].includes(cls) && v === 'auto') return 'confirm'; // destructive: never auto
  return v;
}

/** Local priority P0..P3 <-> Linear 1..4 and Jira names. */
export const PRIORITY = {
  toLinear: { P0: 1, P1: 2, P2: 3, P3: 4 },
  fromLinear: { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3', 0: null },
  toJira: { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' },
  fromJira: { highest: 'P0', high: 'P1', medium: 'P2', low: 'P3', lowest: 'P3' },
};
