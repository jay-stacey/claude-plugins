import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide, splitCommand, matchGlob, lexCommand } from '../../scripts/lib/broker.mjs';
import { tmpDir, cleanup } from '../fixtures/delivery/repo.mjs';

const IS_WIN = process.platform === 'win32';
const root = tmpDir('sfb-');
const fwd = (p) => p.replace(/\\/g, '/');
const REPO = path.join(root, 'r');
const H = path.join(REPO, '.factory');
const WT = path.join(REPO, '.claude', 'worktrees', 'agent-1');
const IWT = path.join(H, 'worktrees', 'E-0001');
const PLUG = path.join(root, 'plug');
const CLI = path.join(PLUG, 'scripts', 'factory.mjs');
const DATA = path.join(root, 'data');
for (const d of [H, WT, IWT, path.join(PLUG, 'scripts'), DATA, path.join(root, 'elsewhere')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(CLI, '');

const config = {
  commands: { install: 'npm ci', build: 'npm run build', test: 'npm test', lint: null, run: 'npm start', migrate_up: 'npm run db:up', extra: ['make docs'] },
  checks: { pre_review: ['npm run build', 'npm test'], post_merge: ['npm run e2e && npm run smoke'] },
};
const task = { id: 'T-0001', branch: 'factory/T-0001-x', files_owned: ['src/vin/**', 'lib/util.js'], files_shared: ['package.json'] };
const base = { home: H, pluginRoot: PLUG, pluginDataDir: DATA, cliPath: CLI, config, outputPaths: [] };

const CTX = {
  author: { ...base, role: 'backend-engineer', run: { id: 'R-000001', kind: 'author', branch: 'factory/T-0001-x' }, task, worktreePath: WT, cwd: WT },
  authorNoCwd: { ...base, role: 'backend-engineer', run: { id: 'R-000001', kind: 'author', branch: 'factory/T-0001-x' }, task, worktreePath: WT },
  reviewer: { ...base, role: 'code-reviewer', run: { id: 'R-000002', kind: 'review' }, task, worktreePath: WT, cwd: WT, outputPaths: ['docs/G-001-x/reviews/T-0001-code-reviewer-r1.md'] },
  cto: { ...base, role: 'cto', run: { id: 'R-000003', kind: 'escalation' }, task: null, worktreePath: null, cwd: REPO },
  staff: { ...base, role: 'staff-engineer', run: { id: 'R-000004', kind: 'author' }, task: null, worktreePath: null, cwd: REPO, outputPaths: [`${fwd(H)}/docs/G-001-x/spec.md`] },
  pm: { ...base, role: 'project-manager', run: { id: 'R-000005', kind: 'author' }, task: null, worktreePath: null, cwd: REPO, outputPaths: ['docs/G-001-x/plan*.md'] },
  designer: { ...base, role: 'ui-ux-designer', run: { id: 'R-000006', kind: 'author' }, task: null, worktreePath: null, cwd: REPO, outputPaths: [path.join(H, 'docs', 'G-001-x', 'design') + path.sep] },
  integrator: { ...base, role: 'devops-release', run: { id: 'R-000007', kind: 'integrate' }, task: { ...task, files_owned: ['src/**'] }, integrate: { conflict_files: ['src/vin/a.ts'] }, worktreePath: IWT, cwd: IWT },
  qa: { ...base, role: 'qa-engineer', run: { id: 'R-000008', kind: 'qa' }, task, worktreePath: WT, cwd: WT, outputPaths: ['docs/G-001-x/qa/E-0001.md'] },
  writer: { ...base, role: 'tech-writer', run: { id: 'R-000009', kind: 'author', branch: 'factory/T-0009-docs' }, task: { id: 'T-0009', files_owned: ['docs/**', '*.md'] }, worktreePath: WT, cwd: WT, outputPaths: ['docs/G-001-x/release-notes.md'] },
};
CTX.stateOut = { ...CTX.cto, outputPaths: ['state/x.json'] };

const A = 'allow';
const D = 'deny';
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const bg = (command) => ({ tool_name: 'Bash', tool_input: { command, run_in_background: true } });
const write = (file_path, tool_name = 'Write') => ({ tool_name, tool_input: { file_path } });
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });
const cli = (rest, form = `"${CLI}"`) => bash(`node ${form} ${rest}`);

