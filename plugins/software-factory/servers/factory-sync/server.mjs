#!/usr/bin/env node
// factory-sync: stdio MCP server for two-way tracker sync. No dependencies: JSON-RPC 2.0 over
// newline-delimited JSON on stdin/stdout (MCP stdio transport). Logs go to stderr only.
// Secrets arrive in env (SF_*) from plugin userConfig; they never reach the Bash tool.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPreview, discover, preview, status, syncTick } from './core/engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HERE, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
const PROTOCOL = '2025-06-18';

const projectDir = { type: 'string', description: 'Absolute path of the project (the git checkout that holds .factory).' };

export const TOOLS = [
  {
    name: 'sync_tick',
    description: 'Run one tracker sync step for the software factory: pull tracker changes into inbox requests, then push factory changes. Only the dispatcher tick calls this (the dispatcher lease must be fresh). Returns at most 15 lines.',
    inputSchema: { type: 'object', properties: { projectDir, mode: { type: 'string', enum: ['delta', 'full', 'dry_run', 'rebuild_map'], description: 'delta (default), full reconcile, dry_run (plan and log, write nothing), or rebuild_map (re-link items by their sf-id footer).' } }, required: ['projectDir'] },
    run: (a, deps) => syncTick({ projectDir: a.projectDir, mode: ['full', 'dry_run', 'rebuild_map'].includes(a.mode) ? a.mode : 'delta' }, deps),
  },
  {
    name: 'sync_preview',
    description: 'Write the first-sync preview to .factory/sync/preview.md (items and labels to create, status map, intake candidates, re-links) and raise the approval request. Reads the tracker; writes nothing to it.',
    inputSchema: { type: 'object', properties: { projectDir }, required: ['projectDir'] },
    run: (a, deps) => preview({ projectDir: a.projectDir }, deps),
  },
  {
    name: 'sync_apply_preview',
    description: 'Approve the first sync for the given preview id. Works only right after the user typed /software-factory:sync --approve-preview themselves.',
    inputSchema: { type: 'object', properties: { projectDir, previewId: { type: 'string', description: 'The id printed in preview.md.' } }, required: ['projectDir', 'previewId'] },
    run: (a, deps) => applyPreview({ projectDir: a.projectDir, previewId: a.previewId }, deps),
  },
  {
    name: 'tracker_discover',
    description: 'Check tracker credentials and scope for setup: finds the team, repo or project, and proposes the status map. Read-only on the tracker.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir, tracker: { type: 'string', enum: ['linear', 'github', 'jira'] },
        scopeHint: { description: 'Linear {team_key}, Jira {project_key}, GitHub {owner, repo}; or a plain key string.', anyOf: [{ type: 'object' }, { type: 'string' }] },
      },
      required: ['projectDir', 'tracker'],
    },
    run: (a, deps) => discover({ projectDir: a.projectDir, tracker: a.tracker, scopeHint: a.scopeHint }, deps),
  },
  {
    name: 'sync_status',
    description: 'Show tracker sync health: last pull and push, backoff, outbox, first-sync approval. No network calls.',
    inputSchema: { type: 'object', properties: { projectDir }, required: ['projectDir'] },
    run: (a, deps) => status({ projectDir: a.projectDir }, deps),
  },
];

function reply(id, result) { return { jsonrpc: '2.0', id, result }; }
function error(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
export async function handle(msg, deps = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && msg.id !== undefined ? error(msg.id, -32600, 'invalid request') : null;
  }
  const isNote = msg.id === undefined || msg.id === null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, { protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'factory-sync', version: VERSION } });
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return isNote ? null : reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return error(msg.id, -32602, `unknown tool ${p.name}`);
      const args = p.arguments || {};
      try {
        const r = await tool.run(args, deps);
        const lines = (r && r.lines) || [];
        const bad = /^(ERROR|REFUSED|NOT_INITIALIZED|NOT_APPROVED)/.test(lines[0] || '');
        return reply(msg.id, { content: [{ type: 'text', text: lines.slice(0, 15).join('\n') }], ...(bad ? { isError: true } : {}) });
      } catch (e) {
        process.stderr.write(`factory-sync ${p.name} failed: ${e && e.stack ? e.stack : e}\n`);
        return reply(msg.id, { content: [{ type: 'text', text: `ERROR ${String((e && e.message) || e).slice(0, 200)}` }], isError: true });
      }
    }
    default:
      return isNote ? null : error(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export function serve({ input = process.stdin, output = process.stdout, deps = {} } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve(); // one message at a time: tool calls never race on .factory/sync files
  const send = (obj) => { if (obj) output.write(JSON.stringify(obj) + '\n'); };
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { send(error(null, -32700, 'parse error')); return; }
    const batch = Array.isArray(msg) ? msg : [msg];
    chain = chain.then(async () => {
      const out = [];
      for (const m of batch) { const r = await handle(m, deps); if (r) out.push(r); }
      if (Array.isArray(msg)) { if (out.length) send(out); } else send(out[0]);
    }).catch((e) => process.stderr.write(`factory-sync: ${e && e.stack ? e.stack : e}\n`));
  });
  return rl;
}

const isMain = (() => { try { return resolve(process.argv[1] || '').toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase(); } catch { return false; } })();
if (isMain) serve();
