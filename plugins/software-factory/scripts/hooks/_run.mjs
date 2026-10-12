// Shared hook runner: fast exit when no .factory exists, read stdin JSON, never throw, log errors.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existingHome } from '../lib/paths.mjs';

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

export function logError(home, name, err) {
  try {
    const dir = join(home, 'run');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} ${name} ${String((err && err.stack) || err).slice(0, 2000)}\n`);
  } catch { /* nothing left to do */ }
}

/** handler({payload, home, env}) -> string|object|null (written to stdout). */
export async function runHook(name, handler) {
  let home = null;
  try {
    home = existingHome(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!home) { process.exitCode = 0; return; }
    const raw = readStdin();
    let payload = {};
    try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
    const res = await handler({ payload, home, env: process.env });
    if (res !== null && res !== undefined) process.stdout.write(typeof res === 'string' ? res : JSON.stringify(res));
  } catch (e) {
    if (home) logError(home, name, e);
  }
  process.exitCode = 0;
}

export function preToolDecision(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason || '' } };
}
