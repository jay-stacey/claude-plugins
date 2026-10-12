// Shared test helpers (not a test file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const CC = fileURLToPath(new URL('../', import.meta.url));
export const FIXTURE = path.join(CC, 'test', 'fixtures', 'basic', '.factory');
const REAL_INBOX = path.join(CC, '..', 'scripts', 'lib', 'inbox.mjs');

// Use Team CORE's inbox module when it exists; otherwise the stand-in in test/lib-double.
export function useInboxLib() {
  if (!fs.existsSync(REAL_INBOX)) process.env.FACTORY_CC_LIB_DIR = path.join(CC, 'test', 'lib-double');
  else delete process.env.FACTORY_CC_LIB_DIR;
  return process.env.FACTORY_CC_LIB_DIR ? 'double' : 'core';
}

export function tempProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sfcc-'));
  const home = path.join(project, '.factory');
  fs.cpSync(FIXTURE, home, { recursive: true });
  const data = path.join(project, 'plugin-data');
  fs.mkdirSync(data);
  return { project, home, data, cleanup: () => fs.rmSync(project, { recursive: true, force: true }) };
}

export function req(port, { method = 'GET', path: p = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (data !== null && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
}

export const auth = (s, extra = {}) => ({ 'X-Factory-Token': s.token, ...extra });
export const postHeaders = (s, extra = {}) => ({ 'X-Factory-Token': s.token, Origin: `http://127.0.0.1:${s.port}`, 'Content-Type': 'application/json', ...extra });

// Minimal SSE client. Collects parsed messages; waitFor(pred) resolves with the first match.
export function sse(port, token, { lastEventId } = {}) {
  const messages = [];
  const waiters = [];
  let buf = '';
  let request;
  const ready = new Promise((resolve, reject) => {
    request = http.get({ host: '127.0.0.1', port, path: `/api/stream?k=${encodeURIComponent(token)}`,
      headers: { Host: `127.0.0.1:${port}`, ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}) } }, (res) => {
      resolve(res.statusCode);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = { id: null, event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) m.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) m.event = line.slice(7);
            else if (line.startsWith('data: ')) m.data += line.slice(6);
          }
          if (!m.data) continue;
          try { m.data = JSON.parse(m.data); } catch { /* keep text */ }
          messages.push(m);
          for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
        }
      });
    });
    request.on('error', reject);
  });
  return {
    ready, messages,
    waitFor(pred, ms = 5000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for SSE message')); } }, ms).unref();
      });
    },
    close() { request?.destroy(); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
