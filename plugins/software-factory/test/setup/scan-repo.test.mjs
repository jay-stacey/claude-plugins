// Tests for scripts/setup/scan-repo.mjs. Builds fixture repos in os.tmpdir(); no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scan, isSecretPath, classifyCommand, parseRemote, trackerHints, pmRun, summarize, bodyHash, stampFile, checkFile,
} from '../../scripts/setup/scan-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/setup/scan-repo.mjs');
const CANARY = 'CANARY_SECRET_9f3b2';
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sf-${tag}-`));
  temps.push(d);
  return d;
}
function write(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function commit(root, msg) { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', msg); }

/** Angular + ASP.NET fixture with CI, docs, ADRs, CODEOWNERS and planted secrets. */
function appFixture() {
  const r = tmpDir('app');
  git(r, 'init', '-q', '-b', 'main');
  write(r, 'package.json', JSON.stringify({
    name: 'widget',
    scripts: { build: 'ng build', test: 'ng test', lint: 'ng lint', start: 'ng serve', e2e: 'playwright test' },
    dependencies: { '@angular/core': '^20.1.0', primeng: '^20.0.0' },
    devDependencies: { typescript: '~5.8.0', '@playwright/test': '^1.50.0' },
  }, null, 2));
  write(r, 'package-lock.json', '{}');
  write(r, 'tsconfig.json', '{}');
  for (let i = 0; i < 10; i++) write(r, `src/app/f${i}.ts`, `export const f${i} = ${i};\n`);
  write(r, 'src/app/app.component.ts', 'export class AppComponent {}\n');
  write(r, 'api/Api.csproj', `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8.0.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>`);
  write(r, 'api/Migrations/20260101_Init.cs', '// migration\n');
  write(r, '.github/workflows/ci.yml', `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @angular/cli
      - run: npm ci
      - name: Test
        run: npm test -- --watch=false
      - name: Lint
        run: |
          npx eslint .
          echo done
