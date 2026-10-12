#!/usr/bin/env node
// Deterministic repo scanner for /software-factory:setup.
// Collects facts, never judgement. Never reads secrets. Node >= 20, built-ins only.
//
// Usage: node scan-repo.mjs [--root <dir>] [--out <file>] [--stdout] [--new]
//        node scan-repo.mjs --stamp <file.md>   set generated_hash in the front matter
//        node scan-repo.mjs --check <file.md>   print UNCHANGED | EDITED | NO_HASH | MISSING
// Default out: <root>/.factory/setup/scan.json

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_PATHS = 5000;
export const MAX_BYTES = 64 * 1024;
export const SKIP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'dist', 'build', '.git', 'vendor', '.venv', 'venv', 'target',
  '.factory', '.claude', '.next', '.nuxt', '.angular', 'coverage', '__pycache__', '.gradle', '.idea', '.vs',
]);
export const ROLES = [
  'cto', 'product-manager', 'project-manager', 'staff-engineer', 'ui-ux-designer', 'data-engineer',
  'backend-engineer', 'frontend-engineer', 'devops-release', 'qa-engineer', 'code-reviewer',
  'security-reviewer', 'critic', 'tech-writer',
];
export const REQUIRED_ROLES = [
  'cto', 'product-manager', 'project-manager', 'staff-engineer', 'devops-release', 'qa-engineer',
  'code-reviewer', 'security-reviewer', 'critic', 'tech-writer',
];
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.cs', '.razor', '.cshtml', '.py',
  '.go', '.rs', '.java', '.kt', '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.fs', '.scala',
]);
const KEY_FALSE_POSITIVES = new Set(['UTF', 'SHA', 'ISO', 'CVE', 'RFC', 'HTTP', 'TLS', 'SSL', 'GPT', 'ES', 'PEP', 'WCAG', 'AES', 'RSA', 'X', 'MD', 'IE', 'V']);

// ---------- secret guard ----------

/** True when a path must never be opened. Only names are inspected. */
export function isSecretPath(rel) {
  const base = path.posix.basename(rel.replace(/\\/g, '/')).toLowerCase();
  if (base.startsWith('.env')) return !(base.endsWith('.example') || base.endsWith('.sample') || base.endsWith('.template'));
  if (/\.(pem|key|pfx|p12|jks|keystore|crt|cer)$/.test(base)) return true;
  if (/^secrets?\./.test(base) || base === 'secrets') return true;
  if (/^appsettings\..+\.json$/.test(base)) return true; // per-environment values
  if (base === 'appsettings.json') return true; // values may hold connection strings; never opened
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc' || base === 'credentials' || base === 'credentials.json') return true;
  if (base.endsWith('.tfvars') || base.endsWith('.tfstate')) return true;
  return false;
}

function safeRead(root, rel) {
  if (isSecretPath(rel)) return null;
  const abs = path.join(root, rel);
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readJsonSafe(root, rel) {
  const t = safeRead(root, rel);
  if (t == null) return null;
  try { return JSON.parse(t.replace(/^﻿/, '')); } catch { return null; }
}

// ---------- git ----------

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch { return null; }
}

export function parseRemote(url) {
  if (!url) return null;
  const az = url.match(/dev\.azure\.com[/:](?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/]+?)(?:\.git)?\/?$/);
  if (az) return { provider: 'azure', owner: `${az[1]}/${az[2]}`, repo: az[3], url };
  const m =url.match(/^(?:https?:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    || url.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return { provider: 'other', owner: '', repo: '', url };
  const host = m[1].toLowerCase();
  const provider = host.includes('github') ? 'github' : host.includes('gitlab') ? 'gitlab'
    : host.includes('bitbucket') ? 'bitbucket' : (host.includes('dev.azure.com') || host.includes('visualstudio.com')) ? 'azure' : 'other';
  return { provider, owner: m[2], repo: m[3], url };
}

function scanGit(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!inside) return { is_repo: false, head: null, commit_count: 0, default_branch: null, current_branch: null, remotes: [], remote: null, tracked_source_files: 0, tracked: null };
  const head = git(root, ['rev-parse', 'HEAD']);
  const count = head ? Number(git(root, ['rev-list', '--count', 'HEAD']) || 0) : 0;
  const current = head ? git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) : git(root, ['symbolic-ref', '--short', 'HEAD']);
  const remotes = [];
  for (const line of (git(root, ['remote', '-v']) || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m) remotes.push({ name: m[1], url: redactUrl(m[2]) });
  }
  const origin = remotes.find((r) => r.name === 'origin') || remotes[0] || null;
  let def = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  def = def ? def.replace(/^origin\//, '') : null;
  let defSource = def ? 'git symbolic-ref refs/remotes/origin/HEAD' : null;
  if (!def) {
    for (const b of ['main', 'master']) {
      if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) { def = b; defSource = `local branch ${b}`; break; }
    }
  }
  if (!def && current && current !== 'HEAD') { def = current; defSource = 'current branch'; }
  const tracked = (git(root, ['ls-files']) || '').split(/\r?\n/).filter(Boolean);
  const trackedSource = tracked.filter((f) => SOURCE_EXT.has(path.extname(f).toLowerCase())).length;
  return {
    is_repo: true, head, commit_count: count, default_branch: def || 'main', default_branch_source: defSource || 'fallback',
    current_branch: current, remotes, remote: origin ? { name: origin.name, ...parseRemote(origin.url) } : null,
    tracked_source_files: trackedSource, tracked: new Set(tracked),
  };
}

