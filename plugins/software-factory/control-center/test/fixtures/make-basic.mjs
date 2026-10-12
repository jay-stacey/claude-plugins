#!/usr/bin/env node
// Regenerates test/fixtures/basic/.factory deterministically.
// Usage: node control-center/test/fixtures/make-basic.mjs --write
// The output is committed; rerun only when the fixture story changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// node --test also loads files under test/; only rewrite the fixture when asked.
if (!process.argv.includes('--write')) {
  console.log('Pass --write to regenerate test/fixtures/basic/.factory');
  process.exit(0);
}
const H = path.join(HERE, 'basic', '.factory');

// ---------- helpers ----------
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const T0 = Date.parse('2026-10-11T08:00:00Z');
const END = Date.parse('2026-10-12T14:30:00Z');
const iso = (ms) => new Date(ms).toISOString();
const at = (h, m = 0) => T0 + (h * 60 + m) * 60000; // hours after T0

function write(rel, obj) {
  const f = path.join(H, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
}
function writeLines(rel, arr) {
  const f = path.join(H, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : ''));
}

fs.rmSync(H, { recursive: true, force: true });
fs.mkdirSync(H, { recursive: true });

// ---------- config ----------
const ROLES = ['cto', 'product-manager', 'project-manager', 'staff-engineer', 'ui-ux-designer', 'data-engineer',
  'backend-engineer', 'frontend-engineer', 'devops-release', 'qa-engineer', 'code-reviewer', 'security-reviewer',
  'critic', 'tech-writer'];
const config = {
  version: 1,
  project: { name: 'dealer-app', kind: 'existing', default_branch: 'main', remote: { provider: 'github', owner: 'example', repo: 'dealer-app' } },
  stack: ['node', 'angular'],
  commands: { install: 'npm ci', build: 'npm run build', test: 'npm test', lint: 'npm run lint', typecheck: null, run: null, e2e: null },
  roles: { active: ROLES },
  gates: { G1: { enabled: true, approvers: ['owner'] }, G2: { enabled: true }, G3: { enabled: true }, G4: { enabled: true } },
  budget: { tier_defaults: { S: 5000000, M: 15000000, L: 40000000 }, warn_pct: 80, stop_pct: 100,
    weights: { input: 1, output: 1, cache_creation: 1.25, cache_read: 0.1 },
    estimates: { intake: 150000, prd: 300000, spec: 500000, mockup: 300000, breakdown: 300000, sequence: 150000,
      code_S: 250000, code_M: 600000, review: 150000, qa: 300000, docs: 200000, escalation: 200000, fixup: 150000 },
    hard_kill: false },
  concurrency: { total: 5, builders: 3, reviewers: 2, planners: 2, per_role: { 'qa-engineer': 1, 'devops-release': 1 }, max_goals_building: 3 },
  checks: { pre_review: ['npm run build', 'npm run lint', 'npm test'], post_merge: [] },
  delivery: { mode: 'github', base_branch: 'main', remote: 'origin' },
  reviews: { profile: 'lean' },
  recovery: { orphan_after_s: 1800 },
  cadence: { active_s: 270, waiting_s: [900, 1800, 3600], paused_s: 1800, inbox_s: 120 },
  sync: { min_interval_s: 60, full_every_ticks: 30 },
  tracker: { provider: 'none' },
  notifications: { desktop: true },
  control_center: { port: 47610, open_browser: true, show_cost: false },
  worktree: { include_files: [] },
};
write('config.json', config);
write('constitution.md', '# Constitution\n\nShip small, tested changes. Never push. Ask in open_questions when unsure.\n');
write('.gitignore', '*\n!.gitignore\n!config.json\n');

const common = (schema, id, created, updated, rev = 3) => ({ schema: `factory/${schema}@1`, id, rev, created_at: iso(created), updated_at: iso(updated) });

// ---------- goals ----------
const goals = [
  { ...common('goal', 'G-001', at(0), at(29, 40), 14), title: 'VIN decoder for inventory intake', slug: 'vin-decoder',
    outcome: 'Staff can type or scan a VIN at intake and the year, make, model and trim fill in automatically.',
    success_criteria: ['A valid VIN fills year, make, model and trim in under 2 seconds', 'An invalid VIN shows a clear error', 'Decodes are cached for 30 days'],
    constraints: ['Use the existing vendor API key from settings'], priority: 'P1', tier: 'M', needs_ui: true, status: 'active', status_reason: null,
    pod: { product: 'product-manager', tech_lead: 'staff-engineer', members: ['backend-engineer', 'frontend-engineer', 'data-engineer', 'devops-release', 'qa-engineer', 'code-reviewer', 'tech-writer'] },
    docs: { prd: 'docs/G-001-vin-decoder/prd.md', spec: 'docs/G-001-vin-decoder/spec.md', plan: 'docs/G-001-vin-decoder/plan.md', design: 'docs/G-001-vin-decoder/design/' },
    gates: { G1: 'GATE-0001', G2: 'GATE-0002', G3: 'GATE-0003' }, gate_policy: {},
    budget: { limit_tokens: 15000000, warn_pct: 80, stop_pct: 100 }, created_by: { kind: 'human', via: 'dashboard' }, epics: ['E-0001', 'E-0002'] },
  { ...common('goal', 'G-002', at(2), at(28, 10), 9), title: 'CSV export for deals', slug: 'csv-export',
    outcome: 'Managers can export the filtered deals list to CSV with the same columns as the screen.',
    success_criteria: ['Export respects current filters', 'Columns match the grid', 'Files over 10k rows stream'],
    constraints: [], priority: 'P2', tier: 'S', needs_ui: false, status: 'budget_blocked', status_reason: 'Spent 104% of the 5M budget',
    pod: { product: 'product-manager', tech_lead: 'staff-engineer', members: ['backend-engineer', 'code-reviewer'] },
    docs: { prd: 'docs/G-002-csv-export/prd.md', spec: null, plan: null, design: null },
    gates: { G1: 'GATE-0004', G2: null, G3: null }, gate_policy: {},
    budget: { limit_tokens: 5000000, warn_pct: 80, stop_pct: 100 }, created_by: { kind: 'human', via: 'cli' }, epics: [] },
  { ...common('goal', 'G-003', at(26), at(29, 5), 4), title: 'Audit log for deal changes', slug: 'audit-log',
    outcome: 'Every change to a deal is recorded with who, when and the old and new values, and is visible on the deal.',
    success_criteria: ['Field-level history on the deal page', 'Entries cannot be edited', 'Export history to CSV'],
    constraints: ['Keep 7 years of history'], priority: 'P3', tier: 'M', needs_ui: true, status: 'awaiting_g1', status_reason: 'PRD waiting for approval',
    pod: { product: 'product-manager', tech_lead: 'staff-engineer', members: [] },
    docs: { prd: 'docs/G-003-audit-log/prd.md', spec: null, plan: null, design: null },
    gates: { G1: 'GATE-0007', G2: null, G3: null }, gate_policy: {},
    budget: { limit_tokens: 15000000, warn_pct: 80, stop_pct: 100 }, created_by: { kind: 'human', via: 'dashboard' }, epics: [] },
];
for (const g of goals) write(`goals/${g.id}.json`, g);

