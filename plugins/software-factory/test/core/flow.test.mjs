import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeHome, lib, fakeDelivery, simulateAgent, addEvidence, writeReport, baseHandoff, join, writeFileSync, existsSync } from './_helpers.mjs';

afterEach(async () => { (await lib('deps')).setDelivery({}); });

/** Fake agents: do what each role would do through the CLI libs, then return a handoff. */
function agentFor(fake, log) {
  return async ({ run, task, home }) => {
    const a = await lib('actions');
    const store = await lib('store');
    const tag = run.review_role ? `${task.kind}>${run.review_role}` : `${task.kind}:${run.role}`;
    log.push({ tag, model: run.model, run: run.id, task: task.id });
    if (run.review_role) {
      const rp = writeReport(home, run.output_paths[0]);
      return baseHandoff(run, task, { verdict: 'pass', report_path: rp, acceptance_criteria: [] });
    }
    switch (task.kind) {
      case 'intake':
        a.setGoal(home, task.goal_id, { tier: 'M', needs_ui: false, pod: { product: 'product-manager', tech_lead: 'staff-engineer', members: ['backend-engineer'] } });
        return baseHandoff(run, task);
      case 'prd': case 'spec': case 'sequence':
        writeReport(home, run.output_paths[0]);
        return baseHandoff(run, task);
      case 'breakdown': {
        const e = a.newEpic(home, { goal_id: task.goal_id, title: 'VIN decoder', summary: 'decode VINs' });
        a.newTasks(home, [
          { ref: 'a', epic_id: e.id, kind: 'code', role: 'backend-engineer', title: 'Decoder core', size: 'S', acceptance_criteria: ['decodes'], files_owned: ['src/a.js'] },
          { ref: 'b', epic_id: e.id, kind: 'code', role: 'backend-engineer', title: 'Decoder API', size: 'M', acceptance_criteria: ['serves', 'validates'], files_owned: ['src/b.js'], depends_on: ['a'] },
        ]);
        return baseHandoff(run, task);
      }
      case 'code': case 'docs': {
        fake.state.shas[task.branch] = `sha-${run.id}`;
        addEvidence(home, run.id, 'EV-1');
        if (task.kind === 'docs') writeReport(home, run.output_paths[0]);
        return baseHandoff(run, task, {
          acceptance_criteria: task.acceptance_criteria.map((x) => ({ id: x.id, met: true, evidence: ['EV-1'] })),
          evidence: ['EV-1'], branch: task.branch, commits: [`sha-${run.id}`], files_touched: task.files_owned,
        });
      }
      case 'qa_epic': case 'review_epic': {
        const rp = writeReport(home, run.output_paths[0]);
        return baseHandoff(run, task, { verdict: 'pass', report_path: rp });
      }
      default:
        void store;
        return baseHandoff(run, task);
    }
  };
}

async function drive(home, fake, { maxTicks = 80, onGate } = {}) {
  const tick = await lib('tick');
  const store = await lib('store');
  const flow = await lib('flow');
  const log = []; const gates = [];
  const agent = agentFor(fake, log);
  for (let i = 0; i < maxTicks; i++) {
    await tick.begin(home, { session: 'S1', force: true });
    const p = await tick.plan(home, { session: 'S1' });
    await tick.end(home, { session: 'S1', loop: true });
    if (p.dispatches.length) {
      for (const d of p.dispatches) await simulateAgent(home, d, agent);
      continue;
    }
    const pending = store.list(home, 'gate', (g) => g.status === 'pending');
    const decidable = pending.filter((g) => g.type !== 'G4');
    if (decidable.length) {
      for (const g of decidable) { gates.push(g.type); if (onGate) await onGate(g); else await flow.decideGate(home, g.id, { decision: 'approve', by: 'test' }); }
      continue;
    }
    const open = store.list(home, 'epic', (e) => e.status === 'pr_open');
    if (open.length && fake.state.prState !== 'MERGED') {
      gates.push('G4');
      fake.state.prState = 'MERGED';
      for (const e of open) await flow.pollPr(home, e.id, { force: true });
      continue;
    }
    break;
  }
  return { log, gates };
}

