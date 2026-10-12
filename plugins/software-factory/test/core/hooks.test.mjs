import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeHome, lib, P, join, readFileSync, writeFileSync, existsSync } from './_helpers.mjs';

const HOOKS = ['session-start', 'prompt', 'pre-agent', 'post-agent', 'broker', 'subagent-stop', 'precompact', 'session-end', 'stop'];

function runHook(name, payload, env = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(P, 'scripts', 'hooks', `${name}.mjs`)], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, FACTORY_NO_NOTIFY: '1', ...env },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms };
}

test('every hook exits 0 at once with no output when no .factory exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfh-'));
  const env = { FACTORY_HOME: '', CLAUDE_PROJECT_DIR: dir };
  const node = spawnSync(process.execPath, ['-e', '0']);
  void node;
  for (const h of HOOKS) {
    const r = runHook(h, { session_id: 's', tool_name: 'Write', tool_input: { file_path: 'x' } }, env);
    assert.equal(r.code, 0, `${h} exit`);
    assert.equal(r.stdout, '', `${h} output`);
    assert.equal(r.stderr, '', `${h} stderr`);
  }
  // timing: the hook body must add little on top of bare node startup
  const base = []; const hook = [];
  // Timing is only reliable on a quiet machine, so it runs when FACTORY_PERF=1. The checks above
  // (exit 0, no output) always run. 80 ms still fails if the hook starts git or loads its libraries.
  if (process.env.FACTORY_PERF !== '1') return;
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); base.push(Number(process.hrtime.bigint() - t0) / 1e6);
    hook.push(runHook('broker', {}, env).ms);
  }
  const over = Math.min(...hook) - Math.min(...base);
  assert.ok(over < 80, `broker fast exit adds ${over.toFixed(1)} ms over bare node`);
});

test('pre-agent denies a factory agent without FACTORY_RUN; ignores setup-interviewer and other agents', async () => {
  const { home } = await makeHome();
  const env = { FACTORY_HOME: home };
  const deny = runHook('pre-agent', { tool_name: 'Agent', tool_input: { subagent_type: 'software-factory:cto', prompt: 'do things' } }, env);
  const out = JSON.parse(deny.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /FACTORY_RUN/);
  assert.equal(runHook('pre-agent', { tool_input: { subagent_type: 'software-factory:setup-interviewer', prompt: 'x' } }, env).stdout, '');
  assert.equal(runHook('pre-agent', { tool_input: { subagent_type: 'general-purpose', prompt: 'x' } }, env).stdout, '');
  // run exists but factory is stopped
  const a = await lib('actions');
  a.newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  const store = await lib('store');
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'dispatching' });
  const r = JSON.parse(runHook('pre-agent', { tool_input: { subagent_type: 'software-factory:cto', prompt: 'FACTORY_RUN=R-000001 task=T-0001' } }, env).stdout);
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /factory is stopped/);
  (await lib('control')).start(home, { session: 'S1' });
  assert.equal(runHook('pre-agent', { tool_input: { subagent_type: 'software-factory:cto', prompt: 'FACTORY_RUN=R-000001 task=T-0001' } }, env).stdout, '');
  // post-agent binds the agent id
  runHook('post-agent', { session_id: 'S1', tool_use_id: 'tu1', tool_input: { subagent_type: 'software-factory:cto', prompt: 'FACTORY_RUN=R-000001 task=T-0001' }, tool_response: { agentId: 'ag77', status: 'async_launched' } }, env);
  const run = store.get(home, 'run', 'R-000001');
  assert.equal(run.status, 'running');
  assert.equal(run.agent_id, 'ag77');
  assert.equal(run.tool_use_id, 'tu1');
});

