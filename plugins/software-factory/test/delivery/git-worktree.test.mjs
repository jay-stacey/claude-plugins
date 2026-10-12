import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as g from '../../scripts/lib/git.mjs';
import * as wt from '../../scripts/lib/worktree.mjs';
import { mkRepo, sh, write, commitAll, branchWith, cleanup, slash } from '../fixtures/delivery/repo.mjs';

test('git helpers: headSha, branchExists, currentBranch, isAncestor, worktreeList, slugify', () => {
  const { root, repo } = mkRepo();
  try {
    const main = g.headSha(repo);
    assert.match(main, /^[0-9a-f]{40}$/);
    assert.equal(g.headSha(repo, 'nope'), null);
    assert.equal(g.branchExists(repo, 'main'), true);
    assert.equal(g.branchExists(repo, 'factory/x'), false);
    assert.equal(g.currentBranch(repo), 'main');
    const b = branchWith(repo, 'factory/T-0001-a', 'main', 'a.txt', 'a\n');
    assert.equal(g.isAncestor(repo, main, b), true);
    assert.equal(g.isAncestor(repo, b, main), false);
    const list = g.worktreeList(repo);
    assert.equal(list.length, 1);
    assert.equal(list[0].branch, 'main');
    assert.equal(list[0].path, slash(repo));
    assert.ok(!list[0].path.includes('\\'));
    assert.equal(g.slugify('Add VIN Decoder: ÉTAPE #2!!'), 'add-vin-decoder-etape-2');
    assert.equal(g.slugify('a'.repeat(40)).length, 30);
    assert.equal(g.slugify('word '.repeat(10), 12), 'word-word-wo');
    assert.equal(g.git(['status', '--porcelain'], { cwd: repo }).code, 0);
  } finally {
    cleanup(root);
  }
});

test('prepare removes a leftover worktree that holds the task branch, then switches to it', () => {
  const { root, repo } = mkRepo();
  try {
    // Leftover native agent worktree from an earlier run, still holding the task branch.
    const old = path.join(repo, '.claude', 'worktrees', 'agent-old');
    sh(repo, 'worktree', 'add', '-q', '-b', 'factory/T-0001-x', old, 'main');
    write(old, 'src/a.txt', 'one\n');
    const tip = commitAll(old, 'work');
    // New agent worktree for this run.
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-new');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-new', agent, 'main');

    const res = wt.prepare({ cwd: agent, repoRoot: repo, branch: 'factory/T-0001-x', fromRef: 'main', mergeFirst: [] });
    assert.equal(res.branch, 'factory/T-0001-x');
    assert.equal(res.head_sha, tip);
    assert.equal(res.worktree_path, slash(agent));
    assert.equal(res.removed_worktrees.length, 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(g.currentBranch(agent), 'factory/T-0001-x');
    assert.ok(!g.worktreeList(repo).some((w) => g.samePath(w.path, old)));
  } finally {
    cleanup(root);
  }
});

test('prepare creates the branch from fromRef and merges mergeFirst', () => {
  const { root, repo } = mkRepo();
  try {
    branchWith(repo, 'factory/E-0001-e', 'main', 'epic.txt', 'epic\n');
    const dep = branchWith(repo, 'factory/T-0001-dep', 'factory/E-0001-e', 'dep.txt', 'dep\n');
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-a1');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', agent, 'main');
    const res = wt.prepare({ cwd: agent, repoRoot: repo, branch: 'factory/T-0002-x', fromRef: 'factory/E-0001-e', mergeFirst: ['factory/T-0001-dep'] });
    assert.equal(g.currentBranch(agent), 'factory/T-0002-x');
    assert.deepEqual(res.merged, ['factory/T-0001-dep']);
    assert.ok(g.isAncestor(agent, dep, 'HEAD'));
    assert.ok(fs.existsSync(path.join(agent, 'epic.txt')));
    assert.ok(fs.existsSync(path.join(agent, 'dep.txt')));
    // Second call is idempotent (already on branch, dep already merged).
    const again = wt.prepare({ cwd: agent, repoRoot: repo, branch: 'factory/T-0002-x', fromRef: 'factory/E-0001-e', mergeFirst: ['factory/T-0001-dep'] });
    assert.equal(again.head_sha, res.head_sha);
  } finally {
    cleanup(root);
  }
});

test('prepare: merge conflict aborts and throws MERGE_CONFLICT with files', () => {
  const { root, repo } = mkRepo();
  try {
    branchWith(repo, 'factory/T-0001-a', 'main', 'README.md', 'from a\n');
    branchWith(repo, 'factory/T-0002-b', 'main', 'README.md', 'from b\n');
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-c1');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-c1', agent, 'main');
    let err;
    try {
      wt.prepare({ cwd: agent, repoRoot: repo, branch: 'factory/T-0002-b', fromRef: 'main', mergeFirst: ['factory/T-0001-a'] });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected a throw');
    assert.equal(err.code, 'MERGE_CONFLICT');
    assert.deepEqual(err.files, ['README.md']);
    assert.equal(err.ref, 'factory/T-0001-a');
    assert.notEqual(g.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: agent }).code, 0, 'merge was aborted');
    assert.equal(sh(agent, 'status', '--porcelain'), '');
  } finally {
    cleanup(root);
  }
});

