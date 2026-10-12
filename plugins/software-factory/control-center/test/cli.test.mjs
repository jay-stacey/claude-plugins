import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempProject, CC, sleep } from './helpers.mjs';

const CLI = path.join(CC, 'server', 'cli.mjs');
const t = tempProject();
const runFile = path.join(t.home, 'run', 'control-center.json');
const env = { ...process.env, CI: '1', FACTORY_PLUGIN_DATA: t.data };
delete env.FACTORY_HOME;

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project', t.project, '--no-open', '--port', '0'], { encoding: 'utf8', env, timeout: 20000 });
  return { code: r.status, out: r.stdout + r.stderr };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

after(() => {
  const rf = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : null;
  if (rf && alive(rf.pid)) try { process.kill(rf.pid); } catch { /* gone */ }
  t.cleanup();
});

test('start, start again (reuse), status, stop', async () => {
  const a = cli('start');
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /Control center running: http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]{43}/);
  const rf1 = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.ok(alive(rf1.pid));

  const b = cli('start');
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /reused/);
  const rf2 = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.equal(rf2.pid, rf1.pid);
  assert.equal(rf2.instance_id, rf1.instance_id);

  const s = cli('status');
  assert.match(s.out, new RegExp(`PID ${rf1.pid}`));
  assert.match(s.out, /Pending approvals: 3/);

  const c = cli('stop');
  assert.match(c.out, new RegExp(`Control center stopped \\(PID ${rf1.pid}\\)`));
  assert.equal(fs.existsSync(runFile), false, 'run file removed');
  for (let i = 0; i < 30 && alive(rf1.pid); i++) await sleep(100);
  assert.equal(alive(rf1.pid), false);

  assert.match(cli('stop').out, /was not running/);
});

test('a stale run file pointing at a dead pid is replaced', () => {
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify({ pid: 999999, port: 1, token: 'x', instance_id: 'dead', project_dir: t.project }));
  const a = cli('start');
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /started just now/);
  const rf = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.notEqual(rf.instance_id, 'dead');
  assert.match(cli('stop').out, /stopped/);
});

test('deleting the run file makes the server exit on its own', async () => {
  assert.equal(cli('start').code, 0);
  const rf = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  fs.rmSync(runFile);
  for (let i = 0; i < 50 && alive(rf.pid); i++) await sleep(100);
  assert.equal(alive(rf.pid), false);
});

test('no factory gives the setup hint', () => {
  const r = spawnSync(process.execPath, [CLI, 'status', '--project', path.join(t.project, 'plugin-data')], { encoding: 'utf8', env });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /No factory here/);
});
