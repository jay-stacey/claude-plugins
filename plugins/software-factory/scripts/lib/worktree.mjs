// Worktree management for software-factory (Team DELIVERY). Pure: no factory record I/O.
import fs from 'node:fs';
import path from 'node:path';
import {
  git, gitOk, headSha, branchExists, worktreeList, currentBranch, toplevel,
  conflictedFiles, normPath, samePath, isInside,
} from './git.mjs';

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** Remove a registered worktree (force, then double force for locked ones), then prune. */
function forceRemove(repoRoot, dir) {
  let r = git(['worktree', 'remove', '--force', dir], { cwd: repoRoot });
  if (r.code !== 0) r = git(['worktree', 'remove', '--force', '--force', dir], { cwd: repoRoot });
  git(['worktree', 'prune'], { cwd: repoRoot });
  return r.code === 0;
}

function mainWorktree(repoRoot) {
  const list = worktreeList(repoRoot);
  return list.length ? list[0].path : null;
}

/**
 * Prepare the agent's worktree (run from inside it).
 * - removes any OTHER worktree holding `branch` (spike finding 3);
 * - switches to `branch` (creates it from `fromRef` when missing);
 * - merges each `mergeFirst` ref with --no-edit (conflict -> abort + MERGE_CONFLICT);
 * - with `detachSha`: `git switch --detach <sha>` (reviewers / QA).
 * @returns {{worktree_path:string, branch:string|null, head_sha:string, detached:boolean, removed_worktrees:string[], merged:string[]}}
 */
export function prepare({ cwd, repoRoot, branch, fromRef, mergeFirst = [], detachSha } = {}) {
  const top = toplevel(cwd || process.cwd());
  if (!top) throw fail('NOT_A_WORKTREE', `not inside a git worktree: ${cwd}`);
  const root = repoRoot ? normPath(repoRoot) : top;

  if (detachSha) {
    const r = git(['switch', '--detach', detachSha], { cwd: top });
    if (r.code !== 0) throw fail('SWITCH_FAILED', `git switch --detach ${detachSha} failed: ${r.stderr}`);
    return { worktree_path: top, branch: null, head_sha: headSha(top), detached: true, removed_worktrees: [], merged: [] };
  }

  if (!branch) throw fail('BAD_ARGS', 'prepare needs a branch or a detachSha');

  // 1. Free the branch from any leftover worktree.
  const removed = [];
  const main = mainWorktree(root);
  for (const wt of worktreeList(root)) {
    if (wt.branch !== branch) continue;
    if (samePath(wt.path, top)) continue; // already ours
    if (main && samePath(wt.path, main)) {
      throw fail('BRANCH_IN_USE', `branch ${branch} is checked out in the main checkout (${wt.path}); switch it away there first`);
    }
    if (isInside(process.cwd(), wt.path)) {
      throw fail('BRANCH_IN_USE', `branch ${branch} is checked out in the current directory ${wt.path}`);
    }
    if (!forceRemove(root, wt.path) && fs.existsSync(wt.path)) {
      throw fail('WORKTREE_REMOVE_FAILED', `could not remove worktree ${wt.path} holding ${branch}`);
    }
    removed.push(wt.path);
  }
  git(['worktree', 'prune'], { cwd: root });

  // 2. Switch to (or create) the branch.
  if (currentBranch(top) !== branch) {
    let r;
    if (branchExists(top, branch)) {
      r = git(['switch', branch], { cwd: top });
    } else {
      if (!fromRef) throw fail('BAD_ARGS', `branch ${branch} does not exist and no fromRef was given`);
      r = git(['switch', '-c', branch, fromRef], { cwd: top });
    }
    if (r.code !== 0) throw fail('SWITCH_FAILED', `git switch ${branch} failed: ${r.stderr}`);
  }

  // 3. Merge prerequisites.
  const merged = [];
  for (const ref of mergeFirst || []) {
    if (!ref) continue;
    const r = git(['merge', '--no-edit', ref], { cwd: top });
    if (r.code !== 0) {
      const files = conflictedFiles(top);
      git(['merge', '--abort'], { cwd: top });
      if (files.length) {
        throw fail('MERGE_CONFLICT', `merge of ${ref} into ${branch} conflicts in: ${files.join(', ')}`, { files, ref });
      }
      throw fail('MERGE_FAILED', `git merge ${ref} failed: ${r.stderr || r.stdout}`, { files: [], ref });
    }
    merged.push(ref);
  }

  return { worktree_path: top, branch, head_sha: headSha(top), detached: false, removed_worktrees: removed, merged };
}

