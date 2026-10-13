// Demo mode: copy the test fixture to a temp project, shift its clock to "now", then replay
// activity every 1.5 s (messages, task moves, live tokens, ticks, inbox results) so the views
// and animations can be reviewed without a running factory. Writes only inside the temp copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../test/fixtures/basic/.factory/', import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function shiftValue(v, ms) {
  if (typeof v === 'string' && ISO.test(v)) return new Date(Date.parse(v) + ms).toISOString();
  if (Array.isArray(v)) return v.map((x) => shiftValue(x, ms));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = shiftValue(x, ms);
    return o;
  }
  return v;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

// Shows the A10 features (contracts 21): teams, an ops goal and a stream goal with items, cycles, a baseline,
// CTO reports and an improvement gate. Runs on the copy, after the clock shift, so every time is relative to `now`.
export function addDemoExtras(home, now = Date.now()) {
  const P = (...p) => path.join(home, ...p);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  const H = 3600 * 1000;
  const D = 24 * H;
  const day = iso(0).slice(0, 10);

  // Config: two teams, streams and cycles on. Existing demo work belongs to the Web team.
  const cfg = read(P('config.json'));
  cfg.teams = {
    web: { name: 'Web', kind: 'engineering', parent: null, repos: [], roles: [], tracker: { team_key: 'WEB' } },
    platform: { name: 'Platform', kind: 'engineering', parent: null, repos: [], roles: [], tracker: { team_key: 'PLT' } },
  };
  cfg.streams = { enabled: true, teams: [], capacity_pct: 30 };
  cfg.cycles = { enabled: true, source: 'local', length_days: 14, anchor: '2026-01-05', plan_at_start: true, review_at_end: true };
  cfg.reports = { enabled: true, every_h: 24, idle_min_h: 4, idle_min_events: 10, max_proposals: 5 };
  write(P('config.json'), cfg);
  const tag = { tasks: () => ({ team: 'web' }), epics: () => ({ team: 'web' }), goals: () => ({ teams: ['web'], lead_team: 'web' }) };
  for (const [dir, patch] of Object.entries(tag)) {
    for (const n of fs.readdirSync(P(dir)).filter((x) => x.endsWith('.json'))) write(P(dir, n), { ...read(P(dir, n)), ...patch() });
  }

  // Documents the Reports view lists. Ages are set through the file times.
  const doc = (rel, text, ageMs) => {
    fs.mkdirSync(path.dirname(P(rel)), { recursive: true });
    fs.writeFileSync(P(rel), text);
    const t = new Date(now - ageMs);
    fs.utimesSync(P(rel), t, t);
  };
  const reportPath = `docs/reports/${day}-0700-periodic.md`;
  const yesterday = iso(-D).slice(0, 10);
  doc(reportPath, [
    `# CTO report, ${day}, periodic`, '',
    '## Headline', '',
    '- 11 tasks done, 3 in review, 1 blocked in the last 24 hours.',
    '- The VIN decoder is on track. The CSV export is over budget and waiting for you.',
    '- Reviews took 3 rounds on average for the intake form. That is where time went.', '',
    '## Process review', '',
    'Code review found the same lint failure in 4 of 7 tasks. A lint check before review would catch it earlier.', '',
    '## Proposals', '',
    '- P-1: Run the build and lint checks before every review, so reviewers see only real findings.', ''].join('\n'), 2 * H);
  doc(`docs/reports/${yesterday}-0700-periodic.md`, `# CTO report, ${yesterday}, periodic\n\nEight tasks done. No blockers. One proposal was approved.\n`, 26 * H);
  doc(`docs/baseline/assessment-${day}.md`, `# Assessment, ${day}\n\nTwo open pull requests are not from the factory. One of them touches files that task T-0016 owns. T-0016 was told to name it in its handoff.\n`, 3 * H);
  doc('docs/cycles/web-3-plan.md', '# Web cycle 3 plan\n\nCommitted: 2 goal tasks and 3 stream items (1 P1 bug, 2 tech debt). Carryover: none.\n', 5 * D);
  doc('docs/baseline/teams/web.md', '# Web team baseline\n\nRepo dealer-app: 2 open pull requests, 1 not from the factory. 14 commits in the last 7 days.\n', 20 * 60 * 1000);
  doc('docs/baseline/factory.md', `# Factory baseline\n\nCollected ${day}. Goals: 1 active, 1 awaiting G1, 1 budget blocked. Streams: Web maintenance.\n`, 20 * 60 * 1000);

  // State: baseline, cycles and the new factory.json sections.
  const pr = (number, title, head, author, draft, factory, ageMs) => ({ number, title, url: `https://example.invalid/pull/${number}`, head, author, draft,
    review_decision: null, updated_at: iso(-ageMs), files: [], factory });
  write(P('state', 'baseline.json'), {
    v: 1, at: iso(-20 * 60 * 1000),
    repos: {
      'dealer-app': {
        team: 'web', base_branch: 'main', head_sha: '3f9c2ab', recent_commits_7d: 14, pr_error: null, factory_branches: 2,
        open_prs: [pr(41, 'Fix tax rounding on the deal sheet', 'ops/tax-rounding', 'dev1', false, false, 6 * H), pr(44, 'VIN decode service', 'factory/E-0001', 'factory', false, true, 2 * H)],
        branches: [{ name: 'ops/spike-search', ahead: 3, behind: 0, last_commit_at: iso(-3 * D) }],
      },
      'dealer-api': {
        team: 'platform', base_branch: 'main', head_sha: '9d41e07', recent_commits_7d: 5, pr_error: null, factory_branches: 0,
        open_prs: [pr(12, 'Upgrade the job runner', 'dev2/runner', 'dev2', true, false, 30 * H)], branches: [],
      },
    },
    factory: {}, tracker: null,
  });
  const cyc = (team, n, startDays) => ({ id: `${team}-${n}`, team, number: n, name: null, starts_at: iso(startDays * D), ends_at: iso((startDays + 14) * D), source: 'local', tracker_id: null });
  write(P('state', 'cycles.json'), {
    v: 1, updated_at: iso(-H),
    teams: Object.fromEntries(['web', 'platform'].map((t) => [t, { previous: cyc(t, 2, -19), current: cyc(t, 3, -5), next: cyc(t, 4, 9) }])),
  });
  const fac = read(P('state', 'factory.json'));
  fac.reports = { last_at: iso(-2 * H), last_path: reportPath, last_type: 'periodic', last_task_id: 'T-0101' };
  fac.baseline = { last_collect_at: iso(-20 * 60 * 1000), last_assess_at: iso(-3 * H), assess_requested: false };
  write(P('state', 'factory.json'), fac);

  // Records: an ops goal, a stream goal with four items, one fix epic with its task, one improvement gate.
  const baseTask = read(P('tasks', 'T-0007.json'));
  const task = (id, patch) => ({
    ...baseTask, id, rev: 1, created_at: iso(-30 * H), updated_at: iso(-2 * H), epic_id: null, kind: 'triage', role: 'staff-engineer', size: 'S', priority: 'P2',
    acceptance_criteria: [], ac_version: 1, files_owned: [], files_shared: [], files_read: [], depends_on: [], gate_deps: [], reviews_required: [], reviews: {},
    status_reason: null, attempts: 1, rework_count: 0, fixups: 0, estimate_tokens: 250000, branch: null, base_ref: null, current_run_id: null, runs: [], blocked: null,
    feedback: [], answers: [], team: 'web', ...patch,
  });
  const goal = (id, patch) => ({
    ...read(P('goals', 'G-003.json')), id, rev: 1, created_at: iso(-3 * D), updated_at: iso(-H), priority: 'P2', needs_ui: false, gates: { G1: null, G2: null, G3: null },
    docs: { prd: null, spec: null, plan: null, design: null }, epics: [], status: 'active', status_reason: null, ...patch,
  });
  const ops = goal('G-004', { title: 'Factory operations', slug: 'ops', kind: 'ops', outcome: 'The team gets a baseline, plans and reports on time.',
    success_criteria: ['The team gets a baseline, plans and reports on time'], constraints: [], teams: [], budget: { limit_tokens: 2000000, warn_pct: 80, stop_pct: 100, window_start: iso(-8 * H) } });
  const stream = goal('G-005', { title: 'Web maintenance', slug: 'web-maintenance', kind: 'stream', team: 'web', teams: [], outcome: 'Bugs and tech debt for the Web team get fixed.',
    success_criteria: ['Bugs and tech debt for the Web team get fixed'], constraints: [], budget: { limit_tokens: 15000000, warn_pct: 80, stop_pct: 100, window_start: iso(-5 * D) } });
  write(P('goals', 'G-004.json'), ops);
  write(P('goals', 'G-005.json'), stream);
  write(P('epics', 'E-0003.json'), {
    schema: 'factory/epic@1', id: 'E-0003', rev: 1, created_at: iso(-20 * H), updated_at: iso(-2 * H), goal_id: 'G-005', title: 'Fix deal sheet tax rounding',
    slug: 'tax-rounding', summary: 'Round tax per line, not per deal.', depends_on: [], status: 'pr_open', branch: 'factory/E-0003-tax-rounding', base_branch: 'main',
    pr: { number: 45, url: 'https://example.invalid/pull/45' }, gates: { G4: null }, tasks: ['T-0106'], team: 'web', item_task_id: 'T-0103',
  });
  const item = (cls, by) => ({ class: cls, tracker_ref: null, reported_by: by });
  const records = [
    task('T-0101', { goal_id: 'G-004', kind: 'report', role: 'cto', title: `CTO report ${day} periodic`, status: 'done', report_type: 'periodic', team: null }),
    task('T-0102', { goal_id: 'G-005', title: 'Intermittent 500 when a deal has no trade-in', status: 'ready', priority: 'P1', item: item('bug', 'human'), item_epic_ids: [], cycle: 'web-3' }),
    task('T-0103', { goal_id: 'G-005', title: 'Tax rounds per deal instead of per line', status: 'done', priority: 'P1', item: item('bug', 'tracker'), item_epic_ids: ['E-0003'], cycle: 'web-3' }),
    task('T-0104', { goal_id: 'G-005', title: 'Remove the unused export helpers', status: 'done', priority: 'P3', item: item('tech_debt', 'agent'), item_epic_ids: [] }),
    task('T-0105', { goal_id: 'G-005', title: 'Slow inventory list on large dealers', status: 'blocked', item: item('tech_debt', 'human'), item_epic_ids: [],
      blocked: { reason: 'Needs a sample of the slow query from the dealer.', needs: 'human', since: iso(-9 * H), question_id: null } }),
    task('T-0106', { goal_id: 'G-005', epic_id: 'E-0003', kind: 'code', role: 'backend-engineer', title: 'Round tax per line', status: 'integrated', priority: 'P1', cycle: 'web-3' }),
  ];
  for (const t of records) write(P('tasks', `${t.id}.json`), t);
  write(P('gates', 'GATE-0008.json'), {
    schema: 'factory/gate@1', id: 'GATE-0008', rev: 1, created_at: iso(-2 * H), updated_at: iso(-2 * H), type: 'improvement', subject: { kind: 'task', id: 'T-0101' },
    goal_id: 'G-004', status: 'pending', opened_at: iso(-2 * H), opened_by: { run_id: null, actor: 'cto' },
    artifact: { paths: [reportPath], summary: 'P-1 Run checks before review: 4 of 7 tasks failed review on lint.' },
    request: { action: 'proposal', proposal: {
      id: 'P-1', title: 'Run the build and lint checks before every review',
      why: 'Code review found the same lint failure in 4 of 7 tasks this week. Each one cost a rework round of about 150k tokens.',
      change: { kind: 'config', patch: { 'reviews.profile': 'strict', 'concurrency.reviewers': 3 } },
      expected_effect: 'About 4 fewer rework rounds a week, around 600k tokens saved.', risk: 'low' } },
    decision: null, auto: false,
  });

  // Index: bumps its revision so a running poller reloads the records.
  const idx = read(P('state', 'index.json'));
  idx.rev = (idx.rev || 0) + 1;
  idx.goals['G-004'] = { status: 'active', title: ops.title, priority: ops.priority };
  idx.goals['G-005'] = { status: 'active', title: stream.title, priority: stream.priority };
  idx.epics['E-0003'] = { goal_id: 'G-005', status: 'pr_open' };
  for (const t of records) {
    idx.tasks[t.id] = { goal_id: t.goal_id, epic_id: t.epic_id, status: t.status, role: t.role, kind: t.kind, priority: t.priority, depends_on: [], gate_deps: [],
      files_owned: [], current_run_id: null, updated_at: t.updated_at };
  }
  write(P('state', 'index.json'), idx);
}

