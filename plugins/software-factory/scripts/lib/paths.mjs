// Locations: factory home discovery, plugin root, CLI path. Built-ins only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Forward-slash form of a path (records store forward slashes). */
export function fwd(p) {
  return p == null ? p : String(p).replace(/\\/g, '/');
}

/** Find the git common dir without spawning git. Returns absolute path or null. */
export function commonDirFs(start) {
  let dir = resolve(start || process.cwd());
  for (let i = 0; i < 64; i++) {
    const dotGit = join(dir, '.git');
    let st = null;
    try { st = statSync(dotGit); } catch { st = null; }
    if (st && st.isDirectory()) {
      const cd = join(dotGit, 'commondir');
      if (existsSync(cd)) {
        const rel = readFileSync(cd, 'utf8').trim();
        return resolve(dotGit, rel);
      }
      return dotGit;
    }
    if (st && st.isFile()) {
      const m = /gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
      const cd = join(gitdir, 'commondir');
      if (existsSync(cd)) return resolve(gitdir, readFileSync(cd, 'utf8').trim());
      return gitdir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function commonDirGit(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch { return null; }
}

/**
 * Workspace home (contracts §20.1): walk up from `start` to the nearest folder holding
 * `.factory/config.json`. Returns the `.factory` path or null. No git spawn.
 */
export function workspaceHome(start) {
  let dir = resolve(start || process.cwd());
  for (let i = 0; i < 64; i++) {
    const h = join(dir, '.factory');
    if (existsSync(join(h, 'config.json'))) return h;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

const cmpKey = (p) => { const s = fwd(resolve(p)).replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };

/** `<X>/.factory` when `cwd` lies under `<X>/.factory/worktrees/` (a CLI worktree) and that home exists. */
export function worktreeHome(cwd) {
  const s = fwd(resolve(cwd || process.cwd()));
  const i = s.toLowerCase().lastIndexOf('/.factory/worktrees/');
  const j = s.toLowerCase().endsWith('/.factory/worktrees') ? s.length - '/worktrees'.length : -1;
  const end = i >= 0 ? i + '/.factory'.length : j;
  if (end < 0) return null;
  const h = resolve(s.slice(0, end));
  return existsSync(h) ? h : null;
}

/** True when workspace home `ws` has workspace mode on and lists a repo at `mainCheckout`. Reads config.json only. */
export function workspaceListsRepo(ws, mainCheckout) {
  let cfg = null;
  try { cfg = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf8').replace(/^﻿/, '')); } catch { return false; }
  if (!cfg || !cfg.workspace || !cfg.workspace.enabled || !cfg.repos || typeof cfg.repos !== 'object') return false;
  const want = cmpKey(mainCheckout);
  return Object.entries(cfg.repos).some(([name, r]) => {
    const raw = (r && r.path) || name;
    return cmpKey(isAbsolute(raw) ? raw : join(dirname(ws), raw)) === want;
  });
}

/**
 * Home resolution shared by findHome and existingHome (contracts §20.1, as amended):
 * FACTORY_HOME; a CLI worktree under `<X>/.factory/worktrees/` -> `<X>/.factory`; inside a git repo:
 * `<main checkout>/.factory` when it exists, else the nearest workspace home above it that lists this
 * repo, else `<main checkout>/.factory` (not created); outside git: the nearest workspace home.
 */
function resolveHome(cwd, commonDir, { mustExist }) {
  if (process.env.FACTORY_HOME) {
    const h = resolve(process.env.FACTORY_HOME);
    return !mustExist || existsSync(h) ? h : null;
  }
  const wt = worktreeHome(cwd);
  if (wt) return wt;
  if (commonDir) {
    const main = dirname(resolve(commonDir));
    const repoHome = join(main, '.factory');
    if (existsSync(repoHome)) return repoHome;
    const ws = workspaceHome(dirname(main));
    if (ws && workspaceListsRepo(ws, main)) return ws;
    return mustExist ? null : repoHome;
  }
  return workspaceHome(cwd);
}

/** `<main checkout>/.factory` for cwd (created or not), or null outside git. `init` without --workspace uses it. */
export function repoHomeOf(cwd = process.cwd()) {
  const cd = commonDirFs(cwd) || commonDirGit(cwd);
  return cd ? join(dirname(resolve(cd)), '.factory') : null;
}

/** Factory home H (see resolveHome). Null outside git and any workspace. */
export function findHome(cwd = process.cwd()) {
  if (process.env.FACTORY_HOME) return resolve(process.env.FACTORY_HOME);
  return resolveHome(cwd, commonDirFs(cwd) || commonDirGit(cwd), { mustExist: false });
}

/** Fast check used by hooks: returns home only when it exists. No git spawn. */
export function existingHome(cwd) {
  return resolveHome(cwd || process.cwd(), commonDirFs(cwd || process.cwd()), { mustExist: true });
}

/**
 * Folder that holds `.factory`. In classic mode this is the repo; in workspace mode it is the
 * workspace root, which is not a git repo. Git and command calls use `repos.mjs` instead.
 */
export function repoRoot(home) { return dirname(resolve(home)); }
export function pluginRoot() { return resolve(HERE, '..', '..'); }
export function cliPath() { return join(pluginRoot(), 'scripts', 'factory.mjs'); }
export function p(home, ...parts) { return join(home, ...parts); }

/** Absolute forward-slash path inside home. */
export function pf(home, ...parts) { return fwd(join(home, ...parts)); }
