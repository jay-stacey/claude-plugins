import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncHome, seed, freshLease, approveFirstSync, SERVER, FAKE_GH, P } from './_sync.mjs';

/** Talk to the server over stdio with newline-delimited JSON-RPC. */
function client(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  const waiting = new Map();
  const stray = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else stray.push(msg);
    }
  });
  let n = 0;
  return {
    child, stray,
    request(method, params) { const id = ++n; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise((r) => waiting.set(id, r)); },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    raw(text) { child.stdin.write(text + '\n'); },
    close() { child.stdin.end(); return new Promise((r) => child.on('exit', r)); },
  };
}

test('MCP stdio: initialize handshake, tools/list, ping, a sync_tick against a temp .factory, and lease refusal', async () => {
  const h = await syncHome({ provider: 'github' });
  await seed(h.home);
  await approveFirstSync(h.home);
  const ghFile = join(h.root, 'gh-state.json');
  writeFileSync(ghFile, JSON.stringify({ n: 0, clock: Date.now(), issues: [], comments: [], labels: [], sub: [], calls: [] }));
  const c = client({ FACTORY_GH: FAKE_GH, FAKE_GH_STATE: ghFile, SF_SYNC_ENABLED: 'true', SF_GITHUB_TOKEN: '${user_config.github_token}', FACTORY_HOME: h.home });
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'factory-sync');
    assert.ok(init.result.capabilities.tools);
    c.notify('notifications/initialized');
    const ping = await c.request('ping');
    assert.deepEqual(ping.result, {});
    const list = await c.request('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['sync_apply_preview', 'sync_preview', 'sync_status', 'sync_tick', 'tracker_discover']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const tick = await c.request('tools/call', { name: 'sync_tick', arguments: { projectDir: h.repo } });
    const text = tick.result.content[0].text;
    assert.ok(text.split('\n').length <= 15);
    const head = JSON.parse(text.split('\n')[0]);
    assert.equal(head.health, 'ok');
    assert.equal(head.pushed, 3, 'two labels and the goal issue');
    const gh = JSON.parse(readFileSync(ghFile, 'utf8'));
    assert.equal(gh.issues.length, 1);
    assert.ok(readdirSync(join(h.home, 'sync')).includes('map.json'));

    freshLease(h.home, Date.now() - 10_000 * 1000);
    const refused = await c.request('tools/call', { name: 'sync_tick', arguments: { projectDir: h.repo } });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /^REFUSED/);

    const status = await c.request('tools/call', { name: 'sync_status', arguments: { projectDir: h.repo } });
    assert.match(status.result.content[0].text, /tracker github; status ready/);

    const unknown = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const bad = await c.request('no/such/method');
    assert.equal(bad.error.code, -32601);
    c.raw('{not json');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.stray.at(-1).error.code, -32700);
  } finally {
    await c.close();
  }
  void P;
});
