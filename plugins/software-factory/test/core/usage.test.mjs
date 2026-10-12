import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { makeHome, lib, join, P, writeFileSync } from './_helpers.mjs';

const FIX = join(P, 'test', 'fixtures', 'core', 'transcript-dup.jsonl');

test('parser dedupes by message.id, skips <synthetic>, tolerates torn lines', async () => {
  const u = await lib('usage');
  const r = u.parseTranscript(FIX);
  assert.equal(r.requests, 3);
  assert.equal(r.bad_lines, 2);
  const s = r.by_model['claude-sonnet-5'];
  assert.deepEqual(s, { input: 12, output: 30, cache_read: 2000, cache_creation: 500, requests: 2 });
  assert.deepEqual(r.by_model['claude-opus-5'], { input: 3, output: 4, cache_read: 0, cache_creation: 100, requests: 1 });
  assert.ok(!r.by_model['<synthetic>']);
  assert.equal(u.endingOf(r), 'handoff');
  assert.equal(u.runIdFromText(r.first_user_text), 'R-000042');
});

test('billed-equivalent tokens use weights', async () => {
  const u = await lib('usage');
  const r = u.parseTranscript(FIX);
  // sonnet: 12 + 30 + 1.25*500 + 0.1*2000 = 867; opus: 3 + 4 + 125 = 132
  assert.equal(u.billed(r.by_model), 999);
  assert.equal(u.billed(r.by_model, { cache_read: 0 }), 799);
});

test('incremental parse replaces a message split across reads', async () => {
  const { root } = await makeHome({ init: false });
  const u = await lib('usage');
  const f = join(root, 's.jsonl');
  const line = (id, out) => JSON.stringify({ type: 'assistant', message: { model: 'm', id, usage: { input_tokens: 1, output_tokens: out } } }) + '\n';
  writeFileSync(f, line('a', 1) + line('b', 2));
  let c = u.parseIncremental(f, null);
  assert.equal(c.requests, 2);
  appendFileSync(f, line('b', 5) + line('c', 1) + '{"torn');
  c = u.parseIncremental(f, c);
  assert.equal(c.requests, 3);
  assert.deepEqual(c.by_model.m, { input: 3, output: 7, cache_read: 0, cache_creation: 0, requests: 3 });
});

test('snapshots: latest line per key wins; setup-interviewer books to overhead', async () => {
  const { home } = await makeHome();
  const u = await lib('usage');
  const b = await lib('budget');
  u.writeSnapshot(home, { scope: 'agent', agent_id: 'x', session_id: 's', status: 'running', requests: 1, by_model: { m: { input: 10, output: 0, cache_read: 0, cache_creation: 0 } } });
  u.writeSnapshot(home, { scope: 'agent', agent_id: 'x', session_id: 's', status: 'finished', requests: 2, by_model: { m: { input: 20, output: 0, cache_read: 0, cache_creation: 0 } } });
  u.writeSnapshot(home, { scope: 'agent', agent_id: 'y', agent_type: 'software-factory:setup-interviewer', session_id: 's', status: 'finished', requests: 1, by_model: { m: { input: 7, output: 0, cache_read: 0, cache_creation: 0 } } });
  u.writeSnapshot(home, { scope: 'session', session_id: 's', status: 'running', requests: 1, by_model: { m: { input: 100, output: 0, cache_read: 0, cache_creation: 0 } } });
  const m = u.latestSnapshots(home);
  assert.equal(m.get('x').requests, 2);
  const r = b.compute(home);
  assert.equal(r.overhead, 107);
  assert.equal(r.unattributed, 20);
});

test('doctor self-test passes on the built-in fixture', async () => {
  const d = await lib('doctor');
  assert.ok(d.parserSelfTest().ok);
});
