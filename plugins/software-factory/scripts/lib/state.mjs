// Factory state (state/factory.json), the dispatcher lease (run/lease.json) and init.
import { existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureDir, nowIso, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import { defaults as configDefaults } from './config.mjs';
import { emit } from './events.mjs';
import { pluginRoot } from './paths.mjs';
import { rebuild } from './index.mjs';

export const LEASE_TTL_S = 4500;

export function pluginVersion() {
  const pj = readJson(join(pluginRoot(), '.claude-plugin', 'plugin.json'), {});
  return pj.version || '0.0.0';
}

export function defaultFactory() {
  return {
    status: 'stopped', status_changed_at: nowIso(), status_reason: null, pause_mode: null,
    tick: { count: 0, last_begin_at: null, last_end_at: null, last_error: null, consecutive_errors: 0, cadence_s: null, next_wakeup_at: null, waiting_streak: 0 },
    dispatcher: { session_id: null, since: null }, backoff_until: null,
    versions: { plugin: pluginVersion(), schema: 1 },
    // CTO reports and the baseline (contracts §21.7.2).
    reports: { last_at: null, last_attempt_at: null, last_path: null, last_type: null, last_task_id: null, requested_at: null },
    baseline: { last_collect_at: null, last_assess_at: null, last_assess_attempt_at: null, assess_requested: false },
  };
}

export function factoryPath(home) { return join(home, 'state', 'factory.json'); }
export function isInitialized(home) { return !!home && existsSync(factoryPath(home)); }

export function readFactory(home) {
  const f = readJson(factoryPath(home), null);
  if (!f) return null;
  const d = defaultFactory();
  return { ...d, ...f, tick: { ...d.tick, ...(f.tick || {}) }, dispatcher: { ...d.dispatcher, ...(f.dispatcher || {}) },
    reports: { ...d.reports, ...(f.reports || {}) }, baseline: { ...d.baseline, ...(f.baseline || {}) } };
}

export function updateFactory(home, fn) {
  return withMutex(home, () => {
    const cur = readFactory(home) || defaultFactory();
    const out = fn(cur) || cur;
    writeJsonAtomic(factoryPath(home), out);
    return out;
  });
}

export function setStatus(home, status, reason = null, extra = null) {
  let from = null;
  const f = updateFactory(home, (s) => {
    from = s.status;
    if (s.status !== status) { s.status = status; s.status_changed_at = nowIso(); }
    s.status_reason = reason;
    if (extra) extra(s);
  });
  if (from !== status) emit(home, { type: 'factory.status', msg: `factory ${from} -> ${status}${reason ? `: ${reason}` : ''}`, data: { from, to: status } });
  return f;
}

// ---------- lease ----------
export function leasePath(home) { return join(home, 'run', 'lease.json'); }
export function readLease(home) { return readJson(leasePath(home), null); }

export function leaseLive(lease, now = Date.now()) {
  if (!lease || !lease.session_id) return false;
  const r = Date.parse(lease.renewed_at || 0) || 0;
  return r + (lease.ttl_s || LEASE_TTL_S) * 1000 > now;
}

export function holdsLease(home, session) {
  const l = readLease(home);
  return !!(l && session && l.session_id === session && leaseLive(l));
}

/**
 * Take or renew the lease. Returns {ok, stolen, holder}. Refuses when another live session holds it,
 * unless takeover. ok=false -> CLI exit 3.
 */
export function acquireLease(home, session, { takeover = false, source = 'cli' } = {}) {
  if (!session) { const e = new Error('--session is required'); e.exitCode = 2; throw e; }
  return withMutex(home, () => {
    const cur = readLease(home);
    const now = nowIso();
    if (cur && cur.session_id === session) {
      cur.renewed_at = now; cur.pid = process.pid;
      writeJsonAtomic(leasePath(home), cur);
      return { ok: true, stolen: false, holder: session };
    }
    if (cur && leaseLive(cur) && !takeover) return { ok: false, stolen: false, holder: cur.session_id };
    const lease = { session_id: session, acquired_at: now, renewed_at: now, ttl_s: LEASE_TTL_S, host: hostname(), pid: process.pid };
    writeJsonAtomic(leasePath(home), lease);
    const stolen = !!(cur && cur.session_id);
    emit(home, {
      type: stolen ? 'lock.stolen' : 'lock.acquired', source, session_id: session,
      msg: stolen ? `lease taken from ${cur.session_id}` : 'lease acquired', data: { from: stolen ? cur.session_id : null },
    });
    updateFactory(home, (s) => { s.dispatcher = { session_id: session, since: now }; });
    return { ok: true, stolen, holder: session };
  });
}

export function releaseLease(home, session) {
  return withMutex(home, () => {
    const cur = readLease(home);
    if (!cur || (session && cur.session_id !== session)) return false;
    cur.renewed_at = new Date(0).toISOString();
    writeJsonAtomic(leasePath(home), cur);
    emit(home, { type: 'lock.released', session_id: cur.session_id, msg: 'lease released' });
    return true;
  });
}

// ---------- init ----------
export const GITIGNORE = ['*', '!.gitignore', '!config.json', '!config.schema.json', '!constitution.md', '!org.md',
  '!roles/', '!roles/**', '!docs/', '!docs/**', '!setup/', '!setup/answers.json', '!sync/', '!sync/map.json'].join('\n') + '\n';

export const LAYOUT = ['roles', 'docs', 'goals', 'epics', 'tasks', 'gates', 'runs', 'state', 'inbox', 'inbox/processed',
  'inbox/rejected', 'events', 'events/archive', 'sync', 'setup', 'run', 'run/checks', 'run/branch-locks', 'worktrees'];

export function init(home) {
  ensureDir(home);
  for (const d of LAYOUT) ensureDir(join(home, d));
  const created = [];
  const gi = join(home, '.gitignore');
  if (!existsSync(gi)) { writeFileSync(gi, GITIGNORE); created.push('.gitignore'); }
  if (!existsSync(join(home, 'config.json'))) { writeJsonAtomic(join(home, 'config.json'), configDefaults()); created.push('config.json'); }
  const schemaSrc = join(pluginRoot(), 'scripts', 'schemas', 'config.schema.json');
  if (!existsSync(join(home, 'config.schema.json')) && existsSync(schemaSrc)) {
    copyFileSync(schemaSrc, join(home, 'config.schema.json')); created.push('config.schema.json');
  }
  if (!existsSync(factoryPath(home))) { writeJsonAtomic(factoryPath(home), defaultFactory()); created.push('state/factory.json'); }
  const counters = join(home, 'state', 'counters.json');
  if (!existsSync(counters)) { writeJsonAtomic(counters, { goal: 0, epic: 0, task: 0, run: 0, gate: 0 }); created.push('state/counters.json'); }
  if (!existsSync(join(home, 'state', 'index.json'))) { rebuild(home); created.push('state/index.json'); }
  for (const f of ['state/usage.jsonl', 'state/ledger.jsonl', 'events/events.jsonl']) {
    if (!existsSync(join(home, f))) { writeFileSync(join(home, f), ''); }
  }
  return created;
}
