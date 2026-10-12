// Transcript parsing and usage snapshots (state/usage.jsonl, latest line per key wins).
import { openSync, readSync, closeSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { appendLine, nowIso, readLines } from './fsutil.mjs';

export const DEFAULT_WEIGHTS = { input: 1, output: 1, cache_creation: 1.25, cache_read: 0.1 };

function usageOf(u) {
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cache_read: Number(u.cache_read_input_tokens) || 0,
    cache_creation: Number(u.cache_creation_input_tokens) || 0,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n');
  return '';
}

/** Parse transcript text. Dedupe assistant lines by message.id (last wins); skip `<synthetic>`; tolerate torn lines. */
export function parseTranscriptText(txt) {
  const byId = new Map();
  let bad = 0; let firstTs = null; let lastTs = null; let firstUser = null; let lastAssistantText = null;
  let anon = 0;
  const lines = txt.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (!o || typeof o !== 'object') { bad++; continue; }
    if (o.timestamp) { if (!firstTs) firstTs = o.timestamp; lastTs = o.timestamp; }
    if (o.type === 'user' && firstUser === null && o.message) {
      const t = textOf(o.message.content);
      if (t) firstUser = t;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    const m = o.message;
    const t = textOf(m.content);
    if (t && t.trim()) lastAssistantText = t;
    if (!m.usage || m.model === '<synthetic>') continue;
    const id = m.id || `anon-${anon++}`;
    byId.set(id, { model: m.model || 'unknown', u: usageOf(m.usage) });
  }
  const by_model = {};
  for (const { model, u } of byId.values()) {
    const b = by_model[model] || (by_model[model] = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0 });
    b.input += u.input; b.output += u.output; b.cache_read += u.cache_read; b.cache_creation += u.cache_creation; b.requests += 1;
  }
  return { requests: byId.size, by_model, bad_lines: bad, first_ts: firstTs, last_ts: lastTs, first_user_text: firstUser, last_assistant_text: lastAssistantText, _ids: byId };
}

export function parseTranscript(file) {
  let txt = '';
  try { txt = readFileSync(file, 'utf8'); } catch { return { requests: 0, by_model: {}, bad_lines: 0, first_ts: null, last_ts: null, missing: true }; }
  const r = parseTranscriptText(txt);
  delete r._ids;
  return r;
}

/**
 * Incremental parse from a byte offset. cursor = {offset, totals{by_model}, last_id, last_model, last_usage}.
 * Returns the new cursor. The last message id may be split over the boundary; its contribution is replaced.
 */
export function parseIncremental(file, cursor = null) {
  const cur = cursor ? structuredClone(cursor) : { offset: 0, by_model: {}, requests: 0, last_id: null, last_model: null, last_usage: null };
  let size = 0;
  try { size = statSync(file).size; } catch { return cur; }
  if (size < cur.offset) return parseIncremental(file, null); // file replaced
  if (size === cur.offset) return cur;
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - cur.offset);
  readSync(fd, buf, 0, buf.length, cur.offset);
  closeSync(fd);
  let txt = buf.toString('utf8');
  const lastNl = txt.lastIndexOf('\n');
  if (lastNl < 0) return cur; // only a partial line so far
  txt = txt.slice(0, lastNl + 1);
  const consumed = Buffer.byteLength(txt);
  const r = parseTranscriptText(txt);
  const add = (model, u, sign) => {
    const b = cur.by_model[model] || (cur.by_model[model] = { input: 0, output: 0, cache_read: 0, cache_creation: 0, requests: 0 });
    b.input += sign * u.input; b.output += sign * u.output; b.cache_read += sign * u.cache_read;
    b.cache_creation += sign * u.cache_creation;
  };
  let lastId = cur.last_id; let lastModel = cur.last_model; let lastUsage = cur.last_usage;
  for (const [id, { model, u }] of r._ids) {
    if (id === cur.last_id && cur.last_usage) {
      add(cur.last_model, cur.last_usage, -1);
      add(model, u, 1);
    } else {
      add(model, u, 1);
      cur.by_model[model].requests += 1;
      cur.requests += 1;
    }
    lastId = id; lastModel = model; lastUsage = u;
  }
  cur.offset += consumed;
  cur.last_id = lastId; cur.last_model = lastModel; cur.last_usage = lastUsage;
  return cur;
}

export function billed(byModel, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  let t = 0;
  for (const b of Object.values(byModel || {})) {
    t += (b.input || 0) * w.input + (b.output || 0) * w.output + (b.cache_creation || 0) * w.cache_creation + (b.cache_read || 0) * w.cache_read;
  }
  return Math.round(t);
}

export function usageFile(home) { return join(home, 'state', 'usage.jsonl'); }

export function writeSnapshot(home, snap) {
  const line = {
    v: 1, ts: nowIso(), source: snap.source || 'hook', scope: snap.scope || 'agent',
    ...(snap.agent_id ? { agent_id: snap.agent_id } : {}), session_id: snap.session_id || null,
  };
  for (const k of ['agent_type', 'run_id', 'task_id', 'goal_id', 'role']) if (snap[k]) line[k] = snap[k];
  line.status = snap.status || 'running';
  line.requests = snap.requests || 0;
  line.by_model = snap.by_model || {};
  appendLine(usageFile(home), line);
  return line;
}

export function snapshotKey(s) { return s.scope === 'session' ? `session:${s.session_id}` : s.agent_id; }

export function latestSnapshots(home) {
  const map = new Map();
  for (const s of readLines(usageFile(home))) {
    const k = snapshotKey(s);
    if (k) map.set(k, s);
  }
  return map;
}

/** <projects>/<slug>/<session_id>.jsonl -> <projects>/<slug>/<session_id>/subagents/agent-<id>.jsonl */
export function findAgentTranscript(sessionTranscriptPath, agentId) {
  const dir = dirname(sessionTranscriptPath);
  const sid = basename(sessionTranscriptPath).replace(/\.jsonl$/, '');
  return join(dir, sid, 'subagents', `agent-${agentId}.jsonl`);
}

export function subagentsDir(sessionTranscriptPath) {
  const sid = basename(sessionTranscriptPath).replace(/\.jsonl$/, '');
  return join(dirname(sessionTranscriptPath), sid, 'subagents');
}

const LIMIT_RX = /(usage limit|rate[ _-]?limit|overloaded|\b529\b|limit will reset|out of extra usage)/i;

/** Classify how an agent transcript ended: handoff | limit | unknown. */
export function endingOf(parsed) {
  const t = parsed && parsed.last_assistant_text;
  if (t && /^\s*HANDOFF\s+\S+\s+\S+/m.test(t)) return 'handoff';
  if (t && LIMIT_RX.test(t)) return 'limit';
  return 'unknown';
}

export function runIdFromText(t) {
  const m = /FACTORY_RUN=(R-\d+)/.exec(t || '');
  return m ? m[1] : null;
}
