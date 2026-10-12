// Recovery: never-started dispatches, suspect and orphaned runs. Never orphans own-session runs on time alone.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { move } from './lifecycle.mjs';
import * as flow from './flow.mjs';
import * as budget from './budget.mjs';
import { writeSnapshot, latestSnapshots } from './usage.mjs';
import * as repos from './repos.mjs';
import { usesOutbox, outboxDir } from './outbox.mjs';
import * as deps from './deps.mjs';

export const NEVER_STARTED_S = 600;

function lastActivity(run, mtimes) {
  return Math.max(mtimes[run.id] || 0, Date.parse(run.started_at || run.dispatched_at || run.created_at) || 0);
}

export async function recover(home, { session = null, mtimes = {}, cfg = loadConfig(home), now = Date.now() } = {}) {
  const out = [];
  const orphanMs = (cfg.recovery.orphan_after_s || 1800) * 1000;
  for (const run of store.list(home, 'run', (r) => ['dispatching', 'running', 'suspect'].includes(r.status))) {
    const idle = now - lastActivity(run, mtimes);
    const task = store.get(home, 'task', run.task_id);
    if (run.status === 'dispatching') {
      if (!run.agent_id && idle > NEVER_STARTED_S * 1000) {
        store.update(home, 'run', run.id, (r) => { r.status = 'failed'; r.ended_at = nowIso(); r.exit = { reason: 'never_started', message: 'Agent call never bound' }; r.collected_at = nowIso(); });
        budget.ledger(home, { kind: 'release', goal_id: run.goal_id, run_id: run.id, tokens: run.estimate_tokens || 0, by: 'recovery' });
        if (task && task.status === 'in_progress' && task.current_run_id === run.id) {
          move(home, task.id, 'ready', { reason: 'dispatch never started', data: (x) => { x.attempts = Math.max(0, x.attempts - 1); x.pending_kind = x.pending_kind_run || null; } });
        }
        emit(home, { type: 'run.lost', source: 'reconcile', run_id: run.id, task_id: run.task_id, goal_id: run.goal_id, msg: `${run.id} never started` });
        out.push({ run_id: run.id, outcome: 'never_started' });
      }
      continue;
    }
    const outboxHandoff = usesOutbox(run) && outboxDir(run) ? join(outboxDir(run), 'handoff.json') : null; // worktree runs write here first
    if (((run.handoff_path && existsSync(run.handoff_path)) || (outboxHandoff && existsSync(outboxHandoff))) && idle > 120000) {
      store.update(home, 'run', run.id, (r) => { r.status = 'completed'; r.ended_at = r.ended_at || nowIso(); r.exit = { reason: 'handoff', message: 'handoff file found by recovery' }; });
      emit(home, { type: 'run.ended', source: 'reconcile', run_id: run.id, task_id: run.task_id, goal_id: run.goal_id, msg: `${run.id} ended (handoff found)` });
      out.push({ run_id: run.id, outcome: 'completed' });
      continue;
    }
    const own = session && run.session_id === session;
    if (own) {
      if (run.status === 'suspect') store.update(home, 'run', run.id, (r) => { r.status = 'running'; });
      continue;
    }
    if (idle <= orphanMs) {
      if (run.status === 'suspect') store.update(home, 'run', run.id, (r) => { r.status = 'running'; });
      continue;
    }
    if (run.status === 'running') {
      store.update(home, 'run', run.id, (r) => { r.status = 'suspect'; });
      out.push({ run_id: run.id, outcome: 'suspect' });
      continue;
    }
    // suspect for a tick and still idle -> orphaned
    store.update(home, 'run', run.id, (r) => { r.status = 'orphaned'; r.ended_at = nowIso(); r.exit = { reason: 'orphaned', message: `no activity for ${Math.round(idle / 1000)} s` }; r.collected_at = nowIso(); });
    budget.ledger(home, { kind: 'release', goal_id: run.goal_id, run_id: run.id, tokens: run.estimate_tokens || 0, by: 'recovery' });
    const snap = run.agent_id ? latestSnapshots(home).get(run.agent_id) : null;
    if (run.agent_id) {
      writeSnapshot(home, { source: 'reconcile', scope: 'agent', agent_id: run.agent_id, session_id: run.session_id, run_id: run.id, task_id: run.task_id, goal_id: run.goal_id, role: run.role, status: 'lost', requests: snap ? snap.requests : 0, by_model: snap ? snap.by_model : {} });
    }
    emit(home, { type: 'run.lost', source: 'reconcile', run_id: run.id, task_id: run.task_id, goal_id: run.goal_id, msg: `${run.id} orphaned` });
    if (task && task.status === 'in_progress' && task.current_run_id === run.id) {
      if (task.branch) {
        try {
          const git = await deps.load('git');
          const epic = task.epic_id ? store.get(home, 'epic', task.epic_id) : null;
          const head = git.headSha(repos.forRecord(home, cfg, { task, epic, run }).path, task.branch);
          if (head) store.update(home, 'task', task.id, (x) => { x.resume_from = { branch: task.branch, commit: head, checkpoint_path: existsSync(join(home, 'runs', run.id, 'checkpoint.md')) ? join(home, 'runs', run.id, 'checkpoint.md').replace(/\\/g, '/') : null }; });
        } catch { /* ignore */ }
      }
      flow.failAttempt(home, task.id, 'run orphaned');
    }
    out.push({ run_id: run.id, outcome: 'orphaned' });
  }
  return out;
}