`);
  write(r, 'CLAUDE.md', '# Rules\n- Use signals for state.\n');
  write(r, 'README.md', '# Widget\nA widget tracker for dealers.\n');
  write(r, 'SECURITY.md', '# Security\nReport to security team.\n');
  write(r, 'eslint.config.js', 'export default [];\n');
  write(r, '.github/CODEOWNERS', '# owners\n* @acme/core @jay\n/api/ @acme/backend\n');
  write(r, '.github/pull_request_template.md', '- [ ] tests\n');
  write(r, 'docs/adr/0001-use-postgres.md', '# Use Postgres for storage\n');
  write(r, 'playwright.config.ts', 'export default {};\n');
  write(r, 'Dockerfile', 'FROM node:20\n');
  write(r, '.gitignore', '.env\nnode_modules/\n');
  write(r, '.env.example', 'API_KEY=\n');
  // Planted secrets: the scanner must never open these.
  write(r, '.env', `API_KEY=${CANARY}\n`);
  write(r, 'secrets.json', `{"k":"${CANARY}"}`);
  write(r, 'certs/server.pem', `${CANARY}\n`);
  write(r, 'api/appsettings.json', `{"ConnectionStrings":{"Db":"${CANARY}"}}`);
  write(r, 'api/appsettings.Development.json', `{"x":"${CANARY}"}`);
  write(r, 'node_modules/leftpad/package.json', '{"name":"leftpad","scripts":{"test":"x"}}');
  commit(r, 'NEO-12 scaffold app');
  write(r, 'src/app/extra.ts', 'export const x = 1;\n');
  commit(r, 'NEO-13 add extra (fixes #4)');
  commit(r, 'NEO-14 tidy, see UTF-8 and SHA-256 notes');
  git(r, 'branch', 'neo-15-feature');
  git(r, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git');
  return r;
}

test('isSecretPath blocks secrets and allows examples', () => {
  for (const p of ['.env', '.env.local', 'api/.env.production', 'a/server.pem', 'k.key', 'secrets.json', 'secret.yaml',
    'appsettings.json', 'api/appsettings.Production.json', 'id_rsa', '.npmrc', 'prod.tfvars']) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ['.env.example', '.env.sample', 'src/env.ts', 'package.json', 'keys.md', 'README.md']) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test('classifyCommand maps CI steps to command slots', () => {
  assert.equal(classifyCommand('npm ci'), 'install');
  assert.equal(classifyCommand('npm install -g @angular/cli'), null);
  assert.equal(classifyCommand('pip install ruff'), null);
  assert.equal(classifyCommand('pip install -r requirements.txt'), 'install');
  assert.equal(classifyCommand('dotnet test --no-build'), 'test');
  assert.equal(classifyCommand('dotnet format --verify-no-changes'), 'lint');
  assert.equal(classifyCommand('npx playwright test'), 'e2e');
  assert.equal(classifyCommand('npx tsc --noEmit'), 'typecheck');
  assert.equal(classifyCommand('go build ./...'), 'build');
  assert.equal(classifyCommand('docker build .'), null);
  assert.equal(classifyCommand('echo hi'), null);
});

test('parseRemote handles https, ssh and credentials', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/widget.git'), { provider: 'github', owner: 'acme', repo: 'widget', url: 'git@github.com:acme/widget.git' });
  assert.equal(parseRemote('https://github.com/acme/widget').repo, 'widget');
  assert.equal(parseRemote('https://dev.azure.com/org/proj/_git/repo').provider, 'azure');
  assert.equal(parseRemote(null), null);
});

test('trackerHints ranks keys and ignores false positives', () => {
  const h = trackerHints('NEO-1 a\nNEO-2 b\nUTF-8 SHA-256 ISO-8601\nOPS-9\nfix #12 and #13');
  assert.deepEqual(h.keys.map((k) => k.prefix), ['NEO', 'OPS']);
  assert.equal(h.keys[0].count, 2);
  assert.equal(h.github_refs, 2);
  const b = trackerHints('', ['neo-15-x', 'feature/neo-16-y', 'worktree-agent-123', 'release-2', 'origin/main']);
  assert.deepEqual(b.keys, [{ prefix: 'NEO', count: 2, example: 'NEO-15' }]);
});

test('pmRun targets sub folders', () => {
  assert.equal(pmRun('npm', 'test'), 'npm test');
  assert.equal(pmRun('npm', 'build', 'web'), 'npm --prefix web run build');
  assert.equal(pmRun('pnpm', 'lint', 'web'), 'pnpm -C web lint');
});

test('scan of an existing Angular + .NET repo', () => {
  const r = appFixture();
  const s = scan(r, { now: new Date('2026-10-12T00:00:00Z') });
  const json = JSON.stringify(s);

  assert.equal(s.schema, 'factory/scan@1');
  assert.equal(s.kind, 'existing');
  assert.ok(!json.includes(CANARY), 'a secret value leaked into scan output');
  assert.ok(s.secret_like_files_skipped >= 5);
  assert.ok(!json.includes('leftpad'), 'node_modules must be skipped');

  assert.equal(s.git.default_branch, 'main');
  assert.deepEqual(s.proposed.project.value.remote, { provider: 'github', owner: 'acme', repo: 'widget' });
  assert.equal(s.proposed.project.value.name, 'widget');
  assert.equal(s.proposed.delivery.mode, 'github');

  const web = s.stack.find((x) => x.path === '.');
  assert.equal(web.language, 'typescript');
  assert.ok(web.frameworks.includes('angular@20'));
  assert.equal(web.package_manager, 'npm');
  const api = s.stack.find((x) => x.path === 'api');
  assert.equal(api.language, 'csharp');
  for (const f of ['aspnetcore@net8.0', 'efcore', 'postgres', 'xunit']) assert.ok(api.frameworks.includes(f), f);

  const c = s.proposed.commands;
  assert.equal(c.install.value, 'npm ci');
  assert.equal(c.install.tier, 'ci');
  assert.equal(c.install.source, '.github/workflows/ci.yml:9');
  assert.equal(c.test.value, 'npm test -- --watch=false');
  assert.equal(c.test.source, '.github/workflows/ci.yml:11');
  assert.equal(c.lint.value, 'npx eslint .');
  assert.equal(c.lint.source, '.github/workflows/ci.yml:14');
  assert.equal(c.build.value, 'npm run build');
  assert.equal(c.build.tier, 'scripts');
  assert.equal(c.build.source, 'package.json scripts.build');
  assert.equal(c.run.value, 'npm start');
  assert.equal(c.e2e.value, 'npm run e2e');
  assert.equal(c.typecheck, null);
  assert.equal(c.migrate_up.value, 'dotnet ef database update --project api');
  assert.equal(c.migrate_up.source, 'api/Migrations/20260101_Init.cs (EF Core)');
  assert.equal(c.migrate_down, null);
  assert.equal(c.screenshot.value, 'npx playwright screenshot');

  const roles = s.proposed.roles.active;
  for (const role of ['frontend-engineer', 'ui-ux-designer', 'backend-engineer', 'data-engineer', 'cto', 'code-reviewer']) assert.ok(roles.includes(role), role);
  assert.equal(roles.length, 14);
  assert.equal(s.proposed.gates.G3.enabled, true);

  assert.equal(s.proposed.tracker.recommend, 'keyed');
  assert.equal(s.proposed.tracker.team_key, 'NEO');
  assert.ok(s.tracker_hints.keys[0].count >= 4);

  assert.deepEqual(s.codeowners.owners, ['@acme/backend', '@acme/core', '@jay']);
  assert.equal(s.pr_template, '.github/pull_request_template.md');
  assert.deepEqual(s.docs.adrs, [{ path: 'docs/adr/0001-use-postgres.md', title: 'Use Postgres for storage' }]);
  assert.ok(s.docs.agent.includes('CLAUDE.md'));
  assert.equal(s.docs.human.security, 'SECURITY.md');
  assert.ok(s.lint.includes('eslint.config.js'));
  assert.ok(s.proposed.constitution_sources.includes('CLAUDE.md'));
  assert.ok(s.signals.e2e.found && s.signals.iac.found && s.signals.migrations.found);
  assert.deepEqual(s.proposed.worktree_include.value, ['.env']);
  assert.equal(s.env.dotenv_gitignored, true);

  assert.ok(summarize(s).split('\n').length <= 8);
});

test('scan is deterministic apart from the timestamp', () => {
  const r = appFixture();
  const now = new Date('2026-10-12T00:00:00Z');
  assert.deepEqual(scan(r, { now }), scan(r, { now }));
});

test('scan of a new Python repo uses framework defaults', () => {
  const r = tmpDir('py');
  git(r, 'init', '-q', '-b', 'main');
  write(r, 'pyproject.toml', '[project]\nname = "svc"\ndependencies = ["fastapi", "pytest"]\n');
  write(r, 'uv.lock', '');
  write(r, 'alembic.ini', '[alembic]\n');
  write(r, 'app/main.py', 'print(1)\n');
  commit(r, 'init');
  const s = scan(r);
  assert.equal(s.kind, 'new');
  assert.equal(s.stack[0].language, 'python');
  assert.equal(s.stack[0].package_manager, 'uv');
  assert.equal(s.proposed.commands.install.value, 'uv sync');
  assert.equal(s.proposed.commands.test.value, 'pytest -q');
  assert.equal(s.proposed.commands.test.tier, 'default');
  assert.equal(s.proposed.commands.migrate_up.value, 'alembic upgrade head');
  assert.equal(s.proposed.commands.migrate_down.value, 'alembic downgrade -1');
  assert.ok(s.proposed.roles.active.includes('backend-engineer'));
  assert.ok(!s.proposed.roles.active.includes('frontend-engineer'));
  assert.equal(s.proposed.gates.G3.enabled, false);
  assert.equal(s.proposed.delivery.mode, 'local');
  assert.equal(s.proposed.tracker.recommend, 'none');
});

test('scan of a folder with no commits or no git', () => {
  const empty = tmpDir('empty');
  git(empty, 'init', '-q', '-b', 'main');
  const s = scan(empty);
  assert.equal(s.kind, 'new');
  assert.equal(s.git.commit_count, 0);
  assert.equal(s.scan_rev, null);

  const plain = tmpDir('plain');
  write(plain, 'notes.txt', 'hi');
  const p = scan(plain);
  assert.equal(p.git.is_repo, false);
  assert.equal(p.kind, 'new');
});

test('root .sln drives dotnet defaults', () => {
  const r = tmpDir('sln');
  git(r, 'init', '-q', '-b', 'main');
  write(r, 'App.sln', '');
  write(r, 'src/Api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>');
  commit(r, 'init');
  const c = scan(r).proposed.commands;
  assert.equal(c.build.value, 'dotnet build');
  assert.equal(c.test.value, 'dotnet test');
  assert.equal(c.build.source, 'App.sln (default for dotnet)');
});

test('CLI writes scan.json and prints a short summary', () => {
  const r = appFixture();
  const out = path.join(r, '.factory', 'setup', 'scan.json');
  const res = spawnSync(process.execPath, [SCRIPT, '--root', r], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(out));
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(s.kind, 'existing');
  assert.ok(!fs.readFileSync(out, 'utf8').includes(CANARY));
  assert.ok(res.stdout.trim().split('\n').length <= 10);
  assert.match(res.stdout, /^SCAN existing repo/);

  const bad = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('stamp and check detect user edits outside Local notes', () => {
  const d = tmpDir('hash');
  const f = path.join(d, 'backend-engineer.md');
  fs.writeFileSync(f, '---\nrole: backend-engineer\ngenerated_hash: pending\n---\n# Overlay\n\n- rule one\n\n## Local notes\n\n');
  assert.equal(checkFile(f), 'EDITED');
  const h = stampFile(f);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(checkFile(f), 'UNCHANGED');
  assert.match(fs.readFileSync(f, 'utf8'), /^---\nrole: backend-engineer\ngenerated_hash: sha256:/);

  // CRLF and trailing spaces are not edits.
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n').replace('- rule one', '- rule one   '));
  assert.equal(checkFile(f), 'UNCHANGED');

  // Local notes belong to the user.
  fs.appendFileSync(f, 'my own note\r\n');
  assert.equal(checkFile(f), 'UNCHANGED');

  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('rule one', 'rule two'));
  assert.equal(checkFile(f), 'EDITED');

  const plain = path.join(d, 'plain.md');
  fs.writeFileSync(plain, '# no front matter\n');
  assert.equal(checkFile(plain), 'NO_HASH');
  assert.equal(checkFile(path.join(d, 'missing.md')), 'MISSING');
  assert.equal(bodyHash('---\na: 1\n---\nx\n'), bodyHash('x'));

  const res = spawnSync(process.execPath, [SCRIPT, '--check', f], { encoding: 'utf8' });
  assert.equal(res.stdout.trim(), 'EDITED');
  const bad = spawnSync(process.execPath, [SCRIPT, '--stamp', plain], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
