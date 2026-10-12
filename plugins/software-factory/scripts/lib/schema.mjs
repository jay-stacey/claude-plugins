// Hand-written runtime validators for records, config, handoff, inbox and events (no deps).
// The documentation-grade JSON Schemas live in scripts/schemas/*.schema.json.

export const ENUMS = {
  priority: ['P0', 'P1', 'P2', 'P3'],
  tier: ['S', 'M', 'L'],
  size: ['S', 'M', 'L'],
  goal_status: ['draft', 'planning', 'awaiting_g1', 'active', 'paused', 'budget_blocked', 'done', 'cancelled'],
  epic_status: ['draft', 'building', 'integrating', 'qa', 'review', 'docs', 'goal_qa', 'pr_open', 'changes_requested', 'done', 'cancelled'],
  task_status: ['draft', 'backlog', 'ready', 'in_progress', 'checking', 'in_review', 'changes_requested', 'verified',
    'integrated', 'awaiting_approval', 'done', 'blocked', 'paused', 'deferred', 'failed', 'cancelled'],
  task_kind: ['intake', 'prd', 'spec', 'mockup', 'breakdown', 'sequence', 'code', 'docs', 'qa_epic', 'review_epic',
    'qa_goal', 'pr_feedback', 'escalation', 'research'],
  run_kind: ['author', 'review', 'qa', 'fixup', 'integrate', 'escalation'],
  run_status: ['dispatching', 'running', 'suspect', 'completed', 'failed', 'deferred', 'orphaned', 'stopped'],
  gate_type: ['G1', 'G2', 'G3', 'G4', 'budget', 'destructive', 'tracker'],
  gate_status: ['pending', 'approved', 'rejected', 'changes_requested', 'superseded'],
  gate_via: ['cli', 'dashboard', 'tracker', 'github'],
  handoff_status: ['handed_off', 'blocked', 'partial', 'failed'],
  verdict: ['pass', 'fail', 'escalate'],
  severity: ['blocker', 'major', 'minor', 'nit'],
  inbox_source: ['dashboard', 'cli', 'tracker', 'setup'],
  actor_kind: ['human', 'tracker', 'system'],
  event_source: ['cli', 'hook', 'server', 'sync', 'reconcile'],
  factory_status: ['stopped', 'running', 'pausing', 'paused'],
};

export const ROLES = ['cto', 'product-manager', 'project-manager', 'staff-engineer', 'ui-ux-designer', 'data-engineer',
  'backend-engineer', 'frontend-engineer', 'devops-release', 'qa-engineer', 'code-reviewer', 'security-reviewer',
  'critic', 'tech-writer'];

export const EVENT_TYPES = ['tick.started', 'tick.finished', 'lock.acquired', 'lock.stolen', 'lock.released',
  'factory.status', 'inbox.processed', 'goal.status', 'epic.status', 'task.created', 'task.status', 'run.dispatched',
  'run.started', 'run.ended', 'run.lost', 'run.deferred', 'msg.dispatch', 'msg.handoff', 'msg.question', 'msg.answer',
  'msg.review_request', 'msg.review_result', 'msg.rework', 'msg.escalation', 'msg.approval_request',
  'msg.approval_result', 'evidence.rejected', 'gate.opened', 'gate.decided', 'budget.warned', 'budget.blocked',
  'budget.overridden', 'pr.opened', 'pr.updated', 'pr.merged', 'sync.completed', 'sync.conflict', 'sync.failing'];

// ---- tiny checker ----
class C {
  constructor(obj, where) { this.o = obj || {}; this.errors = []; this.where = where; }
  err(f, m) { this.errors.push(`${f}: ${m}`); }
  req(f) { if (this.o[f] === undefined) this.err(f, 'required'); return this; }
  str(f, { max, req = false, nullable = false } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (v === null) { if (!nullable) this.err(f, 'must not be null'); return this; }
    if (typeof v !== 'string') this.err(f, 'must be a string');
    else if (max && v.length > max) this.err(f, `longer than ${max}`);
    return this;
  }
  num(f, { req = false, nullable = false, min } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (v === null) { if (!nullable) this.err(f, 'must not be null'); return this; }
    if (typeof v !== 'number' || !Number.isFinite(v)) this.err(f, 'must be a number');
    else if (min !== undefined && v < min) this.err(f, `must be >= ${min}`);
    return this;
  }
  bool(f, { req = false, nullable = false } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (v === null) { if (!nullable) this.err(f, 'must not be null'); return this; }
    if (typeof v !== 'boolean') this.err(f, 'must be true or false');
    return this;
  }
  oneOf(f, list, { req = false, nullable = false } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (v === null) { if (!nullable) this.err(f, 'must not be null'); return this; }
    if (!list.includes(v)) this.err(f, `must be one of ${list.join('|')}`);
    return this;
  }
  arr(f, { req = false, min, max, of } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (!Array.isArray(v)) { this.err(f, 'must be an array'); return this; }
    if (min !== undefined && v.length < min) this.err(f, `needs at least ${min} items`);
    if (max !== undefined && v.length > max) this.err(f, `allows at most ${max} items`);
    if (of) v.forEach((x, i) => { const m = of(x); if (m) this.err(`${f}[${i}]`, m); });
    return this;
  }
  obj(f, { req = false, nullable = false } = {}) {
    const v = this.o[f];
    if (v === undefined) { if (req) this.err(f, 'required'); return this; }
    if (v === null) { if (!nullable) this.err(f, 'must not be null'); return this; }
    if (typeof v !== 'object' || Array.isArray(v)) this.err(f, 'must be an object');
    return this;
  }
  result() { return { ok: this.errors.length === 0, errors: this.errors }; }
}