test('prepare with detachSha checks out the SHA detached', () => {
  const { root, repo } = mkRepo();
  try {
    const sha = branchWith(repo, 'factory/T-0001-a', 'main', 'x.txt', 'x\n');
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-r1');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-r1', agent, 'main');
    const res = wt.prepare({ cwd: agent, repoRoot: repo, detachSha: sha });
    assert.equal(res.head_sha, sha);
    assert.equal(res.detached, true);
    assert.equal(res.branch, null);
    assert.equal(g.currentBranch(agent), null);
  } finally {
    cleanup(root);
  }
});

test('prepare refuses when the branch is checked out in the main checkout', () => {
  const { root, repo } = mkRepo();
  try {
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-m1');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-m1', agent, 'main');
    sh(repo, 'switch', '-q', '-c', 'factory/T-0009-z');
    assert.throws(() => wt.prepare({ cwd: agent, repoRoot: repo, branch: 'factory/T-0009-z', fromRef: 'main' }), (e) => e.code === 'BRANCH_IN_USE');
  } finally {
    cleanup(root);
  }
});

test('removeAgentWorktree removes the dir and deletes only worktree-agent-* branches', () => {
  const { root, repo } = mkRepo();
  try {
    const agent = path.join(repo, '.claude', 'worktrees', 'agent-d1');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-d1', agent, 'main');
    write(agent, 'f.txt', 'f\n');
    commitAll(agent, 'agent work');
    const r = wt.removeAgentWorktree({ repoRoot: repo, worktreePath: agent });
    assert.equal(r.removed, true);
    assert.equal(r.branch_deleted, true);
    assert.equal(fs.existsSync(agent), false);
    assert.equal(g.branchExists(repo, 'worktree-agent-d1'), false);

    // A worktree on a task branch: the dir goes, the branch stays (wrong prefix).
    const agent2 = path.join(repo, '.claude', 'worktrees', 'agent-d2');
    sh(repo, 'worktree', 'add', '-q', '-b', 'factory/T-0003-keep', agent2, 'main');
    const r2 = wt.removeAgentWorktree({ repoRoot: repo, worktreePath: agent2 });
    assert.equal(r2.removed, true);
    assert.equal(r2.branch_deleted, false);
    assert.equal(g.branchExists(repo, 'factory/T-0003-keep'), true);

    // An agent branch still checked out elsewhere is kept.
    const other = path.join(repo, '.claude', 'worktrees', 'agent-d3');
    sh(repo, 'worktree', 'add', '-q', '-b', 'worktree-agent-d3', other, 'main');
    const r3 = wt.removeAgentWorktree({ repoRoot: repo, worktreePath: path.join(repo, 'gone'), agentBranch: 'worktree-agent-d3' });
    assert.equal(r3.removed, false);
    assert.equal(r3.branch_deleted, false);
    assert.equal(g.branchExists(repo, 'worktree-agent-d3'), true);

    // Never the main checkout.
    const r4 = wt.removeAgentWorktree({ repoRoot: repo, worktreePath: repo });
    assert.equal(r4.removed, false);
    assert.ok(fs.existsSync(path.join(repo, 'README.md')));
  } finally {
    cleanup(root);
  }
});

test('addDetached / remove / pruneBranches', () => {
  const { root, repo } = mkRepo();
  try {
    const sha = branchWith(repo, 'factory/T-0004-p', 'main', 'p.txt', 'p\n');
    const dir = path.join(root, 'h', 'worktrees', 'checks-R-1');
    const out = wt.addDetached({ repoRoot: repo, dir, sha });
    assert.equal(g.headSha(out), sha);
    // Re-adding over an existing worktree works.
    wt.addDetached({ repoRoot: repo, dir, sha });
    assert.equal(wt.remove({ repoRoot: repo, dir }).removed, true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(wt.remove({ repoRoot: repo, dir: repo }).removed, false);

    sh(repo, 'branch', 'feature/user');
    const res = wt.pruneBranches({ repoRoot: repo, branches: ['factory/T-0004-p', 'feature/user', 'main', 'factory/none'] });
    assert.deepEqual(res.deleted, ['factory/T-0004-p']);
    assert.equal(g.branchExists(repo, 'feature/user'), true);
    assert.equal(res.skipped.length, 3);
  } finally {
    cleanup(root);
  }
});
