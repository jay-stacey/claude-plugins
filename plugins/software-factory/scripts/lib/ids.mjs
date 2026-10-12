// Ids: record ids from counters, ulid-ish event ids, inbox ids, slugs.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { listDir, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';

export const ID_FORMAT = {
  goal: { prefix: 'G-', width: 3, dir: 'goals' },
  epic: { prefix: 'E-', width: 4, dir: 'epics' },
  task: { prefix: 'T-', width: 4, dir: 'tasks' },
  run: { prefix: 'R-', width: 6, dir: 'runs' },
  gate: { prefix: 'GATE-', width: 4, dir: 'gates' },
};

export function formatId(kind, n) {
  const f = ID_FORMAT[kind];
  return f.prefix + String(n).padStart(f.width, '0');
}

export function parseIdNum(id) {
  const m = /-(\d+)$/.exec(id || '');
  return m ? Number(m[1]) : 0;
}

function scanMax(home, kind) {
  const f = ID_FORMAT[kind];
  let max = 0;
  for (const name of listDir(join(home, f.dir))) {
    if (!name.startsWith(f.prefix)) continue;
    const n = parseIdNum(name.replace(/\.json$/, ''));
    if (n > max) max = n;
  }
  return max;
}

/** Allocate the next id for a kind (takes the mutex). */
export function nextId(home, kind) {
  if (!ID_FORMAT[kind]) throw new Error(`unknown kind ${kind}`);
  return withMutex(home, () => {
    const file = join(home, 'state', 'counters.json');
    const c = readJson(file, {}) || {};
    let cur = typeof c[kind] === 'number' ? c[kind] : 0;
    const scanned = scanMax(home, kind);
    if (scanned > cur) cur = scanned;
    cur += 1;
    c[kind] = cur;
    writeJsonAtomic(file, c);
    return formatId(kind, cur);
  });
}

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
export function ulid(ms = Date.now()) {
  let t = '';
  let n = ms;
  for (let i = 0; i < 10; i++) { t = B32[n % 32] + t; n = Math.floor(n / 32); }
  const r = randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += B32[r[i] % 32];
  return t + s;
}

export function hex(n = 8) { return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n); }

export function slugify(text, max = 30) {
  const s = String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let out = s.slice(0, max).replace(/-+$/g, '');
  return out || 'x';
}

/** yyyymmddThhmmssZ */
export function compactTs(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
