import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFor } from '../../scripts/lib/dispatch.mjs';
import { validateConfig } from '../../scripts/lib/schema.mjs';
import { defaults } from '../../scripts/lib/config.mjs';

test('config.models overrides role models, task override still wins', () => {
  const cfg = defaults();
  const task = { kind: 'code' };
  assert.equal(modelFor(cfg, task, 'backend-engineer', 'author'), 'sonnet');
  assert.equal(modelFor(cfg, { kind: 'review_epic' }, 'code-reviewer', 'review'), 'opus');
  cfg.models = { all: 'haiku', by_role: { 'staff-engineer': 'sonnet' } };
  assert.equal(modelFor(cfg, task, 'backend-engineer', 'author'), 'haiku');
  assert.equal(modelFor(cfg, { kind: 'review_epic' }, 'code-reviewer', 'review'), 'haiku');
  assert.equal(modelFor(cfg, task, 'staff-engineer', 'author'), 'sonnet');
  assert.equal(modelFor(cfg, { kind: 'code', model_override: 'opus' }, 'backend-engineer', 'author'), 'opus');
});

test('validateConfig checks models', () => {
  const cfg = defaults();
  assert.equal(validateConfig(cfg).ok, true);
  cfg.models = { all: 'gpt-4', by_role: {} };
  assert.equal(validateConfig(cfg).ok, false);
  cfg.models = { all: null, by_role: { 'not-a-role': 'haiku' } };
  assert.equal(validateConfig(cfg).ok, false);
  cfg.models = { all: 'claude-haiku-5-5', by_role: { critic: 'opus' } };
  assert.equal(validateConfig(cfg).ok, true);
});
