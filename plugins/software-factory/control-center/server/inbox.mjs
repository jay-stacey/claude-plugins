// Validates dashboard requests and writes them as signed inbox files through the core
// library (scripts/lib/inbox.mjs + hmac.mjs). This is the only factory state the server writes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DASHBOARD_TYPES = ['gate.decide', 'goal.add', 'goal.pause', 'goal.resume', 'goal.remove',
  'factory.pause', 'factory.resume', 'budget.override', 'task.note'];

const DEFAULT_LIB = fileURLToPath(new URL('../../scripts/lib/', import.meta.url));

let libCache = null;
// Lazy import so the server starts (read-only) even before the core library exists.
// FACTORY_CC_LIB_DIR points tests at a stand-in.
export async function loadLib() {
  const dir = process.env.FACTORY_CC_LIB_DIR || DEFAULT_LIB;
  if (libCache && libCache.dir === dir) return libCache;
  const inbox = await import(pathToFileURL(path.join(dir, 'inbox.mjs')).href);
  const hmac = await import(pathToFileURL(path.join(dir, 'hmac.mjs')).href);
  libCache = { dir, inbox, hmac };
  return libCache;
}

export class RequestError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function str(errors, obj, key, { min = 0, max, required = true, oneLine = false } = {}) {
  const v = obj[key];
  if (v === undefined || v === null || v === '') {
    if (required && min > 0) errors.push(`${key} is required`);
    return;
  }
  if (typeof v !== 'string') return errors.push(`${key} must be text`);
  const t = v.trim();
  if (t.length < min) errors.push(`${key} is required`);
  if (max && v.length > max) errors.push(`${key} must be at most ${max} characters`);
  if (CTRL.test(v) || (oneLine && /[\r\n]/.test(v))) errors.push(`${key} has characters that are not allowed`);
}
function int(errors, obj, key, { min, max, required = false } = {}) {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) errors.push(`${key} is required`);
    return;
  }
  if (!Number.isInteger(v) || v < min || v > max) errors.push(`${key} must be a whole number from ${min} to ${max}`);
}
function list(errors, obj, key, { min, max, itemMax, required = false }) {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) errors.push(`${key} is required`);
    return;
  }
  if (!Array.isArray(v)) return errors.push(`${key} must be a list`);
  if (v.length < min || v.length > max) errors.push(`${key} needs ${min} to ${max} items`);
  v.forEach((s, i) => {
    if (typeof s !== 'string' || !s.trim()) errors.push(`${key} item ${i + 1} is empty`);
    else if (s.length > itemMax) errors.push(`${key} item ${i + 1} must be at most ${itemMax} characters`);
    else if (CTRL.test(s) || /[\r\n]/.test(s)) errors.push(`${key} item ${i + 1} has characters that are not allowed`);
  });
}
function onlyKeys(errors, obj, keys) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`unknown field ${k}`);
}
const ID = { goal: /^G-\d{3,}$/, task: /^T-\d{4,}$/, gate: /^GATE-\d{4,}$/ };

