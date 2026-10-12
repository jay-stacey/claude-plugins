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
