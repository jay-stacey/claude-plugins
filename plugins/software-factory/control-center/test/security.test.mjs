import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/server.mjs';
import { tempProject, req, auth, postHeaders, useInboxLib } from './helpers.mjs';

let t, s;
before(async () => {
  useInboxLib();
  t = tempProject();
  s = await startServer({ home: t.home, projectDir: t.project, port: 0, pollMs: 200, log: () => {}, pluginDataDir: t.data });
});
after(async () => { await s.close(); t.cleanup(); });

test('binds 127.0.0.1 and writes the run file', () => {
  assert.equal(s.server.address().address, '127.0.0.1');
  const rf = JSON.parse(fs.readFileSync(path.join(t.home, 'run', 'control-center.json'), 'utf8'));
  assert.equal(rf.port, s.port);
  assert.equal(rf.token, s.token);
  assert.equal(rf.instance_id, s.instanceId);
  assert.ok(Buffer.from(s.token, 'base64url').length === 32);
});

test('API without a token is 401', async () => {
  for (const p of ['/api/state', '/api/health', '/api/events', '/api/artifact?path=docs/G-003-audit-log/prd.md']) {
    assert.equal((await req(s.port, { path: p })).status, 401, p);
  }
});

test('wrong token is 401; query token only works for the stream', async () => {
  assert.equal((await req(s.port, { path: '/api/state', headers: { 'X-Factory-Token': 'x'.repeat(43) } })).status, 401);
  assert.equal((await req(s.port, { path: `/api/state?k=${s.token}` })).status, 401);
  assert.equal((await req(s.port, { path: '/api/state', headers: auth(s) })).status, 200);
});

test('wrong Host is 403 everywhere (DNS rebinding)', async () => {
  for (const host of ['evil.example:80', `127.0.0.1.nip.io:${s.port}`, `127.0.0.1:${s.port + 1}`, 'localhost', `[::1]:${s.port}`]) {
    assert.equal((await req(s.port, { path: '/api/state', headers: auth(s), host })).status, 403, host);
  }
  assert.equal((await req(s.port, { path: '/', host: 'evil.example' })).status, 403);
  assert.equal((await req(s.port, { path: '/api/health', headers: auth(s), host: `localhost:${s.port}` })).status, 200);
});

test('OPTIONS preflight is 403 and no CORS headers are sent', async () => {
  const r = await req(s.port, { method: 'OPTIONS', path: '/api/inbox', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(r.status, 403);
  const ok = await req(s.port, { path: '/api/state', headers: auth(s, { Origin: 'http://evil.example' }) });
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
});

test('POST with a foreign or missing Origin is 403', async () => {
  const body = { type: 'task.note', payload: { task_id: 'T-0012', text: 'hi' } };
  const evil = await req(s.port, { method: 'POST', path: '/api/inbox', headers: postHeaders(s, { Origin: 'http://localhost:3000' }), body });
  assert.equal(evil.status, 403);
  const h = postHeaders(s);
  delete h.Origin;
  assert.equal((await req(s.port, { method: 'POST', path: '/api/inbox', headers: h, body })).status, 403);
});

test('security headers on pages and API', async () => {
  for (const p of ['/', '/api/health']) {
    const r = await req(s.port, { path: p, headers: auth(s) });
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
});

test('static files need no token; traversal outside public is 404', async () => {
  const r = await req(s.port, { path: '/vendor/LICENSES.txt' });
  assert.equal(r.status, 200);
  assert.equal((await req(s.port, { path: '/../server/server.mjs' })).status, 404);
  assert.equal((await req(s.port, { path: '/%2e%2e/server/server.mjs' })).status, 404);
  assert.equal((await req(s.port, { path: '/vendor/..%5c..%5cserver%5cserver.mjs' })).status, 404);
});

test('body over 16 KB is 413', async () => {
  const body = { type: 'task.note', payload: { task_id: 'T-0012', text: 'x'.repeat(17000) } };
  const r = await req(s.port, { method: 'POST', path: '/api/inbox', headers: postHeaders(s), body });
  assert.equal(r.status, 413);
});

test('methods other than GET, HEAD, POST are 405', async () => {
  assert.equal((await req(s.port, { method: 'DELETE', path: '/api/state', headers: auth(s) })).status, 405);
  assert.equal((await req(s.port, { method: 'PUT', path: '/api/inbox', headers: postHeaders(s), body: '{}' })).status, 405);
});

test('more than 30 POSTs a minute is 429', async () => {
  let last;
  for (let i = 0; i < 32; i++) {
    last = await req(s.port, { method: 'POST', path: '/api/inbox', headers: postHeaders(s), body: { type: 'nope', payload: {} } });
  }
  assert.equal(last.status, 429);
});
