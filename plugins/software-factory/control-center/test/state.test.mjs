import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FactoryState, billed } from '../server/state.mjs';
import { tempProject } from './helpers.mjs';

function load(t, now) {
  const st = new FactoryState({ home: t.home, projectDir: t.project, now: now ? () => now : undefined });
  st.refresh({ full: true });
  return st;
}

test('billed-equivalent tokens use the contract weights', () => {
  assert.equal(billed({ m: { input: 100, output: 200, cache_creation: 400, cache_read: 1000 } }), 100 + 200 + 500 + 100);
});

test('fixture covers every task status and every msg type', () => {
  const t = tempProject();
  try {
    const st = load(t);
    const statuses = new Set(st.snapshot().tasks.map((x) => x.status));
    for (const s of ['draft', 'backlog', 'ready', 'in_progress', 'checking', 'in_review', 'changes_requested', 'verified', 'integrated',
      'awaiting_approval', 'done', 'blocked', 'paused', 'deferred', 'failed', 'cancelled']) assert.ok(statuses.has(s), s);
    const types = new Set(st.allEvents().map((e) => e.type));
    for (const m of ['dispatch', 'handoff', 'question', 'answer', 'review_request', 'review_result', 'rework', 'escalation', 'approval_request', 'approval_result']) {
      assert.ok(types.has(`msg.${m}`), m);
    }
    assert.equal(st.snapshot().goals.length, 3);
    assert.equal(st.snapshot().epics.length, 2);
  } finally { t.cleanup(); }
});

test('usage: latest snapshot per key wins; running snapshots are live', () => {
  const t = tempProject();
  try {
    const st = load(t);
    const u = st.snapshot().usage;
    const running = u.running.map((r) => r.run_id).sort();
    assert.deepEqual(running, st.index.runs_active.slice().sort());
    assert.ok(u.by_goal['G-001'].live > 0);
    assert.equal(u.by_goal['G-003'].live, 0);
    assert.ok(u.hourly.length > 10);
    const sumHourly = u.hourly.reduce((a, h) => a + h.total, 0);
    assert.ok(Math.abs(sumHourly - u.totals.billed) / u.totals.billed < 0.01, 'hourly deltas add up to the total');
    // Appending a newer cumulative snapshot replaces, not adds.
    const before = u.totals.billed;
    const last = fs.readFileSync(path.join(t.home, 'state', 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.scope === 'agent').at(-1);
    fs.appendFileSync(path.join(t.home, 'state', 'usage.jsonl'), JSON.stringify(last) + '\n');
    st.refresh();
    assert.equal(st.snapshot().usage.totals.billed, before);
  } finally { t.cleanup(); }
});

test('loop shows "Loop not running" only after next_wakeup_at + 300 s', () => {
  const t = tempProject();
  try {
    const f = JSON.parse(fs.readFileSync(path.join(t.home, 'state', 'factory.json'), 'utf8'));
    const next = Date.parse(f.tick.next_wakeup_at);
    assert.equal(load(t, next + 299000).factorySlice().loop.label, 'Running');
    const stale = load(t, next + 301000).factorySlice().loop;
    assert.equal(stale.label, 'Loop not running');
    assert.equal(stale.state, 'stale');
    assert.equal(load(t, next - 120000).factorySlice().loop.next_tick_in_s, 120);
  } finally { t.cleanup(); }
});

test('goals carry spend from budget.json and a colour index', () => {
  const t = tempProject();
  try {
    const g = load(t).snapshot().goals.find((x) => x.id === 'G-002');
    assert.ok(g.spend.pct > 100);
    assert.equal(g.status, 'budget_blocked');
    assert.ok(g.color_index >= 0 && g.color_index < 8);
  } finally { t.cleanup(); }
});
