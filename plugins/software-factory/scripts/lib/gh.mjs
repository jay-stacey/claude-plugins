// GitHub CLI wrapper for software-factory (Team DELIVERY).
// `FACTORY_GH` (env) overrides the gh executable; a .js/.mjs/.cjs path runs through node (tests).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { git } from './git.mjs';

function clean(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function ghCommand() {
  const exe = process.env.FACTORY_GH || 'gh';
  if (/\.(mjs|cjs|js)$/i.test(exe)) return { file: process.execPath, pre: [exe] };
  return { file: exe, pre: [] };
}

/** Run gh with an argument array. */
export function gh(args, { cwd } = {}) {
  const { file, pre } = ghCommand();
  const r = spawnSync(file, [...pre, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message || r.error), missing: r.error.code === 'ENOENT' };
  return { code: r.status ?? -1, stdout: clean(r.stdout), stderr: clean(r.stderr) };
}

function fail(message, r) {
  const err = new Error(message);
  err.code = 'GH_FAILED';
  if (r) {
    err.stderr = r.stderr;
    err.exitCode = r.code;
  }
  return err;
}

/** @returns {{ok:boolean, user?:string, reason?:string}} */
export function available() {
  const r = gh(['auth', 'status']);
  if (r.missing) return { ok: false, reason: 'gh not found on PATH' };
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) return { ok: false, reason: (r.stderr || r.stdout || 'gh auth status failed').split('\n')[0].trim() };
  const m = /account\s+([A-Za-z0-9-]+)/.exec(text) || /Logged in to \S+ as\s+([A-Za-z0-9-]+)/.exec(text);
  return m ? { ok: true, user: m[1] } : { ok: true };
}

function parsePrUrl(text) {
  const m = /(https?:\/\/\S+\/pull\/(\d+))/.exec(text || '');
  return m ? { url: m[1], number: Number(m[2]) } : null;
}

/** `gh pr create`; returns `{number, url}` (also when the PR already exists: `existing: true`). */
export function prCreate({ cwd, base, head, title, bodyFile } = {}) {
  const args = ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', path.resolve(bodyFile)];
  const r = gh(args, { cwd });
  if (r.code === 0) {
    const pr = parsePrUrl(r.stdout);
    if (!pr) throw fail(`gh pr create gave no PR URL: ${r.stdout}`, r);
    return pr;
  }
  if (/already exists/i.test(r.stderr)) {
    const pr = parsePrUrl(r.stderr);
    if (pr) return { ...pr, existing: true };
  }
  throw fail(`gh pr create failed: ${r.stderr || r.stdout}`, r);
}

/** `gh pr view <n> --json state,mergedAt,reviewDecision,mergeable,headRefOid`. */
export function prView({ cwd, number } = {}) {
  const r = gh(['pr', 'view', String(number), '--json', 'state,mergedAt,reviewDecision,mergeable,headRefOid'], { cwd });
  if (r.code !== 0) throw fail(`gh pr view ${number} failed: ${r.stderr || r.stdout}`, r);
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw fail(`gh pr view ${number} returned invalid JSON`, r);
  }
  return {
    state: data.state ?? null,
    mergedAt: data.mergedAt || null,
    reviewDecision: data.reviewDecision || null,
    mergeable: data.mergeable ?? null,
    headRefOid: data.headRefOid ?? null,
  };
}

/**
 * Open pull requests (contracts §21.5.3): `gh pr list --state open --limit <n> --json
 * number,title,url,headRefName,author,isDraft,reviewDecision,updatedAt,files`. Throws on failure.
 */
export function prList({ cwd, limit = 30 } = {}) {
  const r = gh(['pr', 'list', '--state', 'open', '--limit', String(limit), '--json',
    'number,title,url,headRefName,author,isDraft,reviewDecision,updatedAt,files'], { cwd });
  if (r.missing) throw fail('gh not found on PATH', r);
  if (r.code !== 0) throw fail(`gh pr list failed: ${(r.stderr || r.stdout || '').split('\n')[0]}`, r);
  let data;
  try { data = JSON.parse(r.stdout || '[]'); } catch { throw fail('gh pr list returned invalid JSON', r); }
  return (Array.isArray(data) ? data : []).map((p) => ({
    number: p.number ?? null, title: p.title || '', url: p.url || '', headRefName: p.headRefName || '',
    author: (p.author && (p.author.login || p.author.name)) || (typeof p.author === 'string' ? p.author : null),
    isDraft: !!p.isDraft, reviewDecision: p.reviewDecision || null, updatedAt: p.updatedAt || null,
    files: Array.isArray(p.files) ? p.files.map((f) => (typeof f === 'string' ? f : f && f.path)).filter(Boolean) : [],
  }));
}

/** `git push -u <remote> <branch>` (git, not gh). */
export function push({ cwd, remote = 'origin', branch } = {}) {
  const r = git(['push', '-u', remote, branch], { cwd });
  return { ok: r.code === 0, stderr: r.stderr };
}
