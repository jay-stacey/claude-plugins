// doctor: environment and factory health. Warnings exit 0; failures exit 1 (4 when not initialized).
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './fsutil.mjs';
import { isInitialized, readFactory } from './state.mjs';
import { load as loadConfig, validateHome } from './config.mjs';
import { repoRoot } from './paths.mjs';
import { parseTranscript } from './usage.mjs';
import { rebuild } from './index.mjs';
import * as budget from './budget.mjs';
import * as deps from './deps.mjs';

// A tiny transcript in the format seen in Claude Code 2.1.x: two lines share one message.id, one synthetic, one torn.
export const SELFTEST = [
  '{"type":"user","message":{"role":"user","content":"FACTORY_RUN=R-000001 task=T-0001"},"timestamp":"2026-10-12T10:00:00Z"}',
  '{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_a","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"timestamp":"2026-10-12T10:00:01Z"}',
  '{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_a","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}},"timestamp":"2026-10-12T10:00:02Z"}',
  '{"type":"assistant","message":{"model":"<synthetic>","id":"msg_s","usage":{"input_tokens":999,"output_tokens":999}}}',
  '{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_b","content":[{"type":"text","text":"HANDOFF C:/x/handoff.json handed_off"}],"usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
  '{"type":"assistant","message":{"model":"claude-son',
].join('\n') + '\n';

export function parserSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'sfdoc-'));
  try {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, SELFTEST);
    const r = parseTranscript(f);
    const m = r.by_model['claude-sonnet-5'];
    const ok = r.requests === 2 && r.bad_lines === 1 && m && m.input === 11 && m.output === 9 && m.cache_read === 100 && m.cache_creation === 20 && !r.by_model['<synthetic>'];
    return { ok, detail: ok ? 'transcript parser ok' : `transcript parser mismatch: ${JSON.stringify({ requests: r.requests, bad: r.bad_lines, m })}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Returns {lines[], exitCode}. */
export async function doctor(home, { quick = false, reindex = false } = {}) {
  const out = [];
  let fail = false; let notInit = false;
  const ok = (m) => out.push(`ok   ${m}`);
  const warn = (m) => out.push(`warn ${m}`);
  const bad = (m) => { out.push(`fail ${m}`); fail = true; };
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`node ${process.versions.node}`); else bad(`node ${process.versions.node}; need >= 20`);
  const g = runGit(['--version'], process.cwd());
  if (g.code === 0) ok(g.stdout.trim()); else bad('git not found on PATH');
  if (!home) { bad('not inside a git repository'); return { lines: out, exitCode: 1 }; }
  if (!isInitialized(home)) {
    out.push(`fail factory not initialized at ${home}; run /software-factory:setup`);
    notInit = true;
    return { lines: out, exitCode: 4 };
  }
  ok(`factory home ${home.replace(/\\/g, '/')}`);
  const f = readFactory(home);
  if (f) ok(`factory ${f.status}, tick ${f.tick.count}`); else bad('state/factory.json unreadable');
  const v = validateHome(home);
  if (v.ok) ok('config valid'); else bad(`config invalid: ${v.errors.slice(0, 3).join('; ')}`);
  let cfg = null;
  try { cfg = loadConfig(home); } catch (e) { bad(`config load: ${e.message}`); }
  const root = repoRoot(home);
  if (process.platform === 'win32') {
    const len = root.length + 60;
    const lp = runGit(['config', '--get', 'core.longpaths'], root).stdout.trim();
    if (len > 240 && lp !== 'true') warn(`repo path is long (${root.length} chars); worktrees may fail. Run: git config core.longpaths true`);
    else ok(`path length ${root.length} chars`);
    if (/onedrive/i.test(root)) warn('repo is inside OneDrive; file locks can break worktrees');
  }
  if (cfg && cfg.delivery.mode === 'github' && !quick) {
    try {
      const gh = await deps.load('gh');
      const a = gh.available();
      if (a.ok) ok(`gh logged in${a.user ? ` as ${a.user}` : ''}`); else warn(`gh not ready (${a.reason}); set delivery.mode local or run gh auth login`);
    } catch (e) { warn(`gh check failed: ${e.message}`); }
  }
  if (!quick) {
    const st = parserSelfTest();
    if (st.ok) ok(st.detail); else warn(st.detail);
  }
  if (reindex) {
    rebuild(home);
    budget.compute(home);
    ok('index and budget rebuilt');
  }
  void notInit;
  return { lines: out, exitCode: fail ? 1 : 0 };
}