// ---------- epics ----------
const epics = [
  { ...common('epic', 'E-0001', at(6), at(29, 30), 8), goal_id: 'G-001', title: 'Decoder service and API', slug: 'decoder-service',
    summary: 'Vendor client, cache table and the /vin/decode endpoint.', depends_on: [], status: 'pr_open',
    branch: 'factory/E-0001-decoder-service', base_branch: 'main',
    pr: { number: 128, url: 'https://github.com/example/dealer-app/pull/128', state: 'OPEN', head_sha: 'a1b2c3d4e5f6', review_decision: null, mergeable: 'MERGEABLE', merged_at: null },
    gates: { G4: 'GATE-0006' }, tasks: ['T-0007', 'T-0008', 'T-0009', 'T-0010', 'T-0011'] },
  { ...common('epic', 'E-0002', at(6), at(30), 6), goal_id: 'G-001', title: 'Intake form VIN experience', slug: 'intake-ui',
    summary: 'VIN field, decode panel, error states and keyboard support on the intake form.', depends_on: ['E-0001'], status: 'building',
    branch: 'factory/E-0002-intake-ui', base_branch: 'main', pr: null, gates: { G4: null },
    tasks: ['T-0012', 'T-0013', 'T-0014', 'T-0015', 'T-0016', 'T-0017', 'T-0018', 'T-0019', 'T-0020', 'T-0021', 'T-0022', 'T-0026', 'T-0027'] },
];
for (const e of epics) write(`epics/${e.id}.json`, e);

// ---------- tasks ----------
const MODEL = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' };
const roleModel = (role) => (['cto', 'product-manager', 'staff-engineer', 'critic'].includes(role) ? MODEL.opus : MODEL.sonnet);
const T = [];
let runSeq = 0;
const runs = [];
function task(id, goal, epic, kind, role, title, status, opts = {}) {
  const created = opts.created ?? at(T.length);
  const updated = opts.updated ?? Math.min(END - 60000, created + ri(30, 600) * 60000);
  const t = {
    ...common('task', id, created, updated, opts.rev ?? ri(3, 12)), goal_id: goal, epic_id: epic, kind, title,
    description: opts.description ?? `${title}. Follow the spec section for this work and keep the change small.`,
    role, size: opts.size ?? 'M', priority: goals.find((g) => g.id === goal).priority,
    acceptance_criteria: opts.ac ?? [{ id: 'AC-1', text: `${title} works as described in the spec` }, { id: 'AC-2', text: 'Tests cover the happy path and one failure path' }],
    ac_version: 1, files_owned: opts.files ?? [], files_shared: [], files_read: [], depends_on: opts.deps ?? [],
    gate_deps: opts.gate_deps ?? [], gate: opts.gate ?? null, risk_flags: opts.risk ?? [],
    reviews_required: kind === 'code' ? [['code-reviewer']].concat(role === 'frontend-engineer' ? [['qa-engineer']] : []) : [],
    reviews: opts.reviews ?? {}, status, status_reason: opts.reason ?? null,
    attempts: opts.attempts ?? (['draft', 'backlog', 'ready'].includes(status) ? 0 : 1), max_attempts: 3,
    rework_count: opts.rework ?? 0, max_rework: 3, fixups: 0,
    estimate_tokens: opts.estimate ?? (kind === 'code' ? (opts.size === 'S' ? 250000 : 600000) : config.budget.estimates[kind] ?? 300000),
    model_override: null, branch: kind === 'code' || kind === 'docs' ? `factory/${id}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-$/, '')}` : null,
    base_ref: epic ? `factory/${epic}` : null, current_run_id: null, runs: [], blocked: opts.blocked ?? null,
    resume_from: null, feedback: opts.feedback ?? [], answers: [],
  };
  // runs
  const nRuns = opts.runs ?? (['draft', 'backlog', 'ready', 'cancelled'].includes(status) ? 0 : 1);
  for (let i = 0; i < nRuns; i++) {
    runSeq++;
    const rid = `R-${String(runSeq).padStart(6, '0')}`;
    const live = (opts.liveRun && i === nRuns - 1);
    const disp = Math.max(created + 5 * 60000, updated - (nRuns - i) * 40 * 60000);
    const end = live ? null : disp + ri(8, 35) * 60000;
    const reviewRun = opts.reviewRunRole && i === nRuns - 1;
    const runRole = reviewRun ? opts.reviewRunRole : role;
    runs.push({
      ...common('run', rid, disp, end ?? END - 120000, 4), task_id: id, goal_id: goal, epic_id: epic,
      kind: reviewRun ? 'review' : (i > 0 && status === 'changes_requested' ? 'fixup' : 'author'), role: runRole,
      subagent_type: `software-factory:${runRole}`, model: roleModel(runRole).includes('opus') ? 'opus' : 'sonnet',
      status: live ? 'running' : (status === 'failed' && i === nRuns - 1 ? 'failed' : status === 'deferred' && i === nRuns - 1 ? 'deferred' : 'completed'),
      session_id: 'sess-cto-1', agent_id: `a${rid.slice(2)}f00d`, tool_use_id: `toolu_${rid.slice(2)}`,
      dispatched_at: iso(disp), started_at: iso(disp + 20000), ended_at: end ? iso(end) : null,
      isolation: ['code', 'docs', 'qa_epic', 'review_epic'].includes(kind) ? 'worktree' : 'none',
      worktree_path: null, branch: t.branch, head_sha: 'f'.repeat(7) + String(runSeq).padStart(5, '0'),
      brief_path: `runs/${rid}/brief.md`, handoff_path: `runs/${rid}/handoff.json`,
      estimate_tokens: t.estimate_tokens, round: i + 1, review_role: reviewRun ? runRole : null,
      exit: status === 'failed' && i === nRuns - 1 ? { reason: 'checks_failed', message: 'npm test failed 3 times' } : null,
    });
    t.runs.push(rid);
    if (live) t.current_run_id = rid;
  }
  T.push(t);
  return t;
}

