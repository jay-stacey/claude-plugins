// Evidence runner for software-factory (Team DELIVERY).
// Runs a user command string through the platform shell, writes the output to
// evidence/<label>-<n>.log and appends one line to evidence/index.jsonl.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { headSha as gitHead, toSlash } from './git.mjs';

const IS_WIN = process.platform === 'win32';

/** Spawn arguments for a user command string. */
export function shellSpawnArgs(command) {
  if (IS_WIN) {
    // Same form Node uses for `shell: true`: cmd.exe /d /s /c "<command>" with verbatim arguments.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}

function safeLabel(label) {
  const s = String(label || 'run').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'run';
}

export function readIndex(runDir) {
  const file = path.join(runDir, 'evidence', 'index.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  return out;
}

function nextNumbers(evDir, label, index) {
  let maxEv = 0;
  for (const e of index) {
    const m = /^EV-(\d+)$/.exec(e.id || '');
    if (m) maxEv = Math.max(maxEv, Number(m[1]));
  }
  let n = 1;
  while (fs.existsSync(path.join(evDir, `${label}-${n}.log`))) n++;
  return { ev: maxEv + 1, n };
}

/**
 * Run `command` in `cwd` and record it as evidence.
 * @param {{runDir:string, label:string, command:string, cwd:string, source:'agent'|'cli', headSha?:string|null,
 *          timeoutMs?:number, echo?:boolean, env?:object}} opts
 * @returns entry `{id, label, command, cwd, exit_code, log_path, head_sha, source, started_at, ended_at}`
 */
export function run({ runDir, label, command, cwd, source = 'agent', headSha, timeoutMs = 30 * 60 * 1000, echo = false, env } = {}) {
  if (!runDir) throw new Error('evidence.run needs runDir');
  if (!command || typeof command !== 'string') throw new Error('evidence.run needs a command string');
  const workDir = cwd || process.cwd();
  const evDir = path.join(runDir, 'evidence');
  fs.mkdirSync(evDir, { recursive: true });
  const lbl = safeLabel(label);
  const index = readIndex(runDir);
  const { ev, n } = nextNumbers(evDir, lbl, index);
  const logPath = path.join(evDir, `${lbl}-${n}.log`);
  const sha = headSha !== undefined && headSha !== null ? headSha : gitHead(workDir);

  const started = new Date();
  fs.writeFileSync(logPath, `# command: ${command}\n# cwd: ${toSlash(workDir)}\n# head: ${sha || 'none'}\n# started: ${started.toISOString()}\n`);
  const fd = fs.openSync(logPath, 'a');
  let exitCode;
  let note = '';
  try {
    const sh = shellSpawnArgs(command);
    const r = spawnSync(sh.file, sh.args, {
      cwd: workDir,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      windowsVerbatimArguments: sh.windowsVerbatimArguments,
      timeout: timeoutMs,
      env: { ...process.env, ...(env || {}) },
    });
    if (r.error) {
      exitCode = -1;
      note = r.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs} ms` : String(r.error.message || r.error);
    } else if (r.status === null) {
      exitCode = -1;
      note = `killed by signal ${r.signal}`;
    } else {
      exitCode = r.status;
    }
  } finally {
    fs.closeSync(fd);
  }
  const ended = new Date();
  fs.appendFileSync(logPath, `\n# ${note ? note + '; ' : ''}exit: ${exitCode}\n`);

  const entry = {
    id: `EV-${ev}`,
    label: lbl,
    command,
    cwd: toSlash(workDir),
    exit_code: exitCode,
    log_path: toSlash(path.resolve(logPath)),
    head_sha: sha || null,
    source: source === 'cli' ? 'cli' : 'agent',
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
  };
  fs.appendFileSync(path.join(evDir, 'index.jsonl'), JSON.stringify(entry) + '\n');

  if (echo) {
    try {
      process.stdout.write(fs.readFileSync(logPath, 'utf8'));
    } catch {
      // ignore
    }
  }
  return entry;
}
