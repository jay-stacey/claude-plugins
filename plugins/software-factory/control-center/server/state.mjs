// Read-only model of `.factory/`. Loads records, tails events and usage, and computes the
// slices the UI needs. `refresh()` is called by the poller and reports which slices changed.
import fs from 'node:fs';
import path from 'node:path';

export const ROLES = [
  { id: 'user', name: 'You', short: 'You', monogram: 'YOU', reports_to: null, line: 'user' },
  { id: 'cto', name: 'CTO', short: 'CTO', monogram: 'CT', reports_to: 'user', line: 'lead' },
  { id: 'product-manager', name: 'Product Manager', short: 'Product', monogram: 'PM', reports_to: 'cto', line: 'product' },
  { id: 'ui-ux-designer', name: 'UI/UX Designer', short: 'UI/UX', monogram: 'UX', reports_to: 'product-manager', line: 'product' },
  { id: 'project-manager', name: 'Project Manager', short: 'Project', monogram: 'PJ', reports_to: 'cto', line: 'delivery' },
  { id: 'staff-engineer', name: 'Staff Engineer', short: 'Staff', monogram: 'SE', reports_to: 'cto', line: 'engineering' },
  { id: 'data-engineer', name: 'Data Engineer', short: 'Data', monogram: 'DE', reports_to: 'staff-engineer', line: 'engineering' },
  { id: 'backend-engineer', name: 'Backend Engineer', short: 'Backend', monogram: 'BE', reports_to: 'staff-engineer', line: 'engineering' },
  { id: 'frontend-engineer', name: 'Frontend Engineer', short: 'Frontend', monogram: 'FE', reports_to: 'staff-engineer', line: 'engineering' },
  { id: 'devops-release', name: 'DevOps and Release', short: 'DevOps', monogram: 'DO', reports_to: 'staff-engineer', line: 'engineering' },
  { id: 'tech-writer', name: 'Tech Writer', short: 'Writer', monogram: 'TW', reports_to: 'staff-engineer', line: 'engineering' },
  { id: 'critic', name: 'Critic', short: 'Critic', monogram: 'CR', reports_to: 'cto', line: 'assurance' },
  { id: 'code-reviewer', name: 'Code Reviewer', short: 'Code review', monogram: 'RV', reports_to: 'cto', line: 'assurance' },
  { id: 'security-reviewer', name: 'Security Reviewer', short: 'Security', monogram: 'SR', reports_to: 'cto', line: 'assurance' },
  { id: 'qa-engineer', name: 'QA Engineer', short: 'QA', monogram: 'QA', reports_to: 'cto', line: 'assurance' },
].map((r, i) => ({ ...r, color_index: i === 0 ? null : i - 1 }));

const DEFAULT_WEIGHTS = { input: 1, output: 1, cache_creation: 1.25, cache_read: 0.1 };
const EVENTS_TAIL = 300;
const STALE_GRACE_S = 300;
const ACTIVE_RUN = new Set(['dispatching', 'running', 'suspect']);
// Documents the Reports view lists (contracts 21.10.2). Newest first, capped.
const REPORT_SOURCES = [
  { dir: 'docs/reports', kind: 'report', match: /\.md$/i },
  { dir: 'docs/baseline', kind: 'assessment', match: /^assessment-.*\.md$/i },
  { dir: 'docs/cycles', kind: 'cycle', match: /\.md$/i },
  { dir: 'docs/baseline/teams', kind: 'team_baseline', match: /\.md$/i },
  { dir: 'docs/baseline', kind: 'baseline', match: /^factory\.md$/i },
];
export const REPORTS_CAP = 200;

function statSafe(f) {
  try { return fs.statSync(f); } catch { return null; }
}
function readJsonSafe(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; }
}
function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.includes('.tmp')).sort();
  } catch { return []; }
}
const sig = (st) => (st ? `${st.mtimeMs}:${st.size}` : 'none');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function billed(byModel, w = DEFAULT_WEIGHTS) {
  let s = 0;
  for (const m of Object.values(byModel || {})) {
    s += num(m.input) * w.input + num(m.output) * w.output + num(m.cache_creation) * w.cache_creation + num(m.cache_read) * w.cache_read;
  }
  return Math.round(s);
}

