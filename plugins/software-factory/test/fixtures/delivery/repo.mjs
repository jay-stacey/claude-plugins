// Test helpers for Team DELIVERY: short temp git repos under os.tmpdir().
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\r\n/g, '\n').trim();
}

/** Create a temp dir with a short name. */
export function tmpDir(prefix = 'sfd-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** New repo on `main` with one commit. Returns {root, repo} where repo is the checkout. */
export function mkRepo() {
  const root = tmpDir();
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Factory Test');
  sh(repo, 'config', 'user.email', 'factory@example.invalid');
  sh(repo, 'config', 'core.autocrlf', 'false');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'README.md', 'hello\n');
  commitAll(repo, 'init');
  return { root, repo };
}

export function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function commitAll(dir, msg) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
  return sh(dir, 'rev-parse', 'HEAD');
}

/** Make a branch with one commit writing rel=text, without touching the main checkout. */
export function branchWith(repo, branch, from, rel, text) {
  const dir = path.join(path.dirname(repo), `b-${Math.random().toString(36).slice(2, 7)}`);
  sh(repo, 'worktree', 'add', '-q', '-b', branch, dir, from);
  write(dir, rel, text);
  const sha = commitAll(dir, `${branch}: ${rel}`);
  sh(repo, 'worktree', 'remove', '--force', dir);
  return sha;
}

export function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold a handle briefly; temp dirs are fine to leave.
  }
}

export const slash = (p) => p.replace(/\\/g, '/');
