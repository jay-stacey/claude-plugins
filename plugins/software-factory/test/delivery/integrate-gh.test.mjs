import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTasks, worktreeName } from '../../scripts/lib/integrate.mjs';
import * as gh from '../../scripts/lib/gh.mjs';
import { headSha, isAncestor, git, branchExists } from '../../scripts/lib/git.mjs';
import { mkRepo, sh, branchWith, cleanup, tmpDir } from '../fixtures/delivery/repo.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'delivery');

test('worktreeName uses the epic id', () => {
  assert.equal(worktreeName('factory/E-0001-vin'), 'E-0001');
  assert.equal(worktreeName('feature/x y'), 'feature-x-y');
});

test('mergeTasks: clean merge creates the epic branch and merges with --no-ff', () => {
  const { root, repo } = mkRepo();
  try {
    const home = path.join(repo, '.factory');
    const a = branchWith(repo, 'factory/T-0001-a', 'main', 'a.txt', 'a\n');
    const b = branchWith(repo, 'factory/T-0002-b', 'main', 'b.txt', 'b\n');
    const res = mergeTasks({ repoRoot: repo, home, epicBranch: 'factory/E-0001-e', baseRef: 'main', taskBranches: ['factory/T-0001-a', 'factory/T-0002-b'], postMerge: ['echo post'] });
    assert.deepEqual(res.merged, ['factory/T-0001-a', 'factory/T-0002-b']);
    assert.equal(res.conflict, null);
    assert.equal(res.post_merge.status, 'pass');
    assert.equal(res.head_sha, headSha(repo, 'factory/E-0001-e'));
    assert.ok(isAncestor(repo, a, res.head_sha) && isAncestor(repo, b, res.head_sha));
    // --no-ff: the epic head is a merge commit (two parents).
    assert.equal(sh(repo, 'rev-list', '--parents', '-n', '1', res.head_sha).split(' ').length, 3);
    assert.ok(res.worktree_path.endsWith('/.factory/worktrees/E-0001'));
    assert.equal(fs.existsSync(path.join(home, 'run', 'integrate', 'E-0001', 'evidence', 'index.jsonl')), true);
    // Re-run: everything already merged, worktree reused.
    const again = mergeTasks({ repoRoot: repo, home, epicBranch: 'factory/E-0001-e', baseRef: 'main', taskBranches: ['factory/T-0001-a', 'factory/T-0002-b'] });
    assert.deepEqual(again.already, ['factory/T-0001-a', 'factory/T-0002-b']);
    assert.equal(again.head_sha, res.head_sha);
    assert.equal(again.post_merge, null);
  } finally {
    cleanup(root);
  }
});

test('mergeTasks: conflict aborts and returns branch + files', () => {
  const { root, repo } = mkRepo();
  try {
    const home = path.join(repo, '.factory');
    branchWith(repo, 'factory/T-0001-a', 'main', 'README.md', 'a\n');
    branchWith(repo, 'factory/T-0002-b', 'main', 'README.md', 'b\n');
    branchWith(repo, 'factory/T-0003-c', 'main', 'c.txt', 'c\n');
    const res = mergeTasks({ repoRoot: repo, home, epicBranch: 'factory/E-0002-e', baseRef: 'main', taskBranches: ['factory/T-0001-a', 'factory/T-0002-b', 'factory/T-0003-c'], postMerge: ['echo never'] });
    assert.deepEqual(res.merged, ['factory/T-0001-a']);
    assert.deepEqual(res.conflict, { branch: 'factory/T-0002-b', files: ['README.md'] });
    assert.equal(res.post_merge, null);
    assert.notEqual(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: res.worktree_path }).code, 0);
    assert.equal(sh(res.worktree_path, 'status', '--porcelain'), '');
  } finally {
    cleanup(root);
  }
});