function redactUrl(u) { return u.replace(/\/\/[^@/]+@/, '//'); } // drop embedded credentials

const BRANCH_WORDS = new Set(['FEATURE', 'FEAT', 'RELEASE', 'HOTFIX', 'BUGFIX', 'FIX', 'ISSUE', 'PR', 'AGENT', 'WORKTREE', 'TASK', 'CHORE', 'DEPENDABOT', 'RENOVATE', 'T', 'E', 'G', 'R']);

/** Count tracker keys in commit text (upper case only) and branch names (any case). */
export function trackerHints(text, branches = []) {
  const counts = new Map();
  const examples = new Map();
  const bump = (prefix, key) => {
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
    if (!examples.has(prefix)) examples.set(prefix, key);
  };
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g)) {
    if (!KEY_FALSE_POSITIVES.has(m[1])) bump(m[1], m[0]);
  }
  for (const b of branches) {
    for (const part of b.split('/')) {
      const m = part.match(/^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?:\b|[-_])/);
      if (!m) continue;
      const prefix = m[1].toUpperCase();
      if (!KEY_FALSE_POSITIVES.has(prefix) && !BRANCH_WORDS.has(prefix)) bump(prefix, `${prefix}-${m[2]}`);
    }
  }
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([prefix, count]) => ({ prefix, count, example: examples.get(prefix) }));
  const github_refs = (text.match(/(^|[\s(])#\d+\b/gm) || []).length;
  return { keys, github_refs };
}

// ---------- file walk ----------

export function walk(root) {
  const out = [];
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        if (out.length >= MAX_PATHS) { truncated = true; break; }
        out.push(rel);
      }
    }
    if (truncated) break;
  }
  out.sort();
  return { files: out, truncated };
}

// ---------- detectors ----------

const NODE_FRAMEWORKS = [
  ['@angular/core', 'angular'], ['next', 'next'], ['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'],
  ['@nestjs/core', 'nestjs'], ['express', 'express'], ['fastify', 'fastify'], ['electron', 'electron'],
  ['vite', 'vite'], ['primeng', 'primeng'], ['@playwright/test', 'playwright'], ['cypress', 'cypress'],
  ['jest', 'jest'], ['vitest', 'vitest'], ['prisma', 'prisma'],
];

function major(v) { const m = String(v || '').match(/(\d+)/); return m ? m[1] : null; }

function nodePm(dirFiles) {
  if (dirFiles.has('pnpm-lock.yaml')) return 'pnpm';
  if (dirFiles.has('yarn.lock')) return 'yarn';
  if (dirFiles.has('bun.lockb') || dirFiles.has('bun.lock')) return 'bun';
  if (dirFiles.has('package-lock.json')) return 'npm';
  return null;
}

