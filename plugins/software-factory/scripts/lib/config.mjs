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
        qa_goal: 400000, assess: 250000, report: 250000, cycle_plan: 200000, triage: 250000,
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
    // Contracts §21: teams, work streams, cycles, CTO reports and the baseline. Only reports and the
    // baseline are on by default; the rest stays inert until config turns it on.
    teams: {},
    streams: {
      enabled: false, teams: [], capacity_pct: 30, budget_tokens_per_window: 15000000, epic_review: false, pull: 'intake_label',
      classes: { bug: { labels: ['bug', 'Bug'] }, tech_debt: { labels: ['tech-debt', 'Tech Debt', 'tech debt'] }, chore: { labels: [] } },
    },
    cycles: { enabled: false, source: null, length_days: 14, anchor: '2026-01-05', plan_at_start: true, review_at_end: true },
    reports: { enabled: true, every_h: 24, idle_min_h: 4, idle_min_events: 10, max_proposals: 5 },
    baseline: { enabled: true, collect_every_s: 3600, assess_every_h: 24 },
    ops: { budget_tokens_per_day: 2000000 },
  };
}

export function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/** Deep merge: objects merge, arrays and scalars replace. Unknown keys kept. */
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (FORBIDDEN_KEY_PARTS.has(k)) continue;
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
  // cycles.source defaults to the tracker when it is Linear, else local cycles (contracts §21.6).
  if (!cfg.cycles.source) cfg.cycles.source = cfg.tracker && cfg.tracker.provider === 'linear' ? 'tracker' : 'local';
  if (!cfg.tracker.goal_mapping) cfg.tracker.goal_mapping = 'parent_issue';
  const m = machine(home);
  const opts = m.options || {};
  const cap = Number(opts.max_parallel_agents);
  if (Number.isFinite(cap) && cap > 0) cfg.concurrency.total = Math.min(cfg.concurrency.total, cap);
  if (opts.desktop_notifications === false || opts.desktop_notifications === 'false') cfg.notifications.desktop = false;
  return cfg;
}

/** Key segments that could reach Object.prototype; never valid in a config key. */
export const FORBIDDEN_KEY_PARTS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** True when a dotted key has no empty and no prototype segment. */
export function safeKey(key) {
  const parts = String(key || '').split('.');
  return parts.length > 0 && parts.every((p) => p && !FORBIDDEN_KEY_PARTS.has(p));
}

export function getKey(obj, key) {
  if (!key) return obj;
  let cur = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object' || !own(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setKey(obj, key, value) {
  if (!safeKey(key)) { const e = new Error(`bad config key ${key}`); e.exitCode = 1; throw e; }
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!own(cur, parts[i]) || !isObj(cur[parts[i]])) cur[parts[i]] = {};
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

/** Set several dotted keys at once; validates the result and writes nothing when it is invalid. */
export function setMany(home, patch) {
  return withMutex(home, () => {
    const raw = structuredClone(readRaw(home) || defaults());
    for (const [k, v] of Object.entries(patch || {})) setKey(raw, k, structuredClone(v));
    return saveChecked(home, raw);
  });
}

export function merge(home, obj) {
  return withMutex(home, () => saveChecked(home, deepMerge(readRaw(home) || defaults(), obj)));
}

export function validateHome(home) {
  const raw = readRaw(home);
  if (!raw) return { ok: false, errors: ['config.json missing or not JSON'] };
  return validateConfig(deepMerge(defaults(), raw));
}
