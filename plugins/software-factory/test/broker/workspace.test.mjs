// Broker in workspace mode (contracts §20): one factory home in a plain folder of repos, CLI-made
// worktrees under <home>/worktrees/<run id>, agents whose shell cwd is the workspace root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../../scripts/lib/broker.mjs';
import { tmpDir, cleanup } from '../fixtures/delivery/repo.mjs';

const root = tmpDir('sfw-');
const WS = path.join(root, 'ws');
const H = path.join(WS, '.factory');
const API = path.join(WS, 'api');
const WEB = path.join(WS, 'web');
const WT = path.join(H, 'worktrees', 'R-000010');
const OTHER_WT = path.join(H, 'worktrees', 'R-000011');
const QWT = path.join(H, 'worktrees', 'R-000020');
const PLUG = path.join(root, 'plug');
const CLI = path.join(PLUG, 'scripts', 'factory.mjs');
const DATA = path.join(root, 'data');
for (const d of [H, API, WEB, WT, OTHER_WT, path.join(QWT, 'api'), path.join(QWT, 'web'), path.join(PLUG, 'scripts'), DATA]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(CLI, '');

const config = {
  version: 1,
  commands: {},
  checks: {},
  workspace: { enabled: true, default_repo: 'api' },
  repos: {
    api: { path: 'api', commands: { build: 'dotnet build', test: 'dotnet test', run: 'dotnet run --project src/Api' } },
    web: { path: 'web', commands: { build: 'npm run build', test: 'npm test', run: 'npm start', extra: ['npm run lint:fix'] } },
  },
};
const base = { home: H, pluginRoot: PLUG, pluginDataDir: DATA, cliPath: CLI, config, outputPaths: [], cwd: WS };

const webTask = { id: 'T-0002', repo: 'web', epic_id: 'E-0002', branch: 'factory/T-0002-ui', files_owned: ['src/app/**'], files_shared: ['package.json'] };
const CTX = {
  webAuthor: {
    ...base, role: 'frontend-engineer', task: webTask, epic: { id: 'E-0002', repo: 'web' },
    run: { id: 'R-000010', kind: 'author', repo: 'web', branch: 'factory/T-0002-ui', worktree_path: WT },
    worktreePath: WT,
  },
  // Task and epic missing (older record): the run's repo still selects the scope.
  webAuthorRunOnly: {
    ...base, role: 'frontend-engineer', task: { ...webTask, repo: undefined }, epic: null,
    run: { id: 'R-000010', kind: 'author', repo: 'web', branch: 'factory/T-0002-ui', worktree_path: WT },
    worktreePath: WT,
  },
  webReviewer: {
    ...base, role: 'code-reviewer', task: webTask,
    run: { id: 'R-000012', kind: 'review', repo: 'web', worktree_path: OTHER_WT }, worktreePath: OTHER_WT,
  },
  staff: {
    ...base, role: 'staff-engineer', task: { id: 'T-0001', repo: null, kind: 'spec' }, epic: null,
    run: { id: 'R-000005', kind: 'author', repo: null }, worktreePath: null, outputPaths: ['docs/G-001-x/spec.md'],
  },
  qaGoal: {
    ...base, role: 'qa-engineer', task: { id: 'T-0009', kind: 'qa_goal', repo: null, epic_id: null }, epic: null,
    run: {
      id: 'R-000020', kind: 'qa', repo: null, worktree_path: QWT,
      repo_worktrees: [
        { repo: 'api', epic_id: 'E-0001', path: path.join(QWT, 'api').replace(/\\/g, '/'), branch: 'factory/E-0001-api', head_sha: 'a1' },
        { repo: 'web', epic_id: 'E-0002', path: path.join(QWT, 'web').replace(/\\/g, '/'), branch: 'factory/E-0002-web', head_sha: 'b2' },
      ],
    },
    worktreePath: QWT, outputPaths: ['docs/G-001-x/qa/G-001-goal.md'],
  },
};

const A = 'allow';
const D = 'deny';
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const bg = (command) => ({ tool_name: 'Bash', tool_input: { command, run_in_background: true } });
const write = (file_path, tool_name = 'Write') => ({ tool_name, tool_input: { file_path } });
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });
const cd = (dir) => `cd "${dir}" && `;