export function detectStack(root, files) {
  const byDir = new Map();
  for (const f of files) {
    const d = path.posix.dirname(f);
    if (!byDir.has(d)) byDir.set(d, new Set());
    byDir.get(d).add(path.posix.basename(f));
  }
  const rootFiles = byDir.get('.') || new Set();
  const stack = [];
  const add = (entry, evidence) => { entry.evidence = evidence; stack.push(entry); };

  for (const f of files) {
    const dir = path.posix.dirname(f);
    const base = path.posix.basename(f);
    const dirFiles = byDir.get(dir) || new Set();
    if (base === 'package.json') {
      const pkg = readJsonSafe(root, f);
      if (!pkg) continue;
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const frameworks = [];
      for (const [dep, name] of NODE_FRAMEWORKS) if (deps[dep]) frameworks.push(major(deps[dep]) && ['angular', 'next', 'react', 'vue', 'nestjs'].includes(name) ? `${name}@${major(deps[dep])}` : name);
      const ts = deps.typescript || dirFiles.has('tsconfig.json');
      add({
        path: dir, language: ts ? 'typescript' : 'javascript', frameworks,
        package_manager: nodePm(dirFiles) || nodePm(rootFiles) || 'npm',
        scripts: Object.keys(pkg.scripts || {}).sort(), name: pkg.name || null,
      }, f);
    } else if (base.endsWith('.csproj') || base.endsWith('.fsproj')) {
      const t = safeRead(root, f) || '';
      const frameworks = [];
      const tf = t.match(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/);
      if (/Sdk="Microsoft\.NET\.Sdk\.Web"/.test(t) || /Microsoft\.AspNetCore/.test(t)) frameworks.push(tf ? `aspnetcore@${tf[1].split(';')[0]}` : 'aspnetcore');
      if (/EntityFrameworkCore/.test(t)) frameworks.push('efcore');
      if (/Npgsql/.test(t)) frameworks.push('postgres');
      if (/EntityFrameworkCore\.SqlServer|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient/.test(t)) frameworks.push('sqlserver');
      if (/Sqlite/.test(t)) frameworks.push('sqlite');
      if (/MySql|Pomelo/.test(t)) frameworks.push('mysql');
      if (/Include="xunit/i.test(t)) frameworks.push('xunit');
      if (/Include="NUnit/i.test(t)) frameworks.push('nunit');
      if (/Include="MSTest/i.test(t)) frameworks.push('mstest');
      if (/Microsoft\.Azure\.Functions|Microsoft\.NET\.Sdk\.Functions/.test(t)) frameworks.push('azure-functions');
      if (/Microsoft\.AspNetCore\.Components|Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"/.test(t)) frameworks.push('blazor');
      add({ path: dir, language: base.endsWith('.fsproj') ? 'fsharp' : 'csharp', frameworks, package_manager: 'dotnet', target_framework: tf ? tf[1] : null, project: base }, f);
    } else if (base === 'pyproject.toml' || (/^requirements.*\.txt$/.test(base) && !dirFiles.has('pyproject.toml')
      && base === [...dirFiles].filter((n) => /^requirements.*\.txt$/.test(n)).sort()[0])) {
      const t = safeRead(root, f) || '';
      const frameworks = ['django', 'flask', 'fastapi', 'pytest', 'sqlalchemy', 'alembic', 'pydantic'].filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(t));
      const pm = dirFiles.has('uv.lock') ? 'uv' : dirFiles.has('poetry.lock') || /\[tool\.poetry\]/.test(t) ? 'poetry' : 'pip';
      add({ path: dir, language: 'python', frameworks, package_manager: pm }, f);
    } else if (base === 'go.mod') {
      const t = safeRead(root, f) || '';
      const frameworks = [['gin-gonic/gin', 'gin'], ['labstack/echo', 'echo'], ['gofiber/fiber', 'fiber'], ['go-chi/chi', 'chi']].filter(([k]) => t.includes(k)).map(([, n]) => n);
      add({ path: dir, language: 'go', frameworks, package_manager: 'go', module: (t.match(/^module\s+(\S+)/m) || [])[1] || null }, f);
    } else if (base === 'Cargo.toml') {
      const t = safeRead(root, f) || '';
      const frameworks = ['axum', 'actix-web', 'tokio', 'rocket', 'diesel', 'sqlx'].filter((n) => new RegExp(`^\\s*${n}\\s*=`, 'm').test(t));
      add({ path: dir, language: 'rust', frameworks, package_manager: 'cargo' }, f);
    } else if (base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts') {
      const t = safeRead(root, f) || '';
      const frameworks = /spring-boot/.test(t) ? ['spring-boot'] : [];
      add({ path: dir, language: base.endsWith('.kts') || /kotlin/.test(t) ? 'kotlin' : 'java', frameworks, package_manager: base === 'pom.xml' ? 'maven' : 'gradle' }, f);
    } else if (base === 'Gemfile') {
      const t = safeRead(root, f) || '';
      add({ path: dir, language: 'ruby', frameworks: /['"]rails['"]/.test(t) ? ['rails'] : [], package_manager: 'bundler' }, f);
    } else if (base === 'composer.json') {
      const c = readJsonSafe(root, f) || {};
      const req = { ...(c.require || {}), ...(c['require-dev'] || {}) };
      const frameworks = [['laravel/framework', 'laravel'], ['symfony/framework-bundle', 'symfony'], ['phpunit/phpunit', 'phpunit']].filter(([k]) => req[k]).map(([, n]) => n);
      add({ path: dir, language: 'php', frameworks, package_manager: 'composer' }, f);
    }
  }
  stack.sort((a, b) => (a.path === b.path ? a.evidence.localeCompare(b.evidence) : a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)));
  return stack.slice(0, 40);
}

export function detectMonorepo(root, files, stack) {
  const has = (f) => files.includes(f);
  const pkg = has('package.json') ? readJsonSafe(root, 'package.json') : null;
  let tool = null; let evidence = null;
  if (has('nx.json')) { tool = 'nx'; evidence = 'nx.json'; }
  else if (has('turbo.json')) { tool = 'turbo'; evidence = 'turbo.json'; }
  else if (has('lerna.json')) { tool = 'lerna'; evidence = 'lerna.json'; }
  else if (has('pnpm-workspace.yaml')) { tool = 'pnpm-workspaces'; evidence = 'pnpm-workspace.yaml'; }
  else if (pkg && pkg.workspaces) { tool = 'npm-workspaces'; evidence = 'package.json workspaces'; }
  else if (has('go.work')) { tool = 'go-work'; evidence = 'go.work'; }
  else if (files.filter((f) => f.endsWith('.sln')).length > 1) { tool = 'dotnet-multi-sln'; evidence = files.filter((f) => f.endsWith('.sln')).join(', '); }
  const packages = [...new Set(stack.map((s) => s.path).filter((p) => p !== '.'))];
  if (!tool && new Set(stack.map((s) => s.language)).size > 1 && packages.length > 1) { tool = 'polyglot'; evidence = 'several manifests'; }
  return { tool, evidence, packages: tool ? packages : [] };
}

/** Parse CI files for run/script steps. Returns [{file, provider, steps: [{line, run}]}]. */
export function parseCi(root, files) {
  const ciFiles = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)
    || ['azure-pipelines.yml', '.gitlab-ci.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.circleci/config.yml'].includes(f));
  const out = [];
  for (const f of ciFiles) {
    const t = safeRead(root, f);
    if (t == null) continue;
    const provider = f.startsWith('.github/') ? 'github-actions' : f === 'azure-pipelines.yml' ? 'azure-pipelines'
      : f === '.gitlab-ci.yml' ? 'gitlab-ci' : f === 'Jenkinsfile' ? 'jenkins' : f.startsWith('.circleci') ? 'circleci' : 'bitbucket';
    const steps = [];
    const lines = t.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (provider === 'jenkins') {
        const m = line.match(/\b(?:sh|bat|pwsh|powershell)\s*\(?\s*['"]([^'"]+)['"]/);
        if (m) steps.push({ line: i + 1, run: m[1].trim() });
        continue;
      }
      const m = line.match(/^(\s*)(?:-\s+)?(run|script|bash|pwsh|powershell|command):\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      let val = m[3].trim();
      if (/^\$\{\{/.test(val)) continue;
      if (val === '|' || val === '>' || val === '|-' || val === '>-' || val === '') {
        // block scalar or list (gitlab script:)
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) continue;
          const ind = l.match(/^(\s*)/)[1].length;
          if (ind <= indent && !/^\s*-\s/.test(l)) break;
          if (ind < indent) break;
          let cmd = l.trim().replace(/^-\s+/, '');
          if (/^[a-z_-]+:\s/.test(cmd) && ind <= indent + 2 && !val) break;
          cmd = cmd.replace(/^['"]|['"]$/g, '');
          if (cmd && !cmd.startsWith('#')) steps.push({ line: j + 1, run: cmd });
        }
      } else {
        val = val.replace(/^['"]|['"]$/g, '');
        if (val && !val.startsWith('#')) steps.push({ line: i + 1, run: val });
      }
    }
    out.push({ file: f, provider, steps: steps.slice(0, 80) });
  }
  return out;
}

const COMMAND_KINDS = ['install', 'build', 'test', 'lint', 'typecheck', 'run', 'e2e', 'migrate_up', 'migrate_down', 'screenshot'];

/** Classify one shell command into a commands.* slot, or null. */
export function classifyCommand(cmd) {
  const c = cmd.trim();
  if (/^(echo|cd|export|set|mkdir|cp|mv|rm|ls|cat|curl|wget|chmod|sudo apt|apt-get|choco|brew)\b/.test(c)) return null;
  if (/\b(docker|kubectl|helm|terraform|az |aws |gcloud|gh )\b/.test(c)) return null;
  if (/(\s-g\b|--global\b|\bnpx playwright install)/.test(c)) return null; // tool installs, not project deps
  if (/\bpip install\b/.test(c) && !/(-r\s|-e\s|install\s+\.(\s|$))/.test(c)) return null;
  if (/\b(npm ci|npm install|pnpm install|yarn install|bun install|dotnet restore|pip install|poetry install|uv sync|go mod download|bundle install|composer install|cargo fetch)\b/.test(c) || /^yarn$/.test(c)) return 'install';
  if (/\b(playwright test|cypress run|e2e)\b/.test(c)) return 'e2e';
  if (/\b(typecheck|type-check|tsc --noEmit|tsc -p .*--noEmit|mypy|pyright)\b/.test(c)) return 'typecheck';
  if (/\b(lint|eslint|ruff check|ruff|flake8|pylint|golangci-lint|dotnet format|prettier --check|clippy|rubocop|stylelint)\b/.test(c)) return 'lint';
  if (/\b(test|pytest|jest|vitest|mocha|go test|cargo test|dotnet test|phpunit|rspec)\b/.test(c)) return 'test';
  if (/\b(build|tsc\b|go build|cargo build|dotnet build|mvn package|gradle build|webpack|vite build)\b/.test(c)) return 'build';
  return null;
}

export function pmRun(pm, script, dir = '.') {
  const sub = dir && dir !== '.';
  if (pm === 'npm') return `npm${sub ? ` --prefix ${dir}` : ''} ${script === 'test' || script === 'start' ? script : `run ${script}`}`;
  if (pm === 'pnpm') return `pnpm${sub ? ` -C ${dir}` : ''} ${script}`;
  if (pm === 'yarn') return `yarn${sub ? ` --cwd ${dir}` : ''} ${script}`;
  if (pm === 'bun') return `bun${sub ? ` --cwd ${dir}` : ''} run ${script}`;
  return `${pm} ${script}`;
}

function installFor(entry) {
  switch (entry.package_manager) {
    case 'npm': return 'npm ci';
    case 'pnpm': return 'pnpm install --frozen-lockfile';
    case 'yarn': return 'yarn install --frozen-lockfile';
    case 'bun': return 'bun install';
    case 'dotnet': return 'dotnet restore';
    case 'uv': return 'uv sync';
    case 'poetry': return 'poetry install';
    case 'pip': return 'pip install -r requirements.txt';
    case 'go': return 'go mod download';
    case 'cargo': return 'cargo fetch';
    case 'bundler': return 'bundle install';
    case 'composer': return 'composer install';
    default: return null;
  }
}

function frameworkDefaults(entry) {
  switch (entry.language) {
    case 'csharp': case 'fsharp': return { build: 'dotnet build', test: 'dotnet test' };
    case 'python': return entry.frameworks.includes('pytest') ? { test: 'pytest -q' } : {};
    case 'go': return { build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' };
    case 'rust': return { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' };
    case 'java': case 'kotlin': return entry.package_manager === 'maven' ? { build: 'mvn -q package -DskipTests', test: 'mvn -q test' } : { build: './gradlew build -x test', test: './gradlew test' };
    case 'ruby': return { test: 'bundle exec rspec' };
    case 'php': return { test: 'vendor/bin/phpunit' };
    default: return {};
  }
}

/** Propose commands with precedence CI > package scripts/Makefile > framework defaults. */
export function proposeCommands(root, files, stack, ci) {
  const out = Object.fromEntries(COMMAND_KINDS.map((k) => [k, null]));
  const set = (k, value, source, tier) => { if (!out[k] && value) out[k] = { value, source, tier }; };
  // 1. CI steps
  for (const file of ci) for (const s of file.steps) {
    const k = classifyCommand(s.run);
    if (k) set(k, s.run, `${file.file}:${s.line}`, 'ci');
  }
  // 2. package scripts (root first), Makefile, justfile
  const rootEntry = stack.find((s) => s.path === '.') || stack[0];
  const nodeRoot = stack.find((s) => s.path === '.' && s.scripts) || stack.find((s) => s.scripts);
  if (nodeRoot) {
    const ev = `${nodeRoot.path === '.' ? '' : nodeRoot.path + '/'}package.json`;
    const pm = nodeRoot.package_manager;
    const pick = (names) => names.find((n) => nodeRoot.scripts.includes(n));
    const map = { build: ['build'], test: ['test'], lint: ['lint'], typecheck: ['typecheck', 'type-check', 'tsc'], run: ['dev', 'start', 'serve'], e2e: ['e2e', 'test:e2e'] };
    for (const [k, names] of Object.entries(map)) {
      const n = pick(names);
      if (n) set(k, pmRun(pm, n, nodeRoot.path), `${ev} scripts.${n}`, 'scripts');
    }
  }
  for (const [mf, tool] of [['Makefile', 'make'], ['justfile', 'just'], ['Justfile', 'just']]) {
    if (!files.includes(mf)) continue;
    const t = safeRead(root, mf) || '';
    const lines = t.split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = l.match(/^([A-Za-z0-9_-]+)\s*:(?!=)/);
      if (!m) return;
      const target = m[1];
      const k = { build: 'build', test: 'test', lint: 'lint', typecheck: 'typecheck', run: 'run', dev: 'run', e2e: 'e2e', install: 'install', deps: 'install' }[target];
      if (k) set(k, `${tool} ${target}`, `${mf}:${i + 1}`, 'scripts');
    });
  }
  // 3. framework defaults
  // A manifest outside the root gets defaults only when the tool can target a folder.
  if (rootEntry && rootEntry.path !== '.') {
    const d = rootEntry.path;
    const nodeInstall = { npm: `npm ci --prefix ${d}`, pnpm: `pnpm -C ${d} install --frozen-lockfile`, yarn: `yarn --cwd ${d} install --frozen-lockfile`, bun: `bun --cwd ${d} install` }[rootEntry.package_manager];
    if (nodeInstall) set('install', nodeInstall, `${rootEntry.evidence} (default for ${rootEntry.package_manager})`, 'default');
    const rootSln = files.filter((f) => !f.includes('/') && f.endsWith('.sln'));
    if (rootEntry.package_manager === 'dotnet' && rootSln.length === 1) {
      for (const [k, v] of [['install', 'dotnet restore'], ['build', 'dotnet build'], ['test', 'dotnet test']]) set(k, v, `${rootSln[0]} (default for dotnet)`, 'default');
    } else if (rootEntry.package_manager === 'dotnet') {
      set('install', `dotnet restore ${d}`, `${rootEntry.evidence} (default for dotnet)`, 'default');
      set('build', `dotnet build ${d}`, `${rootEntry.evidence} (default for dotnet)`, 'default');
      set('test', `dotnet test ${d}`, `${rootEntry.evidence} (default for dotnet)`, 'default');
    }
  } else if (rootEntry) {
    set('install', installFor(rootEntry),`${rootEntry.evidence} (default for ${rootEntry.package_manager})`, 'default');
    for (const [k, v] of Object.entries(frameworkDefaults(rootEntry))) set(k, v, `${rootEntry.evidence} (default for ${rootEntry.language})`, 'default');
  }
  // 4. migrations and screenshots: package scripts first, then framework tools
  if (nodeRoot) {
    const ev = `${nodeRoot.path === '.' ? '' : nodeRoot.path + '/'}package.json`;
    const up = ['migrate:up', 'db:migrate', 'migrate'].find((n) => nodeRoot.scripts.includes(n));
    const down = ['migrate:down', 'db:rollback', 'migrate:rollback', 'db:migrate:undo'].find((n) => nodeRoot.scripts.includes(n));
    if (up) set('migrate_up', pmRun(nodeRoot.package_manager, up, nodeRoot.path), `${ev} scripts.${up}`, 'scripts');
    if (down) set('migrate_down', pmRun(nodeRoot.package_manager, down, nodeRoot.path), `${ev} scripts.${down}`, 'scripts');
  }
  for (const [k, v] of Object.entries(proposeMigrations(files, stack))) if (v) set(k, v.value, v.source, 'default');
  const pw = stack.find((s) => s.frameworks.includes('playwright'));
  if (pw) set('screenshot', 'npx playwright screenshot', `${pw.evidence} (@playwright/test)`, 'default');
  return out;
}

/** Framework migration tools. migrate_down stays null when the tool has no safe rollback. */
export function proposeMigrations(files, stack) {
  const has = (fw) => stack.find((s) => s.frameworks.some((f) => f.split('@')[0] === fw));
  const out = { migrate_up: null, migrate_down: null };
  const ef = has('efcore');
  const efMig = files.find((f) => /(^|\/)Migrations\/[^/]+\.cs$/.test(f));
  if (ef && efMig) {
    const proj = ef.path === '.' ? '' : ` --project ${ef.path}`;
    out.migrate_up = { value: `dotnet ef database update${proj}`, source: `${efMig} (EF Core)` };
    return out; // EF rollback = migrate_up with a target migration name
  }
  const prisma = has('prisma');
  const schema = files.find((f) => /(^|\/)prisma\/schema\.prisma$/.test(f));
  if (prisma && schema) {
    out.migrate_up = { value: 'npx prisma migrate deploy', source: `${schema} (Prisma)` };
    return out; // Prisma has no down migration
  }
  const alembic = files.find((f) => /(^|\/)alembic\.ini$/.test(f)) || (has('alembic') && files.find((f) => /(^|\/)alembic\//.test(f)));
  if (alembic) {
    out.migrate_up = { value: 'alembic upgrade head', source: `${alembic} (Alembic)` };
    out.migrate_down = { value: 'alembic downgrade -1', source: `${alembic} (Alembic)` };
    return out;
  }
  const manage = files.find((f) => /^manage\.py$/.test(f));
  if (manage && has('django')) {
    out.migrate_up = { value: 'python manage.py migrate', source: 'manage.py (Django)' };
    return out;
  }
  if (has('rails') && files.some((f) => f.startsWith('db/migrate/'))) {
    out.migrate_up = { value: 'bin/rails db:migrate', source: 'db/migrate/ (Rails)' };
    out.migrate_down = { value: 'bin/rails db:rollback', source: 'db/migrate/ (Rails)' };
    return out;
  }
  if (has('laravel') && files.some((f) => f.startsWith('database/migrations/'))) {
    out.migrate_up = { value: 'php artisan migrate', source: 'database/migrations/ (Laravel)' };
    out.migrate_down = { value: 'php artisan migrate:rollback', source: 'database/migrations/ (Laravel)' };
    return out;
  }
  const knex = files.find((f) => /(^|\/)knexfile\.[cm]?[jt]s$/.test(f));
  if (knex) {
    out.migrate_up = { value: 'npx knex migrate:latest', source: `${knex} (Knex)` };
    out.migrate_down = { value: 'npx knex migrate:rollback', source: `${knex} (Knex)` };
  }
  return out;
}

function lintConfigs(files) {
  const re = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?js|\.editorconfig|ruff\.toml|\.ruff\.toml|\.golangci\.ya?ml|stylecop\.json|\.globalconfig|\.stylelintrc(\.[a-z]+)?|\.rubocop\.yml|tslint\.json|biome\.json|\.flake8|setup\.cfg|mypy\.ini)$/;
  return files.filter((f) => re.test(f) && f.split('/').length <= 3).slice(0, 20);
}

function docs(root, files) {
  const agent = files.filter((f) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f) || f === '.github/copilot-instructions.md' || /^\.cursor\/rules\//.test(f) || f === '.cursorrules').slice(0, 20);
  const pick = (name) => files.find((f) => f.toLowerCase() === name.toLowerCase())
    || files.find((f) => f.toLowerCase() === `.github/${name}`.toLowerCase())
    || files.find((f) => f.toLowerCase() === `docs/${name}`.toLowerCase()) || null;
  const human = { readme: pick('README.md'), contributing: pick('CONTRIBUTING.md'), security: pick('SECURITY.md'), roadmap: pick('ROADMAP.md'), changelog: pick('CHANGELOG.md') };
  const adrDir = ['docs/adr', 'docs/adrs', 'docs/decisions', 'doc/adr', 'adr', 'architecture/decisions', 'docs/architecture/decisions']
    .find((d) => files.some((f) => f.startsWith(d + '/')));
  const adrs = adrDir ? files.filter((f) => f.startsWith(adrDir + '/') && f.endsWith('.md')).slice(0, 30).map((f) => {
    const t = safeRead(root, f) || '';
    const h = t.match(/^#\s+(.+)$/m);
    return { path: f, title: h ? h[1].trim().slice(0, 120) : path.posix.basename(f, '.md') };
  }) : [];
  return { agent, human, adr_dir: adrDir || null, adrs };
}

function codeowners(root, files) {
  const f = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((p) => files.includes(p));
  if (!f) return null;
  const rules = [];
  const owners = new Set();
  for (const line of (safeRead(root, f) || '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const [pattern, ...rest] = l.split(/\s+/);
    const os = rest.filter((o) => o.startsWith('@') || o.includes('@'));
    os.forEach((o) => owners.add(o));
    rules.push({ pattern, owners: os });
  }
  return { path: f, owners: [...owners].sort(), rules: rules.slice(0, 50) };
}

function signals(files, stack) {
  const fw = new Set(stack.flatMap((s) => s.frameworks.map((x) => x.split('@')[0])));
  const ev = (pred, limit = 5) => files.filter(pred).slice(0, limit);
  const ui = [
    ...ev((f) => /\.component\.ts$/.test(f)), ...ev((f) => /\.(tsx|jsx|vue|svelte|razor|cshtml)$/.test(f)),
    ...ev((f) => /(^|\/)pages\//.test(f) && /\.(tsx?|jsx?|vue|html)$/.test(f)),
  ];
  const uiFw = ['angular', 'react', 'vue', 'svelte', 'next', 'blazor'].filter((x) => fw.has(x));
  const migrations = ev((f) => /(^|\/)(Migrations|migrations|alembic|db\/migrate|flyway)\//.test(f) || /(^|\/)prisma\/schema\.prisma$/.test(f) || /(^|\/)dbt_project\.yml$/.test(f));
  const iac = ev((f) => /\.(tf|bicep)$/.test(f) || /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Chart\.yaml|serverless\.ya?ml|cdk\.json|Pulumi\.ya?ml)$/.test(f) || /(^|\/)(helm|k8s|kubernetes)\//.test(f));
  const e2e = ev((f) => /(^|\/)(playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|cypress\.json)$/.test(f));
  const backendFw = ['express', 'nestjs', 'fastify', 'aspnetcore', 'django', 'flask', 'fastapi', 'gin', 'echo', 'fiber', 'chi', 'axum', 'actix-web', 'rocket', 'spring-boot', 'rails', 'laravel', 'symfony', 'azure-functions'].filter((x) => fw.has(x));
  const backendLang = stack.some((s) => ['csharp', 'fsharp', 'python', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php'].includes(s.language));
  return {
    ui: { found: ui.length > 0 || uiFw.length > 0, frameworks: uiFw, evidence: [...new Set(ui)].slice(0, 5) },
    backend: { found: backendFw.length > 0 || backendLang, frameworks: backendFw },
    migrations: { found: migrations.length > 0, evidence: migrations },
    iac: { found: iac.length > 0, evidence: iac },
    e2e: { found: e2e.length > 0, evidence: e2e },
  };
}

function envInfo(root, files, tracked) {
  const examples = files.filter((f) => /(^|\/)\.env\.(example|sample|template)$/.test(f)).slice(0, 10);
  const dotenvs = files.filter((f) => /(^|\/)\.env$/.test(f));
  let ignored = false;
  if (dotenvs.length) ignored = git(root, ['check-ignore', '-q', '--', dotenvs[0]]) !== null;
  const trackedEnv = tracked ? [...tracked].filter((f) => isSecretPath(f) && /(^|\/)\.env/.test(f)) : [];
  // Names only. Contents of .env files are never opened.
  return { example_files: examples, dotenv_present: dotenvs.length > 0, dotenv_gitignored: dotenvs.length > 0 && ignored, tracked_secret_like_files: trackedEnv.slice(0, 10) };
}

function proposeRoles(sig) {
  const active = [...REQUIRED_ROLES];
  const reasons = {};
  if (sig.ui.found) {
    active.push('frontend-engineer', 'ui-ux-designer');
    reasons['frontend-engineer'] = reasons['ui-ux-designer'] = `UI detected (${[...sig.ui.frameworks, ...sig.ui.evidence].slice(0, 2).join(', ')})`;
  }
  if (sig.backend.found || !sig.ui.found) {
    active.push('backend-engineer');
    reasons['backend-engineer'] = sig.backend.found ? `backend detected (${sig.backend.frameworks.slice(0, 2).join(', ') || 'server language'})` : 'default builder (no UI found)';
  }
  if (sig.migrations.found) { active.push('data-engineer'); reasons['data-engineer'] = `migrations detected (${sig.migrations.evidence[0]})`; }
  const ordered = ROLES.filter((r) => active.includes(r));
  return { active: ordered, inactive: ROLES.filter((r) => !ordered.includes(r)), required: REQUIRED_ROLES, reasons };
}

function proposeTracker(hints, remote) {
  const top = hints.keys[0];
  if (top && top.count >= 3) {
    return { recommend: 'keyed', candidates: ['linear', 'jira'], team_key: top.prefix, evidence: `${top.example}-style keys seen ${top.count} times in the last 500 commits and branch names` };
  }
  if (remote && remote.provider === 'github' && hints.github_refs >= 3) {
    return { recommend: 'github', candidates: ['github'], team_key: null, evidence: `#refs seen ${hints.github_refs} times and the remote is GitHub` };
  }
  return { recommend: 'none', candidates: [], team_key: null, evidence: 'no tracker keys found in history' };
}

// ---------- main scan ----------

export function scan(root, { forceNew = false, now = new Date() } = {}) {
  root = path.resolve(root);
  const g = scanGit(root);
  const { files, truncated } = walk(root);
  let historyText = '';
  let branches = [];
  if (g.is_repo && g.head) {
    historyText = git(root, ['log', '-500', '--format=%s%n%b']) || '';
    branches = (git(root, ['branch', '-a', '--format=%(refname:short)']) || '').split(/\r?\n/).filter(Boolean);
  }
  const hints = trackerHints(historyText, branches);
  const stack = detectStack(root, files);
  const monorepo = detectMonorepo(root, files, stack);
  const ci = parseCi(root, files);
  const commands = proposeCommands(root, files, stack, ci);
  const sig = signals(files, stack);
  const d = docs(root, files);
  const owners = codeowners(root, files);
  const env = envInfo(root, files, g.tracked);
  const prTemplate = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md'].find((f) => files.includes(f)) || null;
  const secretsSkipped = files.filter(isSecretPath).length;
  const isNew = forceNew || !g.is_repo || g.commit_count === 0 || g.tracked_source_files < 10;
  const roles = proposeRoles(sig);
  const pkgName = stack.find((s) => s.path === '.' && s.name)?.name;
  const name = (g.remote && g.remote.repo) || pkgName || path.basename(root);
  const remote = g.remote && g.remote.provider !== 'other' ? { provider: g.remote.provider, owner: g.remote.owner, repo: g.remote.repo } : null;
  const lint = lintConfigs(files);

  return {
    schema: 'factory/scan@1',
    scanned_at: now.toISOString(),
    root: root.replace(/\\/g, '/'),
    scan_rev: g.head,
    kind: isNew ? 'new' : 'existing',
    files_seen: files.length,
    truncated,
    secret_like_files_skipped: secretsSkipped,
    git: {
      is_repo: g.is_repo, head: g.head, commit_count: g.commit_count, current_branch: g.current_branch,
      default_branch: g.default_branch, default_branch_source: g.default_branch_source || null,
      remotes: g.remotes, remote: g.remote, tracked_source_files: g.tracked_source_files,
    },
    tracker_hints: hints,
    stack,
    monorepo,
    ci,
    lint,
    docs: d,
    codeowners: owners,
    pr_template: prTemplate,
    signals: sig,
    env,
    proposed: {
      project: {
        value: { name, kind: isNew ? 'new' : 'existing', default_branch: g.default_branch || 'main', remote: remote || { provider: 'none', owner: '', repo: '' } },
        source: g.remote ? `git remote ${g.remote.name}` : 'no remote',
      },
      stack: stack.map((s) => ({ path: s.path, language: s.language, frameworks: s.frameworks, package_manager: s.package_manager, source: s.evidence })),
      commands,
      roles,
      gates: {
        G1: { enabled: true, reason: 'default' },
        G2: { enabled: true, reason: 'default' },
        G3: { enabled: sig.ui.found, reason: sig.ui.found ? 'UI detected' : 'no UI detected' },
        G4: { enabled: true, reason: 'default' },
      },
      delivery: { mode: remote && remote.provider === 'github' ? 'github' : 'local', base_branch: g.default_branch || 'main', remote: g.remote ? g.remote.name : 'origin', source: remote ? `remote ${remote.provider}` : 'no GitHub remote' },
      tracker: proposeTracker(hints, g.remote),
      constitution_sources: [...d.agent, d.human.contributing, d.human.security, ...lint].filter(Boolean).slice(0, 20),
      worktree_include: env.dotenv_present && env.dotenv_gitignored && env.example_files.length ? { value: ['.env'], source: `${env.example_files[0]} present and .env is gitignored`, ask: true } : null,
      approver_candidates: owners ? owners.owners.slice(0, 10) : [],
    },
  };
}

export function summarize(s) {
  const c = s.proposed.commands;
  const cmd = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${k}=${v.value}`).join('; ');
  return [
    `SCAN ${s.kind} repo, ${s.files_seen} files${s.truncated ? ' (truncated)' : ''}, ${s.secret_like_files_skipped} secret-like files not opened`,
    `stack: ${s.stack.map((x) => `${x.path}:${x.language}${x.frameworks.length ? '(' + x.frameworks.slice(0, 3).join(',') + ')' : ''}`).slice(0, 4).join(' ') || 'none'}`,
    `remote: ${s.git.remote ? `${s.git.remote.provider} ${s.git.remote.owner}/${s.git.remote.repo}` : 'none'}; default branch ${s.git.default_branch || 'n/a'}`,
    `ci: ${s.ci.map((x) => x.file).join(', ') || 'none'}`,
    `commands: ${cmd || 'none'}`,
    `roles: ${s.proposed.roles.active.length} proposed; G3 ${s.proposed.gates.G3.enabled ? 'on' : 'off'}`,
    `tracker: ${s.proposed.tracker.recommend}${s.proposed.tracker.team_key ? ' ' + s.proposed.tracker.team_key : ''}`,
  ].join('\n');
}

// ---------- generated-file hashes ----------
// The hash covers the body after the front matter, up to a "## Local notes" heading (that section
// belongs to the user and is never rewritten). Line endings and trailing spaces are normalized so
// git autocrlf does not count as an edit.

function splitFrontMatter(text) {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: m[1], body: t.slice(m[0].length) } : { fm: null, body: t };
}

export function bodyHash(text) {
  let { body } = splitFrontMatter(text);
  const cut = body.search(/^## Local notes\s*$/m);
  if (cut >= 0) body = body.slice(0, cut);
  const norm = body.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
  return `sha256:${createHash('sha256').update(norm).digest('hex')}`;
}

/** Write generated_hash into the front matter of a generated file. Returns the hash. */
export function stampFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { fm, body } = splitFrontMatter(text);
  if (fm == null) throw new Error(`${file}: no front matter`);
  const hash = bodyHash(text);
  const lines = fm.split('\n').filter((l) => !/^generated_hash:/.test(l));
  lines.push(`generated_hash: ${hash}`);
  const out = `---\n${lines.join('\n')}\n---\n${body}`;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  return hash;
}

/** UNCHANGED when the body still matches generated_hash, EDITED when the user changed it. */
export function checkFile(file) {
  if (!fs.existsSync(file)) return 'MISSING';
  const text = fs.readFileSync(file, 'utf8');
  const { fm } = splitFrontMatter(text);
  const m = fm && fm.match(/^generated_hash:\s*(\S+)\s*$/m);
  if (!m) return 'NO_HASH';
  return m[1] === bodyHash(text) ? 'UNCHANGED' : 'EDITED';
}

function parseArgs(argv) {
  const a = { root: process.cwd(), out: null, stdout: false, forceNew: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--root') a.root = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--stdout') a.stdout = true;
    else if (v === '--new') a.forceNew = true;
    else if (v === '--stamp') a.stamp = argv[++i];
    else if (v === '--check') a.check = argv[++i];
    else if (v === '--help' || v === '-h') a.help = true;
    else { a.bad = v; }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || a.bad) {
    process.stderr.write(`${a.bad ? `unknown argument: ${a.bad}\n` : ''}usage: scan-repo.mjs [--root <dir>] [--out <file>] [--stdout] [--new] | --stamp <file.md> | --check <file.md>\n`);
    process.exit(a.bad ? 2 : 0);
  }
  try {
    if (a.stamp) { process.stdout.write(`${stampFile(a.stamp)}\n`); return; }
    if (a.check) { process.stdout.write(`${checkFile(a.check)}\n`); return; }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  const result = scan(a.root, { forceNew: a.forceNew });
  const json = JSON.stringify(result, null, 2) + '\n';
  if (a.stdout) { process.stdout.write(json); return; }
  const out = path.resolve(a.out || path.join(a.root, '.factory', 'setup', 'scan.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, out);
  process.stdout.write(`${summarize(result)}\nwrote ${out.replace(/\\/g, '/')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