// G-001 planning (all done)
task('T-0001', 'G-001', null, 'intake', 'cto', 'Intake: VIN decoder', 'done', { created: at(0), updated: at(0, 40) });
task('T-0002', 'G-001', null, 'prd', 'product-manager', 'PRD: VIN decoder', 'done', { created: at(0, 45), updated: at(2), gate: 'G1' });
task('T-0003', 'G-001', null, 'spec', 'staff-engineer', 'Spec: VIN decoder', 'done', { created: at(2, 30), updated: at(4), gate: 'G2', reviews: { critic: { verdict: 'pass', run_id: 'R-000004', round: 1, at: iso(at(3, 50)) } } });
task('T-0004', 'G-001', null, 'mockup', 'ui-ux-designer', 'Mockup: intake VIN field', 'done', { created: at(4, 10), updated: at(5, 30), gate: 'G3' });
task('T-0005', 'G-001', null, 'breakdown', 'staff-engineer', 'Breakdown: VIN decoder', 'done', { created: at(4, 15), updated: at(5, 50) });
task('T-0006', 'G-001', null, 'sequence', 'project-manager', 'Sequence: VIN decoder', 'done', { created: at(6), updated: at(6, 30) });
// E-0001
task('T-0007', 'G-001', 'E-0001', 'code', 'backend-engineer', 'Add VIN decode service with vendor client', 'integrated', { created: at(6, 30), updated: at(12), files: ['src/api/vin/**'], reviews: { 'code-reviewer': { verdict: 'pass', run_id: 'R-000009', round: 1, at: iso(at(10)) } }, runs: 2 });
task('T-0008', 'G-001', 'E-0001', 'code', 'data-engineer', 'Add vin_decodes cache table migration', 'integrated', { created: at(6, 30), updated: at(11), size: 'S', files: ['db/migrations/**'], reviews: { 'code-reviewer': { verdict: 'pass', run_id: 'R-000011', round: 1, at: iso(at(10, 30)) } }, runs: 2 });
task('T-0009', 'G-001', 'E-0001', 'qa_epic', 'qa-engineer', 'QA: decoder service epic', 'done', { created: at(12), updated: at(15) });
task('T-0010', 'G-001', 'E-0001', 'review_epic', 'code-reviewer', 'Epic review: decoder service', 'done', { created: at(15), updated: at(18) });
task('T-0011', 'G-001', 'E-0001', 'docs', 'tech-writer', 'Docs: VIN decode API', 'integrated', { created: at(18), updated: at(21) });
// E-0002 in flight
task('T-0012', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Intake form VIN field with live decode', 'in_progress', { created: at(21), updated: at(30, 10), files: ['web/src/app/intake/vin-field/**'], gate_deps: ['G3'], liveRun: true });
task('T-0013', 'G-001', 'E-0002', 'code', 'backend-engineer', 'Decode endpoint response caching', 'in_review', { created: at(21), updated: at(29, 50), files: ['src/api/vin/cache/**'], runs: 2, liveRun: true, reviewRunRole: 'code-reviewer' });
task('T-0014', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Decode result panel', 'checking', { created: at(21), updated: at(30), files: ['web/src/app/intake/decode-panel/**'], gate_deps: ['G3'] });
task('T-0015', 'G-001', 'E-0002', 'code', 'backend-engineer', 'Rate limit the decode API', 'changes_requested', { created: at(21), updated: at(29, 20), files: ['src/api/vin/rate-limit/**'], risk: ['auth'], runs: 2, rework: 1,
  reason: 'code-reviewer: limiter key ignores the dealer id', reviews: { 'code-reviewer': { verdict: 'fail', run_id: 'R-000000', round: 1, at: iso(at(29, 20)) } },
  feedback: [{ source: 'code-reviewer', ref: 'F-1', path: 'docs/G-001-vin-decoder/reviews/T-0015-code-reviewer-r1.md', at: iso(at(29, 20)) }] });
task('T-0016', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Error states for a bad VIN', 'ready', { created: at(21), updated: at(28), size: 'S', files: ['web/src/app/intake/vin-errors/**'], gate_deps: ['G3'], deps: ['T-0012'] });
task('T-0017', 'G-001', 'E-0002', 'code', 'devops-release', 'CI job for decoder tests', 'verified', { created: at(21), updated: at(27), size: 'S', files: ['.github/workflows/decoder.yml'], reviews: { 'code-reviewer': { verdict: 'pass', run_id: 'R-000000', round: 1, at: iso(at(26)) } }, runs: 2 });
task('T-0018', 'G-001', 'E-0002', 'code', 'data-engineer', 'Backfill decode cache for current stock', 'blocked', { created: at(21), updated: at(26), files: ['db/scripts/backfill-vin/**'],
  reason: 'Waiting for an answer: may we call the vendor API 4,000 times tonight?', blocked: { reason: 'open question', question_id: 'Q-1', needs: 'human', since: iso(at(26)) } });
task('T-0019', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Keyboard shortcut to focus the VIN field', 'backlog', { created: at(21), updated: at(21, 5), size: 'S', gate_deps: ['G3'] });
task('T-0020', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Barcode scanner input for VIN', 'draft', { created: at(29), updated: at(29) });
task('T-0021', 'G-001', 'E-0002', 'code', 'backend-engineer', 'Retry vendor API on timeout', 'failed', { created: at(21), updated: at(25), runs: 3, attempts: 3, reason: 'Failed 3 attempts: npm test times out on the vendor mock' });
task('T-0022', 'G-001', 'E-0002', 'code', 'devops-release', 'Feature flag for the decoder rollout', 'paused', { created: at(21), updated: at(24), size: 'S', reason: 'Paused by you' });
task('T-0026', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Decode history side panel', 'deferred', { created: at(21), updated: at(29, 45), reason: 'Usage limit hit; retry after backoff' });
task('T-0027', 'G-001', 'E-0002', 'code', 'frontend-engineer', 'Legacy intake form shim', 'cancelled', { created: at(21), updated: at(22), reason: 'Not needed after spec change' });
// G-002
task('T-0023', 'G-002', null, 'intake', 'cto', 'Intake: CSV export', 'done', { created: at(2), updated: at(2, 30) });
task('T-0024', 'G-002', null, 'prd', 'product-manager', 'PRD: CSV export', 'done', { created: at(2, 40), updated: at(8), gate: 'G1', runs: 3 });
task('T-0025', 'G-002', null, 'spec', 'staff-engineer', 'Spec: CSV export', 'ready', { created: at(8, 30), updated: at(28, 10), gate: 'G2', runs: 2, attempts: 2, reason: 'Waiting: goal budget blocked' });
// G-003
task('T-0028', 'G-003', null, 'intake', 'cto', 'Intake: audit log', 'done', { created: at(26), updated: at(26, 30) });
task('T-0029', 'G-003', null, 'prd', 'product-manager', 'PRD: audit log', 'awaiting_approval', { created: at(26, 35), updated: at(29, 5), gate: 'G1' });

for (const t of T) write(`tasks/${t.id}.json`, t);
// Fix review run ids now that runs exist.
for (const r of runs) write(`runs/${r.id}/run.json`, r);

// evidence for a few runs
function evidence(rid, entries) {
  const lines = entries.map((e, i) => ({ id: `EV-${i + 1}`, label: e[0], command: e[1], cwd: `C:/repo/.factory/worktrees/checks-${rid}`, exit_code: e[2], log_path: `runs/${rid}/evidence/${e[0]}-1.log`, head_sha: 'abc1234', source: e[3] ?? 'cli', started_at: iso(END - 3600000), ended_at: iso(END - 3500000) }));
  writeLines(`runs/${rid}/evidence/index.jsonl`, lines);
  for (const e of entries) write(`runs/${rid}/evidence/${e[0]}-1.log`, `$ ${e[1]}\n> dealer-app@1.0.0 ${e[0]}\n${e[2] === 0 ? 'All checks passed.\n' : 'Error: 2 tests failed\n  vin.spec.ts: expected 200, got 429\n'}exit ${e[2]}\n`);
}
const lastRun = (id) => T.find((t) => t.id === id).runs.at(-1);
evidence(lastRun('T-0007'), [['build', 'npm run build', 0], ['lint', 'npm run lint', 0], ['test', 'npm test', 0]]);
evidence(lastRun('T-0017'), [['build', 'npm run build', 0], ['test', 'npm test', 0]]);
evidence(lastRun('T-0015'), [['build', 'npm run build', 0], ['test', 'npm test', 1]]);
evidence(lastRun('T-0009'), [['qa-run', 'npm run e2e -- intake', 0, 'agent']]);
for (const r of runs) {
  write(`runs/${r.id}/brief.md`, `# Brief ${r.id}\n\nTask ${r.task_id}, role ${r.role}.\n`);
}

// ---------- docs ----------
write('docs/G-001-vin-decoder/prd.md', `# PRD: VIN decoder for inventory intake

## Problem
Staff type year, make, model and trim by hand at intake. This is slow and error prone.

## Users
- Intake staff at independent dealers
- Managers who review stock data

## Success criteria
1. A valid VIN fills year, make, model and trim in under **2 seconds**.
2. An invalid VIN shows a clear error.
3. Decodes are cached for 30 days.

| Metric | Today | Target |
|---|---|---|
| Intake time per unit | 4 min | 1 min |
| Data errors per 100 units | 7 | 1 |

See the [vendor docs](https://example.com/vin-api). This link is unsafe and must not render: [x](javascript:alert(1)).

<script>alert('should be escaped')</script>
`);
write('docs/G-001-vin-decoder/spec.md', '# Spec: VIN decoder\n\n## API\n\n`GET /api/vin/decode?vin=` returns `{year, make, model, trim}`.\n\n```ts\nexport interface VinDecode { year: number; make: string }\n```\n\n## Data\n\nTable `vin_decodes (vin pk, payload jsonb, decoded_at)`.\n');
write('docs/G-001-vin-decoder/plan.md', '# Plan\n\n- E-0001 Decoder service and API\n- E-0002 Intake form VIN experience\n');
write('docs/G-001-vin-decoder/design/intake.html', `<!doctype html><html><head><meta charset="utf-8"><title>Intake mockup</title>
<style>body{font-family:system-ui;margin:24px;background:#fafafa}label{display:block;font-weight:600;margin-bottom:4px}
input{font-size:16px;padding:8px;width:320px}.panel{margin-top:16px;padding:12px;border:1px solid #ccc;border-radius:6px;background:#fff}</style></head>
<body><h1>Add unit</h1><label for="vin">VIN</label><input id="vin" value="1HGCM82633A004352">
<div class="panel" id="out">2003 Honda Accord EX</div>
<script>document.getElementById('vin').addEventListener('input',function(){document.getElementById('out').textContent='Decoding...';});</script>
</body></html>
`);
write('docs/G-001-vin-decoder/reviews/E-0001.md', '# Epic review E-0001\n\nVerdict: **pass**.\n\n- F-1 (minor): add a timeout constant.\n');
write('docs/G-001-vin-decoder/reviews/T-0015-code-reviewer-r1.md', '# Review T-0015 round 1\n\nVerdict: **fail**\n\n- F-1 (major) `src/api/vin/rate-limit/limiter.ts:22`: the limiter key ignores the dealer id.\n');
write('docs/G-001-vin-decoder/qa/E-0001.md', '# QA E-0001\n\nAll 6 acceptance criteria met. Evidence EV-1.\n');
write('docs/G-002-csv-export/prd.md', '# PRD: CSV export for deals\n\nExport the filtered deals list.\n');
write('docs/G-003-audit-log/prd.md', '# PRD: Audit log for deal changes\n\n## Outcome\nEvery change to a deal is recorded.\n\n## Scope\n- Field-level history\n- Read-only entries\n- CSV export\n\n## Out of scope\n- Restoring old values\n');

// ---------- gates ----------
const gate = (id, type, subject, goal_id, status, opened, opts = {}) => ({
  ...common('gate', id, opened, opts.decidedAt ?? opened, status === 'pending' ? 1 : 2), type, subject, goal_id, status,
  opened_at: iso(opened), opened_by: { run_id: opts.run ?? null, actor: opts.actor ?? 'product-manager' },
  artifact: { paths: opts.paths ?? [], ...(opts.pr_url ? { pr_url: opts.pr_url } : {}), summary: opts.summary ?? '', ...(opts.diffstat ? { diffstat: opts.diffstat } : {}) },
  request: opts.request ?? {},
  decision: status === 'pending' ? null : { by: 'owner', via: opts.via ?? 'dashboard', at: iso(opts.decidedAt), notes: opts.notes ?? '' },
  auto: false,
});
const gates = [
  gate('GATE-0001', 'G1', { kind: 'goal', id: 'G-001' }, 'G-001', 'approved', at(2), { decidedAt: at(2, 20), paths: ['docs/G-001-vin-decoder/prd.md'], summary: 'PRD for the VIN decoder: 3 success criteria, tier M.' }),
  gate('GATE-0002', 'G2', { kind: 'goal', id: 'G-001' }, 'G-001', 'approved', at(4), { decidedAt: at(4, 30), actor: 'staff-engineer', paths: ['docs/G-001-vin-decoder/spec.md'], summary: 'Spec with API and cache table.', via: 'cli' }),
  gate('GATE-0003', 'G3', { kind: 'goal', id: 'G-001' }, 'G-001', 'approved', at(5, 30), { decidedAt: at(6), actor: 'ui-ux-designer', paths: ['docs/G-001-vin-decoder/design/intake.html'], summary: 'Intake mockup.', notes: 'Use the existing panel component.' }),
  gate('GATE-0004', 'G1', { kind: 'goal', id: 'G-002' }, 'G-002', 'approved', at(8), { decidedAt: at(8, 15), paths: ['docs/G-002-csv-export/prd.md'], summary: 'PRD for CSV export.' }),
  gate('GATE-0005', 'budget', { kind: 'goal', id: 'G-002' }, 'G-002', 'pending', at(28, 10), { actor: 'cto', summary: 'G-002 spent 5.2M of its 5M budget. The spec task needs about 500k more.', request: { add_tokens_suggested: 2000000, impact: ['Spec for CSV export stays paused until you decide'] } }),
  gate('GATE-0006', 'G4', { kind: 'epic', id: 'E-0001' }, 'G-001', 'pending', at(29, 30), { actor: 'cto', paths: ['docs/G-001-vin-decoder/reviews/E-0001.md', 'docs/G-001-vin-decoder/qa/E-0001.md', `runs/${lastRun('T-0009')}/evidence/qa-run-1.log`], pr_url: 'https://github.com/example/dealer-app/pull/128', summary: 'Decoder service and API: QA passed, epic review passed, docs done. Merge PR #128 on GitHub, then approve.', diffstat: '+412 -88, 9 files' }),
  gate('GATE-0007', 'G1', { kind: 'goal', id: 'G-003' }, 'G-003', 'pending', at(29, 5), { run: T.find((t) => t.id === 'T-0029').runs.at(-1), paths: ['docs/G-003-audit-log/prd.md'], summary: 'PRD for the audit log: field-level history, read-only entries, CSV export. Tier M, needs UI.' }),
];
for (const g of gates) write(`gates/${g.id}.json`, g);

// ---------- usage ----------
const W = config.budget.weights;
const usage = [];
const billed = (bm) => Object.values(bm).reduce((s, m) => s + m.input * W.input + m.output * W.output + m.cache_creation * W.cache_creation + m.cache_read * W.cache_read, 0);
const runTarget = { 'G-001': 0, 'G-002': 0, 'G-003': 0 };
for (const r of runs) {
  const goalScale = r.goal_id === 'G-002' ? 3.6 : 1;
  const steps = r.status === 'running' ? 3 : ri(2, 4);
  const start = Date.parse(r.started_at);
  const stop = r.ended_at ? Date.parse(r.ended_at) : END - 60000;
  const model = roleModel(r.role);
  const tot = { input: ri(4000, 12000), output: ri(15000, 40000), cache_read: ri(600000, 1800000), cache_creation: ri(40000, 120000), requests: ri(20, 60) };
  for (const k of Object.keys(tot)) tot[k] = Math.round(tot[k] * goalScale);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    const bm = { [model]: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Math.round(v * f)])) };
    if (s === steps && r.role === 'backend-engineer') bm[MODEL.haiku] = { input: 3000, output: 2000, cache_read: 50000, cache_creation: 8000, requests: 6 };
    const finished = s === steps && r.status !== 'running';
    usage.push({ v: 1, ts: iso(start + (stop - start) * f), source: finished ? 'hook' : 'reconcile', scope: 'agent', agent_id: r.agent_id,
      session_id: r.session_id, agent_type: r.subagent_type, run_id: r.id, task_id: r.task_id, goal_id: r.goal_id, role: r.role,
      status: r.status === 'running' ? 'running' : finished ? (r.status === 'failed' ? 'finished' : 'finished') : 'running',
      requests: bm[model].requests, by_model: bm });
  }
  runTarget[r.goal_id] += billed(usage.at(-1).by_model);
}
// CTO session (overhead), cumulative every 2 hours.
let cto = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0 };
for (let h = 0; h <= 30; h += 2) {
  cto = { input: cto.input + 1500, output: cto.output + 4000, cache_read: cto.cache_read + 220000, cache_creation: cto.cache_creation + 9000, requests: cto.requests + 14 };
  usage.push({ v: 1, ts: iso(at(h, 15)), source: 'hook', scope: 'session', session_id: 'sess-cto-1', role: 'cto', status: h === 30 ? 'running' : 'running', requests: cto.requests, by_model: { [MODEL.opus]: { ...cto } } });
}
usage.sort((a, b) => a.ts.localeCompare(b.ts));
writeLines('state/usage.jsonl', usage);

// budget.json (derived)
const latest = new Map();
for (const u of usage) latest.set(u.scope === 'session' ? u.session_id : u.agent_id, u);
const spent = { 'G-001': 0, 'G-002': 0, 'G-003': 0 };
let overhead = 0;
for (const u of latest.values()) { if (u.goal_id) spent[u.goal_id] += billed(u.by_model); else overhead += billed(u.by_model); }
// scale G-002 to 104% of its limit to make the budget gate realistic
const budget = { goals: {}, overhead: Math.round(overhead), unattributed: 0 };
for (const g of goals) {
  const s = Math.round(spent[g.id]);
  const reserved = g.id === 'G-001' ? 1200000 : 0;
  const pct = Math.round(((s + reserved) / g.budget.limit_tokens) * 1000) / 10;
  budget.goals[g.id] = { limit: g.budget.limit_tokens, spent: s, reserved, pct, warned_at: pct >= 80 ? iso(at(27)) : null, blocked_at: pct >= 100 ? iso(at(28, 10)) : null };
}
write('state/budget.json', budget);
writeLines('state/ledger.jsonl', [
  { ts: iso(at(21)), kind: 'reserve', goal_id: 'G-001', run_id: lastRun('T-0012'), tokens: 600000, by: 'cto' },
  { ts: iso(at(29, 50)), kind: 'reserve', goal_id: 'G-001', run_id: lastRun('T-0013'), tokens: 600000, by: 'cto' },
]);

// ---------- events ----------
const events = [];
let evSeq = 0;
function ev(ms, type, fields = {}) {
  evSeq++;
  events.push({ v: 1, id: `01J${String(ms).padStart(13, '0')}${String(evSeq).padStart(4, '0')}`, ts: iso(ms), type, source: fields.source ?? 'cli',
    session_id: 'sess-cto-1', actor: fields.actor ?? { kind: 'system', role: 'cto' },
    ...(fields.goal_id ? { goal_id: fields.goal_id } : {}), ...(fields.epic_id ? { epic_id: fields.epic_id } : {}),
    ...(fields.task_id ? { task_id: fields.task_id } : {}), ...(fields.run_id ? { run_id: fields.run_id } : {}),
    msg: (fields.msg ?? type).slice(0, 140), data: fields.data ?? {} });
}
const msg = (ms, kind, from, to, t, text, extra = {}) => ev(ms, `msg.${kind}`, { source: 'hook', actor: { kind: 'agent', role: from }, goal_id: t?.goal_id, epic_id: t?.epic_id ?? undefined, task_id: t?.id, run_id: extra.run_id, msg: text, data: { from: { role: from, ...(extra.from_run ? { run_id: extra.from_run } : {}) }, to: { role: to }, ...(extra.ref_path ? { ref_path: extra.ref_path } : {}) } });
const byId = Object.fromEntries(T.map((t) => [t.id, t]));
ev(at(0) - 600000, 'factory.status', { actor: { kind: 'human', role: 'user' }, msg: 'Factory started', data: { from: 'stopped', to: 'running' } });
ev(at(0) - 590000, 'lock.acquired', { msg: 'Lease acquired by sess-cto-1' });
ev(at(0) - 300000, 'inbox.processed', { msg: 'goal.add applied: G-001', data: { inbox_id: 'ib-00000001', type: 'goal.add', status: 'applied', goal_id: 'G-001' } });
// ticks every ~30 min across the window
for (let m = 0; m <= (END - at(0)) / 60000; m += 120) {
  ev(at(0, m), 'tick.started', { msg: `Tick ${m / 120 + 1} started` });
  ev(at(0, m) + 45000, 'tick.finished', { msg: `Tick ${m / 120 + 1} finished`, data: { dispatched: ri(0, 2), next_s: 270 } });
}
// lifecycle per task
for (const t of T) {
  const c = Date.parse(t.created_at);
  ev(c, 'task.created', { goal_id: t.goal_id, epic_id: t.epic_id, task_id: t.id, msg: `${t.id} created: ${t.title}`, data: { kind: t.kind, role: t.role } });
  for (const rid of t.runs) {
    const r = runs.find((x) => x.id === rid);
    const d = Date.parse(r.dispatched_at);
    ev(d, 'run.dispatched', { goal_id: t.goal_id, task_id: t.id, run_id: rid, msg: `${rid} dispatched to ${r.role}`, data: { role: r.role, model: r.model } });
    msg(d + 1000, 'dispatch', 'cto', r.role, t, `Dispatch ${t.id} to ${r.role}`, { run_id: rid });
    ev(d + 20000, 'run.started', { source: 'hook', goal_id: t.goal_id, task_id: t.id, run_id: rid, msg: `${rid} started`, actor: { kind: 'agent', role: r.role, run_id: rid } });
    if (r.ended_at) {
      const e = Date.parse(r.ended_at);
      ev(e, 'run.ended', { source: 'hook', goal_id: t.goal_id, task_id: t.id, run_id: rid, msg: `${rid} ended (${r.status})`, data: { status: r.status }, actor: { kind: 'agent', role: r.role, run_id: rid } });
      msg(e + 1000, 'handoff', r.role, 'cto', t, `${r.role} handed off ${t.id}`, { run_id: rid, ref_path: r.handoff_path });
    }
  }
  if (t.status !== 'draft' && t.status !== 'backlog') ev(Date.parse(t.updated_at), 'task.status', { goal_id: t.goal_id, epic_id: t.epic_id, task_id: t.id, msg: `${t.id} -> ${t.status}`, data: { from: 'in_progress', to: t.status } });
}
// reviews, rework, questions, escalation
msg(at(9, 40), 'review_request', 'cto', 'code-reviewer', byId['T-0007'], 'Review T-0007 round 1');
msg(at(10), 'review_result', 'code-reviewer', 'cto', byId['T-0007'], 'T-0007 review: pass');
msg(at(3, 30), 'review_request', 'cto', 'critic', byId['T-0003'], 'Critic review of the spec');
msg(at(3, 50), 'review_result', 'critic', 'cto', byId['T-0003'], 'Spec critique: pass with 2 minor notes');
msg(at(13), 'review_request', 'cto', 'qa-engineer', byId['T-0009'], 'QA the integrated E-0001 branch');
msg(at(15), 'review_result', 'qa-engineer', 'cto', byId['T-0009'], 'QA E-0001: pass, 6/6 criteria');
msg(at(29, 10), 'review_request', 'cto', 'code-reviewer', byId['T-0015'], 'Review T-0015 round 1');
msg(at(29, 20), 'review_result', 'code-reviewer', 'cto', byId['T-0015'], 'T-0015 review: fail, 1 major finding', { ref_path: 'docs/G-001-vin-decoder/reviews/T-0015-code-reviewer-r1.md' });
msg(at(29, 21), 'rework', 'cto', 'backend-engineer', byId['T-0015'], 'Rework T-0015: limiter key ignores dealer id');
msg(at(29, 50), 'review_request', 'cto', 'code-reviewer', byId['T-0013'], 'Review T-0013 round 1');
msg(at(26), 'question', 'data-engineer', 'user', byId['T-0018'], 'May we call the vendor API 4,000 times tonight?');
msg(at(4, 5), 'question', 'ui-ux-designer', 'product-manager', byId['T-0004'], 'Should the decode panel show trim?');
msg(at(4, 20), 'answer', 'product-manager', 'ui-ux-designer', byId['T-0004'], 'Yes, show trim when known');
msg(at(25), 'escalation', 'cto', 'cto', byId['T-0021'], 'T-0021 failed 3 attempts; escalating');
msg(at(25, 5), 'question', 'backend-engineer', 'staff-engineer', byId['T-0021'], 'Is a 5 s vendor timeout acceptable?');
msg(at(25, 30), 'answer', 'staff-engineer', 'backend-engineer', byId['T-0021'], 'Use 3 s with one retry');
ev(at(24, 50), 'evidence.rejected', { goal_id: 'G-001', task_id: 'T-0021', msg: 'Agent evidence EV-2 ignored: source agent', data: { evidence_id: 'EV-2' } });
// gates
for (const g of gates) {
  const t = T.find((x) => x.goal_id === g.goal_id && x.gate === g.type) ?? null;
  msg(Date.parse(g.opened_at) - 1000, 'approval_request', g.opened_by.actor === 'cto' ? 'cto' : g.opened_by.actor, 'user', t ?? { goal_id: g.goal_id }, `${g.type} approval requested for ${g.subject.id}`);
  ev(Date.parse(g.opened_at), 'gate.opened', { goal_id: g.goal_id, task_id: t?.id, msg: `${g.id} ${g.type} opened for ${g.subject.id}`, data: { gate_id: g.id, type: g.type } });
  if (g.decision) {
    const d = Date.parse(g.decision.at);
    ev(d - 60000, 'inbox.processed', { msg: `gate.decide applied: ${g.id}`, data: { inbox_id: `ib-${g.id.slice(5)}0000`, type: 'gate.decide', status: 'applied', gate_id: g.id } });
    ev(d, 'gate.decided', { actor: { kind: 'human', role: 'user' }, goal_id: g.goal_id, msg: `${g.id} ${g.status}`, data: { gate_id: g.id, decision: g.status, via: g.decision.via } });
    msg(d + 1000, 'approval_result', 'user', 'cto', t ?? { goal_id: g.goal_id }, `${g.type} ${g.status} for ${g.subject.id}`);
  }
}
ev(at(26, 59), 'budget.warned', { goal_id: 'G-002', msg: 'G-002 reached 80% of budget', data: { pct: 81, limit: 5000000 } });
ev(at(28, 10), 'budget.blocked', { goal_id: 'G-002', msg: 'G-002 reached 100% of budget; dispatch stopped', data: { pct: 104, limit: 5000000 } });
ev(at(28, 11), 'goal.status', { goal_id: 'G-002', msg: 'G-002 -> budget_blocked', data: { from: 'active', to: 'budget_blocked' } });
ev(at(2, 21), 'goal.status', { goal_id: 'G-001', msg: 'G-001 -> active', data: { from: 'awaiting_g1', to: 'active' } });
ev(at(29, 6), 'goal.status', { goal_id: 'G-003', msg: 'G-003 -> awaiting_g1', data: { from: 'planning', to: 'awaiting_g1' } });
ev(at(12), 'epic.status', { goal_id: 'G-001', epic_id: 'E-0001', msg: 'E-0001 -> qa', data: { from: 'building', to: 'qa' } });
ev(at(29, 28), 'epic.status', { goal_id: 'G-001', epic_id: 'E-0001', msg: 'E-0001 -> pr_open', data: { from: 'docs', to: 'pr_open' } });
ev(at(29, 29), 'pr.opened', { goal_id: 'G-001', epic_id: 'E-0001', msg: 'PR #128 opened', data: { number: 128, url: 'https://github.com/example/dealer-app/pull/128' } });
ev(at(29, 40), 'pr.updated', { goal_id: 'G-001', epic_id: 'E-0001', msg: 'PR #128 checks passed', data: { number: 128 } });
ev(at(24), 'run.deferred', { goal_id: 'G-001', task_id: 'T-0026', msg: 'Run deferred: usage limit', data: { backoff_until: iso(at(24, 30)) } });
ev(at(23), 'run.lost', { goal_id: 'G-001', task_id: 'T-0021', msg: 'Run lost: no stop event for 30 min' });
ev(at(26, 1), 'inbox.processed', { msg: 'goal.add applied: G-003', data: { inbox_id: 'ib-00000003', type: 'goal.add', status: 'applied', goal_id: 'G-003' } });
ev(at(24, 1), 'inbox.processed', { msg: 'task.pause applied: T-0022', data: { inbox_id: 'ib-00000004', type: 'task.pause', status: 'applied' } });
ev(at(20), 'lock.stolen', { msg: 'Stale lease taken over' });
ev(at(20, 1), 'pr.merged', { goal_id: 'G-001', msg: 'PR #120 merged (earlier work)', data: { number: 120 } });
ev(at(20, 2), 'sync.completed', { source: 'sync', msg: 'Tracker sync: 0 changes' });
events.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
// Re-id in time order so ids sort with position.
events.forEach((e, i) => { e.id = `01J${String(Date.parse(e.ts)).padStart(13, '0')}${String(i + 1).padStart(4, '0')}`; });
writeLines('events/events.jsonl', events);

// ---------- factory state, index, counters, inbox ----------
write('state/factory.json', { status: 'running', status_changed_at: iso(at(0) - 600000), status_reason: 'started by user', pause_mode: null,
  tick: { count: Math.floor((END - at(0)) / 1800000) + 1, last_begin_at: iso(END - 120000), last_end_at: iso(END - 75000), last_error: null, consecutive_errors: 0, cadence_s: 270, next_wakeup_at: iso(END - 75000 + 270000) },
  dispatcher: { session_id: 'sess-cto-1', since: iso(at(0) - 600000) }, backoff_until: null, versions: { plugin: '0.1.0', schema: 1 } });
write('run/lease.json', { session_id: 'sess-cto-1', acquired_at: iso(at(0) - 590000), renewed_at: iso(END - 120000), ttl_s: 4500, host: 'devbox', pid: 4242 });
const index = { rev: 57, goals: {}, epics: {}, tasks: {}, runs_active: runs.filter((r) => r.status === 'running').map((r) => r.id), gates_pending: gates.filter((g) => g.status === 'pending').map((g) => g.id) };
for (const g of goals) index.goals[g.id] = { status: g.status, title: g.title, priority: g.priority };
for (const e of epics) index.epics[e.id] = { goal_id: e.goal_id, status: e.status };
for (const t of T) index.tasks[t.id] = { goal_id: t.goal_id, epic_id: t.epic_id, status: t.status, role: t.role, kind: t.kind, priority: t.priority, depends_on: t.depends_on, gate_deps: t.gate_deps, files_owned: t.files_owned, current_run_id: t.current_run_id, updated_at: t.updated_at };
write('state/index.json', index);
write('state/counters.json', { goal: 3, epic: 2, task: 29, run: runSeq, gate: 7, event: events.length });
fs.mkdirSync(path.join(H, 'inbox', 'processed'), { recursive: true });
fs.mkdirSync(path.join(H, 'inbox', 'rejected'), { recursive: true });
const inboxReq = (id, ts, type, payload, result) => ({ schema: 'factory/inbox@1', id, created_at: iso(ts), source: 'dashboard', actor: { kind: 'human', name: 'dashboard' }, type, payload, needs_confirmation: false, auto_apply: false, sig: '0'.repeat(64), result });
const stamp = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const ib = [
  inboxReq('ib-00000003', at(25, 59), 'goal.add', { title: 'Audit log for deal changes', outcome: 'Every change is recorded.', success_criteria: ['History on deal page'], priority: 'P3' }, { status: 'applied', reason: 'created G-003', tick: 37 }),
  inboxReq('ib-00070000', at(6) - 60000, 'gate.decide', { gate_id: 'GATE-0003', decision: 'approve', notes: 'Use the existing panel component.' }, { status: 'applied', reason: 'gate approved', tick: 13, gate_id: 'GATE-0003' }),
];
for (const r of ib) write(`inbox/processed/${stamp(Date.parse(r.created_at))}-${r.id.slice(3, 11)}-${r.type}.json`, r);
write(`inbox/rejected/${stamp(at(27))}-00000005-goal.pause.json`, inboxReq('ib-00000005', at(27), 'goal.pause', { goal_id: 'G-009' }, { status: 'rejected', reason: 'unknown goal G-009', tick: 39 }));

console.log(`fixture: ${T.length} tasks, ${runs.length} runs, ${gates.length} gates, ${events.length} events, ${usage.length} usage lines`);
console.log('budget', JSON.stringify(budget.goals));