const CASES = [
  // ---- code author in repo web, shell cwd = workspace root
  ['web build after cd prefix', bash(`${cd(WT)}npm run build`), 'webAuthor', A],
  ['web test with extra args after cd prefix', bash(`${cd(WT)}npm test -- --grep cart`), 'webAuthor', A],
  ['web extra command after cd prefix', bash(`${cd(WT)}npm run lint:fix`), 'webAuthor', A],
  ['api build is not this repo', bash(`${cd(WT)}dotnet build`), 'webAuthor', D, /allow list/],
  ['api test without cd', bash('dotnet test'), 'webAuthor', D],
  ['run.repo alone selects web', bash(`${cd(WT)}npm run build`), 'webAuthorRunOnly', A],
  ['run.repo alone denies api', bash(`${cd(WT)}dotnet build`), 'webAuthorRunOnly', D],
  ['cd prefix + git add + commit', bash(`${cd(WT)}git add -A && git commit -m "feat: cart"`), 'webAuthor', A],
  ['cd prefix + git status + test', bash(`${cd(WT)}git status && npm test`), 'webAuthor', A],
  ['git -C worktree add', bash(`git -C "${WT}" add src/app/cart.ts`), 'webAuthor', A],
  ['git -C worktree commit', bash(`git -C "${WT}" commit -m "x"`), 'webAuthor', A],
  ['git -C worktree switch own branch', bash(`git -C "${WT}" switch factory/T-0002-ui`), 'webAuthor', A],
  ['commit from the workspace root', bash('git commit -m x'), 'webAuthor', D, /worktree/],
  ['commit in the web main checkout', bash(`git -C "${WEB}" commit -m x`), 'webAuthor', D, /worktree/],
  ['commit in another run worktree', bash(`git -C "${OTHER_WT}" add -A`), 'webAuthor', D, /worktree/],
  ['cd into the api repo', bash(`${cd(API)}ls`), 'webAuthor', D, /cd only into your worktree/],
  ['cd into another run worktree', bash(`${cd(OTHER_WT)}npm run build`), 'webAuthor', D, /cd only into your worktree/],
  ['cd into the web main checkout', bash(`${cd(WEB)}git status`), 'webAuthor', D, /cd only into your worktree/],
  ['git -C the web main checkout status', bash(`git -C "${WEB}" status`), 'webAuthor', D, /cd_prefix/],
  ['git -C own worktree status from the workspace root', bash(`git -C "${WT}" status`), 'webAuthor', A],
  ['bare web build from the workspace root', bash('npm run build'), 'webAuthor', D, /cd_prefix/],
  ['bare ls from the workspace root', bash('ls src'), 'webAuthor', D, /cd_prefix/],
  ['factory CLI from the workspace root', bash(`node "${CLI}" status`), 'webAuthor', A],
  ['factory CLI with the right --home', bash(`node "${CLI}" task show T-0002 --home "${H}"`), 'webAuthor', A],
  ['factory CLI with --home in forward slashes', bash(`node "${CLI}" status --home "${H.replace(/\\/g, '/')}"`), 'webAuthor', A],
  ['factory CLI with a different --home', bash(`node "${CLI}" status --home "${path.join(WEB, '.factory')}"`), 'webAuthor', D, /--home/],
  ['factory CLI with an empty --home flag', bash(`node "${CLI}" status --home`), 'webAuthor', D, /--home/],
  ['evidence run without cd runs in the worktree', bash(`node "${CLI}" evidence run --run R-000010 --label t -- npm test`), 'webAuthor', A],
  ['evidence run cannot cd elsewhere', bash(`node "${CLI}" evidence run --run R-000010 --label t -- "cd ${OTHER_WT.replace(/\\/g, '/')} && npm test"`), 'webAuthor', D, /evidence command blocked/],
  ['rm an owned file after cd prefix', bash(`${cd(WT)}rm src/app/old.ts`), 'webAuthor', A],
  ['rm in another run worktree', bash(`rm "${path.join(OTHER_WT, 'src', 'app', 'old.ts')}"`), 'webAuthor', D, /cd_prefix/],
  ['rm in another run worktree after cd prefix', bash(`${cd(WT)}rm "${path.join(OTHER_WT, 'src', 'app', 'old.ts')}"`), 'webAuthor', D, /outside/],
  ['evidence run with the web build', bash(`${cd(WT)}node "${CLI}" evidence run --run R-000010 --label build -- npm run build`), 'webAuthor', A],
  ['evidence run with the api build', bash(`${cd(WT)}node "${CLI}" evidence run --run R-000010 --label build -- dotnet build`), 'webAuthor', D, /evidence command blocked/],
  ['redirect into factory state', bash(`${cd(WT)}git status > "${path.join(H, 'state', 'x.txt')}"`), 'webAuthor', D, /\.factory/],
  // writes: own worktree under the home is fine within files_owned / files_shared
  ['write owned file in own worktree under the home', write(path.join(WT, 'src', 'app', 'cart.ts')), 'webAuthor', A],
  ['edit shared package.json in own worktree', write(path.join(WT, 'package.json'), 'Edit'), 'webAuthor', A],
  ['write unowned file in own worktree', write(path.join(WT, 'src', 'lib', 'x.ts')), 'webAuthor', D, /files_owned/],
  ['write outbox handoff', write(path.join(WT, '.factory-out', 'handoff.json')), 'webAuthor', A],
  ['write own run folder handoff', write(path.join(H, 'runs', 'R-000010', 'handoff.json')), 'webAuthor', A],
  ['write another run worktree', write(path.join(OTHER_WT, 'src', 'app', 'cart.ts')), 'webAuthor', D, /not your worktree/],
  ['write checks worktree', write(path.join(H, 'worktrees', 'checks-R-000010', 'src', 'app', 'cart.ts')), 'webAuthor', D, /not your worktree/],
  ['write integration worktree', write(path.join(H, 'worktrees', 'E-0002', 'src', 'app', 'cart.ts')), 'webAuthor', D, /not your worktree/],
  ['write factory state', write(path.join(H, 'state', 'factory.json')), 'webAuthor', D, /CLI/],
  ['write task record', write(path.join(H, 'tasks', 'T-0002.json'), 'Edit'), 'webAuthor', D],
  ['write config', write(path.join(H, 'config.json')), 'webAuthor', D],
  ['write the web main checkout', write(path.join(WEB, 'src', 'app', 'cart.ts')), 'webAuthor', D, /worktree/],
  ['write the api repo', write(path.join(API, 'src', 'x.cs')), 'webAuthor', D, /worktree/],
  ['reviewer writes code in its worktree', write(path.join(OTHER_WT, 'src', 'app', 'cart.ts')), 'webReviewer', D, /role does not edit/],
  ['reviewer runs web tests after cd', bash(`${cd(OTHER_WT)}npm test`), 'webReviewer', A],
  // ---- planner without a repo: workspace root and every repo's commands
  ['planner runs api build', bash('dotnet build'), 'staff', A],
  ['planner runs web test', bash('npm test'), 'staff', A],
  ['planner cd into api to read', bash(`${cd(API)}git log --oneline -3`), 'staff', A],
  ['planner writes its spec output', write(path.join(H, 'docs', 'G-001-x', 'spec.md')), 'staff', A],
  ['planner writes repo code', write(path.join(API, 'src', 'x.cs')), 'staff', D],
  ['planner git add', bash(`${cd(API)}git add -A`), 'staff', D],
  // ---- cross-repo QA (qa_goal)
  ['qa_goal reads the api worktree', read(path.join(QWT, 'api', 'src', 'Program.cs')), 'qaGoal', A],
  ['qa_goal reads the web worktree', read(path.join(QWT, 'web', 'src', 'app.ts')), 'qaGoal', A],
  ['qa_goal runs api build in its worktree', bash(`${cd(path.join(QWT, 'api'))}dotnet build`), 'qaGoal', A],
  ['qa_goal runs web test in its worktree', bash(`${cd(path.join(QWT, 'web'))}npm test`), 'qaGoal', A],
  ['qa_goal lists files across both', bash(`${cd(QWT)}ls api web`), 'qaGoal', A],
  ['qa_goal cd into the api main checkout', bash(`${cd(API)}dotnet test`), 'qaGoal', D, /cd only into your worktree/],
  ['qa_goal bare api test from the workspace root', bash('dotnet test'), 'qaGoal', D, /cd_prefix/],
  ['qa_goal bare background app from the workspace root', bg('npm start'), 'qaGoal', D, /cd_prefix/],
  ['qa_goal starts the api app in background', bg(`${cd(path.join(QWT, 'api'))}dotnet run --project src/Api`), 'qaGoal', A],
  ['qa_goal starts the web app in background', bg(`${cd(path.join(QWT, 'web'))}npm start`), 'qaGoal', A],
  ['qa_goal background test command', bg(`${cd(path.join(QWT, 'web'))}npm test`), 'qaGoal', D, /background/],
  ['qa_goal writes the outbox report', write(path.join(QWT, '.factory-out', 'docs', 'G-001-x', 'qa', 'G-001-goal.md')), 'qaGoal', A],
  ['qa_goal writes the outbox handoff', write(path.join(QWT, '.factory-out', 'handoff.json')), 'qaGoal', A],
  ['qa_goal runs its outbox check script', bash(`${cd(QWT)}node "${path.join(QWT, '.factory-out', 'qa', 'flow.mjs')}"`), 'qaGoal', A],
  ['qa_goal outbox script from the workspace root', bash(`node "${path.join(QWT, '.factory-out', 'qa', 'flow.mjs')}"`), 'qaGoal', D, /cd_prefix/],
  ['qa_goal writes in the api worktree', write(path.join(QWT, 'api', 'src', 'Program.cs')), 'qaGoal', D, /\.factory-out/],
  ['qa_goal edits web package.json', write(path.join(QWT, 'web', 'package.json'), 'Edit'), 'qaGoal', D, /\.factory-out/],
  ['qa_goal writes the parent folder', write(path.join(QWT, 'notes.md')), 'qaGoal', D, /\.factory-out/],
  ['qa_goal git add in a repo worktree', bash(`${cd(path.join(QWT, 'web'))}git add -A`), 'qaGoal', D],
  ['qa_goal rm in a repo worktree', bash(`${cd(path.join(QWT, 'web'))}rm src/app.ts`), 'qaGoal', D],
];