test('tier M goal runs end to end: intake -> prd -> G1 -> spec -> G2 -> breakdown -> sequence -> code -> checks -> review -> integrate -> qa -> review -> docs -> pr -> G4 -> done', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  const cfg = await lib('config');
  cfg.merge(home, { commands: { test: 'npm test' } });
  const a = await lib('actions');
  const control = await lib('control');
  const store = await lib('store');
  control.start(home, { session: 'S1' });
  const goal = a.newGoal(home, { title: 'VIN decoding', outcome: 'Dealers decode VINs', success_criteria: ['VIN decodes', 'Errors are clear'] });
  const { log, gates } = await drive(home, fake);
  const tags = log.map((x) => x.tag);
  assert.deepEqual(tags, [
    'intake:cto', 'prd:product-manager', 'spec:staff-engineer', 'spec>critic', 'breakdown:staff-engineer',
    'sequence:project-manager', 'code:backend-engineer', 'code>code-reviewer', 'code:backend-engineer', 'code>code-reviewer',
    'qa_epic:qa-engineer', 'review_epic:code-reviewer', 'docs:tech-writer',
  ]);
  assert.deepEqual(gates, ['G1', 'G2', 'G4']);
  assert.equal(log.find((x) => x.tag === 'review_epic:code-reviewer').model, 'opus');
  const g = store.get(home, 'goal', goal.id);
  assert.equal(g.status, 'done');
  assert.equal(g.tier, 'M');
  const epic = store.list(home, 'epic')[0];
  assert.equal(epic.status, 'done');
  assert.equal(epic.pr.url, 'https://github.com/o/r/pull/7');
  for (const t of store.list(home, 'task')) assert.equal(t.status, 'done', `${t.id} ${t.kind} is ${t.status}`);
  const code = store.list(home, 'task', (t) => t.kind === 'code');
  assert.deepEqual(fake.state.merges.slice(0, 2), code.map((t) => t.branch));
  assert.equal(fake.state.spawned.length, 3); // checks for 2 code tasks + docs
  assert.ok(fake.state.pushes.includes(epic.branch));
  const g4 = store.get(home, 'gate', epic.gates.G4);
  assert.equal(g4.status, 'approved');
  assert.equal(g4.decision.via, 'github');
  // every run collected; ledger has a release per reserve
  const { readLines } = await lib('fsutil');
  const ledger = readLines(join(home, 'state', 'ledger.jsonl'));
  assert.equal(ledger.filter((l) => l.kind === 'reserve').length, ledger.filter((l) => l.kind === 'release').length);
  assert.ok(store.list(home, 'run').every((r) => r.collected_at));
});

test('disabled gates auto-approve; tier S opens G1 and G2 together', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  const a = await lib('actions');
  const store = await lib('store');
  const control = await lib('control');
  const tick = await lib('tick');
  control.start(home, { session: 'S1' });
  const goal = a.newGoal(home, { title: 'Small', outcome: 'o', success_criteria: ['c'] });
  const log = [];
  const agent = async ({ run, task, home: h }) => {
    log.push(task.kind);
    if (task.kind === 'intake') a.setGoal(h, task.goal_id, { tier: 'S', needs_ui: false });
    else writeReport(h, run.output_paths[0]);
    if (run.review_role) return baseHandoff(run, task, { verdict: 'pass', report_path: run.output_paths[0], acceptance_criteria: [] });
    return baseHandoff(run, task);
  };
  for (let i = 0; i < 8; i++) {
    await tick.begin(home, { session: 'S1', force: true });
    const p = await tick.plan(home, { session: 'S1' });
    for (const d of p.dispatches) await simulateAgent(home, d, agent);
    if (!p.dispatches.length) break;
  }
  assert.deepEqual(log, ['intake', 'prd', 'spec', 'spec']);
  const pending = store.list(home, 'gate', (g) => g.status === 'pending').map((g) => g.type).sort();
  assert.deepEqual(pending, ['G1', 'G2']);
  assert.equal(store.get(home, 'goal', goal.id).status, 'awaiting_g1');

  // a fresh goal with G1 disabled: the gate is created approved with auto: true
  const cfg = await lib('config');
  cfg.set(home, 'gates.G1.enabled', false);
  const g2 = a.newGoal(home, { title: 'Auto', outcome: 'o', success_criteria: ['c'] });
  const log2 = [];
  for (let i = 0; i < 6; i++) {
    await tick.begin(home, { session: 'S1', force: true });
    const p = await tick.plan(home, { session: 'S1' });
    for (const d of p.dispatches.filter((x) => store.get(home, 'run', x.run_id).goal_id === g2.id)) {
      await simulateAgent(home, d, async (ctx) => { log2.push(ctx.task.kind); if (ctx.task.kind === 'intake') a.setGoal(home, g2.id, { tier: 'M' }); return agent(ctx); });
    }
  }
  const gate = store.list(home, 'gate', (g) => g.goal_id === g2.id && g.type === 'G1')[0];
  assert.equal(gate.auto, true);
  assert.equal(gate.status, 'approved');
  assert.equal(store.get(home, 'goal', g2.id).status, 'active');
  assert.ok(log2.includes('spec'));
});

