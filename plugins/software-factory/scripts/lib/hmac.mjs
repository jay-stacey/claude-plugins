// HMAC key and signatures for human-authority inbox requests.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDir, readJson } from './fsutil.mjs';

export function homeHash(home) {
  let h = resolve(home).replace(/\\/g, '/');
  if (process.platform === 'win32') h = h.toLowerCase();
  return createHash('sha256').update(h).digest('hex').slice(0, 16);
}

export function keyPath(home, pluginDataDir) {
  return join(pluginDataDir, 'hmac', `${homeHash(home)}.key`);
}

/** Plugin data dir: explicit > FACTORY_PLUGIN_DATA > run/machine.json > CLAUDE_PLUGIN_DATA. */
export function pluginDataDir(home, given) {
  if (given) return given;
  if (process.env.FACTORY_PLUGIN_DATA) return process.env.FACTORY_PLUGIN_DATA;
  const m = home ? readJson(join(home, 'run', 'machine.json'), null) : null;
  if (m && m.plugin_data) return m.plugin_data;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return null;
}

export function getKey(home, { pluginDataDir: given, create = true } = {}) {
  const dir = pluginDataDir(home, given);
  if (!dir) {
    const e = new Error('plugin data dir unknown (run a Claude Code session once so the SessionStart hook writes run/machine.json)');
    e.exitCode = 1; throw e;
  }
  const file = keyPath(home, dir);
  if (!existsSync(file)) {
    if (!create) { const e = new Error('hmac key missing'); e.exitCode = 1; throw e; }
    ensureDir(join(dir, 'hmac'));
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function signingString(req) {
  return `${req.type}\n${canonicalJson(req.payload ?? {})}\n${req.id}`;
}

export function sign(req, key) {
  return createHmac('sha256', key).update(signingString(req)).digest('hex');
}

export function verify(req, key) {
  if (!req || typeof req.sig !== 'string' || !/^[0-9a-f]{64}$/i.test(req.sig)) return false;
  const want = Buffer.from(sign(req, key), 'hex');
  const got = Buffer.from(req.sig, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
