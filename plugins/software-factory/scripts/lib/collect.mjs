// collect: apply finished runs (handoffs, check results, deferrals) to tasks. Run inside `tick begin`.
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { nowIso, writeJsonAtomic } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { move, setEpicStatus } from './lifecycle.mjs';
import { escalate } from './actions.mjs';
import { validateHandoff } from './handoff.mjs';
import { BRANCH_KINDS, EPIC_CHECK_KINDS } from './roles.mjs';
import * as flow from './flow.mjs';
import * as budget from './budget.mjs';
import { updateFactory } from './state.mjs';
import { repoRoot, cliPath, fwd } from './paths.mjs';
import * as repos from './repos.mjs';
import * as deps from './deps.mjs';
import { importOutbox } from './outbox.mjs';

export const MAX_FIXUPS = 2;
const CHECK_STALE_MS = 30 * 60 * 1000;

function markCollected(home, runId, result) {
  writeJsonAtomic(join(home, 'runs', runId, 'result.json'), { run_id: runId, at: nowIso(), ...result });
  return store.update(home, 'run', runId, (r) => { r.collected_at = nowIso(); });
}

function release(home, run) {
  budget.ledger(home, { kind: 'release', goal_id: run.goal_id, run_id: run.id, tokens: run.estimate_tokens || 0, by: 'collect' });
}

export function agentWorktreePath(home, run) {
  if (run.worktree_path) return run.worktree_path;
  if (!run.agent_id) return null;
  return fwd(join(repoRoot(home), '.claude', 'worktrees', `agent-${run.agent_id}`));
}

/** Runs from before A9 used Claude Code's native worktree under `.claude/worktrees/agent-*`. */
export function isNativeWorktree(home, run) {
  const wt = agentWorktreePath(home, run);
  return !!wt && /\/\.claude\/worktrees\/agent-/.test(fwd(wt));
}

function runRepo(home, cfg, run) {
  const task = store.get(home, 'task', run.task_id);
  const epic = run.epic_id ? store.get(home, 'epic', run.epic_id) : null;
  return repos.forRecord(home, cfg, { task, epic, run });
}

/**
 * Remove the run's worktree (contracts §20.4.6): the CLI-made `<home>/worktrees/<run>` in the run's repo,
 * every per-repo worktree of a `qa_goal` run and then its parent folder, or the native agent worktree of
 * an older run.
 */
export async function removeRunWorktree(home, run, cfg = loadConfig(home)) {
  const wt = agentWorktreePath(home, run);
  if (!wt || run.isolation !== 'worktree') return null;
  try {
    const w = await deps.load('worktree');
    if (isNativeWorktree(home, run)) {
      return w.removeAgentWorktree({ repoRoot: runRepo(home, cfg, run).path, worktreePath: wt, agentBranch: run.agent_id ? `worktree-agent-${run.agent_id}` : undefined });
    }
    if ((run.repo_worktrees || []).length) {
      for (const rw of run.repo_worktrees) {
        try { w.remove({ repoRoot: repos.get(home, cfg, rw.repo).path, dir: rw.path }); } catch { /* best effort */ }
      }
      rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return { removed: !existsSync(wt) };
    }
    const r = w.remove({ repoRoot: runRepo(home, cfg, run).path, dir: wt });
    return r || null;
  } catch (e) { return { removed: false, reason: e.message }; }
}

const removeAgentWorktree = (home, run) => removeRunWorktree(home, run);

/** Author work on a branch (code/docs author, fixup or integrate run): its worktree may hold unsaved work. */
function authorWork(run, task) { return !run.review_role && (BRANCH_KINDS.has(task.kind) || run.kind === 'integrate'); }

/**
 * After a run is applied: keep its CLI worktree for the task's next author run (which reuses the same
 * path, see dispatch) or remove it. Native worktrees of older runs are handled by the apply paths.
 */
async function settleWorktree(home, run, task, cfg, keep) {
  if (isNativeWorktree(home, run) || run.isolation !== 'worktree' || !run.worktree_path) return;
  if (keep && task && task.id && authorWork(run, task) && !['done', 'cancelled'].includes((store.get(home, 'task', task.id) || {}).status)) {
    store.update(home, 'task', task.id, (x) => { x.kept_worktree = { run_id: run.id, path: fwd(run.worktree_path), repo: run.repo || null }; });
    return;
  }
  await removeRunWorktree(home, run, cfg);
}

