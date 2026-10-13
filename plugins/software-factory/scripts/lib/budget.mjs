// Budget: derived spend per goal, reservations ledger, warn/block, override.
import { join } from 'node:path';
import { appendLine, nowIso, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import * as store from './store.mjs';
import { load as loadConfig } from './config.mjs';
import { billed, latestSnapshots } from './usage.mjs';
import { emit } from './events.mjs';
import { NON_RUN_AGENTS } from './roles.mjs';

const ACTIVE = new Set(['running', 'suspect']);

export function budgetPath(home) { return join(home, 'state', 'budget.json'); }
export function ledgerPath(home) { return join(home, 'state', 'ledger.jsonl'); }

export function ledger(home, entry) {
  appendLine(ledgerPath(home), { ts: nowIso(), ...entry });
}

export function runSpend(run, snap, weights) {
  const live = snap ? billed(snap.by_model, weights) : 0;
  if (run.status === 'dispatching') return { spent: 0, reserved: run.estimate_tokens || 0 };
  if (ACTIVE.has(run.status)) return { spent: Math.max(run.estimate_tokens || 0, live), reserved: 0 };
  return { spent: live, reserved: 0 };
}

/** Recompute state/budget.json. Keeps warned_at / blocked_at from the previous file. */
export function compute(home, cfg = loadConfig(home)) {
  const prev = readJson(budgetPath(home), null) || { goals: {} };
  const snaps = latestSnapshots(home);
  const w = cfg.budget.weights;
  const out = { updated_at: nowIso(), goals: {}, overhead: 0, unattributed: 0 };
  const goals = store.list(home, 'goal');
  for (const g of goals) {
    const p = (prev.goals && prev.goals[g.id]) || {};
    out.goals[g.id] = { limit: g.budget.limit_tokens, spent: 0, reserved: 0, pct: 0, warned_at: p.warned_at || null, blocked_at: p.blocked_at || null };
  }
  const runAgents = new Set();
  // Budget windows (contracts §21.1.7): a goal with budget.window_start counts only runs dispatched since.
  const windows = new Map(goals.filter((g) => g.budget && g.budget.window_start).map((g) => [g.id, g.budget.window_start]));
  for (const r of store.list(home, 'run')) {
    if (r.agent_id) runAgents.add(r.agent_id);
    const slot = out.goals[r.goal_id];
    if (!slot) continue;
    const ws = windows.get(r.goal_id);
    if (ws && String(r.dispatched_at || r.created_at || '') < ws) continue;
    const s = runSpend(r, r.agent_id ? snaps.get(r.agent_id) : null, w);
    slot.spent += s.spent; slot.reserved += s.reserved;
  }
  for (const [k, s] of snaps) {
    if (s.scope === 'session') { out.overhead += billed(s.by_model, w); continue; }
    if (NON_RUN_AGENTS.has(s.agent_type)) { out.overhead += billed(s.by_model, w); continue; }
    if (!s.run_id && !runAgents.has(k)) out.unattributed += billed(s.by_model, w);
  }
  for (const b of Object.values(out.goals)) {
    b.pct = b.limit > 0 ? Math.round(((b.spent + b.reserved) / b.limit) * 1000) / 10 : 0;
  }
  writeJsonAtomic(budgetPath(home), out);
  return out;
}

export function read(home) { return readJson(budgetPath(home), null) || compute(home); }

export function wouldExceed(goal, slot, estimate) {
  const limit = goal.budget.limit_tokens * ((goal.budget.stop_pct ?? 100) / 100);
  return (slot ? slot.spent + slot.reserved : 0) + (estimate || 0) > limit;
}

/** Warn at warn_pct once per goal. Returns [{goal_id, pct}] newly warned. */
export function check(home, cfg = loadConfig(home), notifyFn = null) {
  const b = compute(home, cfg);
  const warned = [];
  for (const g of store.list(home, 'goal', (x) => !['done', 'cancelled'].includes(x.status))) {
    const slot = b.goals[g.id];
    if (!slot || slot.limit <= 0) continue;
    const warnPct = g.budget.warn_pct ?? cfg.budget.warn_pct;
    if (slot.pct >= warnPct && !slot.warned_at) {
      slot.warned_at = nowIso();
      warned.push({ goal_id: g.id, pct: slot.pct });
      emit(home, { type: 'budget.warned', goal_id: g.id, msg: `${g.id} budget at ${slot.pct}%`, data: { pct: slot.pct, limit: slot.limit } });
      if (notifyFn) notifyFn('Factory budget', `${g.id} is at ${slot.pct}% of its token budget`);
    }
  }
  writeJsonAtomic(budgetPath(home), b);
  return { budget: b, warned };
}

/** Block a goal: status budget_blocked and one pending budget gate. Returns the gate. */
export function block(home, goalId, estimate, { notifyFn = null } = {}) {
  return withMutex(home, () => {
    const g = store.mustGet(home, 'goal', goalId);
    const b = compute(home);
    const slot = b.goals[goalId] || {};
    let gate = store.list(home, 'gate', (x) => x.type === 'budget' && x.goal_id === goalId && x.status === 'pending')[0];
    if (g.status !== 'budget_blocked') {
      store.update(home, 'goal', goalId, (x) => {
        x.status_before_block = x.status; x.status = 'budget_blocked';
        x.status_reason = `next run would pass ${x.budget.stop_pct ?? 100}% of the token budget`;
      });
      emit(home, { type: 'goal.status', goal_id: goalId, msg: `${goalId} -> budget_blocked`, data: { from: g.status, to: 'budget_blocked' } });
    }
    if (!gate) {
      const suggest = Math.max(estimate * 3, Math.round(g.budget.limit_tokens * 0.25));
      gate = store.create(home, 'gate', {
        type: 'budget', subject: { kind: 'goal', id: goalId }, goal_id: goalId, status: 'pending', opened_at: nowIso(),
        opened_by: { run_id: null, actor: 'factory' },
        artifact: { paths: [], summary: `${goalId} spent ${slot.spent || 0} + reserved ${slot.reserved || 0} of ${g.budget.limit_tokens} tokens. The next run needs about ${estimate}.` },
        request: { add_tokens_suggested: suggest },
      });
      store.update(home, 'goal', goalId, (x) => { x.gates = { ...(x.gates || {}), budget: gate.id }; });
      const bb = readJson(budgetPath(home), b);
      if (bb.goals[goalId]) { bb.goals[goalId].blocked_at = nowIso(); writeJsonAtomic(budgetPath(home), bb); }
      emit(home, { type: 'budget.blocked', goal_id: goalId, msg: `${goalId} budget blocked; ${gate.id} opened`, data: { gate_id: gate.id, estimate } });
      emit(home, { type: 'gate.opened', goal_id: goalId, msg: `${gate.id} budget gate for ${goalId}`, data: { gate_id: gate.id, type: 'budget' } });
      if (notifyFn) notifyFn('Factory budget', `${goalId} is blocked on its token budget. Approve more tokens to continue.`);
    }
    return gate;
  });
}

/**
 * Start a new budget window for a standing goal (contracts §21.1.7): set window_start and the limit,
 * clear budget_blocked (back to active) and supersede the open budget gate. Returns the goal.
 */
export function rollWindow(home, goalId, { windowStart, limit, reason = 'budget window rolled' } = {}) {
  return withMutex(home, () => {
    const before = store.mustGet(home, 'goal', goalId);
    const g = store.update(home, 'goal', goalId, (x) => {
      x.budget.window_start = windowStart;
      if (Number.isFinite(limit) && limit > 0) x.budget.limit_tokens = limit;
      if (x.status === 'budget_blocked') { x.status = 'active'; x.status_reason = reason; delete x.status_before_block; }
    });
    if (before.status === 'budget_blocked') emit(home, { type: 'goal.status', goal_id: goalId, msg: `${goalId} budget_blocked -> active: ${reason}`, data: { from: 'budget_blocked', to: 'active', window: true } });
    for (const gate of store.list(home, 'gate', (x) => x.type === 'budget' && x.goal_id === goalId && x.status === 'pending')) {
      store.update(home, 'gate', gate.id, (x) => { x.status = 'superseded'; x.decision = { by: 'factory', via: 'cli', at: nowIso(), notes: reason }; });
      emit(home, { type: 'gate.decided', goal_id: goalId, msg: `${gate.id} superseded: ${reason}`.slice(0, 140), data: { gate_id: gate.id, decision: 'superseded', window: true } });
    }
    const bb = compute(home);
    if (bb.goals[goalId]) { bb.goals[goalId].blocked_at = null; bb.goals[goalId].warned_at = null; writeJsonAtomic(budgetPath(home), bb); }
    return g;
  });
}

/** Add tokens to a goal and unblock it. */
export function override(home, goalId, addTokens, { by = 'human', via = 'cli', note = '' } = {}) {
  const add = Number(addTokens);
  if (!Number.isFinite(add) || add <= 0) { const e = new Error('--add must be a positive number'); e.exitCode = 2; throw e; }
  return withMutex(home, () => {
    let restored = null;
    const g = store.update(home, 'goal', goalId, (x) => {
      x.budget.limit_tokens += add;
      if (x.status === 'budget_blocked') { restored = x.status_before_block || 'active'; x.status = restored; x.status_reason = 'budget override'; delete x.status_before_block; }
    });
    ledger(home, { kind: 'override', goal_id: goalId, tokens: add, by });
    emit(home, { type: 'budget.overridden', goal_id: goalId, actor: { kind: 'human' }, msg: `${goalId} +${add} tokens`, data: { add_tokens: add, note, via } });
    if (restored) emit(home, { type: 'goal.status', goal_id: goalId, msg: `${goalId} budget_blocked -> ${restored}`, data: { from: 'budget_blocked', to: restored } });
    for (const gate of store.list(home, 'gate', (x) => x.type === 'budget' && x.goal_id === goalId && x.status === 'pending')) {
      store.update(home, 'gate', gate.id, (x) => {
        x.status = 'approved'; x.decision = { by, via, at: nowIso(), notes: note || 'budget override', add_tokens: add };
      });
      emit(home, { type: 'gate.decided', goal_id: goalId, msg: `${gate.id} approved (+${add})`, data: { gate_id: gate.id, decision: 'approve' } });
    }
    const bb = compute(home);
    if (bb.goals[goalId]) {
      bb.goals[goalId].blocked_at = null;
      if (bb.goals[goalId].pct < (g.budget.warn_pct ?? 80)) bb.goals[goalId].warned_at = null;
      writeJsonAtomic(budgetPath(home), bb);
    }
    return g;
  });
}