/**
 * Remove the native agent worktree and delete its `worktree-agent-*` branch.
 * Safe: never removes the main checkout or the current directory; never deletes a branch that is
 * not prefixed `worktree-agent-` or that is still checked out somewhere.
 * @returns {{removed:boolean, branch_deleted:boolean, branch:string|null, reason?:string}}
 */
export function removeAgentWorktree({ repoRoot, worktreePath, agentBranch } = {}) {
  const root = normPath(repoRoot);
  const target = normPath(worktreePath);
  const list = worktreeList(root);
  const entry = list.find((w) => samePath(w.path, target));
  const branch = agentBranch || entry?.branch || null;
  const out = { removed: false, branch_deleted: false, branch };

  if (list.length && samePath(list[0].path, target)) {
    out.reason = 'refusing to remove the main checkout';
    return out;
  }
  if (isInside(process.cwd(), target)) {
    out.reason = 'refusing to remove the current directory';
    return out;
  }
  if (entry) {
    out.removed = forceRemove(root, target) || !fs.existsSync(target);
    if (!out.removed) out.reason = `git worktree remove failed for ${target}`;
  } else {
    git(['worktree', 'prune'], { cwd: root });
    out.reason = 'not a registered worktree';
  }

  if (branch) {
    if (!branch.startsWith('worktree-agent-')) {
      out.reason = out.reason || `kept branch ${branch}: not a worktree-agent-* branch`;
    } else if (worktreeList(root).some((w) => w.branch === branch)) {
      out.reason = out.reason || `kept branch ${branch}: still checked out`;
    } else if (branchExists(root, branch)) {
      out.branch_deleted = git(['branch', '-D', branch], { cwd: root }).code === 0;
    }
  }
  return out;
}

/** `git worktree add --detach <dir> <sha>`; replaces a stale worktree at the same dir. */
export function addDetached({ repoRoot, dir, sha } = {}) {
  const root = normPath(repoRoot);
  const abs = normPath(dir);
  const existing = worktreeList(root).find((w) => samePath(w.path, abs));
  if (existing) forceRemove(root, abs);
  else git(['worktree', 'prune'], { cwd: root });
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  gitOk(['worktree', 'add', '--detach', abs, sha], { cwd: root });
  return abs;
}

/** Remove a CLI-managed worktree. Leftover files of a registered worktree are deleted too. */
export function remove({ repoRoot, dir } = {}) {
  const root = normPath(repoRoot);
  const abs = normPath(dir);
  const list = worktreeList(root);
  if (list.length && samePath(list[0].path, abs)) return { removed: false, reason: 'refusing to remove the main checkout' };
  const entry = list.find((w) => samePath(w.path, abs));
  if (!entry) {
    git(['worktree', 'prune'], { cwd: root });
    return { removed: false, reason: 'not a registered worktree' };
  }
  forceRemove(root, abs);
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  git(['worktree', 'prune'], { cwd: root });
  return { removed: !fs.existsSync(abs) };
}

/**
 * Delete factory branches. Only `factory/*` and `worktree-agent-*` branches are touched, and never a
 * branch that is checked out in any worktree.
 * @returns {{deleted:string[], skipped:{branch:string, reason:string}[]}}
 */
export function pruneBranches({ repoRoot, branches = [] } = {}) {
  const root = normPath(repoRoot);
  git(['worktree', 'prune'], { cwd: root });
  const checkedOut = new Set(worktreeList(root).map((w) => w.branch).filter(Boolean));
  const deleted = [];
  const skipped = [];
  for (const b of branches) {
    if (!b) continue;
    if (!b.startsWith('factory/') && !b.startsWith('worktree-agent-')) {
      skipped.push({ branch: b, reason: 'not a factory branch' });
    } else if (checkedOut.has(b)) {
      skipped.push({ branch: b, reason: 'checked out in a worktree' });
    } else if (!branchExists(root, b)) {
      skipped.push({ branch: b, reason: 'does not exist' });
    } else if (git(['branch', '-D', b], { cwd: root }).code === 0) {
      deleted.push(b);
    } else {
      skipped.push({ branch: b, reason: 'git branch -D failed' });
    }
  }
  return { deleted, skipped };
}