export class FactoryState {
  constructor({ home, projectDir, demo = false, instanceId = '', now = () => Date.now() }) {
    this.home = home;
    this.projectDir = projectDir;
    this.demo = demo;
    this.instanceId = instanceId;
    this.now = now;
    this.rev = 0;
    this.sigs = new Map(); // key -> signature, for change detection
    this.records = { goals: new Map(), epics: new Map(), tasks: new Map(), gates: new Map(), runs: new Map() };
    this.fileCache = new Map(); // file -> {sig, data}
    this.config = {};
    this.factory = null;
    this.budget = { goals: {} };
    this.index = null;
    this.events = []; // tail, oldest first
    this.eventsOffset = 0;
    this.eventsIno = null;

    this.badLines = 0;
    this.usage = { offset: 0, ino: null, latest: new Map(), lastBilled: new Map(), hourly: new Map() };
    this.inbox = { pending: [], recent: [] };
    this.slices = {};
    this.lastFactorySlice = '';
    this.cycles = null; // state/cycles.json as written, or null
    this.baseline = null; // state/baseline.json, summarised by baselineSummary()
    this.titleCache = new Map(); // file -> {sig, title}
    this.reportsList = [];
    this.baselineSummaryValue = null;
  }

  p(...parts) { return path.join(this.home, ...parts); }

  weights() { return { ...DEFAULT_WEIGHTS, ...(this.config?.budget?.weights || {}) }; }

  cachedJson(file) {
    const st = statSafe(file);
    const s = sig(st);
    const hit = this.fileCache.get(file);
    if (hit && hit.sig === s) return hit.data;
    if (!st) { this.fileCache.delete(file); return undefined; }
    const data = readJsonSafe(file);
    if (data === undefined && hit) return hit.data; // torn read: keep the previous copy
    this.fileCache.set(file, { sig: s, data });
    return data;
  }

  changed(key, s) {
    if (this.sigs.get(key) === s) return false;
    this.sigs.set(key, s);
    return true;
  }

  // ---------- loaders ----------
  loadDir(kind, dir) {
    const map = new Map();
    for (const name of listJson(this.p(dir))) {
      const rec = this.cachedJson(this.p(dir, name));
      if (rec && typeof rec === 'object' && rec.id) map.set(rec.id, rec);
    }
    this.records[kind] = map;
  }

  loadRuns() {
    // Active runs from the index plus the latest run of every task (for evidence).
    const ids = new Set(this.index?.runs_active || []);
    for (const t of this.records.tasks.values()) {
      if (t.current_run_id) ids.add(t.current_run_id);
      const last = Array.isArray(t.runs) ? t.runs.at(-1) : null;
      if (last) ids.add(last);
    }
    const map = new Map();
    for (const id of ids) {
      if (!/^R-[\w-]+$/.test(id)) continue;
      const rec = this.cachedJson(this.p('runs', id, 'run.json'));
      if (rec) map.set(id, rec);
    }
    this.records.runs = map;
  }

