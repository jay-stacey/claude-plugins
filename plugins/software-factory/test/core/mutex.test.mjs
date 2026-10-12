import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { makeHome, lib, join, P } from './_helpers.mjs';

test('withMutex is exclusive across processes', async () => {
  const { home } = await makeHome();
  const fsu = join(P, 'scripts', 'lib', 'fsutil.mjs').replace(/\\/g, '/');
  const script = `import { withMutex, sleepSync } from 'file:///${fsu.replace(/^\//, '')}';
    import { appendFileSync } from 'node:fs';
    const home = process.argv[1];
    for (let i = 0; i < 5; i++) withMutex(home, () => { appendFileSync(home + '/log.txt', 'in\\n'); sleepSync(5); appendFileSync(home + '/log.txt', 'out\\n'); });`;
  const kids = [0, 1, 2].map(() => new Promise((res) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, home], { stdio: 'inherit' });
    c.on('exit', res);
  }));
  const codes = await Promise.all(kids);
  assert.deepEqual(codes, [0, 0, 0]);
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(join(home, 'log.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 30);
  for (let i = 0; i < lines.length; i += 2) assert.deepEqual([lines[i], lines[i + 1]], ['in', 'out']);
});

test('a lock held by a dead pid is broken; a live fresh lock times out', async () => {
  const { home } = await makeHome();
  const fsutil = await lib('fsutil');
  const dir = join(home, 'run', 'mutex');
  mkdirSync(dir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: dead, token: 'x', at: new Date().toISOString() }));
  assert.equal(fsutil.withMutex(home, () => 42), 42);
  assert.ok(!existsSync(dir));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.ppid || 1, token: 'y', at: new Date().toISOString() }));
  if (fsutil.pidAlive(process.ppid)) {
    assert.throws(() => fsutil.acquireMutex(home, { waitMs: 100 }), /mutex busy/);
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.ppid || 1, token: 'y', at: new Date(Date.now() - 200000).toISOString() }));
  assert.equal(fsutil.withMutex(home, () => 'stale broken'), 'stale broken');
});

test('withMutex is re-entrant within one process', async () => {
  const { home } = await makeHome();
  const { withMutex } = await lib('fsutil');
  assert.equal(withMutex(home, () => withMutex(home, () => 7)), 7);
});