// [name, call, ctx key, expected decision, optional reason regex]
const CASES = [
  // ---- Bash: read-only + splitting
  ['git status', bash('git status'), 'author', A],
  ['git log piped to head', bash('git log --oneline -5 | head -3'), 'author', A],
  ['ls with 2>&1 piped', bash('ls -la 2>&1 | head'), 'author', A],
  ['ls to /dev/null', bash('ls > /dev/null'), 'author', A],
  ['quoted separators stay in one part', bash('echo "a && b; c | d"'), 'author', A],
  ['single-quoted $() is literal', bash("echo '$(not run)'"), 'author', A],
  ['command substitution', bash('echo $(cat /etc/passwd)'), 'author', D, /substitution/],
  ['backticks', bash('echo `whoami`'), 'author', D, /substitution/],
  ['background & then curl', bash('ls & curl http://x'), 'author', D, /network/],
  ['grep allowed', bash('grep -rn "TODO" src'), 'author', A],
  ['find -exec rm', bash('find . -name "*.ts" -exec rm {} \\;'), 'author', D, /find/],
  ['rg --pre', bash('rg --pre ./evil foo'), 'author', D],
  ['cat .env', bash('cat .env'), 'author', D, /secret/],
  ['cat source file', bash('cat src/vin/a.ts'), 'author', A],
  ['sed not on allow list', bash('sed -i s/a/b/ x.js'), 'author', D, /open_questions/],
  ['env assignment prefix', bash('FOO=1 npm test'), 'author', D],
  ['git -c option', bash('git -c core.pager=evil log'), 'author', D],
  ['git diff --output', bash('git diff --output=x.patch'), 'author', D],
  ['git -C worktree status', bash(`git -C "${WT}" status`), 'cto', A],
  // ---- Bash: config commands
  ['exact test command', bash('npm test'), 'author', A],
  ['test command with extra args (§12.3)', bash('npm test -- --grep vin'), 'author', A],
  ['extra args with quoted pipe', bash('npm test -- --grep "a|b"'), 'author', D],
  ['extra args with redirection', bash('npm test -- --ci > out.txt'), 'author', D, /redirection/],
  ['extra args then curl', bash('npm test --ci; curl http://x'), 'author', D, /network/],
  ['config prefix without a space', bash('npm testx'), 'author', D],
  ['commands.extra entry', bash('make docs'), 'author', A],
  ['commands.extra entry with args', bash('make docs OUT=build'), 'author', A],
  ['commands.migrate_up', bash('npm run db:up'), 'author', A],
  ['post_merge string plus args', bash('npm run e2e && npm run smoke --ci'), 'author', A],
  ['cd worktree && command plus args', bash(`cd "${WT}" && npm run build -- --prod`), 'authorNoCwd', A],
  ['cd worktree && config command', bash(`cd "${WT}" && npm test`), 'authorNoCwd', A],
  ['cd worktree (backslashes) && build', bash(`cd "${WT.replace(/\//g, '\\')}" && npm run build`), 'authorNoCwd', A],
  ['exact post_merge string containing &&', bash('npm run e2e && npm run smoke'), 'author', A],
  ['install command', bash('npm ci'), 'author', A],
  ['other install', bash('npm install left-pad'), 'author', D],
  ['cd outside the repo', bash(`cd "${path.join(root, 'elsewhere')}" && ls`), 'author', D, /worktree/],
  // ---- Bash: redirection
  ['echo into factory state', bash(`echo hi > "${path.join(H, 'state', 'factory.json')}"`), 'author', D, /\.factory/],
  ['append into factory home', bash(`npm test >> "${fwd(H)}/runs/R-000001/evidence/index.jsonl"`), 'author', D, /\.factory/],
  ['redirect to a worktree file', bash('cat README.md > out.txt'), 'author', D, /redirection/],
  // ---- Bash: network, eval, gh, push
  ['git push', bash('git push origin HEAD'), 'author', D, /push/],
  ['git push after cd', bash(`cd "${WT}" && git add -A && git push`), 'authorNoCwd', D, /push/],
  ['gh pr merge', bash('gh pr merge 1 --squash'), 'author', D, /GitHub/],
  ['curl', bash('curl https://example.invalid'), 'author', D, /network/],
  ['wget', bash('wget https://example.invalid'), 'author', D, /network/],
  ['Invoke-WebRequest', bash('Invoke-WebRequest https://example.invalid'), 'author', D, /network/],
  ['node -e', bash('node -e "require(\'fs\')"'), 'author', D, /node -e/],
  ['python -c', bash('python -c "print(1)"'), 'author', D, /python -c/],
  ['node other script', bash('node scripts/build.mjs'), 'author', D],
  // ---- Bash: git writes
  ['cd + add + commit', bash(`cd "${WT}" && git add -A && git commit -m "feat: decode VIN"`), 'authorNoCwd', A],
  ['commit without cwd', bash('git commit -m x'), 'authorNoCwd', D, /cd "/],
  ['commit with cwd in worktree', bash('git commit -m "x; y"'), 'author', A],
  ['commit --no-verify', bash('git commit --no-verify -m x'), 'author', D, /no-verify/],
  ['commit in main checkout', bash(`cd "${REPO}" && git commit -m x`), 'authorNoCwd', D, /worktree/],
  ['switch to own branch', bash('git switch factory/T-0001-x'), 'author', A],
  ['switch to main', bash('git switch main'), 'author', D],
  ['switch -c new branch', bash('git switch -c other'), 'author', D],
  ['checkout -- file', bash('git checkout -- src/vin/a.ts'), 'author', A],
  ['checkout branch', bash('git checkout main'), 'author', D],
  ['restore', bash('git restore --staged src/vin/a.ts'), 'author', A],
  ['stash', bash('git stash'), 'author', A],
  ['stash pop', bash('git stash pop'), 'author', D, /shared/],
  ['reviewer git add', bash('git add .'), 'reviewer', D],
  ['author git merge', bash('git merge factory/T-0002-y'), 'author', D, /devops-release/],
  ['integrator git merge', bash('git merge --no-edit factory/T-0002-y'), 'integrator', A],
  ['git branch --list', bash("git branch --list 'factory/*'"), 'author', A],
  ['git branch -D', bash('git branch -D factory/T-0001-x'), 'author', D],
  ['git branch create', bash('git branch newbranch'), 'author', D],
  ['git rebase not allowed', bash('git rebase main'), 'author', D],
  // ---- Bash: rm
  ['rm -rf owned dir', bash('rm -rf src/vin/old'), 'author', A],
  ['rm -rf root', bash('rm -rf /'), 'author', D],
  ['rm -rf outside worktree', bash(`rm -rf "${path.join(REPO, 'src')}"`), 'author', D, /outside/],
  ['rm file not owned', bash('rm src/other.js'), 'author', D, /files_owned/],
  ['rm wildcard', bash('rm src/vin/*.ts'), 'author', D, /wildcard/],
  ['reviewer rm', bash('rm src/vin/a.ts'), 'reviewer', D],
  // ---- Bash: factory CLI forms
  ['CLI quoted native path', cli('status'), 'author', A],
  ['CLI quoted backslash path', cli('status --json', `"${CLI.replace(/\//g, '\\')}"`), 'author', A],
  ['CLI quoted forward-slash path', cli(`handoff validate "${fwd(H)}/runs/R-000001/handoff.json"`, `"${fwd(CLI)}"`), 'author', A],
  ['CLI unquoted forward-slash path', cli('task show T-0001', fwd(CLI)), 'author', A],
  ['CLI unquoted backslash path', cli('goal show G-001', CLI.replace(/\//g, '\\')), 'author', A],
  ['CLI evidence run with config command', cli('evidence run --run R-000001 --label test -- npm test'), 'author', A],
  ['CLI evidence run quoted inner', cli('evidence run --run R-000001 --label st -- "git status"'), 'author', A],
  ['CLI evidence run with curl', cli('evidence run --run R-000001 --label x -- curl http://x'), 'author', D, /evidence command blocked/],
  ['CLI evidence run for another run', cli('evidence run --run R-000002 --label x -- npm test'), 'author', D, /R-000001/],
  ['CLI evidence run config command plus args', cli('evidence run --run R-000001 --label test -- npm test -- --grep vin'), 'author', A],
  ['CLI evidence run quoted inner with ;', cli('evidence run --run R-000001 --label x -- "npm test; curl http://x"'), 'author', D, /evidence command blocked/],
  ['CLI task list for any role', cli('task list --goal G-001'), 'reviewer', A],
  ['CLI epic list / show', cli('epic show E-0001'), 'author', A],
  ['CLI budget show', cli('budget show G-001'), 'pm', A],
  ['CLI events tail', cli('events tail --n 20'), 'qa', A],
  ['CLI gate list for builder', cli('gate list'), 'author', A],
  ['CLI task waive as cto', cli('task waive T-0001 --finding F-1 --reason "accepted"'), 'cto', A],
  ['CLI task waive as builder', cli('task waive T-0001 --finding F-1 --reason x'), 'author', D],
  ['CLI task block as cto', cli('task block T-0001 --needs human --question "which API?"'), 'cto', A],
  ['CLI task replan as staff-engineer', cli('task replan T-0002 --file p.json'), 'staff', D],
  ['CLI worktree prepare own run', cli('worktree prepare --run R-000001'), 'author', A],
  ['CLI wrong --home', cli(`status --home "${path.join(root, 'elsewhere')}"`), 'author', D],
  ['CLI task new as builder', cli('task new --file t.json'), 'author', D, /not allowed for backend-engineer/],
  ['CLI task new as cto', cli('task new --file t.json'), 'cto', A],
  ['CLI task new as staff-engineer', cli('task new --file t.json'), 'staff', A],
  ['CLI epic new as staff-engineer', cli('epic new --goal G-001 --title x --summary y'), 'staff', A],
  ['CLI task replan as pm', cli('task replan T-0002 --file p.json'), 'pm', A],
  ['CLI note as cto', cli('note "hello"'), 'cto', A],
  ['CLI gate decide as cto', cli('gate decide GATE-0001 --decision approve'), 'cto', D],
  ['CLI goal set as builder', cli('goal set G-001 --tier S'), 'author', D],
  ['CLI at a different path', bash(`node "${path.join(root, 'elsewhere', 'factory.mjs')}" status`), 'author', D, /factory CLI/],
  ['CLI piped to head', bash(`node "${CLI}" status | head -5`), 'author', A],
  ['PowerShell tool is denied', { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' } }, 'author', D, /Bash tool/],
  // ---- Edit / Write
  ['author writes owned file', write(path.join(WT, 'src', 'vin', 'decoder.ts')), 'author', A],
  ['author writes owned file (forward slashes)', write(`${fwd(WT)}/lib/util.js`), 'author', A],
  ['author edits shared file', write(path.join(WT, 'package.json'), 'Edit'), 'author', A],
  ['author MultiEdit owned', write(path.join(WT, 'src', 'vin', 'a.ts'), 'MultiEdit'), 'author', A],
  ['author writes unowned file', write(path.join(WT, 'src', 'other', 'x.ts')), 'author', D, /files_owned/],
  ['author writes in main checkout', write(path.join(REPO, 'src', 'vin', 'decoder.ts')), 'author', D, /worktree/],
  ['author writes .git', write(path.join(WT, '.git', 'config')), 'author', D],
  ['author writes own handoff', write(path.join(H, 'runs', 'R-000001', 'handoff.json')), 'author', A],
  ['author writes own checkpoint', write(path.join(H, 'runs', 'R-000001', 'checkpoint.md')), 'author', A],
  ['author forges evidence index', write(path.join(H, 'runs', 'R-000001', 'evidence', 'index.jsonl')), 'author', D, /evidence/],
  ['author writes run.json', write(path.join(H, 'runs', 'R-000001', 'run.json')), 'author', D],
  ['author writes another run handoff', write(path.join(H, 'runs', 'R-000002', 'handoff.json')), 'author', D],
  ['author writes factory state', write(path.join(H, 'state', 'factory.json')), 'author', D, /CLI/],
  ['author writes task record', write(path.join(H, 'tasks', 'T-0001.json'), 'Edit'), 'author', D],
  ['NotebookEdit unowned', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(WT, 'nb.ipynb') } }, 'author', D],
  ['reviewer writes report path', write(path.join(H, 'docs', 'G-001-x', 'reviews', 'T-0001-code-reviewer-r1.md')), 'reviewer', A],
  ['reviewer writes code', write(path.join(WT, 'src', 'vin', 'decoder.ts')), 'reviewer', D, /role does not edit/],
  ['reviewer writes the spec', write(path.join(H, 'docs', 'G-001-x', 'spec.md')), 'reviewer', D, /output paths/],
  ['reviewer writes own handoff', write(path.join(H, 'runs', 'R-000002', 'handoff.json')), 'reviewer', A],
  ['staff writes spec (absolute output path)', write(path.join(H, 'docs', 'G-001-x', 'spec.md')), 'staff', A],
  ['pm writes plan (glob output path)', write(path.join(H, 'docs', 'G-001-x', 'plan.md')), 'pm', A],
  ['designer writes in design dir', write(path.join(H, 'docs', 'G-001-x', 'design', 'home.html')), 'designer', A],
  ['designer writes project code', write(path.join(REPO, 'src', 'app.css')), 'designer', D],
  ['write to plugin data', write(path.join(DATA, 'hmac', 'abc.key')), 'cto', D, /data folder/],
  ['integrator edits a conflict file', write(path.join(IWT, 'src', 'vin', 'a.ts'), 'Edit'), 'integrator', A],
  ['integrator edits a non-conflict file', write(path.join(IWT, 'src', 'vin', 'b.ts'), 'Edit'), 'integrator', D, /files_owned/],
  ['tech writer writes release notes output', write(path.join(H, 'docs', 'G-001-x', 'release-notes.md')), 'writer', A],
  ['tech writer writes repo docs (files_owned)', write(path.join(WT, 'docs', 'guide.md')), 'writer', A],
  ['tech writer writes code', write(path.join(WT, 'src', 'app.ts')), 'writer', D],
  ['qa writes its report', write(path.join(H, 'docs', 'G-001-x', 'qa', 'E-0001.md')), 'qa', A],
  ['cto writes its handoff', write(path.join(H, 'runs', 'R-000003', 'handoff.json')), 'cto', A],
  ['cto writes code', write(path.join(REPO, 'src', 'x.ts')), 'cto', D],
  ['output path pointing at state is still denied', write(path.join(H, 'state', 'x.json')), 'stateOut', D],
  // ---- background commands (§12.3)
  ['qa starts commands.run in background', bg('npm start'), 'qa', A],
  ['qa starts commands.run after cd', bg(`cd "${WT}" && npm start`), 'qa', A],
  ['qa background other command', bg('npm test'), 'qa', D, /background/],
  ['builder background commands.run', bg('npm start'), 'author', D, /background/],
  ['qa foreground commands.run', bash('npm start'), 'qa', A],
  ['integrator edits factory state', write(path.join(H, 'state', 'index.json'), 'Edit'), 'integrator', D],
  // ---- Read
  ['read source', read(path.join(WT, 'src', 'a.ts')), 'author', A],
  ['read factory state', read(path.join(H, 'state', 'factory.json')), 'author', A],
  ['read .env', read(path.join(REPO, '.env')), 'author', D, /secret/],
  ['read .env.local', read(path.join(REPO, '.env.local')), 'reviewer', D],
  ['read pem', read(path.join(REPO, 'certs', 'server.pem')), 'author', D],
  ['read ssh key', read(path.join(root, '.ssh', 'id_rsa')), 'cto', D],
  ['read HMAC key in plugin data', read(path.join(DATA, 'hmac', 'abcdef.key')), 'author', D],
  ['read plugin data json', read(path.join(DATA, 'x.json')), 'author', D, /data folder/],
  ['qa runs its own check script from the outbox', bash(`node "${path.join(WT, '.factory-out', 'qa', 'edge.mjs')}"`), 'qa', A],
  ['qa runs node --test on an outbox script', bash(`node --test "${path.join(WT, '.factory-out', 'qa', 'edge.test.mjs')}"`), 'qa', A],
  ['qa cannot run a repo script with node', bash(`node "${path.join(WT, 'scripts', 'x.mjs')}"`), 'qa', D],
  ['author cannot run an outbox qa script', bash(`node "${path.join(WT, '.factory-out', 'qa', 'edge.mjs')}"`), 'author', D],
  ['qa script with a flag is denied', bash(`node "${path.join(WT, '.factory-out', 'qa', 'edge.mjs')}" --inspect`), 'qa', D],
  ['author writes handoff to worktree outbox', write(path.join(WT, '.factory-out', 'handoff.json')), 'author', A],
  ['reviewer writes report to worktree outbox', write(path.join(WT, '.factory-out', 'docs', 'G-001-x', 'reviews', 'T-1.md')), 'reviewer', A],
  ['read id_utils source (not an ssh key)', read(path.join(WT, 'src', 'id_utils.ts')), 'author', A],
  ['read ssh public key', read(path.join(root, '.ssh', 'id_ed25519.pub')), 'author', D],
  // ---- Glob / Grep
  ['glob source', { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.ts' } }, 'author', A],
  ['glob .env files', { tool_name: 'Glob', tool_input: { pattern: '**/.env*' } }, 'author', D, /secret/],
  ['grep source', { tool_name: 'Grep', tool_input: { pattern: 'decode', path: path.join(WT, 'src') } }, 'reviewer', A],
  ['grep with .env glob', { tool_name: 'Grep', tool_input: { pattern: 'API_KEY', glob: '.env*' } }, 'reviewer', D, /secret/],
  ['grep plugin data folder', { tool_name: 'Grep', tool_input: { pattern: 'x', path: DATA } }, 'author', D, /data folder/],
  ['grep for the word key in source', { tool_name: 'Grep', tool_input: { pattern: 'apiKey', path: path.join(WT, 'src') } }, 'author', A],
];

if (IS_WIN) {
  const gitBash = '/' + CLI[0].toLowerCase() + fwd(CLI).slice(2);
  CASES.push(['CLI Git Bash /c/ path', cli('status', gitBash), 'author', A]);
  CASES.push(['author writes owned file (backslashes)', write(path.join(WT, 'src', 'vin', 'x.ts').replace(/\//g, '\\')), 'author', A]);
}

test(`broker table (${CASES.length} cases)`, async (t) => {
  assert.ok(CASES.length >= 40);
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

test('pass for non-factory agents and the setup interviewer', () => {
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'curl x' }, agent_type: 'general-purpose' }, CTX.author).decision, 'pass');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'curl x' } }, CTX.author).decision, 'pass');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(H, 'state', 'x.json') }, agent_type: 'software-factory:setup-interviewer' }, CTX.cto).decision, 'pass');
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'gh auth status' }, agent_type: 'software-factory:setup-interviewer' }, {}).decision, 'pass');
  // Glob/Grep are brokered for factory agents (contracts §13.3): plain searches are allowed.
  assert.equal(decide({ tool_name: 'Glob', tool_input: { pattern: '**' }, agent_type: 'software-factory:backend-engineer' }, CTX.author).decision, 'allow');
});

