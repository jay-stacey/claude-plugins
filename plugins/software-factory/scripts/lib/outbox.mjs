// Worktree outbox. Worktree runs write their handoff and reports to `<worktree>/.factory-out/`
// (contracts §17.1, §20.4.5). `collect` imports the files into the factory home before it validates the handoff.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fwd } from './paths.mjs';

export const OUTBOX_DIR = '.factory-out';

/** True when the run writes through a worktree outbox. */
export function usesOutbox(run) {
  return !!run && run.isolation === 'worktree';
}

export function outboxDir(run) {
  return run && run.worktree_path ? join(run.worktree_path, OUTBOX_DIR) : null;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(fwd(relative(base, p)));
  }
  return out;
}

/** A path inside an outbox (`.../.factory-out/docs/x.md`) becomes home-relative (`docs/x.md`). */
export function toHomeRel(p) {
  if (typeof p !== 'string') return p;
  const s = p.replace(/\\/g, '/');
  const i = s.indexOf(`/${OUTBOX_DIR}/`);
  if (i >= 0) return s.slice(i + OUTBOX_DIR.length + 2);
  if (s.startsWith(`${OUTBOX_DIR}/`)) return s.slice(OUTBOX_DIR.length + 1);
  return p;
}

// Agents name their report by the outbox path they wrote. After the import that path is gone,
// so point the handoff at the imported copy under the factory home.
function rewriteOutboxPaths(handoffFile) {
  try {
    const h = JSON.parse(readFileSync(handoffFile, 'utf8'));
    let changed = false;
    if (typeof h.report_path === 'string') {
      const r = toHomeRel(h.report_path);
      if (r !== h.report_path) { h.report_path = r; changed = true; }
    }
    if (changed) writeFileSync(handoffFile, `${JSON.stringify(h, null, 2)}\n`);
  } catch { /* an unparseable handoff is reported by validation */ }
}

function allowedOutput(rel, outputPaths) {
  return (outputPaths || []).some((o) => (o.endsWith('/') ? rel.startsWith(o) : rel === o));
}

/**
 * Copy `<worktree>/.factory-out/handoff.json` to the run folder, and every other file whose path
 * (relative to the outbox) matches one of the run's output paths to the same path under the home.
 * Files outside the output paths are skipped and reported. The outbox is removed afterwards.
 */
export function importOutbox(home, run) {
  const dir = outboxDir(run);
  const result = { imported: [], skipped: [], handoff: false };
  if (!usesOutbox(run) || !dir || !existsSync(dir)) return result;
  for (const rel of walk(dir)) {
    const src = join(dir, rel);
    if (rel === 'handoff.json') {
      const dest = join(home, 'runs', run.id, 'handoff.json');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      rewriteOutboxPaths(dest);
      result.handoff = true;
      result.imported.push(rel);
    } else if (rel.startsWith('qa/')) {
      // QA check scripts are kept with the run as part of its evidence.
      const dest = join(home, 'runs', run.id, 'qa-scripts', rel.slice(3));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      result.imported.push(rel);
    } else if (allowedOutput(rel, run.output_paths)) {
      const dest = join(home, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      result.imported.push(rel);
    } else {
      result.skipped.push(rel);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

/** The handoff path an agent should write to, as shown in its brief. Runs from before A9 keep the placeholder. */
export function agentHandoffPath(run, homeHandoffPath) {
  if (!usesOutbox(run)) return homeHandoffPath;
  return `${run.worktree_path ? fwd(run.worktree_path) : '<worktree>'}/${OUTBOX_DIR}/handoff.json`;
}