test('subagent-stop writes a finished usage snapshot and completes the run; setup-interviewer is overhead', async () => {
  const { home, root } = await makeHome();
  const env = { FACTORY_HOME: home };
  const store = await lib('store');
  (await lib('actions')).newGoal(home, { title: 'G', outcome: 'o', success_criteria: ['c'] });
  store.create(home, 'run', { task_id: 'T-0001', goal_id: 'G-001', kind: 'author', role: 'cto', subagent_type: 'software-factory:cto', model: 'opus', status: 'running', agent_id: 'a1' });
  const tr = join(root, 'agent-a1.jsonl');
  copyFileSync(join(P, 'test', 'fixtures', 'core', 'transcript-dup.jsonl'), tr);
  const r = runHook('subagent-stop', { session_id: 'S1', agent_id: 'a1', agent_type: 'software-factory:cto', agent_transcript_path: tr }, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(store.get(home, 'run', 'R-000001').status, 'completed');
  const usage = await lib('usage');
  const snap = usage.latestSnapshots(home).get('a1');
  assert.equal(snap.status, 'finished');
  assert.equal(snap.run_id, 'R-000001');
  assert.equal(snap.requests, 3);
  runHook('subagent-stop', { session_id: 'S1', agent_id: 'si', agent_type: 'software-factory:setup-interviewer', agent_transcript_path: tr }, env);
  const si = usage.latestSnapshots(home).get('si');
  assert.ok(!si.run_id);
  assert.ok((await lib('budget')).compute(home).overhead > 0);
});

test('session-start writes machine.json without secrets and injects the completion rule for the lease holder', async () => {
  const { home, pd } = await makeHome();
  (await lib('control')).start(home, { session: 'S1' });
  const env = { FACTORY_HOME: home, CLAUDE_PLUGIN_DATA: pd, CLAUDE_PLUGIN_ROOT: P, CLAUDE_PLUGIN_OPTION_LINEAR_API_KEY: 'lin_secret', CLAUDE_PLUGIN_OPTION_DESKTOP_NOTIFICATIONS: 'false', CLAUDE_PLUGIN_OPTION_MAX_PARALLEL_AGENTS: '4' };
  const r = runHook('session-start', { session_id: 'S1', transcript_path: 'C:/x/S1.jsonl', source: 'compact' }, env);
  const m = JSON.parse(readFileSync(join(home, 'run', 'machine.json'), 'utf8'));
  assert.equal(m.options.desktop_notifications, false);
  assert.equal(m.options.max_parallel_agents, 4);
  assert.ok(!JSON.stringify(m).includes('lin_secret'));
  assert.equal(m.plugin_data, pd);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("When a background factory agent's completion notice arrives (last line starts with HANDOFF), do not read or discuss it; invoke /software-factory:tick once; that tick does not call ScheduleWakeup."));
  assert.ok(ctx.split('\n').length <= 15);
  assert.equal(runHook('session-start', { session_id: 'OTHER', source: 'startup' }, env).stdout, '');
  assert.equal((await lib('config')).load(home).concurrency.total, 4);
});

test('prompt hook records human intent; broker guards state files in the main session', async () => {
  const { home } = await makeHome();
  const env = { FACTORY_HOME: home };
  runHook('prompt', { session_id: 'S1', prompt: '/software-factory:approve GATE-0001' }, env);
  const intent = await lib('intent');
  assert.ok(intent.hasIntent(home, 'S1', 'approve'));
  assert.ok(!intent.hasIntent(home, 'S2', 'approve'));
  assert.ok(!intent.hasIntent(home, 'S1', 'pause'));
  runHook('prompt', { session_id: 'S1', prompt: 'please approve it' }, env);
  assert.ok(intent.hasIntent(home, 'S1', 'approve'));
  const deny = JSON.parse(runHook('broker', { session_id: 'S1', cwd: home, tool_name: 'Write', tool_input: { file_path: join(home, 'state', 'factory.json') } }, env).stdout);
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook('broker', { session_id: 'S1', tool_name: 'Write', tool_input: { file_path: join(home, 'docs', 'x.md') } }, env).stdout, '');
  assert.equal(runHook('broker', { session_id: 'S1', tool_name: 'Read', tool_input: { file_path: join(home, 'state', 'factory.json') } }, env).stdout, '');
  // a factory agent goes through the delivery broker (deny git push)
  const r = JSON.parse(runHook('broker', { session_id: 'S1', agent_id: 'zz', agent_type: 'software-factory:backend-engineer', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, env).stdout);
  assert.equal(r.hookSpecificOutput.permissionDecision, 'deny');
});