test('no run context: writes denied, reads allowed', () => {
  const ctx = { ...base, role: 'backend-engineer', run: null, task: null, worktreePath: null };
  const at = 'software-factory:backend-engineer';
  assert.equal(decide({ ...write(path.join(REPO, 'a.ts')), agent_type: at }, ctx).decision, D);
  assert.equal(decide({ ...read(path.join(REPO, 'a.ts')), agent_type: at }, ctx).decision, A);
  assert.equal(decide({ ...bash('git status'), agent_type: at }, ctx).decision, A);
  assert.equal(decide({ ...bash('git add -A'), agent_type: at }, ctx).decision, D);
});

test('splitCommand respects quotes and operators', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommand('echo "x && y" && ls'), ['echo "x && y"', 'ls']);
  assert.deepEqual(splitCommand("echo 'a|b;c' | wc -l"), ["echo 'a|b;c'", 'wc -l']);
  assert.deepEqual(splitCommand('npm test 2>&1 | tail -5'), ['npm test 2>&1', 'tail -5']);
  assert.deepEqual(splitCommand('cd "C:\\a b" && git status'), ['cd "C:\\a b"', 'git status']);
  assert.deepEqual(splitCommand('a\nb;'), ['a', 'b']);
  assert.deepEqual(splitCommand('echo a\\;b'), ['echo a\\;b']);
  assert.deepEqual(splitCommand('ls & pwd'), ['ls', 'pwd']);
  const lx = lexCommand('git log > "out file.txt" 2>&1');
  assert.deepEqual(lx.segments[0].redirects.map((r) => [r.op, r.target]), [['>', 'out file.txt'], ['>&', '&1']]);
  assert.deepEqual(lx.segments[0].tokens.map((t) => t.value), ['git', 'log']);
  assert.ok(lexCommand('echo "unterminated').error);
});

test('matchGlob', () => {
  assert.ok(matchGlob('src/vin/**', 'src/vin/a/b.ts'));
  assert.ok(matchGlob('src/vin/**', 'src/vin'));
  assert.ok(!matchGlob('src/vin/**', 'src/vinx/a.ts'));
  assert.ok(matchGlob('src/*.ts', 'src/a.ts'));
  assert.ok(!matchGlob('src/*.ts', 'src/x/a.ts'));
  assert.ok(matchGlob('**/*.test.ts', 'a/b/c.test.ts'));
  assert.ok(matchGlob('**/*.test.ts', 'c.test.ts'));
  assert.ok(matchGlob('lib/util.js', 'lib/util.js'));
  assert.ok(matchGlob('lib/', 'lib/util.js'));
  assert.ok(matchGlob('./lib', 'lib/x/y.js'));
  assert.ok(matchGlob('src/?.ts', 'src/a.ts'));
  assert.ok(!matchGlob('src/a.ts', 'src/a.tsx'));
});

test.after(() => cleanup(root));
