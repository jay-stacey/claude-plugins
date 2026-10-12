// Control center HTTP server. Binds 127.0.0.1 only. Reads `.factory/` and writes only signed
// inbox requests, plus its own run file. Run directly: node server.mjs --project <dir> [--home <dir>] [--port n] [--demo]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FactoryState, eventMatches } from './state.mjs';
import { SseHub } from './sse.mjs';
import { startPoller, POLL_MS } from './poll.mjs';
import { Artifacts, ArtifactError } from './artifacts.mjs';
import { InboxWriter, RequestError } from './inbox.mjs';
import {
  baseHeaders, hostOk, originOk, requestToken, tokenEquals, newToken, RateLimiter, readBody, MOCKUP_CSP,
} from './security.mjs';

export const APP = 'software-factory-control-center';
export const VERSION = '0.1.0';
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const PORT_SPAN = 20;
const IDLE_MS = 24 * 3600 * 1000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

export function runFilePath(home) {
  return path.join(home, 'run', 'control-center.json');
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short backoff */ }
    }
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(opts) {
  const { home, projectDir = path.dirname(home), demo = false, writeRunFile = true, pollMs = POLL_MS,
    pluginDataDir } = opts; // undefined: hmac.getKey finds it (FACTORY_PLUGIN_DATA, run/machine.json, CLAUDE_PLUGIN_DATA)
  const log = opts.log || ((m) => console.log(`${new Date().toISOString()} ${m}`));
  const token = opts.token || newToken();
  const instanceId = crypto.randomBytes(8).toString('hex');
  const startedAt = Date.now();
  const state = new FactoryState({ home, projectDir, demo, instanceId });
  state.refresh({ full: true });
  const hub = new SseHub({ snapshot: () => state.snapshot({ clients: hub.clients.size }), onChange: () => { lastActivity = Date.now(); } });
  const artifacts = new Artifacts({ home, projectDir, referenced: () => state.referencedPaths() });
  const inbox = new InboxWriter({ home, pluginDataDir });
  const limiter = new RateLimiter();
  let lastActivity = Date.now();
  let port = 0;
  let closing = null;

  const send = (res, status, body, headers = {}) => {
    const isText = typeof body === 'string' || Buffer.isBuffer(body);
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, baseHeaders({ 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers }));
    res.end(payload);
  };
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });

  function serveStatic(res, pathname, head) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'bad path'); }
    if (rel === '/' || rel === '/index.html') rel = '/index.html';
    if (rel.includes('\0') || rel.includes('..')) return fail(res, 404, 'not found');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return fail(res, 404, 'not found');
    const type = TYPES[path.extname(file).toLowerCase()];
    let data;
    try { if (!type || !fs.statSync(file).isFile()) throw new Error('x'); data = fs.readFileSync(file); } catch { return fail(res, 404, 'not found'); }
    res.writeHead(200, baseHeaders({ 'Content-Type': type, 'Cache-Control': 'no-cache' }));
    res.end(head ? undefined : data);
  }

  function health() {
    const snap = state.factorySlice();
    return {
      app: APP, version: VERSION, instance_id: instanceId, project_dir: projectDir, home, pid: process.pid,
      uptime_s: Math.round((Date.now() - startedAt) / 1000), clients: hub.clients.size, watcher: 'polling', poll_ms: pollMs, demo,
      loop: snap.loop, pending_gates: (state.slices.gates || []).filter((g) => g.status === 'pending').length,
      last_event_at: state.events.at(-1)?.ts ?? null,
    };
  }

  function eventsPage(url) {
    const q = Object.fromEntries(['before', 'limit', 'role', 'goal', 'task', 'type'].map((k) => [k, url.searchParams.get(k) || '']));
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
    const all = state.allEvents();
    let end = all.length;
    if (q.before) {
      const i = all.findIndex((e) => e.id === q.before);
      end = i >= 0 ? i : all.length;
    }
    const out = [];
    let i = end - 1;
    for (; i >= 0 && out.length < limit; i--) if (eventMatches(all[i], q)) out.push(all[i]);
    let more = false;
    for (; i >= 0; i--) if (eventMatches(all[i], q)) { more = true; break; }
    return { events: out, has_more: more };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (!hostOk(req, port)) return fail(res, 403, 'bad host');
    if (req.method === 'OPTIONS') return fail(res, 403, 'no cross-origin access');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return fail(res, 405, 'method not allowed', {});

    // One-use mockup tickets: the ticket is the credential, so no token in the iframe URL.
    if (req.method === 'GET' && p.startsWith('/api/mockup/')) {
      const body = artifacts.redeem(p.slice('/api/mockup/'.length));
      if (!body) return fail(res, 404, 'ticket expired; open the artifact again');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': MOCKUP_CSP,
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (!p.startsWith('/api/')) {
      if (req.method === 'POST') return fail(res, 405, 'method not allowed');
      return serveStatic(res, p, req.method === 'HEAD');
    }

    const given = requestToken(req, url, { allowQuery: p === '/api/stream' });
    if (!tokenEquals(given, token)) return fail(res, 401, 'token missing or wrong');

    if (req.method === 'POST') {
      if (!originOk(req, port, { requireOrigin: p === '/api/inbox' })) return fail(res, 403, 'bad origin');
      if (!limiter.take()) return fail(res, 429, 'too many requests; wait a minute');
      let raw;
      try { raw = await readBody(req); } catch (e) { return fail(res, e.status || 400, e.message); }
      if (p === '/api/shutdown') {
        send(res, 200, { ok: true });
        setImmediate(() => close('shutdown request'));
        return undefined;
      }
      if (p === '/api/inbox') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(res, 415, 'send application/json');
        let body;
        try { body = JSON.parse(raw); } catch { return fail(res, 400, 'body is not valid JSON'); }
        try {
          const out = await inbox.submit(body);
          log(`inbox ${out.type} ${out.id}`);
          return send(res, 201, out);
        } catch (e) {
          if (e instanceof RequestError) return fail(res, e.status, e.message, e.extra);
          log(`inbox error: ${e.stack || e.message}`);
          return fail(res, 500, 'could not write the request');
        }
      }
      return fail(res, 404, 'not found');
    }

    switch (p) {
      case '/api/health': return send(res, 200, health());
      case '/api/state': return send(res, 200, state.snapshot({ clients: hub.clients.size }));
      case '/api/stream': hub.add(req, res, req.headers['last-event-id'] || url.searchParams.get('last_event_id')); return undefined;
      case '/api/events': return send(res, 200, eventsPage(url));
      case '/api/artifact': {
        try {
          return send(res, 200, artifacts.read(url.searchParams.get('path')));
        } catch (e) {
          if (e instanceof ArtifactError) return fail(res, e.status, e.message);
          return fail(res, 500, 'could not read the artifact');
        }
      }
      default: return fail(res, 404, 'not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`request error: ${e.stack || e.message}`);
      try { fail(res, 500, 'internal error'); } catch { /* headers sent */ }
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;

  // Port: preferred, then +1..+19, then any free port.
  const preferred = opts.port ?? readPort(home);
  if (preferred === 0) port = await listen(server, 0);
  else {
    for (let i = 0; i < PORT_SPAN && !port; i++) {
      try { port = await listen(server, preferred + i); } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
    }
    if (!port) port = await listen(server, 0);
  }

  const url = `http://127.0.0.1:${port}/?k=${token}`;
  const runFile = runFilePath(home);
  if (writeRunFile) {
    writeJsonAtomic(runFile, { pid: process.pid, port, token, instance_id: instanceId, started_at: new Date(startedAt).toISOString(),
      version: VERSION, project_dir: projectDir, home, demo });
  }
  log(`listening on http://127.0.0.1:${port} (instance ${instanceId}, project ${projectDir}${demo ? ', demo' : ''})`);

  let demoCtl = null;
  if (demo) {
    const { startDemo } = await import('./demo.mjs');
    demoCtl = startDemo({ home, log });
  }

  const poller = startPoller({
    state, hub, intervalMs: pollMs, log,
    onCycle: ({ changed }) => {
      if (changed) lastActivity = Date.now();
      if (!writeRunFile) return;
      if (!fs.existsSync(home)) return close('.factory was removed');
      let rf = null;
      try { rf = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') rf = null; else return undefined; }
      if (!rf || rf.instance_id !== instanceId) return close('run file removed or replaced');
      if (hub.clients.size === 0 && Date.now() - lastActivity > (opts.idleMs ?? IDLE_MS)) return close('idle');
      return undefined;
    },
  });

  function close(reason = 'stop') {
    if (closing) return closing;
    log(`shutting down: ${reason}`);
    closing = new Promise((resolve) => {
      poller.stop();
      demoCtl?.stop();
      hub.close();
      if (writeRunFile) {
        try {
          const rf = JSON.parse(fs.readFileSync(runFile, 'utf8'));
          if (rf.instance_id === instanceId) fs.rmSync(runFile, { force: true });
        } catch { /* already gone */ }
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1000).unref();
    });
    closing.then(() => opts.onClose?.(reason));
    return closing;
  }

  return { server, port, token, url, instanceId, state, hub, close, poll: () => poller.cycle() };
}

function readPort(home) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const p = c?.control_center?.port;
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 47610;
  } catch {
    return 47610;
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(args.project || process.cwd());
  const home = path.resolve(args.home || process.env.FACTORY_HOME || path.join(projectDir, '.factory'));
  if (!fs.existsSync(home)) {
    console.error(`No factory at ${home}. Run /software-factory:setup first.`);
    process.exit(4);
  }
  startServer({
    home, projectDir, demo: !!args.demo, port: args.port !== undefined ? Number(args.port) : undefined,
    onClose: () => process.exit(0),
  }).then((s) => {
    const stop = () => s.close('signal');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => {
    console.error(`start failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
