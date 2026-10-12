import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncHome, seed, makeClock, core, lib, inboxFiles, readSync, approveFirstSync, FAKE_GH } from './_sync.mjs';

function ghState(root) {
  const file = join(root, 'gh-state.json');
  writeFileSync(file, JSON.stringify({ n: 0, clock: Date.now(), issues: [], comments: [], labels: ['bug'], sub: [], calls: [] }));
  return {
    file,
    read: () => JSON.parse(readFileSync(file, 'utf8')),
    edit: (fn) => { const s = JSON.parse(readFileSync(file, 'utf8')); fn(s); writeFileSync(file, JSON.stringify(s)); },
  };
}

test('GitHub: push creates labelled goal and task issues with a sub-issue link; pull maps close-as-not-planned to cancel and reads comments', async () => {
  const h = await syncHome({ provider: 'github' });
  const { g, t } = await seed(h.home);
  const gs = ghState(h.root);
  process.env.FACTORY_GH = FAKE_GH;
  process.env.FAKE_GH_STATE = gs.file;
  const clock = makeClock();
  const e = await core('engine');
  const d = { env: { SF_SYNC_ENABLED: 'true' }, now: clock, sleep: async () => {} };
  try {
    const disc = await e.discover({ projectDir: h.repo, tracker: 'github', scopeHint: 'o/r' }, d);
    assert.match(disc.lines[0], /^READY github o\/r/);
    await approveFirstSync(h.home);
    await e.syncTick({ projectDir: h.repo }, d);
    clock.advance(1000);
    await e.syncTick({ projectDir: h.repo }, d);
    let s = gs.read();
    const map = readSync(h.home, 'map.json');
    const goalIssue = s.issues.find((i) => String(i.number) === map.goals[g.id].remoteId);
    const taskIssue = s.issues.find((i) => String(i.number) === map.items[t.id].remoteId);
    assert.deepEqual(goalIssue.labels.sort(), ['factory-goal', 'software-factory']);
    assert.deepEqual(taskIssue.labels.sort(), ['role:staff-engineer', 'software-factory']);
    assert.match(taskIssue.body, new RegExp(`sf-id: ${t.id}`));
    assert.deepEqual(s.sub, [[goalIssue.number, taskIssue.id]]);
    assert.ok(s.labels.includes('software-factory') && s.labels.includes('role:staff-engineer'));
    assert.ok(!s.calls.some((c) => /^DELETE/.test(c)));

    // echo: nothing new on the next tick
    const callsBefore = s.calls.filter((c) => !c.startsWith('GET')).length;
    clock.advance(1000);
    await e.syncTick({ projectDir: h.repo }, d);
    assert.equal(gs.read().calls.filter((c) => !c.startsWith('GET')).length, callsBefore);
    assert.equal(inboxFiles(h.home).length, 0);

    // human closes the task issue as not planned and comments
    gs.edit((x) => {
      const i = x.issues.find((y) => y.number === taskIssue.number);
      x.clock += 5000; i.state = 'closed'; i.state_reason = 'not_planned'; i.updated_at = new Date(x.clock).toISOString();
      x.comments.push({ id: 9001, issue: taskIssue.number, body: 'Not needed this quarter', user: { login: 'pat' }, created_at: i.updated_at, updated_at: i.updated_at });
    });
    clock.advance(1000);
    await e.syncTick({ projectDir: h.repo }, d);
    const sc = inboxFiles(h.home, "tracker.status_change");
    assert.equal(sc.length, 1);
    assert.equal(sc[0].payload.class, 'cancel');
    assert.equal(sc[0].payload.remote_key, `#${taskIssue.number}`);
    const cm = inboxFiles(h.home, 'tracker.comment');
    assert.equal(cm.length, 1);
    assert.equal(cm[0].payload.author_id, 'pat');

    // local done on the goal closes it as completed
    (await lib('store')).update(h.home, 'goal', g.id, (x) => { x.status = 'done'; });
    clock.advance(1000);
    await e.syncTick({ projectDir: h.repo }, d);
    s = gs.read();
    const gi = s.issues.find((i) => i.number === goalIssue.number);
    assert.equal(gi.state, 'closed');
    assert.equal(gi.state_reason, 'completed');
  } finally {
    delete process.env.FACTORY_GH; delete process.env.FAKE_GH_STATE;
  }
});

test('GitHub: a secondary rate limit from gh sets a backoff', async () => {
  const h = await syncHome({ provider: 'github' });
  await seed(h.home);
  const gs = ghState(h.root);
  process.env.FACTORY_GH = FAKE_GH;
  process.env.FAKE_GH_STATE = gs.file;
  try {
    const e = await core('engine');
    const d = { env: { SF_SYNC_ENABLED: 'true' }, sleep: async () => {} };
    await approveFirstSync(h.home);
    await e.syncTick({ projectDir: h.repo }, d); // discovery + first pull + creates
    gs.edit((x) => { x.failNext = [{ code: 403, msg: 'You have exceeded a secondary rate limit' }]; });
    await e.syncTick({ projectDir: h.repo }, d);
    const st = readSync(h.home, 'state.json');
    assert.ok(st.backoff_until && Date.parse(st.backoff_until) > Date.now());
  } finally {
    delete process.env.FACTORY_GH; delete process.env.FAKE_GH_STATE;
  }
});