// Pure validation against the current state. Returns {payload (cleaned), errors[]}.
export function validateRequest(type, payload, look) {
  const errors = [];
  if (!DASHBOARD_TYPES.includes(type)) return { errors: [`type ${String(type).slice(0, 40)} is not allowed from the dashboard`] };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { errors: ['payload must be an object'] };
  const p = { ...payload };
  const goal = (id) => look.goal(id);
  switch (type) {
    case 'gate.decide': {
      onlyKeys(errors, p, ['gate_id', 'decision', 'notes', 'add_tokens']);
      if (!ID.gate.test(String(p.gate_id))) { errors.push('gate_id is not valid'); break; }
      const g = look.gate(p.gate_id);
      if (!g) errors.push(`gate ${p.gate_id} not found`);
      else if (g.status !== 'pending') errors.push(`gate ${p.gate_id} is already ${g.status}`);
      if (!['approve', 'changes', 'reject'].includes(p.decision)) errors.push('decision must be approve, changes or reject');
      const needNotes = p.decision === 'changes' || p.decision === 'reject';
      str(errors, p, 'notes', { min: needNotes ? 1 : 0, max: 4000 });
      if (p.notes === undefined) p.notes = '';
      int(errors, p, 'add_tokens', { min: 1, max: 1e9 });
      break;
    }
    case 'goal.add': {
      onlyKeys(errors, p, ['title', 'outcome', 'success_criteria', 'priority', 'budget_tokens', 'constraints', 'notes']);
      str(errors, p, 'title', { min: 1, max: 80, oneLine: true });
      str(errors, p, 'outcome', { min: 1, max: 600 });
      list(errors, p, 'success_criteria', { min: 1, max: 7, itemMax: 200, required: true });
      if (!['P0', 'P1', 'P2', 'P3'].includes(p.priority)) errors.push('priority must be P0, P1, P2 or P3');
      int(errors, p, 'budget_tokens', { min: 100000, max: 1e9 });
      list(errors, p, 'constraints', { min: 0, max: 10, itemMax: 200 });
      str(errors, p, 'notes', { max: 2000, required: false });
      break;
    }
    case 'goal.pause':
    case 'goal.resume': {
      onlyKeys(errors, p, ['goal_id']);
      const g = ID.goal.test(String(p.goal_id)) ? goal(p.goal_id) : null;
      if (!g) { errors.push(`goal ${String(p.goal_id).slice(0, 20)} not found`); break; }
      if (type === 'goal.pause' && ['paused', 'done', 'cancelled'].includes(g.status)) errors.push(`goal ${g.id} is ${g.status}`);
      if (type === 'goal.resume' && g.status !== 'paused') errors.push(`goal ${g.id} is not paused`);
      break;
    }
    case 'goal.remove': {
      onlyKeys(errors, p, ['goal_id', 'confirm_text', 'discard']);
      const g = ID.goal.test(String(p.goal_id)) ? goal(p.goal_id) : null;
      if (!g) { errors.push(`goal ${String(p.goal_id).slice(0, 20)} not found`); break; }
      if (p.confirm_text !== p.goal_id) errors.push('confirm_text must equal the goal id');
      if (p.discard !== undefined && p.discard !== false) errors.push('discard must be false from the dashboard');
      p.discard = false;
      break;
    }
    case 'factory.pause': {
      onlyKeys(errors, p, ['mode']);
      if (!['drain', 'now'].includes(p.mode)) errors.push('mode must be drain or now');
      const s = look.factory()?.status || 'stopped';
      if (!['running', 'pausing'].includes(s)) errors.push(`the factory is ${s}`);
      break;
    }
    case 'factory.resume': {
      onlyKeys(errors, p, []);
      const s = look.factory()?.status || 'stopped';
      if (!['paused', 'pausing'].includes(s)) errors.push(`the factory is ${s}; start it with /software-factory:start`);
      break;
    }
    case 'budget.override': {
      onlyKeys(errors, p, ['goal_id', 'add_tokens', 'note']);
      if (!(ID.goal.test(String(p.goal_id)) && goal(p.goal_id))) errors.push(`goal ${String(p.goal_id).slice(0, 20)} not found`);
      int(errors, p, 'add_tokens', { min: 1, max: 1e9, required: true });
      str(errors, p, 'note', { min: 1, max: 500 });
      break;
    }
    case 'task.note': {
      onlyKeys(errors, p, ['task_id', 'text']);
      if (!(ID.task.test(String(p.task_id)) && look.task(p.task_id))) errors.push(`task ${String(p.task_id).slice(0, 20)} not found`);
      str(errors, p, 'text', { min: 1, max: 2000 });
      break;
    }
    default:
      break;
  }
  return { payload: p, errors };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Fresh, record-level reads. Ids are checked against strict patterns before they reach a path.
export function diskLookup(home) {
  const rec = (dir, re) => (id) => (re.test(String(id)) ? readJson(path.join(home, dir, `${id}.json`)) : null);
  return {
    goal: rec('goals', ID.goal), task: rec('tasks', ID.task), gate: rec('gates', ID.gate),
    factory: () => readJson(path.join(home, 'state', 'factory.json')),
  };
}

export function pendingRequests(home) {
  let names = [];
  try { names = fs.readdirSync(path.join(home, 'inbox')).filter((n) => n.endsWith('.json') && !n.includes('.tmp')); } catch { /* none */ }
  return names.map((n) => readJson(path.join(home, 'inbox', n))).filter((r) => r && r.id);
}

export class InboxWriter {
  constructor({ home, pluginDataDir }) {
    this.home = home;
    this.pluginDataDir = pluginDataDir;
    this.clientIds = new Map(); // client_id -> inbox id (double-submit guard)
  }

  async submit(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'body must be a JSON object');
    const { type, payload, client_id } = body;
    for (const k of Object.keys(body)) if (!['type', 'payload', 'client_id'].includes(k)) throw new RequestError(400, `unknown field ${k}`);
    if (client_id !== undefined && (typeof client_id !== 'string' || !/^[\w-]{8,64}$/.test(client_id))) throw new RequestError(400, 'client_id is not valid');
    if (client_id && this.clientIds.has(client_id)) {
      throw new RequestError(409, 'this request was already sent', { pending_id: this.clientIds.get(client_id) });
    }
    // Validate against the files on disk right now (not the poller's cache).
    const { payload: clean, errors } = validateRequest(type, payload, diskLookup(this.home));
    if (errors.length) throw new RequestError(400, errors[0], { errors });
    if (type === 'gate.decide') {
      const dup = pendingRequests(this.home).find((r) => r.type === 'gate.decide' && r.payload?.gate_id === clean.gate_id);
      if (dup) throw new RequestError(409, `a decision for ${clean.gate_id} is already queued`, { pending_id: dup.id });
    }
    let lib;
    try {
      lib = await loadLib();
    } catch (e) {
      throw new RequestError(503, 'the factory library is not installed; update the plugin', { detail: String(e.message).slice(0, 200) });
    }
    const key = this.pluginDataDir ? lib.hmac.getKey(this.home, { pluginDataDir: this.pluginDataDir }) : lib.hmac.getKey(this.home);
    const req = lib.inbox.write(this.home, {
      type, payload: clean, source: 'dashboard', actor: { kind: 'human', name: 'dashboard' },
      needs_confirmation: false, auto_apply: false,
    }, { sign: true, key });
    if (client_id) this.clientIds.set(client_id, req.id);
    if (this.clientIds.size > 1000) this.clientIds.delete(this.clientIds.keys().next().value);
    return { id: req.id, type: req.type, created_at: req.created_at };
  }
}