async function invalidHandoff(home, run, task, errors, cfg) {
  const t = store.update(home, 'task', task.id, (x) => {
    x.fixups = (x.fixups || 0) + 1;
    x.feedback.push({ source: 'handoff', ref: run.id, path: run.handoff_path, text: `handoff invalid: ${errors.join('; ')}`.slice(0, 1000), at: nowIso() });
  });
  emit(home, { type: 'msg.rework', goal_id: t.goal_id, task_id: t.id, run_id: run.id, msg: `${run.id} handoff invalid (${errors.length} errors)`, data: { from: { role: 'cto' }, to: { role: run.role, run_id: run.id }, errors: errors.slice(0, 10) } });
  if (t.fixups > MAX_FIXUPS) {
    if (t.status !== 'failed' && t.status !== 'cancelled') {
      const f = move(home, t.id, 'failed', { reason: `handoff invalid after ${MAX_FIXUPS} fixups` });
      escalate(home, f, `handoff still invalid after ${MAX_FIXUPS} fixups`);
    }
    return 'failed';
  }
  if (!run.review_role && t.status === 'in_progress') {
    move(home, t.id, 'ready', { reason: 'fixup: handoff invalid', data: { pending_kind: 'fixup' } });
  }
  void cfg;
  return 'fixup';
}

async function applyAuthor(home, run, task, h, cfg) {
  const repo = runRepo(home, cfg, run);
  const root = repo.path;
  if (h.status === 'blocked') {
    const q = (h.open_questions || []).find((x) => x.blocking) || {};
    const toHuman = ['user', 'human', undefined, null, ''].includes(q.to_role);
    const needs = toHuman ? 'human' : (q.to_role === 'cto' ? 'cto' : q.to_role);
    const t = move(home, task.id, 'blocked', {
      reason: `question ${q.id || ''}: ${q.question || ''}`.slice(0, 200),
      data: { blocked: { reason: (q.question || 'blocked').slice(0, 300), question_id: q.id || null, needs, since: nowIso() }, resume_from: h.branch && h.commits && h.commits.length ? { branch: h.branch, commit: h.commits[h.commits.length - 1], checkpoint_path: null } : task.resume_from },
    });
    emit(home, { type: 'msg.question', goal_id: t.goal_id, task_id: t.id, run_id: run.id, msg: `${t.id} asks ${needs}: ${q.question || ''}`.slice(0, 140), data: { from: { role: run.role, run_id: run.id }, to: { role: needs === 'human' ? 'user' : needs }, ref_path: run.handoff_path } });
    if (needs !== 'human') escalate(home, t, `question for ${needs}: ${q.question || ''}`, { ref_path: run.handoff_path });
    if (run.kind !== 'integrate') await removeAgentWorktree(home, run);
    return 'blocked';
  }
  if (h.status === 'failed' || h.status === 'partial') {
    if (h.status === 'partial' && h.branch && (h.commits || []).length) {
      store.update(home, 'task', task.id, (x) => { x.resume_from = { branch: h.branch, commit: h.commits[h.commits.length - 1], checkpoint_path: null }; });
    }
    await removeAgentWorktree(home, run);
    flow.failAttempt(home, task.id, h.summary ? h.summary.split('\n')[0].slice(0, 120) : h.status);
    return h.status;
  }
  // handed_off
  if (run.kind === 'integrate') {
    await removeAgentWorktree(home, run);
    move(home, task.id, 'verified', { reason: 'merge conflict resolved', data: (x) => { x.conflict_files = []; x.pending_kind = null; } });
    return 'integrate_resolved';
  }
  if (task.kind === 'escalation') {
    move(home, task.id, 'done', { reason: 'escalation handled' });
    await flow.onTaskDone(home, store.get(home, 'task', task.id), { cfg });
    return 'done';
  }
  if (EPIC_CHECK_KINDS.has(task.kind)) {
    await removeAgentWorktree(home, run);
    const verdict = h.verdict || 'escalate';
    if (verdict === 'escalate') {
      const b = move(home, task.id, 'blocked', { reason: 'escalated', data: { verdict, blocked: { reason: 'reviewer escalated', question_id: null, needs: 'cto', since: nowIso() } } });
      escalate(home, b, `${task.kind} escalated`, { ref_path: h.report_path });
      return 'escalated';
    }
    move(home, task.id, 'done', { reason: `verdict ${verdict}`, data: { verdict, report_path: h.report_path } });
    if (verdict === 'fail' && task.epic_id) {
      setEpicStatus(home, task.epic_id, 'building', `${task.kind} failed`);
      escalate(home, store.get(home, 'task', task.id), `${task.kind} failed; create rework tasks`, { ref_path: h.report_path });
    } else if (verdict === 'fail' && task.kind === 'qa_goal') {
      // Epics stay in goal_qa; an epic that gets rework tasks goes back to building (flow.advanceEpic).
      escalate(home, store.get(home, 'task', task.id), 'qa_goal failed; create rework tasks in the right epics', { ref_path: h.report_path });
    }
    await flow.onTaskDone(home, store.get(home, 'task', task.id), { cfg });
    return verdict;
  }
  if (BRANCH_KINDS.has(task.kind)) {
    const git = await deps.load('git');
    let head = null;
    try { head = git.headSha(root, task.branch); } catch { head = null; }
    const base = task.base_ref ? (() => { try { return git.headSha(root, task.base_ref); } catch { return null; } })() : null;
    if (!head) return { invalid: [`task branch ${task.branch} not found; commit your work on it`] };
    if (base && head === base) return { invalid: [`task branch ${task.branch} has no new commits`] };
    store.update(home, 'run', run.id, (r) => { r.head_sha = head; r.branch = task.branch; });
    await removeAgentWorktree(home, run);
    const checks = repo.checks.pre_review || [];
    store.update(home, 'task', task.id, (x) => { x.head_sha = head; x.commits = h.commits || []; x.checked_run_id = run.id; x.checks_status = checks.length ? 'running' : 'skipped'; x.resume_from = null; });
    if (!checks.length) { await flow.toReviewOrNext(home, task.id, { cfg }); return 'no_checks'; }
    move(home, task.id, 'checking', { reason: `checks at ${head.slice(0, 8)}`, data: { checks_started_at: nowIso() } });
    try {
      const ck = await deps.load('checks');
      ck.spawnDetached({ cliPath: cliPath(), home, runId: run.id });
    } catch (e) {
      emit(home, { type: 'task.status', task_id: task.id, msg: `check runner spawn failed: ${e.message}`.slice(0, 140) });
    }
    return 'checking';
  }
  if (task.kind === 'spec' && Array.isArray(h.risk_flags) && h.risk_flags.length) {
    store.update(home, 'task', task.id, (x) => {
      x.risk_flags = [...new Set([...(x.risk_flags || []), ...h.risk_flags])];
      if (!x.reviews_required.some((g) => g.includes('security-reviewer'))) x.reviews_required.push(['security-reviewer']);
    });
  }
  await flow.toReviewOrNext(home, task.id, { cfg, runId: run.id });
  return 'handed_off';
}

