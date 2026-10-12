// Git helpers for software-factory (Team DELIVERY). Pure: no factory record I/O.
// Always calls git with an argument array (never a shell string). Windows first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Strip trailing whitespace/newlines and normalize CRLF to LF. */
function clean(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Run git with an argument array.
 * @returns {{code:number, stdout:string, stderr:string}}
 */
export function git(args, { cwd, env, input } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', ...(env || {}) },
  });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message || r.error) };
  return { code: r.status ?? -1, stdout: clean(r.stdout), stderr: clean(r.stderr) };
}

/** Run git and throw an Error (code GIT_FAILED) when it exits non-zero. Returns stdout. */
export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.code !== 0) {
    const err = new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
    err.code = 'GIT_FAILED';
    err.stderr = r.stderr;
    err.stdout = r.stdout;
    throw err;
  }
  return r.stdout;
}

export function headSha(cwd, ref = 'HEAD') {
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return r.code === 0 && r.stdout ? r.stdout.trim() : null;
}

export function branchExists(cwd, branch) {
  if (!branch) return false;
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd }).code === 0;
}

/** Parse `git worktree list --porcelain`. Paths use forward slashes. */
export function worktreeList(cwd) {
  const r = git(['worktree', 'list', '--porcelain'], { cwd });
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: toSlash(line.slice(9)), head: null, branch: null, detached: false, bare: false, prunable: false, locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function currentBranch(cwd) {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return r.code === 0 && r.stdout ? r.stdout.trim() : null;
}

export function isAncestor(cwd, a, b) {
  return git(['merge-base', '--is-ancestor', a, b], { cwd }).code === 0;
}

/** Top level of the worktree that contains cwd (forward slashes), or null. */
export function toplevel(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  return r.code === 0 && r.stdout ? toSlash(r.stdout.trim()) : null;
}

/** Files with unresolved merge conflicts in cwd. */
export function conflictedFiles(cwd) {
  const r = git(['diff', '--name-only', '--diff-filter=U'], { cwd });
  return r.code === 0 && r.stdout ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** Lowercase kebab slug, at most `max` characters, no leading/trailing dashes. */
export function slugify(text, max = 30) {
  let s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-+$/g, '');
  return s;
}

// ---------- path helpers (shared by worktree.mjs and broker.mjs) ----------

/** Backslashes to forward slashes. */
export function toSlash(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/**
 * Canonical absolute path for storage and comparison: resolved, real path when it exists,
 * forward slashes, no trailing slash (except a drive root).
 */
export function normPath(p, base) {
  if (p == null || p === '') return '';
  let s = toSlash(String(p));
  // Git Bash style /c/Users/... -> c:/Users/...
  if (IS_WIN && /^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`;
  let abs = base ? path.resolve(base, s) : path.resolve(s);
  try {
    abs = fs.realpathSync.native(abs);
  } catch {
    // Path may not exist yet: resolve the nearest existing parent.
    abs = realParent(abs);
  }
  let out = toSlash(abs);
  if (out.length > 1 && out.endsWith('/') && !/^[a-zA-Z]:\/$/.test(out)) out = out.slice(0, -1);
  if (IS_WIN && /^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

function realParent(abs) {
  const parts = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(cur);
    parts.unshift(path.basename(cur));
    if (parent === cur) return abs;
    cur = parent;
    try {
      const real = fs.realpathSync.native(cur);
      return path.join(real, ...parts);
    } catch {
      // keep walking up
    }
  }
  return abs;
}

function cmpKey(p) {
  return IS_WIN ? p.toLowerCase() : p;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  return cmpKey(normPath(a)) === cmpKey(normPath(b));
}

/** True when child equals parent or lies under it. */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = cmpKey(normPath(child));
  let p = cmpKey(normPath(parent));
  if (c === p) return true;
  if (!p.endsWith('/')) p += '/';
  return c.startsWith(p);
}

/** Relative path (forward slashes) of child under parent, or null when outside. */
export function relInside(child, parent) {
  if (!isInside(child, parent)) return null;
  const c = normPath(child);
  const p = normPath(parent);
  if (c.length === p.length) return '';
  return c.slice(p.length).replace(/^\/+/, '');
}