// Returns the temp project dir (holding .factory).
export function prepareDemo() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cc-demo-'));
  const home = path.join(project, '.factory');
  fs.cpSync(FIXTURE, home, { recursive: true });
  // The fixture's newest event marks "now".
  const lines = fs.readFileSync(path.join(home, 'events', 'events.jsonl'), 'utf8').trim().split('\n');
  const newest = Date.parse(JSON.parse(lines.at(-1)).ts);
  const shift = Date.now() - newest - 60000;
  for (const f of walk(home)) {
    if (f.endsWith('.json')) {
      fs.writeFileSync(f, JSON.stringify(shiftValue(JSON.parse(fs.readFileSync(f, 'utf8')), shift), null, 2) + '\n');
    } else if (f.endsWith('.jsonl')) {
      const out = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify(shiftValue(JSON.parse(l), shift)));
      fs.writeFileSync(f, out.join('\n') + '\n');
    }
  }
  addDemoExtras(home);
  fs.mkdirSync(path.join(project, '.git'), { recursive: true }); // looks like a repo root; never read
  // The demo gets its own plugin data dir, so signing uses a throwaway HMAC key, never the real one.
  const data = path.join(project, 'plugin-data');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'run', 'machine.json'), JSON.stringify({ plugin_data: data, demo: true }, null, 2) + '\n');
  return project;
}