async function applyReview(home, run, task, h, cfg) {
  if (task.status !== 'in_review') return 'stale';
  let verdict = h.verdict;
  if (h.status !== 'handed_off' || !verdict) verdict = 'escalate';
  await flow.applyReviewVerdict(home, task.id, run.review_role, verdict, { runId: run.id, reportPath: h.report_path || null, findings: h.findings || [], cfg });
  return verdict;
}

/** Collect one completed run. */
export async function collectRun(home, run, { cfg = loadConfig(home) } = {}) {
  const task = store.get(home, 'task', run.task_id);
  release(home, run);
  if (!task || ['cancelled', 'done'].includes(task.status)) {
    await settleWorktree(home, run, task, cfg, false);
    if (task && task.kept_worktree && task.kept_worktree.run_id !== run.id) {
      await removeRunWorktree(home, { ...run, worktree_path: task.kept_worktree.path, repo: task.kept_worktree.repo, repo_worktrees: [] }, cfg);
    }
    markCollected(home, run.id, { status: 'ignored', reason: 'task closed' });
    return { run_id: run.id, outcome: 'ignored' };
  }
  const ob = importOutbox(home, run);
  if (ob.skipped.length) {
    emit(home, { type: 'evidence.rejected', goal_id: run.goal_id, task_id: run.task_id, run_id: run.id, msg: `${run.id}: ignored ${ob.skipped.length} outbox file(s) outside its output paths`, data: { skipped: ob.skipped.slice(0, 20) } });
  }
  const v = validateHandoff(home, run.handoff_path || join(home, 'runs', run.id, 'handoff.json'), { run });
  let outcome;
  if (!v.ok) {
    outcome = await invalidHandoff(home, run, task, v.errors, cfg);
    await settleWorktree(home, run, task, cfg, true); // the fixup run continues in the same worktree
    markCollected(home, run.id, { status: 'invalid', errors: v.errors });
    return { run_id: run.id, task_id: task.id, outcome };
  }
  const h = v.handoff;
  // A valid handoff ends any fix-up streak, so a later run on this task starts with a full allowance.
  if (task.fixups) store.update(home, 'task', task.id, (x) => { x.fixups = 0; });
  outcome = run.review_role ? await applyReview(home, run, task, h, cfg) : await applyAuthor(home, run, task, h, cfg);
  // CLI-made worktrees go once the run is applied (a blocked integrate run keeps its merge state).
  // Keep the worktree when the next author run on this task continues there: a "no new commits" style
  // fixup (uncommitted work must survive) or a blocked integrate run (its merge state). Else remove it.
  await settleWorktree(home, run, task, cfg, !!(outcome && outcome.invalid) || (run.kind === 'integrate' && outcome === 'blocked'));
  if (outcome && outcome.invalid) {
    outcome = await invalidHandoff(home, run, store.get(home, 'task', task.id), outcome.invalid, cfg);
    markCollected(home, run.id, { status: 'invalid', errors: [] });
  } else {
    markCollected(home, run.id, { status: 'valid', handoff_status: h.status, verdict: h.verdict || null, outcome });
  }
  return { run_id: run.id, task_id: task.id, outcome };
}

