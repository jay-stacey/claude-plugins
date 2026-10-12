// Epic integration for software-factory (Team DELIVERY).
// Serial `--no-ff` merge of task branches into the epic branch in a CLI-managed worktree.
import fs from 'node:fs';
import path from 'node:path';
import {
  git, gitOk, headSha, branchExists, worktreeList, currentBranch, isAncestor, conflictedFiles,
  normPath, samePath,
} from './git.mjs';
import * as evidence from './evidence.mjs';

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** Worktree folder name for an epic branch: `E-0001` when present, else a branch-safe name. */
export function worktreeName(epicBranch) {
  const m = /(E-\d+)/.exec(epicBranch || '');
  if (m) return m[1];
  return String(epicBranch || 'epic').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'epic';
}

/** Create or reuse `<home>/worktrees/<name>` on `epicBranch`. Returns the worktree path. */
export function ensureEpicWorktree({ repoRoot, home, epicBranch, baseRef, name }) {
  const root = normPath(repoRoot);
  const dir = normPath(path.join(home, 'worktrees', name || worktreeName(epicBranch)));
  if (!branchExists(root, epicBranch)) {
    if (!baseRef) throw fail('BAD_ARGS', `epic branch ${epicBranch} does not exist and no baseRef was given`);
    gitOk(['branch', epicBranch, baseRef], { cwd: root });
  }
  git(['worktree', 'prune'], { cwd: root });
  const list = worktreeList(root);
  const ours = list.find((w) => samePath(w.path, dir));
  const holder = list.find((w) => w.branch === epicBranch && !samePath(w.path, dir));
  if (holder) {
    throw fail('BRANCH_IN_USE', `epic branch ${epicBranch} is checked out in ${holder.path}; free it first`);
  }
  if (ours && ours.branch !== epicBranch) {
    git(['worktree', 'remove', '--force', dir], { cwd: root });
    git(['worktree', 'prune'], { cwd: root });
  }
  if (!ours || ours.branch !== epicBranch) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gitOk(['worktree', 'add', dir, epicBranch], { cwd: root });
  } else {
    // Reused: clear any half-finished merge and tracked edits left by an earlier attempt.
    if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir }).code === 0) git(['merge', '--abort'], { cwd: dir });
    if (git(['status', '--porcelain', '--untracked-files=no'], { cwd: dir }).stdout) git(['reset', '--hard', 'HEAD'], { cwd: dir });
  }
  if (currentBranch(dir) !== epicBranch) throw fail('SWITCH_FAILED', `integration worktree ${dir} is not on ${epicBranch}`);
  return dir;
}

/**
 * Merge task branches (in the given order) into the epic branch, then run post-merge checks.
 * Stops at the first conflict (merge aborted, conflict returned). Branches already contained in the
 * epic branch count as merged.
 * @returns {{merged:string[], already:string[], conflict:{branch:string, files:string[]}|null,
 *            post_merge:{status:'pass'|'fail', failed_command:string|null, evidence:string[]}|null,
 *            head_sha:string, worktree_path:string}}
 */
export function mergeTasks({ repoRoot, home, epicBranch, baseRef, taskBranches = [], postMerge = [], runDir, name, timeoutMs } = {}) {
  const dir = ensureEpicWorktree({ repoRoot, home, epicBranch, baseRef, name });
  const merged = [];
  const already = [];
  let conflict = null;

  for (const branch of taskBranches) {
    if (!branch) continue;
    if (!headSha(dir, branch)) {
      conflict = { branch, files: [], error: `branch ${branch} not found` };
      break;
    }
    if (isAncestor(dir, branch, 'HEAD')) {
      already.push(branch);
      merged.push(branch);
      continue;
    }
    const r = git(['merge', '--no-ff', '--no-edit', branch], { cwd: dir });
    if (r.code !== 0) {
      const files = conflictedFiles(dir);
      git(['merge', '--abort'], { cwd: dir });
      conflict = files.length ? { branch, files } : { branch, files: [], error: r.stderr || r.stdout };
      break;
    }
    merged.push(branch);
  }

  let post_merge = null;
  const cmds = (postMerge || []).filter(Boolean);
  if (!conflict && cmds.length) {
    const evDir = runDir || path.join(home, 'run', 'integrate', name || worktreeName(epicBranch));
    const sha = headSha(dir);
    post_merge = { status: 'pass', failed_command: null, evidence: [] };
    for (const command of cmds) {
      const entry = evidence.run({ runDir: evDir, label: 'post-merge', command, cwd: dir, source: 'cli', headSha: sha, timeoutMs });
      post_merge.evidence.push(entry.id);
      if (entry.exit_code !== 0) {
        post_merge.status = 'fail';
        post_merge.failed_command = command;
        break;
      }
    }
  }

  return { merged, already, conflict, post_merge, head_sha: headSha(dir), worktree_path: dir };
}