test('hooks find a workspace home from a non-git workspace root and broker the run in its repo (A9)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'sfws-'));
  const home = join(ws, '.factory');
  const prev = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = home;
  try { (await lib('state')).init(home); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; }
  const cfgFile = join(home, 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.workspace = { enabled: true, default_repo: 'api' };
  cfg.repos = {
    api: { path: 'api', commands: { build: 'dotnet build', test: 'dotnet test' } },
    web: { path: 'web', commands: { build: 'npm run build', test: 'npm test' } },
  };
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  for (const d of ['api', 'web']) mkdirSync(join(ws, d), { recursive: true });
  const wt = join(home, 'worktrees', 'R-000001');
  mkdirSync(wt, { recursive: true });
  // Records written as files so this test does not depend on schema details owned by core.
  mkdirSync(join(home, 'runs', 'R-000001'), { recursive: true });
  writeFileSync(join(home, 'runs', 'R-000001', 'run.json'), JSON.stringify({
    id: 'R-000001', task_id: 'T-0001', goal_id: 'G-001', epic_id: null, kind: 'author', role: 'frontend-engineer',
    status: 'running', agent_id: 'wa1', repo: 'web', branch: 'factory/T-0001-x', worktree_path: wt.replace(/\\/g, '/'), output_paths: [],
  }));
  mkdirSync(join(home, 'tasks'), { recursive: true });
  writeFileSync(join(home, 'tasks', 'T-0001.json'), JSON.stringify({ id: 'T-0001', goal_id: 'G-001', epic_id: null, repo: 'web', kind: 'code', files_owned: ['src/**'], files_shared: [] }));
  // Plain workspace root: no git repo, no FACTORY_HOME. The home is found by walking up to .factory/config.json.
  const env = { FACTORY_HOME: '', CLAUDE_PROJECT_DIR: ws };
  const main = JSON.parse(runHook('broker', { session_id: 'S1', cwd: ws, tool_name: 'Write', tool_input: { file_path: join(home, 'state', 'factory.json') } }, env).stdout);
  assert.equal(main.hookSpecificOutput.permissionDecision, 'deny');
  // Repo files in a CLI worktree are not factory state for the main session.
  assert.equal(runHook('broker', { session_id: 'S1', cwd: ws, tool_name: 'Write', tool_input: { file_path: join(wt, 'package.json') } }, env).stdout, '');
  // ...but an outbox is agent output that collect imports: the main session may not forge it.
  for (const f of [join(wt, '.factory-out', 'handoff.json'), join(wt, '.factory-out', 'docs', 'G-001-x', 'qa', 'r.md')]) {
    const out = JSON.parse(runHook('broker', { session_id: 'S1', cwd: ws, tool_name: 'Write', tool_input: { file_path: f } }, env).stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /outbox/);
  }
  // A factory agent started in the workspace root is pinned to its worktree.
  const bare = JSON.parse(runHook('broker', { session_id: 'S1', cwd: ws, agent_id: 'wa1', agent_type: 'software-factory:frontend-engineer', tool_name: 'Bash', tool_input: { command: 'npm run build' } }, env).stdout);
  assert.equal(bare.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(bare.hookSpecificOutput.permissionDecisionReason, /cd_prefix/);
  const agent = (command) => JSON.parse(runHook('broker', { session_id: 'S1', cwd: ws, agent_id: 'wa1', agent_type: 'software-factory:frontend-engineer', tool_name: 'Bash', tool_input: { command } }, env).stdout).hookSpecificOutput;
  assert.equal(agent(`cd "${wt}" && npm run build`).permissionDecision, 'allow');
  assert.equal(agent(`cd "${wt}" && dotnet build`).permissionDecision, 'deny');
  assert.equal(agent(`cd "${wt}" && git add -A && git commit -m "x"`).permissionDecision, 'allow');
  const w = JSON.parse(runHook('broker', { session_id: 'S1', cwd: ws, agent_id: 'wa1', agent_type: 'software-factory:frontend-engineer', tool_name: 'Write', tool_input: { file_path: join(wt, 'src', 'a.ts') } }, env).stdout);
  assert.equal(w.hookSpecificOutput.permissionDecision, 'allow');
  // Also from inside a repo of the workspace (its own git common dir has no .factory).
  const repo = join(ws, 'web');
  spawnSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  const fromRepo = JSON.parse(runHook('broker', { session_id: 'S1', cwd: repo, tool_name: 'Write', tool_input: { file_path: join(home, 'state', 'factory.json') } }, { ...env, CLAUDE_PROJECT_DIR: repo }).stdout);
  assert.equal(fromRepo.hookSpecificOutput.permissionDecision, 'deny');
});

test('precompact writes the CTO checkpoint for the lease holder; session-end releases the lease', async () => {
  const { home } = await makeHome();
  const env = { FACTORY_HOME: home };
  (await lib('control')).start(home, { session: 'S1' });
  runHook('precompact', { session_id: 'S1' }, env);
  assert.ok(existsSync(join(home, 'run', 'cto-checkpoint.md')));
  runHook('session-end', { session_id: 'S2' }, env);
  const st = await lib('state');
  assert.ok(st.holdsLease(home, 'S1'));
  runHook('session-end', { session_id: 'S1' }, env);
  assert.ok(!st.holdsLease(home, 'S1'));
  mkdirSync(join(home, 'x'), { recursive: true });
});