async function collectDeferred(home, run, cfg) {
  release(home, run);
  const task = store.get(home, 'task', run.task_id);
  if (task && task.status === 'in_progress' && !run.review_role) {
    move(home, task.id, 'ready', {
      reason: 'usage limit; deferred', data: (x) => { if (run.kind !== 'fixup' && run.kind !== 'integrate') x.attempts = Math.max(0, x.attempts - 1); x.pending_kind = x.pending_kind_run || null; },
    });
  }
  const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  updateFactory(home, (s) => { if (!s.backoff_until || Date.parse(s.backoff_until) < Date.parse(until)) s.backoff_until = until; });
  emit(home, { type: 'run.deferred', goal_id: run.goal_id, task_id: run.task_id, run_id: run.id, msg: `${run.id} deferred; backoff until ${until}`, data: { backoff_until: until } });
  await settleWorktree(home, run, task || { kind: null }, cfg, true);
  markCollected(home, run.id, { status: 'deferred' });
  return { run_id: run.id, outcome: 'deferred' };
}

/** Move tasks in `checking` once the check runner has written its result. */
export async function collectChecks(home, { cfg = loadConfig(home) } = {}) {
  const out = [];
  const ck = await deps.load('checks');
  for (const task of store.list(home, 'task', (t) => t.status === 'checking')) {
    let res = null;
    try { res = ck.readResult(home, task.checked_run_id); } catch { res = null; }
    if (!res) {
      const started = Date.parse(task.checks_started_at || task.updated_at);
      if (Date.now() - started > CHECK_STALE_MS && !task.checks_respawned) {
        try { ck.spawnDetached({ cliPath: cliPath(), home, runId: task.checked_run_id }); } catch { /* ignore */ }
        store.update(home, 'task', task.id, (x) => { x.checks_respawned = true; });
      }
      continue;
    }
    if (res.status === 'pass') {
      store.update(home, 'task', task.id, (x) => { x.checks_status = 'pass'; });
      await flow.toReviewOrNext(home, task.id, { cfg });
      out.push({ task_id: task.id, outcome: 'checks_pass' });
    } else {
      const logs = (res.evidence || []).map((id) => id);
      store.update(home, 'task', task.id, (x) => { x.checks_status = 'fail'; });
      await flow.requestChanges(home, task.id, `check failed: ${res.failed_command || res.error || 'unknown'}`, {
        cfg, feedback: { source: 'checks', ref: task.checked_run_id, path: fwd(join(home, 'runs', task.checked_run_id, 'evidence', 'index.jsonl')), text: `failed: ${res.failed_command || res.error || ''} (evidence ${logs.join(', ')})` },
      });
      out.push({ task_id: task.id, outcome: 'checks_fail' });
    }
  }
  return out;
}

/** Apply all finished runs and check results. */
export async function collect(home, { cfg = loadConfig(home) } = {}) {
  const results = [];
  for (const run of store.list(home, 'run', (r) => !r.collected_at && ['completed', 'deferred'].includes(r.status))) {
    try {
      results.push(run.status === 'deferred' ? await collectDeferred(home, run, cfg) : await collectRun(home, run, { cfg }));
    } catch (e) {
      results.push({ run_id: run.id, outcome: 'error', error: e.message });
      emit(home, { type: 'run.ended', run_id: run.id, task_id: run.task_id, msg: `collect error: ${e.message}`.slice(0, 140), data: { error: String(e.stack || e).slice(0, 1500) } });
    }
  }
  results.push(...await collectChecks(home, { cfg }));
  if (results.length) await flow.advance(home, { cfg });
  return results;
}

export function pendingCollect(home) {
  return store.list(home, 'run', (r) => !r.collected_at && ['completed', 'deferred'].includes(r.status)).length
    + store.list(home, 'task', (t) => t.status === 'checking' && existsSync(join(home, 'run', 'checks', `${t.checked_run_id}.json`))).length;
}
