// Records: goal, epic, task, run, gate. Every write validates, bumps rev and patches the index.
import { join } from 'node:path';
import { listDir, nowIso, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import { ID_FORMAT, nextId as allocId } from './ids.mjs';
import { validate } from './schema.mjs';
import { patchIndex } from './index.mjs';

export const kinds = ['goal', 'epic', 'task', 'run', 'gate'];

export class ValidationError extends Error {
  constructor(kind, errors) {
    super(`${kind} invalid: ${errors.join('; ')}`);
    this.code = 'VALIDATION'; this.exitCode = 1; this.errors = errors;
  }
}
export class RevConflict extends Error {
  constructor(kind, id, expected, actual) {
    super(`${kind} ${id} rev conflict: expected ${expected}, found ${actual}`);
    this.code = 'REV_CONFLICT'; this.exitCode = 5;
  }
}
export class NotFound extends Error {
  constructor(kind, id) { super(`${kind} ${id} not found`); this.code = 'NOT_FOUND'; this.exitCode = 1; }
}

export function fileFor(home, kind, id) {
  const f = ID_FORMAT[kind];
  if (!f) throw new Error(`unknown kind ${kind}`);
  if (kind === 'run') return join(home, 'runs', id, 'run.json');
  return join(home, f.dir, `${id}.json`);
}

export function get(home, kind, id) {
  if (!id) return null;
  return readJson(fileFor(home, kind, id), null);
}

export function mustGet(home, kind, id) {
  const r = get(home, kind, id);
  if (!r) throw new NotFound(kind, id);
  return r;
}

export function list(home, kind, filterFn) {
  const f = ID_FORMAT[kind];
  const out = [];
  for (const name of listDir(join(home, f.dir)).sort()) {
    if (!name.startsWith(f.prefix)) continue;
    const id = name.replace(/\.json$/, '');
    if (kind !== 'run' && !name.endsWith('.json')) continue;
    const rec = get(home, kind, id);
    if (rec && (!filterFn || filterFn(rec))) out.push(rec);
  }
  return out;
}

export function nextId(home, kind) { return allocId(home, kind); }

const DEFAULTS = {
  goal: () => ({
    title: '', slug: '', outcome: '', success_criteria: [], constraints: [], priority: 'P2', tier: null,
    needs_ui: null, status: 'planning', status_reason: null, pod: { product: null, tech_lead: null, members: [] },
    docs: { prd: null, spec: null, plan: null, design: null }, gates: { G1: null, G2: null, G3: null },
    gate_policy: {}, budget: { limit_tokens: 0, warn_pct: 80, stop_pct: 100 },
    created_by: { kind: 'human', via: 'cli' }, epics: [],
  }),
  epic: () => ({
    goal_id: null, title: '', slug: '', summary: '', depends_on: [], status: 'draft', branch: '', base_branch: 'main',
    pr: null, gates: { G4: null }, tasks: [],
  }),
  task: () => ({
    goal_id: null, epic_id: null, kind: 'code', title: '', description: '', role: 'backend-engineer', size: 'M',
    priority: 'P2', acceptance_criteria: [], ac_version: 1, files_owned: [], files_shared: [], files_read: [],
    depends_on: [], gate_deps: [], gate: null, risk_flags: [], reviews_required: [], reviews: {}, status: 'draft',
    status_reason: null, attempts: 0, max_attempts: 3, rework_count: 0, max_rework: 3, fixups: 0, estimate_tokens: 0,
    model_override: null, branch: null, base_ref: null, current_run_id: null, runs: [], blocked: null,
    resume_from: null, feedback: [], answers: [], pending_kind: null,
  }),
  run: () => ({
    task_id: null, goal_id: null, epic_id: null, kind: 'author', role: 'cto', subagent_type: '', model: 'sonnet',
    status: 'dispatching', session_id: null, agent_id: null, tool_use_id: null, dispatched_at: null, started_at: null,
    ended_at: null, isolation: 'none', worktree_path: null, branch: null, head_sha: null, brief_path: null,
    handoff_path: null, estimate_tokens: 0, round: 1, review_role: null, exit: null,
  }),
  gate: () => ({
    type: 'G1', subject: { kind: 'goal', id: null }, goal_id: null, status: 'pending', opened_at: null,
    opened_by: { run_id: null, actor: 'factory' }, artifact: { paths: [], summary: '' }, request: {}, decision: null,
    auto: false,
  }),
};

export function defaults(kind) { return DEFAULTS[kind](); }

function check(kind, rec) {
  const v = validate(kind, rec);
  if (!v.ok) throw new ValidationError(kind, v.errors);
}

/** Create a record. Assigns id (unless fields.id), rev 1, timestamps; validates; patches index. */
export function create(home, kind, fields = {}) {
  return withMutex(home, () => {
    const id = fields.id || allocId(home, kind);
    const ts = nowIso();
    const rec = {
      schema: `factory/${kind}@1`, id, rev: 1, created_at: ts, updated_at: ts,
      ...DEFAULTS[kind](), ...fields,
    };
    rec.schema = `factory/${kind}@1`; rec.id = id; rec.rev = 1; rec.created_at = ts; rec.updated_at = ts;
    check(kind, rec);
    if (get(home, kind, id)) throw new ValidationError(kind, [`id ${id} already exists`]);
    writeJsonAtomic(fileFor(home, kind, id), rec);
    patchIndex(home, kind, rec);
    return rec;
  });
}

/** Update with a mutator (may mutate in place or return a new object). Optional expectRev. */
export function update(home, kind, id, mutator, opts = {}) {
  return withMutex(home, () => {
    const cur = get(home, kind, id);
    if (!cur) throw new NotFound(kind, id);
    if (opts.expectRev !== undefined && opts.expectRev !== null && cur.rev !== opts.expectRev) {
      throw new RevConflict(kind, id, opts.expectRev, cur.rev);
    }
    const draft = structuredClone(cur);
    const out = mutator(draft) || draft;
    out.id = cur.id; out.schema = cur.schema; out.created_at = cur.created_at;
    out.rev = cur.rev + 1; out.updated_at = nowIso();
    check(kind, out);
    writeJsonAtomic(fileFor(home, kind, id), out);
    patchIndex(home, kind, out);
    return out;
  });
}
