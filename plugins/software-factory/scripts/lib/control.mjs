// Factory control: start, pause (drain/now/stop), resume, run checkpoint, run stop.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, ensureDir } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { move } from './lifecycle.mjs';
import { acquireLease, readFactory, releaseLease, setStatus } from './state.mjs';
import { setGoalPaused } from './actions.mjs';
import * as budget from './budget.mjs';
import { ACTIVE_RUN } from './dispatch.mjs';
import { fwd } from './paths.mjs';
import * as deps from './deps.mjs';

const FACTORY_PAUSE = 'factory pause';

function activeRuns(home) { return store.list(home, 'run', (r) => ACTIVE_RUN.has(r.status)); }

function unpauseTasks(home) {
  let n = 0;
  for (const t of store.list(home, 'task', (x) => x.status === 'paused' && x.status_reason === FACTORY_PAUSE)) {
    move(home, t.id, 'ready', { actor: 'human', reason: 'factory resumed' });
    n++;
  }
  return n;
}

export function start(home, { session, takeover = false } = {}) {
  const l = acquireLease(home, session, { takeover });
  if (!l.ok) { const e = new Error(`LEASE held by ${l.holder}; close that session or use --takeover`); e.exitCode = 3; throw e; }
  setStatus(home, 'running', 'started', (s) => { s.pause_mode = null; s.tick.waiting_streak = 0; });
  const n = unpauseTasks(home);
  const lines = [`STARTED lease ${l.stolen ? 'taken over' : 'held'} by ${session}`];
  if (n) lines.push(`resumed ${n} paused tasks`);
  lines.push('NEXT invoke the loop skill with /software-factory:tick');
  return lines;
}

export function resume(home) {
  setStatus(home, 'running', 'resumed', (s) => { s.pause_mode = null; s.tick.waiting_streak = 0; });
  const n = unpauseTasks(home);
  return [`RESUMED${n ? ` (${n} tasks back to ready)` : ''}`];
}

/** Returns output lines. `STOP <run_id> <agent_id>` per active run for --now/--stop. */
export function pause(home, { mode = 'drain', stop = false, goal = null, session = null } = {}) {
  if (goal) {
    setGoalPaused(home, goal, true, 'paused by user');
    const runs = activeRuns(home).filter((r) => r.goal_id === goal);
    return [`PAUSED goal ${goal}; ${runs.length} running agents finish their current task`];
  }
  const lines = [];
  const f = readFactory(home);
  if (f && f.status !== 'stopped') setStatus(home, 'pausing', mode === 'now' || stop ? 'pause now' : 'drain', (s) => { s.pause_mode = stop ? 'stop' : mode; });
  if (mode === 'now' || stop) {
    for (const r of activeRuns(home)) {
      if (r.status === 'dispatching' && !r.agent_id) {
        stopRun(home, r.id, { reason: 'paused before start' });
        continue;
      }
      lines.push(`STOP ${r.id} ${r.agent_id || 'unknown'}`);
    }
  }
  if (stop) {
    releaseLease(home, session || undefined);
    setStatus(home, 'stopped', 'stopped by user', (s) => { s.tick.next_wakeup_at = null; });
    lines.push('STOPPED lease released; only /software-factory:start restarts');
  } else if (!activeRuns(home).length) {
    setStatus(home, 'paused', mode === 'now' ? 'paused now' : 'drained');
    lines.push('PAUSED no runs active');
  } else {
    lines.push(`PAUSING ${mode}; ${activeRuns(home).length} runs active`);
  }
  return lines;
}