  evidenceFor(runId) {
    if (!runId || !/^R-[\w-]+$/.test(runId)) return [];
    const f = this.p('runs', runId, 'evidence', 'index.jsonl');
    const st = statSafe(f);
    const s = sig(st);
    const hit = this.fileCache.get(f);
    if (hit && hit.sig === s) return hit.data;
    let out = [];
    if (st) {
      try {
        out = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean).map((e) => ({ id: e.id, label: e.label, log_path: e.log_path, exit_code: e.exit_code, source: e.source }));
      } catch { out = []; }
    }
    this.fileCache.set(f, { sig: s, data: out });
    return out;
  }

  loadInbox() {
    const pending = [];
    for (const name of listJson(this.p('inbox'))) {
      const r = this.cachedJson(this.p('inbox', name));
      if (r && r.id) pending.push({ id: r.id, type: r.type, created_at: r.created_at, payload: r.payload ?? {} });
    }
    const recent = [];
    for (const sub of ['processed', 'rejected']) {
      for (const name of listJson(this.p('inbox', sub))) recent.push({ name, sub });
    }
    recent.sort((a, b) => b.name.localeCompare(a.name));
    const rows = [];
    for (const { name, sub } of recent.slice(0, 50)) {
      const r = this.cachedJson(this.p('inbox', sub, name));
      if (!r || !r.id) continue;
      const res = r.result || {};
      rows.push({ id: r.id, type: r.type, created_at: r.created_at, status: res.status || (sub === 'rejected' ? 'rejected' : 'applied'),
        reason: res.reason ?? null, tick: res.tick ?? null, gate_id: res.gate_id ?? r.payload?.gate_id ?? null });
    }
    this.inbox = { pending, recent: rows };
  }

  // ---------- events tail ----------
  readEventsInitial() {
    const f = this.p('events', 'events.jsonl');
    const st = statSafe(f);
    this.events = [];
    if (!st) { this.eventsOffset = 0; this.eventsIno = null; return; }
    const start = Math.max(0, st.size - 2 * 1024 * 1024);
    const { lines, offset } = readCompleteLines(f, start, st.size);
    for (const l of start > 0 ? lines.slice(1) : lines) this.pushEvent(l);
    this.events = this.events.slice(-EVENTS_TAIL);
    this.eventsOffset = offset;
    this.eventsIno = st.ino;
  }

  pushEvent(line) {
    if (!line.trim()) return null;
    try {
      const e = JSON.parse(line);
      if (!e || typeof e !== 'object') throw new Error('bad');
      this.events.push(e);
      return e;
    } catch { this.badLines++; return null; }
  }

  tailEvents() {
    const f = this.p('events', 'events.jsonl');
    const st = statSafe(f);
    if (!st) { this.eventsOffset = 0; return []; }
    if (st.size < this.eventsOffset || (this.eventsIno !== null && st.ino !== this.eventsIno && st.ino !== 0)) {
      this.eventsOffset = 0; // rotated: read the new file from the start
    }
    this.eventsIno = st.ino;
    if (st.size === this.eventsOffset) return [];
    const { lines, offset } = readCompleteLines(f, this.eventsOffset, st.size);
    this.eventsOffset = offset;
    const fresh = [];
    for (const l of lines) { const e = this.pushEvent(l); if (e) fresh.push(e); }
    if (this.events.length > EVENTS_TAIL) this.events = this.events.slice(-EVENTS_TAIL);
    return fresh;
  }

  // ---------- usage ----------
  tailUsage() {
    const f = this.p('state', 'usage.jsonl');
    const st = statSafe(f);
    if (!st) { if (this.usage.offset !== 0 || this.usage.latest.size) { this.resetUsage(); return true; } return false; }
    let reset = false;
    if (st.size < this.usage.offset || (this.usage.ino !== null && st.ino !== this.usage.ino && st.ino !== 0)) {
      this.resetUsage(); // compacted or replaced
      reset = true;
    }
    const u = this.usage;
    u.ino = st.ino;
    if (st.size === u.offset) return reset;
    const { lines, offset } = readCompleteLines(f, u.offset, st.size);
    if (offset === u.offset) return reset;
    u.offset = offset;
    const w = this.weights();
    for (const l of lines) {
      if (!l.trim()) continue;
      let s;
      try { s = JSON.parse(l); } catch { this.badLines++; continue; }
      const key = s.scope === 'session' ? `session:${s.session_id}` : `agent:${s.agent_id ?? s.run_id ?? s.session_id}`;
      const b = billed(s.by_model, w);
      const prev = u.lastBilled.get(key) || 0;
      const delta = Math.max(0, b - prev);
      u.lastBilled.set(key, Math.max(prev, b));
      u.latest.set(key, s);
      const hour = typeof s.ts === 'string' ? s.ts.slice(0, 13) : null;
      if (hour && delta > 0) {
        const bucket = u.hourly.get(hour) || { total: 0, by_goal: {} };
        const g = s.goal_id || '_overhead';
        bucket.total += delta;
        bucket.by_goal[g] = (bucket.by_goal[g] || 0) + delta;
        u.hourly.set(hour, bucket);
      }
    }
    return true;
  }

  resetUsage() {
    this.usage = { offset: 0, ino: null, latest: new Map(), lastBilled: new Map(), hourly: new Map() };
  }

  usageSlice() {
    const w = this.weights();
    const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0, billed: 0 };
    const by_goal = {}, by_role = {}, by_model = {}, by_task = {};
    const running = [];
    let unattributed = 0, overhead = 0;
    for (const [key, s] of this.usage.latest) {
      const b = billed(s.by_model, w);
      const live = s.status === 'running';
      totals.billed += b;
      totals.requests += num(s.requests);
      for (const [model, m] of Object.entries(s.by_model || {})) {
        for (const k of ['input', 'output', 'cache_read', 'cache_creation']) totals[k] += num(m[k]);
        const row = by_model[model] || (by_model[model] = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0, billed: 0 });
        for (const k of ['input', 'output', 'cache_read', 'cache_creation', 'requests']) row[k] += num(m[k]);
        row.billed += billed({ [model]: m }, w);
      }
      const role = s.role || (s.scope === 'session' ? 'cto' : (s.agent_type || '').split(':').pop() || 'unknown');
      const r = by_role[role] || (by_role[role] = { billed: 0, live: 0 });
      r.billed += b; if (live) r.live += b;
      if (s.goal_id) {
        const g = by_goal[s.goal_id] || (by_goal[s.goal_id] = { billed: 0, live: 0 });
        g.billed += b; if (live) g.live += b;
      } else if (s.scope === 'session') overhead += b;
      else unattributed += b;
      if (s.task_id) by_task[s.task_id] = (by_task[s.task_id] || 0) + b;
      if (live && s.scope !== 'session') running.push({ key, run_id: s.run_id ?? null, task_id: s.task_id ?? null, goal_id: s.goal_id ?? null, role, billed: b });
    }
    const hours = [...this.usage.hourly.keys()].sort().slice(-48);
    const hourly = hours.map((h) => ({ hour: h, total: Math.round(this.usage.hourly.get(h).total), by_goal: roundAll(this.usage.hourly.get(h).by_goal) }));
    this.byTask = by_task;
    return { totals, by_goal, by_role, by_model, hourly, running, unattributed, overhead };
  }

  // ---------- slices ----------
  factorySlice() {
    const f = this.factory || { status: 'stopped', tick: {} };
    const tick = f.tick || {};
    const now = this.now();
    const next = tick.next_wakeup_at ? Date.parse(tick.next_wakeup_at) : null;
    const nextIn = next ? Math.round((next - now) / 1000) : null;
    let state = f.status || 'stopped';
    let label = { running: 'Running', pausing: 'Pausing', paused: 'Paused', stopped: 'Stopped' }[state] || 'Stopped';
    if ((state === 'running' || state === 'pausing') && next && now > next + STALE_GRACE_S * 1000) {
      state = 'stale';
      label = 'Loop not running';
    }
    return {
      status: f.status || 'stopped', status_reason: f.status_reason ?? null, status_changed_at: f.status_changed_at ?? null,
      pause_mode: f.pause_mode ?? null, tick, backoff_until: f.backoff_until ?? null,
      reports: f.reports && typeof f.reports === 'object' ? f.reports : null,
      baseline: f.baseline && typeof f.baseline === 'object' ? f.baseline : null,
      loop: { state, label, next_tick_at: tick.next_wakeup_at ?? null, next_tick_in_s: nextIn },
    };
  }

  configSlice() {
    const c = this.config || {};
    return {
      show_cost: !!c.control_center?.show_cost,
      warn_pct: c.budget?.warn_pct ?? 80, stop_pct: c.budget?.stop_pct ?? 100,
      inbox_s: c.cadence?.inbox_s ?? 120, active_s: c.cadence?.active_s ?? 270,
      weights: this.weights(),
      workspace: this.workspaceInfo(),
      teams: this.teamsInfo(),
      streams: { enabled: c.streams?.enabled === true },
      cycles: { enabled: c.cycles?.enabled === true },
      reports: { enabled: c.reports?.enabled !== false }, // on by default (contracts 21.7)
    };
  }

  // Teams (contracts 21.2). Empty when the config has no `teams`: the implicit single team is not a filter choice.
  teamsInfo() {
    const t = this.config?.teams;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return [];
    return Object.entries(t).filter(([, v]) => v && typeof v === 'object').map(([id, v]) => ({
      id, name: typeof v.name === 'string' && v.name ? v.name : id, kind: v.kind ?? null, parent: v.parent ?? null,
      repos: Array.isArray(v.repos) ? v.repos : [], tracker_key: v.tracker?.team_key ?? null,
    }));
  }

  // Workspace mode (contracts 20.2): on when workspace.enabled and repos is not empty.
  workspaceInfo() {
    const c = this.config || {};
    const names = c.repos && typeof c.repos === 'object' && !Array.isArray(c.repos) ? Object.keys(c.repos) : [];
    const enabled = !!c.workspace?.enabled && names.length > 0;
    const def = typeof c.workspace?.default_repo === 'string' && names.includes(c.workspace.default_repo) ? c.workspace.default_repo : (names[0] ?? null);
    return { enabled, default_repo: enabled ? def : null, repos: enabled ? names : [] };
  }

  goalsSlice() {
    const tasks = [...this.records.tasks.values()];
    const goals = [...this.records.goals.values()].sort((a, b) => a.id.localeCompare(b.id));
    return goals.map((g) => {
      const mine = tasks.filter((t) => t.goal_id === g.id && t.status !== 'cancelled');
      const by_status = {};
      for (const t of mine) by_status[t.status] = (by_status[t.status] || 0) + 1;
      const b = this.budget?.goals?.[g.id] || null;
      const limit = b?.limit ?? g.budget?.limit_tokens ?? 0;
      const spent = b?.spent ?? 0;
      const reserved = b?.reserved ?? 0;
      const pct = b?.pct ?? (limit ? Math.round(((spent + reserved) / limit) * 1000) / 10 : 0);
      const n = parseInt(String(g.id).replace(/\D/g, ''), 10) || 0;
      return { ...g, color_index: (n + 7) % 8, task_counts: { total: mine.length, done: mine.filter((t) => t.status === 'done' || t.status === 'integrated').length, by_status },
        spend: { limit, spent, reserved, pct, warned_at: b?.warned_at ?? null, blocked_at: b?.blocked_at ?? null } };
    });
  }

  tasksSlice() {
    const now = this.now();
    const activeByTask = new Map();
    for (const r of this.records.runs.values()) if (ACTIVE_RUN.has(r.status)) activeByTask.set(r.task_id, r);
    const byTask = this.byTask || {};
    return [...this.records.tasks.values()].sort((a, b) => a.id.localeCompare(b.id)).map((t) => {
      const last = Array.isArray(t.runs) ? t.runs.at(-1) : null;
      const upd = t.updated_at ? Date.parse(t.updated_at) : null;
      return { ...t, tokens: Math.round(byTask[t.id] || 0), live: activeByTask.has(t.id), evidence: this.evidenceFor(last),
        time_in_status_s: upd ? Math.max(0, Math.round((now - upd) / 1000)) : null };
    });
  }

  runsSlice() {
    const out = [];
    const tokensByRun = {};
    const lastTs = {};
    for (const s of this.usage.latest.values()) {
      if (!s.run_id) continue;
      tokensByRun[s.run_id] = (tokensByRun[s.run_id] || 0) + billed(s.by_model, this.weights());
      lastTs[s.run_id] = s.ts;
    }
    for (const r of this.records.runs.values()) {
      if (!ACTIVE_RUN.has(r.status)) continue;
      out.push({ ...r, tokens: tokensByRun[r.id] || 0, last_ts: lastTs[r.id] ?? null });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  gatesSlice() {
    const all = [...this.records.gates.values()];
    const pending = all.filter((g) => g.status === 'pending').sort((a, b) => String(a.opened_at).localeCompare(String(b.opened_at)));
    const rest = all.filter((g) => g.status !== 'pending')
      .sort((a, b) => String(b.decision?.at ?? b.updated_at).localeCompare(String(a.decision?.at ?? a.updated_at)));
    return pending.concat(rest).slice(0, 200);
  }

  // ---------- reports, cycles, baseline ----------
  // Stat-only scan of the report folders. Titles are read later, and only when the listing changed.
  scanReports() {
    const files = [];
    for (const src of REPORT_SOURCES) {
      let names = [];
      try { names = fs.readdirSync(this.p(...src.dir.split('/'))); } catch { continue; }
      for (const name of names) {
        if (!src.match.test(name)) continue;
        const abs = this.p(...src.dir.split('/'), name);
        const st = statSafe(abs);
        if (st && st.isFile()) files.push({ rel: `${src.dir}/${name}`, abs, kind: src.kind, st });
      }
    }
    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || (a.rel < b.rel ? 1 : a.rel > b.rel ? -1 : 0));
    return { files, sig: files.map((f) => `${f.rel}@${sig(f.st)}`).join('|') };
  }

  titleOf(f) {
    const s = sig(f.st);
    const hit = this.titleCache.get(f.abs);
    if (hit && hit.sig === s) return hit.title;
    let title = path.basename(f.abs);
    try {
      const fd = fs.openSync(f.abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(f.st.size, 4096));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(buf.subarray(0, n).toString('utf8'));
        if (m && m[1].trim()) title = m[1].trim().slice(0, 200);
      } finally { fs.closeSync(fd); }
    } catch { /* keep the file name */ }
    this.titleCache.set(f.abs, { sig: s, title });
    return title;
  }

  reportsSlice(files) {
    const top = files.slice(0, REPORTS_CAP);
    const keep = new Set(top.map((f) => f.abs));
    for (const k of this.titleCache.keys()) if (!keep.has(k)) this.titleCache.delete(k);
    return top.map((f) => ({ path: f.rel, kind: f.kind, title: this.titleOf(f), mtime: new Date(f.st.mtimeMs).toISOString(), size: f.st.size }));
  }

  // Per repo: open PRs, PRs that are not the factory's own, and local branches ahead of base.
  baselineSummary(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    const repos = [];
    const src = b.repos && typeof b.repos === 'object' && !Array.isArray(b.repos) ? b.repos : {};
    for (const [repo, r] of Object.entries(src)) {
      const prs = Array.isArray(r?.open_prs) ? r.open_prs : [];
      repos.push({
        repo, team: r?.team ?? null, open_prs: prs.length, non_factory_prs: prs.filter((x) => !x?.factory).length,
        branches: Array.isArray(r?.branches) ? r.branches.length : 0, pr_error: r?.pr_error ?? null,
      });
    }
    return { at: typeof b.at === 'string' ? b.at : null, repos };
  }

  // ---------- refresh ----------
  // Returns {slices: {name: value}, events: [new event lines]}.
  refresh({ full = false } = {}) {
    const changed = new Set();
    const cfgSig = sig(statSafe(this.p('config.json')));
    if (this.changed('config', cfgSig) || full) {
      this.config = readJsonSafe(this.p('config.json')) || this.config || {};
      changed.add('config');
    }
    const facSig = sig(statSafe(this.p('state', 'factory.json')));
    if (this.changed('factory', facSig) || full) {
      const f = readJsonSafe(this.p('state', 'factory.json'));
      if (f !== undefined || facSig === 'none') this.factory = f ?? null;
    }
    const budSig = sig(statSafe(this.p('state', 'budget.json')));
    if (this.changed('budget', budSig) || full) {
      const b = readJsonSafe(this.p('state', 'budget.json'));
      if (b !== undefined || budSig === 'none') this.budget = b ?? { goals: {} };
      changed.add('budget'); changed.add('goals');
    }
    const idxSig = sig(statSafe(this.p('state', 'index.json')));
    if (this.changed('index', idxSig) || full) {
      const idx = readJsonSafe(this.p('state', 'index.json'));
      if (idx !== undefined || idxSig === 'none') this.index = idx ?? null;
      this.loadDir('goals', 'goals');
      this.loadDir('epics', 'epics');
      this.loadDir('tasks', 'tasks');
      this.loadRuns();
      for (const s of ['goals', 'epics', 'tasks', 'runs']) changed.add(s);
    } else if (this.records.runs.size) {
      // Run records change without an index rebuild (hooks write them). Cheap stat per active run.
      let runChanged = false;
      for (const id of this.records.runs.keys()) {
        const f = this.p('runs', id, 'run.json');
        const before = this.fileCache.get(f)?.sig;
        if (sig(statSafe(f)) !== before) { runChanged = true; break; }
      }
      if (runChanged) { this.loadRuns(); changed.add('runs'); changed.add('tasks'); }
    }
    // Gates: directory listing + per-file stat.
    const gateNames = listJson(this.p('gates'));
    const gateSig = gateNames.map((n) => `${n}@${sig(statSafe(this.p('gates', n)))}`).join('|');
    if (this.changed('gates', gateSig) || full) { this.loadDir('gates', 'gates'); changed.add('gates'); }
    // Reports, cycles, baseline summary.
    const scan = this.scanReports();
    if (this.changed('reports', scan.sig) || full) { this.reportsList = this.reportsSlice(scan.files); changed.add('reports'); }
    const cycSig = sig(statSafe(this.p('state', 'cycles.json')));
    if (this.changed('cycles', cycSig) || full) {
      const c = readJsonSafe(this.p('state', 'cycles.json'));
      if (c !== undefined || cycSig === 'none') this.cycles = c && typeof c === 'object' && !Array.isArray(c) ? c : null;
      changed.add('cycles');
    }
    const baseSig = sig(statSafe(this.p('state', 'baseline.json')));
    if (this.changed('baseline', baseSig) || full) {
      const b = readJsonSafe(this.p('state', 'baseline.json'));
      if (b !== undefined || baseSig === 'none') this.baselineSummaryValue = this.baselineSummary(b);
      changed.add('baseline_summary');
    }
    // Inbox: listing only.
    const inboxSig = ['', 'processed', 'rejected'].map((d) => listJson(this.p('inbox', d)).join(',')).join('|');
    if (this.changed('inbox', inboxSig) || full) { this.loadInbox(); changed.add('inbox'); }
    // Usage tail.
    if (this.tailUsage() || full) { changed.add('usage'); changed.add('tasks'); changed.add('runs'); }
    // Events tail.
    const events = full ? (this.readEventsInitial(), []) : this.tailEvents();

    const slices = {};
    if (changed.has('usage') || full) slices.usage = this.usageSlice();
    if (changed.has('config')) slices.config = this.configSlice();
    if (changed.has('goals')) slices.goals = this.goalsSlice();
    if (changed.has('epics')) slices.epics = [...this.records.epics.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (changed.has('tasks')) slices.tasks = this.tasksSlice();
    if (changed.has('runs')) slices.runs = this.runsSlice();
    if (changed.has('gates')) slices.gates = this.gatesSlice();
    if (changed.has('budget')) slices.budget = this.budget;
    if (changed.has('inbox')) slices.inbox = this.inbox;
    if (changed.has('reports')) slices.reports = this.reportsList;
    if (changed.has('cycles')) slices.cycles = this.cycles;
    if (changed.has('baseline_summary')) slices.baseline_summary = this.baselineSummaryValue ?? null;
    const fs1 = this.factorySlice();
    const fsKey = JSON.stringify({ ...fs1, loop: { ...fs1.loop, next_tick_in_s: Math.round((fs1.loop.next_tick_in_s ?? 0) / 60) } });
    if (full || fsKey !== this.lastFactorySlice) { this.lastFactorySlice = fsKey; slices.factory = fs1; }
    // Keep the cached snapshot slices current.
    Object.assign(this.slices, slices);
    if (Object.keys(slices).length) this.rev++;
    return { slices, events };
  }

  snapshot(extra = {}) {
    const config = this.config || {};
    return {
      rev: this.rev, instance_id: this.instanceId, now: new Date(this.now()).toISOString(), demo: this.demo,
      project: { name: config.project?.name || path.basename(this.projectDir || path.dirname(this.home)), dir: this.projectDir },
      factory: this.factorySlice(), config: this.slices.config ?? this.configSlice(), roles: ROLES,
      goals: this.slices.goals ?? [], epics: this.slices.epics ?? [], tasks: this.slices.tasks ?? [], gates: this.slices.gates ?? [],
      runs: this.slices.runs ?? [], usage: this.slices.usage ?? this.usageSlice(), budget: this.budget ?? { goals: {} },
      reports: this.slices.reports ?? [], cycles: this.slices.cycles ?? null, baseline_summary: this.slices.baseline_summary ?? null,
      inbox: this.inbox, events_tail: this.events.slice(-EVENTS_TAIL),
      diagnostics: { poll_ms: 1500, bad_lines: this.badLines, last_event_at: this.events.at(-1)?.ts ?? null, ...extra },
    };
  }

  // Artifact allow-list: every path a gate, task, goal or evidence entry references.
  referencedPaths() {
    const out = new Set();
    const add = (p) => { if (typeof p === 'string' && p) out.add(p.replace(/\\/g, '/')); };
    for (const g of this.records.gates.values()) for (const p of g.artifact?.paths || []) add(p);
    for (const g of this.records.goals.values()) for (const p of Object.values(g.docs || {})) add(p);
    for (const t of this.records.tasks.values()) {
      for (const f of t.feedback || []) add(f.path);
      for (const e of this.evidenceFor(Array.isArray(t.runs) ? t.runs.at(-1) : null)) add(e.log_path);
    }
    return out;
  }

  // Event history for paging: archives (oldest first) then the live file.
  allEvents() {
    const files = [];
    const arch = this.p('events', 'archive');
    try {
      for (const n of fs.readdirSync(arch).filter((n) => n.endsWith('.jsonl')).sort().slice(-5)) files.push(path.join(arch, n));
    } catch { /* no archive */ }
    files.push(this.p('events', 'events.jsonl'));
    const out = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) {
        if (!l.trim()) continue;
        try { out.push(JSON.parse(l)); } catch { /* skip torn line */ }
      }
    }
    return out;
  }
}

function roundAll(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = Math.round(v);
  return r;
}

// Reads [start, end) and returns only complete lines. A torn last line is held back by not
// advancing the offset past it (byte-exact, so a UTF-8 character is never split).
export function readCompleteLines(file, start, end) {
  if (end <= start) return { lines: [], offset: start };
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    buf = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return { lines: [], offset: start };
  return { lines: buf.subarray(0, nl).toString('utf8').split('\n'), offset: start + nl + 1 };
}

export function readRange(file, start, end) {
  if (end <= start) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function eventMatches(e, { role, goal, task, type }) {
  if (type && !String(e.type || '').startsWith(type)) return false;
  if (goal && e.goal_id !== goal) return false;
  if (task && e.task_id !== task) return false;
  if (role) {
    const roles = [e.actor?.role, e.data?.from?.role, e.data?.to?.role, e.data?.role];
    if (!roles.includes(role)) return false;
  }
  return true;
}
