// Telemetry reconcile: parse subagent transcripts of active runs into usage snapshots, bind unbound runs.
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listDir, nowIso, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { readLease } from './state.mjs';
import { endingOf, findAgentTranscript, parseTranscript, runIdFromText, subagentsDir, writeSnapshot } from './usage.mjs';

export function sessionsPath(home) { return join(home, 'run', 'sessions.json'); }

/** Remember where a session's transcript lives (hooks call this). Keeps the newest 20. */
export function recordSession(home, sessionId, transcriptPath) {
  if (!sessionId || !transcriptPath) return;
  const cur = readJson(sessionsPath(home), {}) || {};
  if (cur[sessionId] && cur[sessionId].transcript_path === transcriptPath) return;
  cur[sessionId] = { transcript_path: transcriptPath, at: nowIso() };
  const entries = Object.entries(cur).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 20);
  writeJsonAtomic(sessionsPath(home), Object.fromEntries(entries));
}

export function sessionTranscript(home, sessionId) {
  const cur = readJson(sessionsPath(home), {}) || {};
  return cur[sessionId] ? cur[sessionId].transcript_path : null;
}

function readHead(file, bytes = 65536) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
}

/** Find the run id an agent transcript belongs to: meta description tag or FACTORY_RUN= in the first user message. */
export function runIdOfAgentFile(file) {
  const head = readHead(file);
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'user' && o.message) {
        const c = o.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
        return runIdFromText(t);
      }
    } catch { /* torn */ }
  }
  return runIdFromText(head);
}

function taskTagOfMeta(file) {
  const meta = readJson(file.replace(/\.jsonl$/, '.meta.json'), null);
  const m = meta && /\[(T-\d+)\]/.exec(meta.description || '');
  return m ? m[1] : null;
}

const WATCH = new Set(['dispatching', 'running', 'suspect']);

/**
 * Reconcile usage for runs of the lease session (and the runs' own sessions).
 * Returns {mtimes: {run_id: ms}, bound: [run_id], finished: [run_id], snapshots: n}.
 */
export function reconcile(home, { session = null } = {}) {
  const out = { mtimes: {}, bound: [], finished: [], deferred: [], snapshots: 0 };
  const lease = readLease(home);
  const leaseSession = session || (lease && lease.session_id);
  const cursorFile = join(home, 'state', 'telemetry.json');
  const cursors = readJson(cursorFile, { files: {} }) || { files: {} };
  const runs = store.list(home, 'run', (r) => WATCH.has(r.status) || (r.agent_id && r.status === 'completed' && !r.usage_final));
  for (const run of runs) {
    const sid = run.session_id || leaseSession;
    const st = sid && sessionTranscript(home, sid);
    if (!st) continue;
    let agentId = run.agent_id;
    if (!agentId) {
      const dir = subagentsDir(st);
      for (const name of listDir(dir)) {
        if (!/^agent-.+\.jsonl$/.test(name)) continue;
        const file = join(dir, name);
        const tag = taskTagOfMeta(file);
        if (tag && tag !== run.task_id) continue;
        if (runIdOfAgentFile(file) === run.id) { agentId = name.slice(6, -6); break; }
      }
      if (!agentId) continue;
      withMutex(home, () => store.update(home, 'run', run.id, (r) => {
        r.agent_id = agentId;
        if (r.status === 'dispatching') { r.status = 'running'; r.started_at = r.started_at || nowIso(); }
      }));
      out.bound.push(run.id);
      emit(home, { type: 'run.started', source: 'reconcile', session_id: sid, goal_id: run.goal_id, task_id: run.task_id, run_id: run.id, actor: { kind: 'system', role: run.role, run_id: run.id, agent_id: agentId }, msg: `${run.id} bound to agent ${agentId} by reconcile` });
    }
    const file = findAgentTranscript(st, agentId);
    if (!existsSync(file)) continue;
    let s;
    try { s = statSync(file); } catch { continue; }
    out.mtimes[run.id] = s.mtimeMs;
    const prev = cursors.files[file];
    if (prev && prev.mtime === s.mtimeMs && prev.size === s.size) continue;
    const parsed = parseTranscript(file);
    const ending = endingOf(parsed);
    const cur = store.get(home, 'run', run.id);
    const finished = cur.status === 'completed' || ending === 'handoff';
    writeSnapshot(home, {
      source: 'reconcile', scope: 'agent', agent_id: agentId, session_id: sid, agent_type: cur.subagent_type,
      run_id: run.id, task_id: run.task_id, goal_id: run.goal_id, role: run.role, status: finished ? 'finished' : 'running',
      requests: parsed.requests, by_model: parsed.by_model,
    });
    out.snapshots++;
    cursors.files[file] = { mtime: s.mtimeMs, size: s.size };
    if (WATCH.has(cur.status) && cur.status !== 'dispatching' && ending === 'handoff' && Date.now() - s.mtimeMs > 60000) {
      store.update(home, 'run', run.id, (r) => { r.status = 'completed'; r.ended_at = r.ended_at || nowIso(); r.exit = { reason: 'handoff', message: 'found by reconcile' }; });
      emit(home, { type: 'run.ended', source: 'reconcile', goal_id: run.goal_id, task_id: run.task_id, run_id: run.id, msg: `${run.id} ended (reconcile)` });
      out.finished.push(run.id);
    } else if (WATCH.has(cur.status) && ending === 'limit' && Date.now() - s.mtimeMs > 60000) {
      store.update(home, 'run', run.id, (r) => { r.status = 'deferred'; r.ended_at = nowIso(); r.exit = { reason: 'usage_limit', message: (parsed.last_assistant_text || '').slice(0, 200) }; });
      out.deferred.push(run.id);
    }
    if (finished) store.update(home, 'run', run.id, (r) => { r.usage_final = true; });
  }
  writeJsonAtomic(cursorFile, cursors);
  return out;
}