test('invalid handoff creates a fixup run, then fails after 2 fixups with an escalation', async () => {
  const { home } = await makeHome();
  (await lib('deps')).setDelivery(fakeDelivery().d);
  const a = await lib('actions');
  const store = await lib('store');
  const tick = await lib('tick');
  (await lib('control')).start(home, { session: 'S1' });
  a.newGoal(home, { title: 'Bad', outcome: 'o', success_criteria: ['c'] });
  const kinds = [];
  for (let i = 0; i < 4; i++) {
    await tick.begin(home, { session: 'S1', force: true });
    const p = await tick.plan(home, { session: 'S1' });
    for (const d of p.dispatches) {
      const r = store.get(home, 'run', d.run_id);
      kinds.push(`${r.kind}:${r.role}`);
      await simulateAgent(home, d, async ({ run, task }) => (task.kind === 'intake' ? { schema: 'factory/handoff@1', run_id: run.id } : baseHandoff(run, task)));
    }
  }
  assert.deepEqual(kinds.slice(0, 4), ['author:cto', 'fixup:cto', 'fixup:cto', 'escalation:cto']);
  const intake = store.list(home, 'task', (t) => t.kind === 'intake')[0];
  assert.equal(intake.status, 'failed');
  assert.equal(intake.fixups, 3);
  assert.ok(intake.feedback.some((f) => /handoff invalid/.test(f.text)));
});

test('reviewer fail sends the task back for rework on the same branch; risk flags on a spec add a security group', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  (await lib('deps')).setDelivery(fake.d);
  const a = await lib('actions');
  const store = await lib('store');
  const collect = await lib('collect');
  const g = a.newGoal(home, { title: 'R', outcome: 'o', success_criteria: ['c'] });
  const spec = a.createTask(home, { goal_id: g.id, kind: 'spec', gate: 'G2', status: 'ready', title: 'Spec' });
  const run = store.create(home, 'run', { task_id: spec.id, goal_id: g.id, kind: 'author', role: 'staff-engineer', subagent_type: 'software-factory:staff-engineer', model: 'opus', status: 'completed', handoff_path: join(home, 'runs', 'R-000001', 'handoff.json').replace(/\\/g, '/') });
  (await lib('lifecycle')).move(home, spec.id, 'in_progress');
  mkdirSync(join(home, 'runs', run.id), { recursive: true });
  writeFileSync(run.handoff_path, JSON.stringify(baseHandoff(run, spec, { risk_flags: ['auth'] })));
  await collect.collect(home);
  const t = store.get(home, 'task', spec.id);
  assert.equal(t.status, 'in_review');
  assert.deepEqual(t.reviews_required, [['critic'], ['security-reviewer']]);
  assert.deepEqual(t.risk_flags, ['auth']);
  const flow = await lib('flow');
  await flow.applyReviewVerdict(home, spec.id, 'critic', 'fail', { runId: 'R-9' });
  assert.equal(store.get(home, 'task', spec.id).status, 'changes_requested');
  await flow.advance(home);
  const t2 = store.get(home, 'task', spec.id);
  assert.equal(t2.status, 'ready');
  assert.equal(t2.pending_kind, 'rework');
  assert.equal(t2.rework_count, 1);
  assert.equal(flow.reviewState(t2).state, 'pending');
});