const isStr = (x) => (typeof x === 'string' ? null : 'must be a string');

function common(c, kind) {
  c.str('schema', { req: true });
  if (c.o.schema && c.o.schema !== `factory/${kind}@1`) c.err('schema', `must be factory/${kind}@1`);
  c.str('id', { req: true }).num('rev', { req: true, min: 1 }).str('created_at', { req: true }).str('updated_at', { req: true });
}

export function validateGoal(g) {
  const c = new C(g); common(c, 'goal');
  c.str('title', { req: true, max: 80 }).str('slug', { req: true }).str('outcome', { req: true, max: 600 })
    .arr('success_criteria', { req: true, min: 1, max: 7, of: isStr }).arr('constraints', { of: isStr })
    .oneOf('priority', ENUMS.priority, { req: true }).oneOf('tier', ENUMS.tier, { nullable: true })
    .bool('needs_ui', { nullable: true }).oneOf('status', ENUMS.goal_status, { req: true })
    .obj('budget', { req: true }).obj('gates').obj('docs').obj('pod', { nullable: true }).arr('epics', { of: isStr });
  if (g && g.budget) {
    const b = new C(g.budget); b.num('limit_tokens', { req: true, min: 0 }).num('warn_pct').num('stop_pct');
    b.errors.forEach((e) => c.err('budget', e));
  }
  return c.result();
}

export function validateEpic(e) {
  const c = new C(e); common(c, 'epic');
  c.str('goal_id', { req: true }).str('title', { req: true, max: 80 }).str('slug', { req: true })
    .str('summary').arr('depends_on', { of: isStr }).oneOf('status', ENUMS.epic_status, { req: true })
    .str('branch', { req: true }).str('base_branch').str('repo', { nullable: true }).obj('pr', { nullable: true }).arr('tasks', { of: isStr });
  return c.result();
}

function acItem(x) {
  if (!x || typeof x !== 'object') return 'must be {id, text}';
  if (!/^AC-\d+$/.test(x.id || '')) return 'id must look like AC-1';
  if (typeof x.text !== 'string' || !x.text.trim()) return 'text required';
  return null;
}
function reviewGroup(x) {
  if (!Array.isArray(x) || !x.length) return 'each review group must be a non-empty array of roles';
  for (const r of x) if (!ROLES.includes(r)) return `unknown role ${r}`;
  return null;
}

export function validateTask(t) {
  const c = new C(t); common(c, 'task');
  c.str('goal_id', { req: true }).str('epic_id', { nullable: true }).str('repo', { nullable: true }).oneOf('kind', ENUMS.task_kind, { req: true })
    .str('title', { req: true, max: 80 }).str('description', { max: 1200 }).oneOf('role', ROLES, { req: true })
    .oneOf('size', ENUMS.size).oneOf('priority', ENUMS.priority)
    .arr('acceptance_criteria', { of: acItem }).arr('files_owned', { of: isStr }).arr('files_shared', { of: isStr })
    .arr('files_read', { of: isStr }).arr('depends_on', { of: isStr })
    .arr('gate_deps', { of: (x) => (['G1', 'G2', 'G3'].includes(x) ? null : 'must be G1|G2|G3') })
    .oneOf('gate', ['G1', 'G2', 'G3'], { nullable: true }).arr('reviews_required', { of: reviewGroup })
    .oneOf('status', ENUMS.task_status, { req: true }).num('attempts', { min: 0 }).num('max_attempts', { min: 1 })
    .num('rework_count', { min: 0 }).num('max_rework', { min: 0 }).arr('runs', { of: isStr });
  if (t && t.kind === 'code' && Array.isArray(t.acceptance_criteria)) {
    if (t.acceptance_criteria.length < 1 || t.acceptance_criteria.length > 5) c.err('acceptance_criteria', 'code tasks need 1-5 criteria');
  }
  if (t && t.kind === 'code' && t.size === 'L') c.err('size', 'code tasks above M are rejected; split it');
  return c.result();
}

