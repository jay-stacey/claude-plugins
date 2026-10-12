// Repo resolution (contracts §20). One config can describe one repo (classic mode) or a workspace:
// a plain folder that holds several git repos, with the factory home at <workspace>/.factory.
// Every git, command, check and delivery call resolves its repo here instead of using the home's parent.
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fwd } from './paths.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_KEYS = ['install', 'build', 'test', 'lint', 'typecheck', 'run', 'e2e', 'migrate_up', 'migrate_down', 'screenshot'];

/** Folder that holds `.factory` (the single repo, or the workspace root). */
export function homeParent(home) { return dirname(resolve(home)); }

/** True when the config describes a workspace of several repos. */
export function isWorkspace(cfg) {
  return !!(cfg && cfg.workspace && cfg.workspace.enabled && cfg.repos && Object.keys(cfg.repos).length);
}

export function validName(name) { return typeof name === 'string' && NAME_RE.test(name); }

function cleanCommands(c = {}) {
  const out = {};
  for (const k of COMMAND_KEYS) out[k] = typeof c[k] === 'string' && c[k].trim() ? c[k] : null;
  out.extra = Array.isArray(c.extra) ? c.extra.filter((x) => typeof x === 'string' && x.trim()) : [];
  return out;
}

function defaultChecks(commands, checks) {
  const pre = Array.isArray(checks && checks.pre_review) && checks.pre_review.length
    ? checks.pre_review
    : [commands.build, commands.lint, commands.test].filter(Boolean);
  const post = Array.isArray(checks && checks.post_merge) ? checks.post_merge : [];
  return { pre_review: pre, post_merge: post };
}

/**
 * Resolved repo view: {name, path (absolute, forward slashes), rel, stack[], commands, checks,
 * delivery {mode, base_branch, remote}, remote {provider, owner, repo}, include_files[]}.
 */
function resolveOne(home, cfg, name, r) {
  const parent = homeParent(home);
  const rawPath = r.path || name;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(parent, rawPath);
  const commands = cleanCommands(r.commands || {});
  const d = cfg.delivery || {};
  const rd = r.delivery || {};
  return {
    name,
    path: fwd(abs),
    rel: fwd(rawPath),
    stack: Array.isArray(r.stack) ? r.stack : [],
    commands,
    checks: defaultChecks(commands, r.checks),
    delivery: {
      mode: rd.mode || d.mode || 'github',
      base_branch: rd.base_branch || r.default_branch || d.base_branch || 'main',
      remote: rd.remote || d.remote || 'origin',
    },
    remote: { provider: 'github', owner: '', repo: '', ...(r.remote || {}) },
    include_files: Array.isArray(r.include_files) ? r.include_files : ((cfg.worktree && cfg.worktree.include_files) || []),
  };
}

/** The implicit single repo of classic mode, built from the top-level config keys. */
function classicRepo(home, cfg) {
  const name = (cfg.project && cfg.project.name) || basename(homeParent(home)) || 'repo';
  const commands = cleanCommands(cfg.commands || {});
  const d = cfg.delivery || {};
  return {
    name,
    path: fwd(homeParent(home)),
    rel: '.',
    stack: Array.isArray(cfg.stack) ? cfg.stack : [],
    commands,
    checks: defaultChecks(commands, cfg.checks),
    delivery: { mode: d.mode || 'github', base_branch: d.base_branch || (cfg.project && cfg.project.default_branch) || 'main', remote: d.remote || 'origin' },
    remote: { provider: 'github', owner: '', repo: '', ...((cfg.project && cfg.project.remote) || {}) },
    include_files: (cfg.worktree && cfg.worktree.include_files) || [],
  };
}

/** All repos, in config order. Classic mode returns one entry. */
export function list(home, cfg) {
  if (!isWorkspace(cfg)) return [classicRepo(home, cfg)];
  return Object.entries(cfg.repos).map(([name, r]) => resolveOne(home, cfg, name, r || {}));
}

export function names(home, cfg) { return list(home, cfg).map((r) => r.name); }

/** Default repo name: workspace.default_repo, else the first repo. */
export function defaultName(home, cfg) {
  const all = list(home, cfg);
  if (isWorkspace(cfg) && cfg.workspace.default_repo && all.some((r) => r.name === cfg.workspace.default_repo)) return cfg.workspace.default_repo;
  return all[0].name;
}

/** One repo by name; null name means the default repo. Throws on an unknown name. */
export function get(home, cfg, name = null) {
  const all = list(home, cfg);
  if (!isWorkspace(cfg)) return all[0];
  const want = name || defaultName(home, cfg);
  const r = all.find((x) => x.name === want);
  if (!r) {
    const e = new Error(`unknown repo "${want}"; known: ${all.map((x) => x.name).join(', ')}`);
    e.exitCode = 1;
    throw e;
  }
  return r;
}

/**
 * The repo name a record works in: task.repo, else its epic's repo, else run.repo, else the default.
 * `records` = {task?, epic?, run?}. Returns a name (never null).
 */
export function nameFor(home, cfg, { task = null, epic = null, run = null } = {}) {
  return (task && task.repo) || (epic && epic.repo) || (run && run.repo) || defaultName(home, cfg);
}

/** Resolved repo for a record set (see nameFor). */
export function forRecord(home, cfg, recs = {}) { return get(home, cfg, nameFor(home, cfg, recs)); }

/** Union of every repo's command strings (for allow-lists when no single repo applies). */
export function allCommandStrings(home, cfg) {
  const out = new Set();
  for (const r of list(home, cfg)) {
    for (const k of COMMAND_KEYS) if (r.commands[k]) out.add(r.commands[k]);
    for (const x of r.commands.extra) out.add(x);
    for (const x of [...r.checks.pre_review, ...r.checks.post_merge]) if (x) out.add(x);
  }
  return [...out];
}

/** Path where the CLI keeps a run's worktree: <home>/worktrees/<run id>. */
export function runWorktreeDir(home, runId) { return fwd(join(resolve(home), 'worktrees', runId)); }

export { COMMAND_KEYS };