test('mergeTasks: post-merge failure is reported', () => {
  const { root, repo } = mkRepo();
  try {
    const home = path.join(repo, '.factory');
    branchWith(repo, 'factory/T-0001-a', 'main', 'a.txt', 'a\n');
    const runDir = path.join(home, 'runs', 'R-000010');
    const res = mergeTasks({ repoRoot: repo, home, epicBranch: 'factory/E-0003-e', baseRef: 'main', taskBranches: ['factory/T-0001-a'], postMerge: ['echo ok', 'exit 2', 'echo never'], runDir });
    assert.deepEqual(res.merged, ['factory/T-0001-a']);
    assert.equal(res.post_merge.status, 'fail');
    assert.equal(res.post_merge.failed_command, 'exit 2');
    assert.deepEqual(res.post_merge.evidence, ['EV-1', 'EV-2']);
    assert.ok(fs.existsSync(path.join(runDir, 'evidence', 'post-merge-2.log')));
  } finally {
    cleanup(root);
  }
});

test('gh wrapper with a fake gh script', () => {
  const dir = tmpDir('sfg-');
  const prev = { gh: process.env.FACTORY_GH, log: process.env.FAKE_GH_LOG, mode: process.env.FAKE_GH_MODE };
  try {
    process.env.FACTORY_GH = path.join(FIXTURES, 'fake-gh.mjs');
    process.env.FAKE_GH_LOG = path.join(dir, 'gh.log');
    delete process.env.FAKE_GH_MODE;
    assert.deepEqual(gh.available(), { ok: true, user: 'factory-bot' });

    const body = path.join(dir, 'body.md');
    fs.writeFileSync(body, 'Refs G-001\n');
    const pr = gh.prCreate({ cwd: dir, base: 'main', head: 'factory/E-0001-x', title: '[factory] E-0001 VIN', bodyFile: body });
    assert.deepEqual(pr, { url: 'https://github.com/o/r/pull/42', number: 42 });
    const calls = fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const create = calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    assert.equal(create[create.indexOf('--title') + 1], '[factory] E-0001 VIN');
    assert.equal(create[create.indexOf('--head') + 1], 'factory/E-0001-x');

    assert.deepEqual(gh.prView({ cwd: dir, number: 42 }), { state: 'MERGED', mergedAt: '2026-10-12T10:00:00Z', reviewDecision: 'APPROVED', mergeable: 'UNKNOWN', headRefOid: 'abc123' });

    process.env.FAKE_GH_MODE = 'exists';
    assert.deepEqual(gh.prCreate({ cwd: dir, base: 'main', head: 'h', title: 't', bodyFile: body }), { url: 'https://github.com/o/r/pull/7', number: 7, existing: true });
    process.env.FAKE_GH_MODE = 'fail';
    assert.throws(() => gh.prCreate({ cwd: dir, base: 'main', head: 'h', title: 't', bodyFile: body }), (e) => e.code === 'GH_FAILED');
    process.env.FAKE_GH_MODE = 'noauth';
    const na = gh.available();
    assert.equal(na.ok, false);
    assert.match(na.reason, /not logged/);

    process.env.FACTORY_GH = path.join(dir, 'no-such-gh.exe');
    assert.equal(gh.available().ok, false);
  } finally {
    for (const [k, env] of [['gh', 'FACTORY_GH'], ['log', 'FAKE_GH_LOG'], ['mode', 'FAKE_GH_MODE']]) {
      if (prev[k] === undefined) delete process.env[env];
      else process.env[env] = prev[k];
    }
    cleanup(dir);
  }
});

test('push to a local bare remote', () => {
  const { root, repo } = mkRepo();
  try {
    const bare = path.join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', bare);
    sh(repo, 'remote', 'add', 'origin', bare);
    branchWith(repo, 'factory/E-0004-p', 'main', 'p.txt', 'p\n');
    const r = gh.push({ cwd: repo, remote: 'origin', branch: 'factory/E-0004-p' });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(branchExists(bare, 'factory/E-0004-p'), true);
    assert.equal(gh.push({ cwd: repo, remote: 'origin', branch: 'nope' }).ok, false);
  } finally {
    cleanup(root);
  }
});