test(`workspace broker table (${CASES.length} cases)`, async (t) => {
  for (const [name, call, ctxKey, expected, reasonRe] of CASES) {
    await t.test(name, () => {
      const r = decide({ ...call, agent_type: `software-factory:${CTX[ctxKey].role}`, agent_id: 'a1' }, CTX[ctxKey]);
      assert.equal(r.decision, expected, `${name}: got ${r.decision} (${r.reason})`);
      if (expected === D) {
        assert.ok(r.reason && r.reason.length < 200, 'deny has a short reason');
        if (reasonRe) assert.match(r.reason, reasonRe);
      }
    });
  }
});

test('qa_goal before worktree prepare (no repo_worktrees yet) may run any repo command but not write', () => {
  const ctx = { ...CTX.qaGoal, run: { ...CTX.qaGoal.run, repo_worktrees: undefined } };
  const at = 'software-factory:qa-engineer';
  assert.equal(decide({ ...bash(`node "${CLI}" worktree prepare --run R-000020`), agent_type: at }, ctx).decision, A);
  assert.equal(decide({ ...bash(`${cd(QWT)}dotnet test`), agent_type: at }, ctx).decision, A);
  assert.equal(decide({ ...write(path.join(QWT, 'api', 'x.cs')), agent_type: at }, ctx).decision, D);
});

test('unknown repo name gets no project commands', () => {
  const ctx = { ...CTX.webAuthor, task: { ...webTask, repo: 'nope' }, run: { ...CTX.webAuthor.run, repo: 'nope' }, epic: null };
  const r = decide({ ...bash(`${cd(WT)}npm run build`), agent_type: 'software-factory:frontend-engineer' }, ctx);
  assert.equal(r.decision, D);
});

test.after(() => cleanup(root));