test('check failure moves a code task to changes_requested with the log path', async () => {
  const { home } = await makeHome();
  const fake = fakeDelivery();
  fake.state.checkStatus = 'fail';
  (await lib('deps')).setDelivery(fake.d);
  const a = await lib('actions');
  const store = await lib('store');
  const collect = await lib('collect');
  (await lib('config')).merge(home, { commands: { test: 'npm test' } });
  const g = a.newGoal(home, { title: 'C', outcome: 'o', success_criteria: ['c'] });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'T', acceptance_criteria: ['x'], branch: 'factory/T-0002-t', base_ref: e.branch });
  (await lib('lifecycle')).move(home, t.id, 'in_progress');
  const run = store.create(home, 'run', { task_id: t.id, goal_id: g.id, epic_id: e.id, kind: 'author', role: 'backend-engineer', subagent_type: 'software-factory:backend-engineer', model: 'sonnet', status: 'completed', isolation: 'worktree', agent_id: 'abc', handoff_path: join(home, 'runs', 'R-000001', 'handoff.json') });
  fake.state.shas['factory/T-0002-t'] = 'new1';
  addEvidence(home, run.id);
  writeFileSync(run.handoff_path, JSON.stringify(baseHandoff(run, store.get(home, 'task', t.id), { acceptance_criteria: [{ id: 'AC-1', met: true, evidence: ['EV-1'] }], evidence: ['EV-1'], branch: 'factory/T-0002-t' })));
  const res = await collect.collect(home);
  assert.deepEqual(res.map((r) => r.outcome), ['checking', 'checks_fail']);
  assert.ok(fake.state.removed[0].endsWith('agent-abc'));
  const t2 = store.get(home, 'task', t.id);
  assert.equal(t2.status, 'ready');
  assert.equal(t2.pending_kind, 'rework');
  assert.equal(t2.rework_count, 1);
  assert.equal(t2.head_sha, 'new1');
  assert.ok(t2.feedback.some((f) => f.source === 'checks' && f.path.endsWith('index.jsonl')));
});

test('handoff validate: AC evidence ids must exist; reviewers need a verdict and an existing report', async () => {
  const { home } = await makeHome();
  const a = await lib('actions');
  const store = await lib('store');
  const { validateHandoff } = await lib('handoff');
  const g = a.newGoal(home, { title: 'V', outcome: 'o', success_criteria: ['c'] });
  const e = a.newEpic(home, { goal_id: g.id, title: 'E' });
  const t = a.createTask(home, { goal_id: g.id, epic_id: e.id, kind: 'code', role: 'backend-engineer', size: 'S', status: 'ready', title: 'T', acceptance_criteria: ['x', 'y'], branch: 'factory/T-x' });
  const run = store.create(home, 'run', { task_id: t.id, goal_id: g.id, kind: 'author', role: 'backend-engineer', subagent_type: 'software-factory:backend-engineer', model: 'sonnet', status: 'running' });
  const f = join(home, 'runs', run.id, 'handoff.json');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(baseHandoff(run, t, { acceptance_criteria: [{ id: 'AC-1', met: true, evidence: ['EV-3'] }], branch: 'factory/other' })));
  const v = validateHandoff(home, f);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((x) => /AC-2 missing/.test(x)));
  assert.ok(v.errors.some((x) => /EV-3 not found/.test(x)));
  assert.ok(v.errors.some((x) => /branch factory\/other/.test(x)));
  const rr = store.create(home, 'run', { task_id: t.id, goal_id: g.id, kind: 'review', role: 'code-reviewer', review_role: 'code-reviewer', subagent_type: 'software-factory:code-reviewer', model: 'sonnet', status: 'running' });
  const f2 = join(home, 'runs', rr.id, 'handoff.json');
  mkdirSync(dirname(f2), { recursive: true });
  writeFileSync(f2, JSON.stringify(baseHandoff(rr, t, { report_path: 'docs/nope.md' })));
  const v2 = validateHandoff(home, f2);
  assert.ok(v2.errors.some((x) => /verdict/.test(x)));
  assert.ok(v2.errors.some((x) => /does not exist/.test(x)));
  assert.ok(existsSync(f2));
});