// Message script: [type, from, to, task]. Covers every msg.* type.
const SCRIPT = [
  ['dispatch', 'cto', 'frontend-engineer', 'T-0016'],
  ['handoff', 'frontend-engineer', 'cto', 'T-0012'],
  ['review_request', 'cto', 'code-reviewer', 'T-0012'],
  ['question', 'backend-engineer', 'staff-engineer', 'T-0015'],
  ['answer', 'staff-engineer', 'backend-engineer', 'T-0015'],
  ['review_result', 'code-reviewer', 'cto', 'T-0013'],
  ['dispatch', 'cto', 'qa-engineer', 'T-0012'],
  ['rework', 'cto', 'backend-engineer', 'T-0015'],
  ['approval_request', 'cto', 'user', 'T-0029'],
  ['dispatch', 'cto', 'data-engineer', 'T-0018'],
  ['question', 'data-engineer', 'user', 'T-0018'],
  ['handoff', 'qa-engineer', 'cto', 'T-0012'],
  ['dispatch', 'cto', 'product-manager', 'T-0029'],
  ['handoff', 'product-manager', 'critic', 'T-0029'],
  ['review_result', 'critic', 'cto', 'T-0029'],
  ['escalation', 'devops-release', 'cto', 'T-0022'],
  ['approval_result', 'user', 'cto', 'T-0029'],
  ['dispatch', 'cto', 'tech-writer', 'T-0011'],
  ['handoff', 'tech-writer', 'cto', 'T-0011'],
  ['dispatch', 'cto', 'security-reviewer', 'T-0015'],
  ['review_result', 'security-reviewer', 'cto', 'T-0015'],
  ['dispatch', 'cto', 'devops-release', 'T-0017'],
  ['dispatch', 'cto', 'ui-ux-designer', 'T-0020'],
  ['handoff', 'ui-ux-designer', 'product-manager', 'T-0020'],
  ['dispatch', 'cto', 'project-manager', 'T-0019'],
];
// Task cycles: the task walks these statuses, one step every few beats.
const CYCLES = {
  'T-0016': ['ready', 'in_progress', 'checking', 'in_review', 'verified', 'integrated'],
  'T-0019': ['backlog', 'ready', 'in_progress', 'checking', 'in_review', 'changes_requested', 'ready'],
  'T-0014': ['checking', 'in_review', 'verified', 'integrated'],
};

