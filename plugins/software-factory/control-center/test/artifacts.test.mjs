import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/server.mjs';
import { tempProject, req, auth } from './helpers.mjs';

let t, s;
const art = (p) => req(s.port, { path: `/api/artifact?path=${encodeURIComponent(p)}`, headers: auth(s) });

before(async () => {
  t = tempProject();
  // Files that must never be served.
  fs.writeFileSync(path.join(t.project, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(t.home, 'docs', '.env.local'), 'SECRET=2\n');
  fs.writeFileSync(path.join(t.home, 'docs', 'deploy.pem'), 'KEY\n');
  fs.mkdirSync(path.join(t.project, '.git'));
  fs.writeFileSync(path.join(t.project, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(t.project, 'src.ts'), 'export {}\n');
  fs.writeFileSync(path.join(path.dirname(t.project), `outside-${path.basename(t.project)}.md`), '# outside\n');
  s = await startServer({ home: t.home, projectDir: t.project, port: 0, pollMs: 200, log: () => {} });
});
after(async () => {
  await s.close();
  fs.rmSync(path.join(path.dirname(t.project), `outside-${path.basename(t.project)}.md`), { force: true });
  t.cleanup();
});

test('markdown referenced by a gate is returned as text', async () => {
  const r = await art('docs/G-003-audit-log/prd.md');
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'markdown');
  assert.match(r.json.text, /^# PRD: Audit log/);
  assert.match(r.headers['content-type'], /application\/json/);
});

test('evidence logs referenced by tasks are readable', async () => {
  const state = (await req(s.port, { path: '/api/state', headers: auth(s) })).json;
  const ev = state.tasks.find((x) => x.id === 'T-0015').evidence.find((e) => e.label === 'test');
  const r = await art(ev.log_path);
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'log');
  assert.match(r.json.text, /exit 1/);
});

test('path traversal and outside paths are refused', async () => {
  const outside = path.join(path.dirname(t.project), `outside-${path.basename(t.project)}.md`);
  for (const p of ['../outside.md', `../../${path.basename(outside)}`, `docs/../../${'..'}/${path.basename(outside)}`, outside,
    outside.replace(/\\/g, '/'), 'docs/../../../../../../../../Windows/win.ini', '/etc/passwd']) {
    const r = await art(p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.equal(r.json.text, undefined);
  }
});

test('secrets, .git and runtime files are denied', async () => {
  for (const p of ['.env', 'docs/.env.local', 'docs/deploy.pem', '.git/config', 'run/control-center.json', 'state/index.json', 'config.json']) {
    const r = await art(p);
    assert.equal(r.status, 403, p);
  }
});

test('files not referenced by any record are denied', async () => {
  assert.equal((await art('src.ts')).status, 403);
  assert.equal((await art('tasks/T-0001.json')).status, 403);
});

test('bad input is 400', async () => {
  assert.equal((await art('')).status, 400);
  assert.equal((await art('a\0b')).status, 400);
  assert.equal((await art('https://example.com/x.md')).status, 400);
});

test('symlink pointing outside the project is refused', async (tt) => {
  const link = path.join(t.home, 'docs', 'G-001-vin-decoder', 'escape.md');
  const target = path.join(path.dirname(t.project), `outside-${path.basename(t.project)}.md`);
  try { fs.symlinkSync(target, link, 'file'); } catch { tt.skip('symlinks need privileges on this machine'); return; }
  const r = await art('docs/G-001-vin-decoder/escape.md');
  assert.equal(r.status, 403);
});

test('mockup HTML: one-use ticket served with a CSP sandbox', async () => {
  const r = await art('docs/G-001-vin-decoder/design/intake.html');
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'html');
  assert.equal(r.json.text, undefined);
  assert.match(r.json.ticket_url, /^\/api\/mockup\/[\w-]{20,}$/);
  const page = await req(s.port, { path: r.json.ticket_url });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers['content-security-policy'], /allow-same-origin/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.text, /Add unit/);
  assert.equal((await req(s.port, { path: r.json.ticket_url })).status, 404, 'ticket is single use');
  assert.equal((await req(s.port, { path: '/api/mockup/made-up-ticket-value-123' })).status, 404);
});
