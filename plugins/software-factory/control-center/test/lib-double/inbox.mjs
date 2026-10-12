// Test stand-in for scripts/lib/inbox.mjs, used only while Team CORE's module is missing.
// Same signature as docs/module-api.md: write(home, fields, {sign, key}) -> req.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sign as hmacSign } from './hmac.mjs';

export const HUMAN_TYPES = ['gate.decide', 'goal.remove', 'factory.stop', 'budget.override'];

export function validate(req) {
  const errors = [];
  if (req.schema !== 'factory/inbox@1') errors.push('schema');
  if (!req.id || !req.type || !req.payload) errors.push('fields');
  return { ok: errors.length === 0, errors };
}

export function write(home, fields, { sign = false, key } = {}) {
  const now = new Date();
  const id = crypto.randomBytes(4).toString('hex');
  const req = {
    schema: 'factory/inbox@1', id, created_at: now.toISOString(), source: fields.source, actor: fields.actor,
    type: fields.type, payload: fields.payload, ...(fields.dedupe_key ? { dedupe_key: fields.dedupe_key } : {}),
    needs_confirmation: !!fields.needs_confirmation, auto_apply: !!fields.auto_apply,
  };
  if (sign) req.sig = hmacSign(req, key);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(home, 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${id}-${fields.type}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(req, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return req;
}
