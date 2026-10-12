// Check runner for software-factory (Team DELIVERY).
// Re-runs checks.pre_review at a SHA in a CLI-managed detached worktree and records `source: cli` evidence.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { slugify, normPath } from './git.mjs';
import { addDetached, remove } from './worktree.mjs';
import * as evidence from './evidence.mjs';

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 50 * 2 ** i;
      while (Date.now() < until) { /* short backoff */ }
    }
  }
}

export function resultPath(home, runId) {
  return path.join(home, 'run', 'checks', `${runId}.json`);
}

/** Spawn `node <cliPath> checks run --run <runId> --home <home>` detached. Returns the pid. */
export function spawnDetached({ cliPath, home, runId } = {}) {
  const child = spawn(process.execPath, [cliPath, 'checks', 'run', '--run', runId, '--home', home], {
    cwd: path.dirname(path.resolve(home)),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function copyIncludes(repoRoot, dir, includeFiles) {
  for (const rel of includeFiles || []) {
    if (!rel || path.isAbsolute(rel) || String(rel).split(/[\\/]/).includes('..')) continue;
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}

/**
 * Run `commands` sequentially at `sha` in `<home>/worktrees/checks-<runId>`; stop at the first failure.
 * Writes evidence under `runDir` and the result to `<home>/run/checks/<runId>.json`.
 * @returns {{status:'pass'|'fail', failed_command:string|null, evidence:object[], error?:string}}
 */
export function runChecks({ repoRoot, home, runId, runDir, sha, commands = [], includeFiles = [], timeoutMs } = {}) {
  const dir = path.join(home, 'worktrees', `checks-${runId}`);
  const started_at = new Date().toISOString();
  const result = { status: 'pass', failed_command: null, evidence: [] };
  let wtDir = null;
  try {
    wtDir = addDetached({ repoRoot, dir, sha });
    copyIncludes(repoRoot, wtDir, includeFiles);
    for (const command of commands.filter(Boolean)) {
      const entry = evidence.run({
        runDir,
        label: `check-${slugify(command, 24) || 'cmd'}`,
        command,
        cwd: wtDir,
        source: 'cli',
        headSha: sha,
        timeoutMs,
      });
      result.evidence.push(entry);
      if (entry.exit_code !== 0) {
        result.status = 'fail';
        result.failed_command = command;
        break;
      }
    }
  } catch (e) {
    result.status = 'fail';
    result.error = String(e.message || e);
  } finally {
    if (wtDir) {
      try {
        remove({ repoRoot, dir: wtDir });
      } catch {
        // best effort; `worktree prune` cleans up later
      }
    }
  }
  writeJsonAtomic(resultPath(home, runId), {
    run_id: runId,
    status: result.status,
    failed_command: result.failed_command,
    error: result.error || null,
    sha,
    evidence: result.evidence.map((e) => e.id),
    worktree: wtDir ? normPath(wtDir) : null,
    started_at,
    finished_at: new Date().toISOString(),
  });
  return result;
}

/** @returns {{status, failed_command, finished_at, ...}|null} */
export function readResult(home, runId) {
  try {
    return JSON.parse(fs.readFileSync(resultPath(home, runId), 'utf8'));
  } catch {
    return null;
  }
}
