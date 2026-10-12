// File helpers: atomic JSON writes with Windows retries, line appends, the home mutex.
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export function nowIso(ms = Date.now()) { return new Date(ms).toISOString(); }

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

export function retry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return fn(); } catch (e) {
      last = e;
      if (!RETRY_CODES.has(e.code)) throw e;
      sleepSync(15 * 2 ** i);
    }
  }
  throw last;
}

export function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir; }

export function readJson(file, fallback = null) {
  try {
    const txt = readFileSync(file, 'utf8');
    return JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt);
  } catch (e) {
    if (e.code === 'ENOENT' || e.name === 'SyntaxError') return fallback;
    if (RETRY_CODES.has(e.code)) {
      try { return retry(() => JSON.parse(readFileSync(file, 'utf8'))); } catch { return fallback; }
    }
    return fallback;
  }
}

export function writeTextAtomic(file, text) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, text);
  try {
    retry(() => renameSync(tmp, file));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function writeJsonAtomic(file, obj) {
  writeTextAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Append one JSON line (lock-free). Lines over 4 KB are trimmed by the caller's data shrink. */
export function appendLine(file, obj) {
  ensureDir(dirname(file));
  let line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  retry(() => appendFileSync(file, line + '\n'));
}

export function readLines(file) {
  let txt;
  try { txt = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of txt.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

export function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

export function mtimeMs(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Run git with an arg array (no shell). */
export function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------- mutex ----------
let held = 0; // re-entrant depth within this process
let heldToken = null;

export class MutexTimeout extends Error {
  constructor(msg) { super(msg); this.code = 'MUTEX_TIMEOUT'; this.exitCode = 1; }
}

export function acquireMutex(home, { waitMs = 15000, staleMs = 120000 } = {}) {
  const dir = join(home, 'run', 'mutex');
  ensureDir(join(home, 'run'));
  const start = Date.now();
  const token = randomBytes(6).toString('hex');
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: nowIso() }));
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST' && !RETRY_CODES.has(e.code)) throw e;
    }
    const owner = readJson(join(dir, 'owner.json'), null);
    let age = 0;
    if (owner && owner.at) age = Date.now() - Date.parse(owner.at);
    else age = Date.now() - mtimeMs(dir);
    const dead = owner && owner.pid && !pidAlive(owner.pid);
    if (dead || age > staleMs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ }
      continue;
    }
    if (Date.now() - start > waitMs) throw new MutexTimeout(`mutex busy (pid ${owner && owner.pid})`);
    sleepSync(20 + Math.floor(Math.random() * 30));
  }
}

export function releaseMutex(home, token) {
  const dir = join(home, 'run', 'mutex');
  const owner = readJson(join(dir, 'owner.json'), null);
  if (owner && owner.token !== token) return;
  try { retry(() => rmSync(dir, { recursive: true, force: true })); } catch { /* ignore */ }
}

/** Run fn while holding the home mutex. Re-entrant within one process. Sync or async fn. */
export function withMutex(home, fn, opts) {
  if (held > 0) {
    held++;
    try {
      const r = fn();
      if (r && typeof r.then === 'function') return r.finally(() => { held--; });
      held--;
      return r;
    } catch (e) { held--; throw e; }
  }
  const token = acquireMutex(home, opts);
  held = 1; heldToken = token;
  const done = () => { held = 0; heldToken = null; releaseMutex(home, token); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(done);
    done();
    return r;
  } catch (e) { done(); throw e; }
}

export function mutexHeld() { return held > 0 ? heldToken : null; }

export function exists(p) { return existsSync(p); }
