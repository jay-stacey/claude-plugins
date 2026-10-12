// config.json: defaults, deep merge, dotted get/set, machine clamps.
import { join } from 'node:path';
import { readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import { ROLES, validateConfig } from './schema.mjs';

export function defaults() {
  return {
    version: 1,
    project: { name: '', kind: 'existing', default_branch: 'main', remote: { provider: 'github', owner: '', repo: '' } },
    stack: [],
    commands: {
      install: null, build: null, test: null, lint: null, typecheck: null, run: null, e2e: null,
      migrate_up: null, migrate_down: null, screenshot: null, extra: [],
    },
    roles: { active: [...ROLES] },
    gates: { G1: { enabled: true, approvers: ['owner'] }, G2: { enabled: true }, G3: { enabled: true }, G4: { enabled: true } },
    budget: {
      tier_defaults: { S: 5000000, M: 15000000, L: 40000000 }, warn_pct: 80, stop_pct: 100,
      weights: { input: 1, output: 1, cache_creation: 1.25, cache_read: 0.1 },
      estimates: {
        intake: 150000, prd: 300000, spec: 500000, mockup: 300000, breakdown: 300000, sequence: 150000,
        code_S: 250000, code_M: 600000, review: 150000, qa: 300000, docs: 200000, escalation: 200000, fixup: 150000,
        qa_goal: 400000,
      },
      hard_kill: false,
    },
    concurrency: { total: 5, builders: 3, reviewers: 2, planners: 2, per_role: { 'qa-engineer': 1, 'devops-release': 1 }, max_goals_building: 3 },
    checks: { pre_review: [], post_merge: [] },
    delivery: { mode: 'github', base_branch: 'main', remote: 'origin' },
    reviews: { profile: 'lean' },
    models: { all: null, by_role: {} },
    recovery: { orphan_after_s: 1800 },
    cadence: { active_s: 270, waiting_s: [900, 1800, 3600], paused_s: 1800, inbox_s: 120 },
    sync: { min_interval_s: 60, full_every_ticks: 30 },
    tracker: { provider: 'none' },
    notifications: { desktop: true },
    control_center: { port: 47610, open_browser: true, show_cost: false },
    worktree: { include_files: [] },
    workspace: { enabled: false, default_repo: null },
    repos: {},
  };
}

export function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/** Deep merge: objects merge, arrays and scalars replace. Unknown keys kept. */
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

export function configPath(home) { return join(home, 'config.json'); }

export function readRaw(home) { return readJson(configPath(home), null); }

export function machine(home) { return readJson(join(home, 'run', 'machine.json'), null) || {}; }

/** Effective config: defaults <- config.json, plus derived defaults and machine clamps. */
export function load(home) {
  const raw = readRaw(home) || {};
  const cfg = deepMerge(defaults(), raw);
  if (!Array.isArray(cfg.checks.pre_review) || cfg.checks.pre_review.length === 0) {
    cfg.checks.pre_review = [cfg.commands.build, cfg.commands.lint, cfg.commands.test].filter((x) => typeof x === 'string' && x.trim());
  }
  const m = machine(home);
  const opts = m.options || {};
  const cap = Number(opts.max_parallel_agents);
  if (Number.isFinite(cap) && cap > 0) cfg.concurrency.total = Math.min(cfg.concurrency.total, cap);
  if (opts.desktop_notifications === false || opts.desktop_notifications === 'false') cfg.notifications.desktop = false;
  return cfg;
}

export function getKey(obj, key) {
  if (!key) return obj;
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setKey(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function saveChecked(home, raw) {
  const eff = deepMerge(defaults(), raw);
  const v = validateConfig(eff);
  if (!v.ok) {
    const e = new Error(`config invalid: ${v.errors.join('; ')}`); e.exitCode = 1; e.errors = v.errors; throw e;
  }
  writeJsonAtomic(configPath(home), raw);
  return raw;
}

export function set(home, key, value) {
  return withMutex(home, () => saveChecked(home, setKey(readRaw(home) || defaults(), key, value)));
}

export function merge(home, obj) {
  return withMutex(home, () => saveChecked(home, deepMerge(readRaw(home) || defaults(), obj)));
}

export function validateHome(home) {
  const raw = readRaw(home);
  if (!raw) return { ok: false, errors: ['config.json missing or not JSON'] };
  return validateConfig(deepMerge(defaults(), raw));
}
