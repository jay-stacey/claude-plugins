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
 * Factory home H = <main checkout>/.factory. FACTORY_HOME overrides.
 * Returns the path (it may not exist yet, e.g. before init) or null outside git.
 */
export function findHome(cwd = process.cwd()) {
  if (process.env.FACTORY_HOME) return resolve(process.env.FACTORY_HOME);
  let cd = commonDirFs(cwd);
  if (!cd) cd = commonDirGit(cwd);
  if (!cd) return null;
  return join(dirname(resolve(cd)), '.factory');
}

/** Fast check used by hooks: returns home only when it exists. */
export function existingHome(cwd) {
  if (process.env.FACTORY_HOME) { const h = resolve(process.env.FACTORY_HOME); return existsSync(h) ? h : null; }
  const cd = commonDirFs(cwd); // no git spawn: hooks must exit fast outside a factory repo
  if (!cd) return null;
  const h = join(dirname(resolve(cd)), '.factory');
  return existsSync(h) ? h : null;
}

export function repoRoot(home) { return dirname(resolve(home)); }
export function pluginRoot() { return resolve(HERE, '..', '..'); }
export function cliPath() { return join(pluginRoot(), 'scripts', 'factory.mjs'); }
export function p(home, ...parts) { return join(home, ...parts); }

/** Absolute forward-slash path inside home. */
export function pf(home, ...parts) { return fwd(join(home, ...parts)); }