export function validateRun(r) {
  const c = new C(r); common(c, 'run');
  c.str('task_id', { req: true }).str('goal_id', { req: true }).oneOf('kind', ENUMS.run_kind, { req: true })
    .oneOf('role', ROLES, { req: true }).str('subagent_type', { req: true }).str('model', { req: true })
    .oneOf('status', ENUMS.run_status, { req: true }).oneOf('isolation', ['worktree', 'none']).str('repo', { nullable: true })
    .num('estimate_tokens', { min: 0 }).num('round', { min: 1 });
  return c.result();
}

export function validateGate(g) {
  const c = new C(g); common(c, 'gate');
  c.oneOf('type', ENUMS.gate_type, { req: true }).obj('subject', { req: true }).str('goal_id', { nullable: true })
    .oneOf('status', ENUMS.gate_status, { req: true }).str('opened_at', { req: true }).obj('artifact', { req: true })
    .obj('decision', { nullable: true }).bool('auto');
  if (g && g.artifact && g.artifact.summary && g.artifact.summary.length > 600) c.err('artifact.summary', 'longer than 600');
  if (g && g.decision) {
    const d = new C(g.decision); d.str('by', { req: true }).oneOf('via', ENUMS.gate_via, { req: true }).str('at', { req: true });
    d.errors.forEach((e) => c.err('decision', e));
  }
  return c.result();
}

export const VALIDATORS = { goal: validateGoal, epic: validateEpic, task: validateTask, run: validateRun, gate: validateGate };

export function validate(kind, rec) {
  const v = VALIDATORS[kind];
  if (!v) return { ok: false, errors: [`unknown kind ${kind}`] };
  return v(rec);
}

// ---- handoff (structure only; cross-checks live in handoff.mjs) ----
export function validateHandoffShape(h) {
  const c = new C(h);
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { ok: false, errors: ['handoff must be a JSON object'] };
  if (h.schema !== 'factory/handoff@1') c.err('schema', 'must be factory/handoff@1');
  c.str('run_id', { req: true }).str('task_id', { req: true }).str('from_role', { req: true }).str('to_role')
    .oneOf('status', ENUMS.handoff_status, { req: true }).oneOf('verdict', ENUMS.verdict, { nullable: true })
    .str('summary', { req: true }).arr('acceptance_criteria', {
      of: (x) => (x && /^AC-\d+$/.test(x.id || '') && typeof x.met === 'boolean' && (x.evidence === undefined || Array.isArray(x.evidence))
        ? null : 'must be {id: "AC-n", met: bool, evidence: []}'),
    })
    .arr('evidence', { of: isStr }).arr('files_touched', { of: isStr }).str('branch', { nullable: true })
    .arr('commits', { of: isStr })
    .arr('findings', {
      of: (x) => (x && typeof x === 'object' && ENUMS.severity.includes(x.severity) && typeof x.text === 'string'
        ? null : 'must have severity blocker|major|minor|nit and text'),
    })
    .str('report_path', { nullable: true })
    .arr('open_questions', {
      of: (x) => (x && typeof x === 'object' && typeof x.question === 'string' && x.question.trim()
        ? null : 'must have a question'),
    })
    .arr('follow_ups').obj('destructive', { nullable: true }).str('resume_note', { nullable: true });
  if (typeof h.summary === 'string' && h.summary.split(/\r?\n/).length > 10) c.err('summary', 'more than 10 lines');
  return c.result();
}

