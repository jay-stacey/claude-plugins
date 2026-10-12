// Small glob matcher (**, *, ?) and file-ownership overlap on the repo file list.
import { runGit } from './fsutil.mjs';

const cache = new Map();

export function hasWild(p) { return /[*?]/.test(p); }

function norm(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.endsWith('/')) s += '**';
  return s;
}

export function globToRegex(pattern) {
  const pat = norm(pattern);
  if (cache.has(pat)) return cache.get(pat);
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        const prevSlash = i === 0 || pat[i - 1] === '/';
        const nextSlash = pat[i + 2] === '/';
        if (prevSlash && nextSlash) { re += '(?:.*/)?'; i += 2; continue; }
        if (prevSlash && i + 2 === pat.length) { re += '.*'; i += 1; continue; }
        re += '.*'; i += 1; continue;
      }
      re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A literal path also matches everything under it (directory ownership).
  const full = hasWild(pat) ? `^${re}$` : `^${re}(?:/.*)?$`;
  const rx = new RegExp(full, process.platform === 'win32' ? 'i' : '');
  cache.set(pat, rx);
  return rx;
}

export function match(pattern, file) { return globToRegex(pattern).test(String(file).replace(/\\/g, '/')); }

export function expand(patterns, files) {
  const out = new Set();
  for (const p of patterns || []) {
    const rx = globToRegex(p);
    for (const f of files) if (rx.test(f)) out.add(f);
  }
  return out;
}

function staticPrefix(p) {
  const s = norm(p);
  const i = s.search(/[*?]/);
  const pre = i < 0 ? s : s.slice(0, i);
  return pre.slice(0, pre.lastIndexOf('/') + 1);
}

/**
 * Do two pattern lists overlap? Uses the real file list first; for files that do not exist yet,
 * falls back to pattern checks (literal-vs-glob, equal patterns, nested static prefixes).
 */
export function overlap(a, b, files = []) {
  if (!a || !b || !a.length || !b.length) return false;
  const ea = expand(a, files);
  if (ea.size) {
    const eb = expand(b, files);
    for (const f of ea) if (eb.has(f)) return true;
  }
  for (const x of a) {
    for (const y of b) {
      const nx = norm(x); const ny = norm(y);
      if (nx.toLowerCase() === ny.toLowerCase()) return true;
      if (!hasWild(nx) && match(ny, nx)) return true;
      if (!hasWild(ny) && match(nx, ny)) return true;
      if (hasWild(nx) && hasWild(ny)) {
        const px = staticPrefix(nx); const py = staticPrefix(ny);
        const ex = expand([nx], files).size; const ey = expand([ny], files).size;
        if ((ex === 0 || ey === 0) && (px.startsWith(py) || py.startsWith(px))) return true;
      }
    }
  }
  return false;
}

export function lsFiles(repoRoot) {
  const r = runGit(['ls-files', '-z'], repoRoot);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}
