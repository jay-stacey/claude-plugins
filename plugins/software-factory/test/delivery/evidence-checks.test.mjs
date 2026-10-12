import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as evidence from '../../scripts/lib/evidence.mjs';
import * as checks from '../../scripts/lib/checks.mjs';
import { headSha } from '../../scripts/lib/git.mjs';
import { mkRepo, tmpDir, write, cleanup } from '../fixtures/delivery/repo.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'delivery');

test('evidence.run records exit 0 and exit 1, writes logs and index lines', () => {
  const { root, repo } = mkRepo();
  try {
    const runDir = path.join(root, 'runs', 'R-000001');
    const a = evidence.run({ runDir, label: 'build', command: 'echo hello-evidence', cwd: repo, source: 'agent' });
    assert.equal(a.id, 'EV-1');
    assert.equal(a.exit_code, 0);
    assert.equal(a.source, 'agent');
    assert.equal(a.head_sha, headSha(repo));
    assert.ok(!a.log_path.includes('\\'));
    assert.ok(!a.cwd.includes('\\'));
    assert.match(a.log_path, /evidence\/build-1\.log$/);
    assert.match(fs.readFileSync(a.log_path, 'utf8'), /hello-evidence/);

    const b = evidence.run({ runDir, label: 'build', command: 'exit 1', cwd: repo, source: 'cli', headSha: 'deadbeef' });
    assert.equal(b.id, 'EV-2');
    assert.equal(b.exit_code, 1);
    assert.equal(b.source, 'cli');
    assert.equal(b.head_sha, 'deadbeef');
    assert.match(b.log_path, /build-2\.log$/);

    const c = evidence.run({ runDir, label: 'unit tests!', command: 'node --version', cwd: repo });
    assert.equal(c.label, 'unit-tests');
    assert.equal(c.exit_code, 0);

    const idx = evidence.readIndex(runDir);
    assert.deepEqual(idx.map((e) => e.id), ['EV-1', 'EV-2', 'EV-3']);
    for (const key of ['id', 'label', 'command', 'cwd', 'exit_code', 'log_path', 'head_sha', 'source', 'started_at', 'ended_at']) {
      assert.ok(key in idx[0], `index line has ${key}`);
    }
    assert.deepEqual(evidence.readIndex(path.join(root, 'none')), []);
  } finally {
    cleanup(root);
  }
});

test('checks.runChecks pass: runs at SHA in a CLI worktree, copies include files, writes result', () => {
  const { root, repo } = mkRepo();
  try {
    const home = path.join(repo, '.factory');
    fs.mkdirSync(home);
    write(repo, '.env.local', 'X=1\n'); // untracked: only present when copied
    const sha = headSha(repo);
    const runDir = path.join(home, 'runs', 'R-000002');
    const res = checks.runChecks({
      repoRoot: repo, home, runId: 'R-000002', runDir, sha,
      commands: ['echo ok', 'node -e "process.exit(require(\'fs\').existsSync(\'.env.local\')?0:1)"'],
      includeFiles: ['.env.local', 'missing.txt', '../escape.txt'],
    });
    assert.equal(res.status, 'pass', JSON.stringify(res));
    assert.equal(res.failed_command, null);
    assert.equal(res.evidence.length, 2);
    assert.ok(res.evidence.every((e) => e.source === 'cli' && e.head_sha === sha));
    assert.equal(fs.existsSync(path.join(home, 'worktrees', 'checks-R-000002')), false, 'worktree removed');
    const saved = checks.readResult(home, 'R-000002');
    assert.equal(saved.status, 'pass');
    assert.ok(saved.finished_at);
    assert.equal(checks.readResult(home, 'R-404'), null);
  } finally {
    cleanup(root);
  }
});

test('checks.runChecks fail: stops at the first failing command', () => {
  const { root, repo } = mkRepo();
  try {
    const home = path.join(repo, '.factory');
    fs.mkdirSync(home);
    const runDir = path.join(home, 'runs', 'R-000003');
    const res = checks.runChecks({ repoRoot: repo, home, runId: 'R-000003', runDir, sha: headSha(repo), commands: ['echo a', 'exit 3', 'echo never'] });
    assert.equal(res.status, 'fail');
    assert.equal(res.failed_command, 'exit 3');
    assert.equal(res.evidence.length, 2);
    assert.equal(res.evidence[1].exit_code, 3);
    const saved = checks.readResult(home, 'R-000003');
    assert.equal(saved.status, 'fail');
    assert.equal(saved.failed_command, 'exit 3');

    const bad = checks.runChecks({ repoRoot: repo, home, runId: 'R-000004', runDir, sha: '0'.repeat(40), commands: ['echo a'] });
    assert.equal(bad.status, 'fail');
    assert.ok(bad.error);
  } finally {
    cleanup(root);
  }
});

test('checks.spawnDetached starts the CLI detached with run and home', async () => {
  const home = tmpDir('sfh-');
  try {
    const pid = checks.spawnDetached({ cliPath: path.join(FIXTURES, 'fake-cli.mjs'), home, runId: 'R-000009' });
    assert.ok(Number.isInteger(pid) && pid > 0);
    const file = path.join(home, 'spawned.json');
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    let data;
    for (let i = 0; i < 20; i++) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.deepEqual(data.args, ['checks', 'run', '--run', 'R-000009', '--home', home]);
  } finally {
    cleanup(home);
  }
});