// ---- config ----
export function validateConfig(cfg) {
  const c = new C(cfg);
  c.num('version', { req: true }).obj('project').arr('stack').obj('commands').obj('roles').obj('gates').obj('budget')
    .obj('concurrency').obj('checks').obj('delivery').obj('reviews').obj('recovery').obj('cadence');
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['config must be an object'] };
  const b = cfg.budget || {};
  for (const t of ENUMS.tier) {
    if (b.tier_defaults && typeof b.tier_defaults[t] !== 'number') c.err(`budget.tier_defaults.${t}`, 'must be a number');
  }
  for (const k of ['warn_pct', 'stop_pct']) if (b[k] !== undefined && typeof b[k] !== 'number') c.err(`budget.${k}`, 'must be a number');
  const cc = cfg.concurrency || {};
  for (const k of ['total', 'builders', 'reviewers', 'planners', 'max_goals_building']) {
    if (cc[k] !== undefined && (typeof cc[k] !== 'number' || cc[k] < 0)) c.err(`concurrency.${k}`, 'must be a number >= 0');
  }
  if (cfg.reviews && !['lean', 'thorough'].includes(cfg.reviews.profile)) c.err('reviews.profile', 'must be lean|thorough');
  if (cfg.models) {
    const okModel = (m) => m === null || ['opus', 'sonnet', 'haiku', 'inherit'].includes(m) || /^claude-[a-z0-9.-]+$/.test(m);
    if (cfg.models.all !== undefined && !okModel(cfg.models.all)) c.err('models.all', 'must be opus|sonnet|haiku|inherit, a claude-* model id, or null');
    for (const [r, m] of Object.entries(cfg.models.by_role || {})) {
      if (!ROLES.includes(r)) c.err(`models.by_role.${r}`, 'unknown role');
      else if (!okModel(m)) c.err(`models.by_role.${r}`, 'must be opus|sonnet|haiku|inherit or a claude-* model id');
    }
  }
  if (cfg.delivery && !['github', 'local'].includes(cfg.delivery.mode)) c.err('delivery.mode', 'must be github|local');
  for (const g of ['G1', 'G2', 'G3', 'G4']) {
    if (cfg.gates && cfg.gates[g] && typeof cfg.gates[g].enabled !== 'boolean') c.err(`gates.${g}.enabled`, 'must be true or false');
  }
  if (cfg.checks) {
    for (const k of ['pre_review', 'post_merge']) {
      if (cfg.checks[k] !== undefined && !(Array.isArray(cfg.checks[k]) && cfg.checks[k].every((x) => typeof x === 'string'))) {
        c.err(`checks.${k}`, 'must be an array of command strings');
      }
    }
  }
  checkCommands(c, 'commands', cfg.commands);
  if (cfg.repos !== undefined && (typeof cfg.repos !== 'object' || cfg.repos === null || Array.isArray(cfg.repos))) {
    c.err('repos', 'must be an object of {name: repo}');
  } else if (cfg.repos) {
    for (const [name, r] of Object.entries(cfg.repos)) {
      const at = `repos.${name}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) c.err(at, 'name must be letters, digits, dot, dash or underscore');
      if (!r || typeof r !== 'object' || Array.isArray(r)) { c.err(at, 'must be an object'); continue; }
      if (r.path !== undefined && (typeof r.path !== 'string' || !r.path.trim())) c.err(`${at}.path`, 'must be a non-empty string');
      if (r.stack !== undefined && !Array.isArray(r.stack)) c.err(`${at}.stack`, 'must be an array');
      checkCommands(c, `${at}.commands`, r.commands);
      if (r.checks) {
        for (const k of ['pre_review', 'post_merge']) {
          if (r.checks[k] !== undefined && !(Array.isArray(r.checks[k]) && r.checks[k].every((x) => typeof x === 'string'))) {
            c.err(`${at}.checks.${k}`, 'must be an array of command strings');
          }
        }
      }
      if (r.delivery && r.delivery.mode !== undefined && !['github', 'local'].includes(r.delivery.mode)) c.err(`${at}.delivery.mode`, 'must be github|local');
    }
  }
  if (cfg.workspace && cfg.workspace.enabled) {
    const names = Object.keys(cfg.repos || {});
    if (!names.length) c.err('workspace.enabled', 'workspace mode needs at least one entry in repos');
    const dr = cfg.workspace.default_repo;
    if (dr !== undefined && dr !== null && !names.includes(dr)) c.err('workspace.default_repo', `must be one of: ${names.join(', ')}`);
  }
  return c.result();
}

function checkCommands(c, at, cmds) {
  if (!cmds) return;
  if (typeof cmds !== 'object' || Array.isArray(cmds)) { c.err(at, 'must be an object'); return; }
  for (const [k, v] of Object.entries(cmds)) {
    if (k === 'extra') {
      if (!(Array.isArray(v) && v.every((x) => typeof x === 'string'))) c.err(`${at}.extra`, 'must be an array of command strings');
    } else if (v !== null && typeof v !== 'string') c.err(`${at}.${k}`, 'must be a string or null');
  }
}

// ---- event ----
export function validateEvent(e) {
  const c = new C(e);
  c.num('v', { req: true }).str('id', { req: true }).str('ts', { req: true }).oneOf('type', EVENT_TYPES, { req: true })
    .oneOf('source', ENUMS.event_source, { req: true }).obj('actor', { req: true }).str('msg', { max: 140 });
  return c.result();
}

export { C as Checker };