/** After TaskStop: save work (commit or patch), mark the run stopped and the task paused with resume_from. */
export async function checkpointRun(home, runId) {
  const run = store.mustGet(home, 'run', runId);
  const task = store.get(home, 'task', run.task_id);
  const lines = [];
  let commit = null; let patch = null;
  const wt = run.worktree_path || (run.agent_id && run.isolation === 'worktree' ? fwd(join(home, '..', '.claude', 'worktrees', `agent-${run.agent_id}`)) : null);
  if (wt && existsSync(wt) && !run.review_role && task && task.branch) {
    try {
      const git = await deps.load('git');
      const st = git.git(['status', '--porcelain'], { cwd: wt });
      if (st.code === 0 && st.stdout.trim()) {
        git.git(['add', '-A'], { cwd: wt });
        const c = git.git(['commit', '-m', `factory checkpoint ${runId}`], { cwd: wt });
        if (c.code !== 0) {
          const d = git.git(['diff', 'HEAD'], { cwd: wt });
          patch = join(home, 'runs', runId, 'checkpoint.patch');
          ensureDir(join(home, 'runs', runId));
          writeFileSync(patch, d.stdout || '');
          lines.push(`commit hook failed; saved patch ${fwd(patch)}`);
        }
      }
      commit = git.headSha(wt);
    } catch (e) { lines.push(`checkpoint git error: ${e.message}`); }
  }
  const cpPath = join(home, 'runs', runId, 'checkpoint.md');
  ensureDir(join(home, 'runs', runId));
  writeFileSync(cpPath, `# Checkpoint ${runId}\n\nStopped at ${nowIso()}.\nBranch: ${task && task.branch}\nCommit: ${commit || 'none'}\n${patch ? `Patch: ${fwd(patch)}\n` : ''}`);
  if (['dispatching', 'running', 'suspect'].includes(run.status)) {
    store.update(home, 'run', runId, (r) => { r.status = 'stopped'; r.ended_at = nowIso(); r.exit = { reason: 'checkpoint', message: 'stopped by pause' }; r.collected_at = nowIso(); });
    budget.ledger(home, { kind: 'release', goal_id: run.goal_id, run_id: runId, tokens: run.estimate_tokens || 0, by: 'checkpoint' });
    emit(home, { type: 'run.ended', run_id: runId, task_id: run.task_id, goal_id: run.goal_id, msg: `${runId} stopped and checkpointed` });
  }
  if (task && !run.review_role && task.current_run_id === runId && task.status === 'in_progress') {
    move(home, task.id, 'paused', {
      reason: FACTORY_PAUSE,
      data: (x) => {
        x.attempts = Math.max(0, x.attempts - 1);
        x.pending_kind = x.pending_kind_run || null;
        if (task.branch && commit) x.resume_from = { branch: task.branch, commit, checkpoint_path: fwd(cpPath) };
      },
    });
  }
  lines.unshift(`CHECKPOINT ${runId} ${commit ? commit.slice(0, 10) : 'no-commit'}`);
  maybePaused(home);
  return lines;
}

export function stopRun(home, runId, { reason = 'stopped' } = {}) {
  const run = store.mustGet(home, 'run', runId);
  if (ACTIVE_RUN.has(run.status)) {
    store.update(home, 'run', runId, (r) => { r.status = 'stopped'; r.ended_at = nowIso(); r.exit = { reason: 'stopped', message: reason }; r.collected_at = nowIso(); });
    budget.ledger(home, { kind: 'release', goal_id: run.goal_id, run_id: runId, tokens: run.estimate_tokens || 0, by: 'stop' });
    emit(home, { type: 'run.ended', run_id: runId, task_id: run.task_id, goal_id: run.goal_id, msg: `${runId} stopped: ${reason}`.slice(0, 140) });
  }
  const task = store.get(home, 'task', run.task_id);
  if (task && !run.review_role && task.current_run_id === runId && task.status === 'in_progress') {
    move(home, task.id, 'ready', { reason, data: (x) => { x.attempts = Math.max(0, x.attempts - 1); x.pending_kind = x.pending_kind_run || null; } });
  }
  return [`STOPPED ${runId}`];
}

/** pausing -> paused when nothing is running. */
export function maybePaused(home) {
  const f = readFactory(home);
  if (f && f.status === 'pausing' && !activeRuns(home).length) setStatus(home, 'paused', f.pause_mode === 'now' ? 'paused now' : 'drained');
}
