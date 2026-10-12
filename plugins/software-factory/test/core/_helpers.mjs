// Shared test helpers: temp git repo + factory home, fake DELIVERY modules, a fake agent driver.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const P = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = join(P, 'scripts', 'factory.mjs');
export const lib = (n) => import(`../../scripts/lib/${n}.mjs`);

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temp git repo with one commit, an initialized factory home and env pointing at it. */
export async function makeHome({ init = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sf-'));
  const repo = join(root, 'r');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'b.js'), 'export const b = 1;\n');
  writeFileSync(join(repo, 'README.md'), '# x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const home = join(repo, '.factory');
  const pd = join(root, 'pd');
  process.env.FACTORY_HOME = home;
  process.env.FACTORY_PLUGIN_DATA = pd;
  process.env.FACTORY_NO_NOTIFY = '1';
  if (init) {
    const st = await lib('state');
    st.init(home);
  }
  return { root, repo, home, pd };
}

export function runCli(args, { home, env = {}, input, cwd } = {}) {
  const cut = args.indexOf('--');
  const full = home ? (cut >= 0 ? [...args.slice(0, cut), '--home', home, ...args.slice(cut)] : [...args, '--home', home]) : args;
  const r = spawnSync(process.execPath, [CLI, ...full], {
    encoding: 'utf8', windowsHide: true, input, cwd,
    env: { ...process.env, FACTORY_NO_NOTIFY: '1', CLAUDE_CODE_SESSION_ID: '', ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Fake DELIVERY modules. state.shas maps ref -> sha; state.prState drives gh.prView. */
export function fakeDelivery() {
  const state = { shas: { main: 'base000' }, prState: 'OPEN', merges: [], pushes: [], spawned: [], removed: [], home: null };
  let n = 0;
  const d = {
    git: {
      git: (args) => { if (args[0] === 'branch' && args[1]) state.shas[args[1]] = state.shas[args[2]] || 'base000'; return { code: 0, stdout: '', stderr: '' }; },
      headSha: (_cwd, ref = 'HEAD') => state.shas[ref] || null,
      branchExists: (_cwd, b) => !!state.shas[b],
      isAncestor: () => state.prState === 'MERGED',
      slugify: (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
      worktreeList: () => [], currentBranch: () => 'main',
    },
    worktree: {
      prepare: (o) => ({ worktree_path: o.cwd, branch: o.detachSha ? null : o.branch, head_sha: o.detachSha || 'wt' + (++n), detached: !!o.detachSha, removed_worktrees: [], merged: [] }),
      removeAgentWorktree: (o) => { state.removed.push(o.worktreePath); return { removed: true }; },
      pruneBranches: () => ({ deleted: [] }), addDetached: (o) => o.dir, remove: () => {},
    },
    checks: {
      spawnDetached: ({ home, runId }) => {
        state.spawned.push(runId);
        mkdirSync(join(home, 'run', 'checks'), { recursive: true });
        writeFileSync(join(home, 'run', 'checks', `${runId}.json`), JSON.stringify({ run_id: runId, status: state.checkStatus || 'pass', failed_command: null, evidence: ['EV-9'], finished_at: new Date().toISOString() }));
        return 1;
      },
      readResult: (home, runId) => { try { return JSON.parse(readFileSync(join(home, 'run', 'checks', `${runId}.json`), 'utf8')); } catch { return null; } },
      runChecks: () => ({ status: 'pass', failed_command: null, evidence: [] }),
    },
    integrate: {
      mergeTasks: (o) => { state.merges.push(...o.taskBranches); state.shas[o.epicBranch] = 'epic' + state.merges.length; return { merged: o.taskBranches, already: [], conflict: null, post_merge: null, head_sha: state.shas[o.epicBranch] }; },
    },
    gh: {
      available: () => ({ ok: true, user: 'x' }),
      push: (o) => { state.pushes.push(o.branch); return { ok: true, stderr: '' }; },
      prCreate: () => ({ number: 7, url: 'https://github.com/o/r/pull/7' }),
      prView: () => ({ state: state.prState, mergedAt: state.prState === 'MERGED' ? new Date().toISOString() : null, reviewDecision: null, mergeable: 'MERGEABLE', headRefOid: 'h1' }),
    },
  };
  return { d, state };
}

/** Bind a dispatched run as the PostToolUse hook would, then complete it with a handoff. */
export async function simulateAgent(home, line, makeHandoff, { sessionId = 'S1' } = {}) {
  const store = await lib('store');
  const run0 = store.get(home, 'run', line.run_id);
  const agentId = `a${line.run_id.slice(2)}`;
  store.update(home, 'run', run0.id, (r) => { r.status = 'running'; r.agent_id = agentId; r.started_at = new Date().toISOString(); r.session_id = sessionId; });
  const run = store.get(home, 'run', run0.id);
  const task = store.get(home, 'task', run.task_id);
  const h = await makeHandoff({ run, task, home });
  if (h) writeFileSync(join(home, 'runs', run.id, 'handoff.json'), JSON.stringify(h, null, 2));
  store.update(home, 'run', run.id, (r) => { r.status = 'completed'; r.ended_at = new Date().toISOString(); });
  return { run, task };
}

export function addEvidence(home, runId, id = 'EV-1', source = 'agent') {
  const dir = join(home, 'runs', runId, 'evidence');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'index.jsonl'), JSON.stringify({ id, label: 'test', command: 'npm test', cwd: '.', exit_code: 0, log_path: join(dir, 'x.log'), head_sha: 'x', source, started_at: '', ended_at: '' }) + '\n');
}

export function writeReport(home, rel) {
  const abs = join(home, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '# report\n');
  return rel;
}

export function baseHandoff(run, task, extra = {}) {
  return {
    schema: 'factory/handoff@1', run_id: run.id, task_id: task.id, from_role: run.role, to_role: 'cto',
    status: 'handed_off', verdict: null, summary: 'done',
    acceptance_criteria: task.acceptance_criteria.map((a) => ({ id: a.id, met: true, evidence: [] })),
    evidence: [], files_touched: [], branch: null, commits: [], findings: [], report_path: null,
    open_questions: [], follow_ups: [], destructive: null, resume_note: '', ...extra,
  };
}

export { existsSync, readFileSync, writeFileSync, join };