export function startDemo({ home, intervalMs = 1500, log = () => {} }) {
  let beat = 0;
  let seq = 5000;
  const P = (...p) => path.join(home, ...p);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const write = (f, o) => {
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n');
    fs.renameSync(tmp, f);
  };
  const tasks = (id) => read(P('tasks', `${id}.json`));
  const event = (type, fields) => {
    const now = Date.now();
    const line = { v: 1, id: `01J${String(now).padStart(13, '0')}${String(++seq).padStart(4, '0')}`, ts: new Date(now).toISOString(), type,
      source: 'cli', session_id: 'sess-cto-1', actor: { kind: 'system', role: 'cto' }, data: {}, ...fields };
    fs.appendFileSync(P('events', 'events.jsonl'), JSON.stringify(line) + '\n');
  };
  const live = new Map(); // run id -> token counters

  function message(offset = 0) {
    const [kind, from, to, tid] = SCRIPT[(beat + offset) % SCRIPT.length];
    const t = tasks(tid) || {};
    event(`msg.${kind}`, { source: 'hook', actor: { kind: from === 'user' ? 'human' : 'agent', role: from }, goal_id: t.goal_id, epic_id: t.epic_id ?? undefined,
      task_id: tid, msg: `${kind.replace('_', ' ')} ${tid}: ${from} to ${to}`.slice(0, 140), data: { from: { role: from }, to: { role: to } } });
  }

  function moveTask() {
    const ids = Object.keys(CYCLES);
    const id = ids[Math.floor(beat / 4) % ids.length];
    const t = tasks(id);
    if (!t) return;
    const cycle = CYCLES[id];
    const i = cycle.indexOf(t.status);
    const to = cycle[(i + 1) % cycle.length];
    const from = t.status;
    t.status = to;
    t.rev = (t.rev || 0) + 1;
    t.updated_at = new Date().toISOString();
    write(P('tasks', `${id}.json`), t);
    const idx = read(P('state', 'index.json'));
    if (idx?.tasks?.[id]) {
      idx.tasks[id].status = to;
      idx.tasks[id].updated_at = t.updated_at;
      idx.rev = (idx.rev || 0) + 1;
      write(P('state', 'index.json'), idx);
    }
    event('task.status', { goal_id: t.goal_id, epic_id: t.epic_id ?? undefined, task_id: id, msg: `${id} ${from} -> ${to}`, data: { from, to } });
  }

  function tokens() {
    const idx = read(P('state', 'index.json'));
    for (const rid of idx?.runs_active || []) {
      const r = read(P('runs', rid, 'run.json'));
      if (!r) continue;
      const c = live.get(rid) || { input: 9000, output: 30000, cache_read: 1200000, cache_creation: 80000, requests: 40 };
      c.input += 300; c.output += 1500; c.cache_read += 60000; c.cache_creation += 2500; c.requests += 2;
      live.set(rid, c);
      const model = r.model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
      fs.appendFileSync(P('state', 'usage.jsonl'), JSON.stringify({ v: 1, ts: new Date().toISOString(), source: 'reconcile', scope: 'agent', agent_id: r.agent_id,
        session_id: r.session_id, agent_type: r.subagent_type, run_id: rid, task_id: r.task_id, goal_id: r.goal_id, role: r.role, status: 'running',
        requests: c.requests, by_model: { [model]: { ...c } } }) + '\n');
    }
  }

  function tick() {
    const f = read(P('state', 'factory.json'));
    if (!f) return;
    const now = Date.now();
    f.tick = { ...(f.tick || {}), count: (f.tick?.count || 0) + 1, last_begin_at: new Date(now).toISOString(), last_end_at: new Date(now + 2000).toISOString(),
      next_wakeup_at: new Date(now + 120000).toISOString() };
    write(P('state', 'factory.json'), f);
    event('tick.started', { msg: `Tick ${f.tick.count} started` });
    event('tick.finished', { msg: `Tick ${f.tick.count} finished`, data: { dispatched: 1, next_s: 120 } });
  }

  // Applies queued dashboard requests like the real loop would, but simplified.
  function inbox() {
    let names = [];
    try { names = fs.readdirSync(P('inbox')).filter((n) => n.endsWith('.json') && !n.includes('.tmp')); } catch { return; }
    for (const n of names) {
      const req = read(P('inbox', n));
      if (!req) continue;
      let result = { status: 'applied', reason: 'demo: applied', tick: 0 };
      if (req.type === 'gate.decide') {
        const g = read(P('gates', `${req.payload.gate_id}.json`));
        if (g && g.status === 'pending') {
          g.status = { approve: 'approved', changes: 'changes_requested', reject: 'rejected' }[req.payload.decision];
          g.decision = { by: 'owner', via: 'dashboard', at: new Date().toISOString(), notes: req.payload.notes || '' };
          g.rev = (g.rev || 0) + 1;
          write(P('gates', `${g.id}.json`), g);
          event('gate.decided', { actor: { kind: 'human', role: 'user' }, goal_id: g.goal_id, msg: `${g.id} ${g.status}`, data: { gate_id: g.id, decision: g.status, via: 'dashboard' } });
          result = { status: 'applied', reason: `gate ${g.status}`, tick: 0, gate_id: g.id };
        } else result = { status: 'rejected', reason: 'gate is not pending', tick: 0 };
      }
      req.result = result;
      fs.mkdirSync(P('inbox', 'processed'), { recursive: true });
      write(P('inbox', 'processed', n), req);
      fs.rmSync(P('inbox', n), { force: true });
      event('inbox.processed', { msg: `${req.type} ${result.status}: ${req.id}`, data: { inbox_id: req.id, type: req.type, status: result.status, reason: result.reason } });
    }
  }

  const timer = setInterval(() => {
    beat++;
    try {
      message();
      if (beat % 2 === 0) message(11);
      if (beat % 4 === 0) moveTask();
      tokens();
      if (beat % 10 === 1) tick();
      if (beat % 3 === 0) inbox();
    } catch (e) {
      log(`demo error: ${e.message}`);
    }
  }, intervalMs);
  log(`demo replay every ${intervalMs} ms`);
  return { stop: () => clearInterval(timer) };
}
