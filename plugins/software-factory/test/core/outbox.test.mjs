import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importOutbox, usesOutbox, agentHandoffPath } from '../../scripts/lib/outbox.mjs';

test('importOutbox copies the handoff and allowed outputs, skips the rest, removes the outbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'sfob-'));
  const home = join(root, 'h');
  const wt = join(root, 'wt');
  mkdirSync(join(wt, '.factory-out', 'docs', 'G-001-x', 'reviews'), { recursive: true });
  writeFileSync(join(wt, '.factory-out', 'handoff.json'), '{"run_id":"R-000009"}');
  writeFileSync(join(wt, '.factory-out', 'docs', 'G-001-x', 'reviews', 'T-0001-code-reviewer-r1.md'), '# Review');
  writeFileSync(join(wt, '.factory-out', 'state.json'), '{}');
  const run = { id: 'R-000009', isolation: 'worktree', worktree_path: wt, output_paths: ['docs/G-001-x/reviews/T-0001-code-reviewer-r1.md'] };
  const r = importOutbox(home, run);
  assert.equal(r.handoff, true);
  assert.deepEqual(r.skipped, ['state.json']);
  assert.equal(readFileSync(join(home, 'runs', 'R-000009', 'handoff.json'), 'utf8'), '{"run_id":"R-000009"}');
  assert.ok(existsSync(join(home, 'docs', 'G-001-x', 'reviews', 'T-0001-code-reviewer-r1.md')));
  assert.equal(existsSync(join(home, 'state.json')), false);
  assert.equal(existsSync(join(wt, '.factory-out')), false);
});

test('folder output paths and non-worktree runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sfob-'));
  const home = join(root, 'h');
  const wt = join(root, 'wt');
  mkdirSync(join(wt, '.factory-out', 'docs', 'G-001-x', 'design'), { recursive: true });
  writeFileSync(join(wt, '.factory-out', 'docs', 'G-001-x', 'design', 'a.html'), '<p>x</p>');
  const r = importOutbox(home, { id: 'R-1', isolation: 'worktree', worktree_path: wt, output_paths: ['docs/G-001-x/design/'] });
  assert.deepEqual(r.imported, ['docs/G-001-x/design/a.html']);
  assert.equal(usesOutbox({ isolation: 'none' }), false);
  assert.equal(agentHandoffPath({ isolation: 'none' }, '/h/runs/R/handoff.json'), '/h/runs/R/handoff.json');
  assert.equal(agentHandoffPath({ isolation: 'worktree' }, '/h/runs/R/handoff.json'), '<worktree>/.factory-out/handoff.json');
  assert.deepEqual(importOutbox(home, { id: 'R-2', isolation: 'none' }), { imported: [], skipped: [], handoff: false });
});

test('imported handoff report_path is rewritten from the outbox to the factory home', async () => {
  const { toHomeRel } = await import('../../scripts/lib/outbox.mjs');
  assert.equal(toHomeRel('C:/x/wt/.factory-out/docs/G-001-x/reviews/T-1.md'), 'docs/G-001-x/reviews/T-1.md');
  assert.equal(toHomeRel(['C:', 'x', 'wt', '.factory-out', 'docs', 'a.md'].join(String.fromCharCode(92))), 'docs/a.md');
  assert.equal(toHomeRel('.factory-out/docs/a.md'), 'docs/a.md');
  assert.equal(toHomeRel('docs/a.md'), 'docs/a.md');
  const root = mkdtempSync(join(tmpdir(), 'sfob-'));
  const home = join(root, 'h');
  const wt = join(root, 'wt');
  mkdirSync(join(wt, '.factory-out', 'docs'), { recursive: true });
  writeFileSync(join(wt, '.factory-out', 'docs', 'r.md'), '# r');
  writeFileSync(join(wt, '.factory-out', 'handoff.json'), JSON.stringify({ run_id: 'R-3', report_path: `${wt.split(String.fromCharCode(92)).join('/')}/.factory-out/docs/r.md` }));
  importOutbox(home, { id: 'R-3', isolation: 'worktree', worktree_path: wt, output_paths: ['docs/r.md'] });
  const h = JSON.parse(readFileSync(join(home, 'runs', 'R-3', 'handoff.json'), 'utf8'));
  assert.equal(h.report_path, 'docs/r.md');
  assert.ok(existsSync(join(home, h.report_path)));
});
