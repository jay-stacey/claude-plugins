// Human intent tokens written by the UserPromptSubmit hook (valid 15 minutes).
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { nowIso, readJson, writeJsonAtomic } from './fsutil.mjs';

export const INTENT_COMMANDS = ['approve', 'remove-goal', 'pause', 'sync-approve'];

export function intentPath(home) { return join(home, 'run', 'human-intent.json'); }

export function writeIntent(home, sessionId, command) {
  const rec = { session_id: sessionId || null, command, at: nowIso(), nonce: randomBytes(8).toString('hex') };
  writeJsonAtomic(intentPath(home), rec);
  return rec;
}

/**
 * True when a fresh intent for `command` exists. When sessionId is given it must match;
 * when it is unknown (CLI without --session and no env), any fresh intent counts.
 */
export function hasIntent(home, sessionId, command, maxAgeS = 900) {
  const rec = readJson(intentPath(home), null);
  if (!rec || rec.command !== command) return false;
  const age = (Date.now() - Date.parse(rec.at)) / 1000;
  if (!(age >= -5 && age <= maxAgeS)) return false;
  if (sessionId && rec.session_id && rec.session_id !== sessionId) return false;
  return true;
}

export function parseIntentCommand(prompt) {
  const s = String(prompt || '').trimStart();
  if (/^\/(?:software-factory:)?sync\s+(?:\S+\s+)*--approve-preview(?:\s|$)/.test(s)) return 'sync-approve';
  const m = /^\/(?:software-factory:)?(approve|remove-goal|pause)(?:\s|$)/.exec(s);
  return m ? m[1] : null;
}
