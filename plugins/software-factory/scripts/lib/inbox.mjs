// Inbox: signed human requests from the dashboard, CLI, tracker and setup. Processed by `tick plan`.
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, listDir, nowIso, readJson, retry, writeJsonAtomic } from './fsutil.mjs';
import { compactTs, hex } from './ids.mjs';
import { getKey, sign as hmacSign, verify as hmacVerify } from './hmac.mjs';
import { ENUMS } from './schema.mjs';
import { emit } from './events.mjs';

export const HUMAN_TYPES = ['gate.decide', 'goal.remove', 'factory.stop', 'budget.override'];

export const TYPES = ['gate.decide', 'goal.add', 'goal.activate', 'goal.pause', 'goal.resume', 'goal.remove',
  'factory.pause', 'factory.resume', 'factory.stop', 'budget.override', 'task.note', 'task.answer', 'task.retry',
  'task.cancel', 'task.pause', 'sync.now', 'item.add', 'report.request', 'cycle.commit'];

export function knownType(t) { return TYPES.includes(t) || /^(tracker|sync)\.[a-z_]+$/.test(t || ''); }

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Errors for an optional link to an existing tracker item or project (goal.add, item.add). */
function trackerRefErrors(r, e) {
  if (r === undefined || r === null) return;
  if (!isObj(r)) { e.push('payload.tracker_ref must be an object'); return; }
  if (typeof r.remote_id !== 'string' || !r.remote_id.trim()) e.push('payload.tracker_ref.remote_id required');
  for (const k of Object.keys(r)) if (!['provider', 'remote_id', 'key', 'url', 'kind'].includes(k)) e.push(`payload.tracker_ref.${k} is not allowed`);
  for (const k of ['provider', 'key', 'url']) if (r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string') e.push(`payload.tracker_ref.${k} must be a string`);
  if (r.kind !== undefined && !['issue', 'project'].includes(r.kind)) e.push('payload.tracker_ref.kind must be issue|project');
  if (typeof r.url === 'string' && r.url && !/^https?:\/\//i.test(r.url)) e.push('payload.tracker_ref.url must be http(s)');
}

function payloadErrors(type, p) {
  const e = [];
  const str = (k) => { if (typeof p[k] !== 'string' || !p[k].trim()) e.push(`payload.${k} required`); };
  switch (type) {
    case 'gate.decide': str('gate_id'); if (!['approve', 'changes', 'reject'].includes(p.decision)) e.push('payload.decision must be approve|changes|reject'); break;
    case 'goal.add':
      str('title'); str('outcome');
      if (!Array.isArray(p.success_criteria) || !p.success_criteria.length) e.push('payload.success_criteria needs 1-7 items');
      if (p.priority && !ENUMS.priority.includes(p.priority)) e.push('payload.priority must be P0..P3');
      trackerRefErrors(p.tracker_ref, e);
      break;
    case 'goal.activate': case 'goal.pause': case 'goal.resume': str('goal_id'); break;
    case 'goal.remove': str('goal_id'); if (p.confirm_text !== p.goal_id) e.push('payload.confirm_text must equal goal_id'); break;
    case 'factory.pause': if (!['drain', 'now'].includes(p.mode || 'drain')) e.push('payload.mode must be drain|now'); break;
    case 'budget.override': str('goal_id'); if (!(Number(p.add_tokens) > 0)) e.push('payload.add_tokens must be > 0'); break;
    case 'task.note': str('task_id'); str('text'); break;
    case 'task.answer': str('task_id'); str('text'); break;
    case 'task.retry': case 'task.cancel': case 'task.pause': str('task_id'); break;
    case 'item.add':
      str('team'); str('title');
      if (!['bug', 'tech_debt', 'chore'].includes(p.class)) e.push('payload.class must be bug|tech_debt|chore');
      if (p.priority && !ENUMS.priority.includes(p.priority)) e.push('payload.priority must be P0..P3');
      trackerRefErrors(p.tracker_ref, e);
      if (p.cycle !== undefined && p.cycle !== null && !(typeof p.cycle === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/.test(p.cycle))) e.push('payload.cycle must be a cycle id like core-12 or null');
      break;
    case 'cycle.commit': str('task_id'); str('cycle'); break;
    default: break;
  }
  return e;
}

export function validate(req) {
  const errors = [];
  if (!isObj(req)) return { ok: false, errors: ['request must be an object'] };
  if (req.schema !== 'factory/inbox@1') errors.push('schema must be factory/inbox@1');
  if (typeof req.id !== 'string' || !req.id) errors.push('id required');
  if (typeof req.created_at !== 'string') errors.push('created_at required');
  if (!ENUMS.inbox_source.includes(req.source)) errors.push(`source must be ${ENUMS.inbox_source.join('|')}`);
  if (!isObj(req.actor) || !ENUMS.actor_kind.includes(req.actor.kind)) errors.push('actor.kind must be human|tracker|system');
  if (!knownType(req.type)) errors.push(`unknown type ${req.type}`);
  if (!isObj(req.payload)) errors.push('payload must be an object');
  else errors.push(...payloadErrors(req.type, req.payload));
  return { ok: errors.length === 0, errors };
}

export function inboxDir(home) { return join(home, 'inbox'); }

/** Write a request (tmp then rename). Signs when opts.sign is true. */
export function write(home, { type, payload = {}, source = 'cli', actor = { kind: 'human' }, needs_confirmation = false, auto_apply = false, dedupe_key } = {}, opts = {}) {
  const id = hex(16);
  const req = {
    schema: 'factory/inbox@1', id, created_at: nowIso(), source, actor, type, payload,
    ...(dedupe_key ? { dedupe_key } : {}), needs_confirmation: !!needs_confirmation, auto_apply: !!auto_apply,
  };
  const v = validate(req);
  if (!v.ok) { const e = new Error(`inbox request invalid: ${v.errors.join('; ')}`); e.exitCode = 1; e.errors = v.errors; throw e; }
  if (opts.sign) req.sig = hmacSign(req, opts.key || getKey(home));
  const dir = inboxDir(home);
  ensureDir(dir);
  const name = `${compactTs()}-${id.slice(0, 8)}-${type}.json`;
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(req, null, 2) + '\n');
  retry(() => renameSync(tmp, join(dir, name)));
  return { ...req, file: join(dir, name) };
}

export function pending(home) {
  return listDir(inboxDir(home)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
}

export function hasPendingPause(home) {
  return pending(home).some((n) => /-(factory\.pause|factory\.stop)\.json$/.test(n));
}

function finish(home, name, req, result) {
  const dest = result.status === 'rejected' ? 'rejected' : 'processed';
  ensureDir(join(inboxDir(home), dest));
  const out = { ...(req || {}), result };
  writeJsonAtomic(join(inboxDir(home), dest, name), out);
  try { retry(() => unlinkSync(join(inboxDir(home), name))); } catch { /* ignore */ }
  emit(home, { type: 'inbox.processed', msg: `${(req && req.type) || name} ${result.status}${result.reason ? `: ${result.reason}` : ''}`.slice(0, 140), data: { request_id: (req && req.id) || null, type: (req && req.type) || null, outcome: result.status, reason: result.reason || null, ...(result.gate_id ? { gate_id: result.gate_id } : {}) } });
}

/** Apply one validated request. Returns {status, reason, gate_id?}. */
export async function applyRequest(home, req, { via = 'dashboard', session = null } = {}) {
  const actions = await import('./actions.mjs');
  const flow = await import('./flow.mjs');
  const budget = await import('./budget.mjs');
  const control = await import('./control.mjs');
  const p = req.payload || {};
  const by = (req.actor && (req.actor.name || req.actor.kind)) || 'human';
  const viaSrc = req.source === 'dashboard' ? 'dashboard' : req.source === 'tracker' ? 'tracker' : 'cli';
  switch (req.type) {
    case 'gate.decide': await flow.decideGate(home, p.gate_id, { decision: p.decision, by, via: viaSrc, notes: p.notes || '', add_tokens: p.add_tokens }); break;
    case 'goal.add': {
      const g = actions.newGoal(home, { title: p.title, outcome: p.outcome, success_criteria: p.success_criteria, priority: p.priority, budget_tokens: p.budget_tokens, constraints: p.constraints, notes: p.notes, tracker_ref: p.tracker_ref }, { via: req.source === 'tracker' ? 'tracker' : req.source === 'setup' ? 'setup' : viaSrc, kind: req.actor.kind === 'tracker' ? 'tracker' : 'human' });
      return { status: 'applied', reason: `created ${g.id}` };
    }
    case 'goal.activate': actions.activateGoal(home, p.goal_id); break;
    case 'goal.pause': actions.setGoalPaused(home, p.goal_id, true, 'paused from inbox'); break;
    case 'goal.resume': actions.setGoalPaused(home, p.goal_id, false, 'resumed from inbox'); break;
    case 'goal.remove': {
      const r = actions.removeGoal(home, p.goal_id, { discard: !!p.discard, by, via: viaSrc });
      return { status: 'applied', reason: r.gate ? `cancelled; ${r.gate.id} opened` : 'cancelled', ...(r.gate ? { gate_id: r.gate.id } : {}) };
    }
    case 'factory.pause': control.pause(home, { mode: p.mode || 'drain', session }); break;
    case 'factory.resume': control.resume(home); break;
    case 'factory.stop': control.pause(home, { mode: 'now', stop: true, session }); break;
    case 'budget.override': budget.override(home, p.goal_id, Number(p.add_tokens), { by, via: viaSrc, note: p.note || '' }); break;
    case 'task.note': actions.noteTask(home, p.task_id, p.text, { by }); break;
    case 'task.answer': actions.answerTask(home, p.task_id, p.question_id, p.text, { by }); break;
    case 'task.retry': actions.retryTask(home, p.task_id); break;
    case 'task.cancel': actions.cancelTask(home, p.task_id, 'cancelled from inbox'); break;
    case 'task.pause': actions.pauseTask(home, p.task_id); break;
    case 'item.add': { // contracts §21.4.3
      const streams = await import('./streams.mjs');
      const r = streams.newItem(home, { ...p, reported_by: req.actor && req.actor.kind === 'tracker' ? 'tracker' : 'human' });
      return { status: 'applied', reason: r.created ? `created ${r.task.id}` : r.reason };
    }
    case 'report.request': {
      const ops = await import('./ops.mjs');
      ops.requestReport(home);
      return { status: 'applied', reason: 'report requested for the next tick' };
    }
    case 'cycle.commit': {
      const cycles = await import('./cycles.mjs');
      const { load } = await import('./config.mjs');
      const t = cycles.commit(home, load(home), p.task_id, p.cycle, { by });
      return { status: 'applied', reason: `${t.id} cycle ${t.cycle || 'none'}` };
    }
    case 'sync.now': {
      const { updateFactory } = await import('./state.mjs');
      updateFactory(home, (s) => { s.sync_requested_at = nowIso(); });
      break;
    }
    default: {
      if (/^(tracker|sync)\./.test(req.type || '')) {
        const { applyTracker } = await import('./tracker.mjs');
        return applyTracker(home, req, { by });
      }
      return { status: 'rejected', reason: `no handler for ${req.type}` };
    }
  }
  void via;
  return { status: 'applied', reason: null };
}

/** Process every pending request. ctx = {tick, key?, session?}. */
async function processInbox(home, ctx = {}) {
  const results = [];
  const names = pending(home);
  if (!names.length) return results;
  let key = ctx.key || null;
  const seenFile = join(home, 'state', 'inbox-dedupe.json');
  const seen = readJson(seenFile, {}) || {};
  const store = await import('./store.mjs');
  const items = names.map((name) => ({ name, req: readJson(join(inboxDir(home), name), null) }))
    .sort((a, b) => String((a.req && a.req.created_at) || '').localeCompare(String((b.req && b.req.created_at) || '')) || a.name.localeCompare(b.name));
  for (const { name, req } of items) {
    let result;
    try {
      const v = validate(req);
      if (!v.ok) result = { status: 'rejected', reason: v.errors.join('; ').slice(0, 300) };
      else if (HUMAN_TYPES.includes(req.type)) {
        if (!req.sig) result = { status: 'rejected', reason: 'unsigned human-authority request' };
        else {
          if (!key) { try { key = getKey(home, { create: false }); } catch { key = null; } }
          if (!key || !hmacVerify(req, key)) result = { status: 'rejected', reason: 'bad signature' };
        }
      }
      if (!result && req.dedupe_key && seen[req.dedupe_key]) result = { status: 'superseded', reason: `duplicate of ${seen[req.dedupe_key]}` };
      if (!result && req.needs_confirmation) {
        const summary = /^(tracker|sync)\./.test(req.type) ? (await import('./tracker.mjs')).gateSummary(req) : `${req.type}: ${JSON.stringify(req.payload).slice(0, 500)}`;
        const gate = store.create(home, 'gate', {
          type: 'tracker', subject: { kind: req.payload.task_id ? 'task' : 'goal', id: req.payload.task_id || req.payload.goal_id || null },
          goal_id: req.payload.goal_id || null, status: 'pending', opened_at: nowIso(), opened_by: { run_id: null, actor: req.source },
          artifact: { paths: req.type === 'sync.first_sync' ? ['sync/preview.md'] : [], summary },
          request: { inbox_id: req.id, action: req.type, original: { ...req, sig: undefined } },
        });
        emit(home, { type: 'gate.opened', goal_id: gate.goal_id, msg: `${gate.id} tracker confirmation: ${req.type}`, data: { gate_id: gate.id, type: 'tracker' } });
        result = { status: 'gated', reason: 'needs confirmation', gate_id: gate.id };
      }
      if (!result) result = await applyRequest(home, req, { session: ctx.session || null });
    } catch (e) {
      result = { status: 'rejected', reason: String(e.message || e).slice(0, 300) };
    }
    result.tick = ctx.tick ?? null;
    if (req && req.dedupe_key && ['applied', 'gated'].includes(result.status)) seen[req.dedupe_key] = req.id;
    finish(home, name, req, result);
    results.push({ file: name, id: req && req.id, type: req && req.type, ...result });
  }
  const keys = Object.keys(seen);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete seen[k];
  writeJsonAtomic(seenFile, seen);
  return results;
}

export { processInbox as process };
