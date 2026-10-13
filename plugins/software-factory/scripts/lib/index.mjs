// state/index.json: a small denormalized view, patched on every mutation, rebuildable.
import { join } from 'node:path';
import { listDir, readJson, writeJsonAtomic, withMutex } from './fsutil.mjs';

const ACTIVE_RUN = new Set(['dispatching', 'running', 'suspect']);

export function emptyIndex() {
  return { rev: 0, goals: {}, epics: {}, tasks: {}, runs_active: [], gates_pending: [] };
}

function entry(kind, rec) {
  switch (kind) {
    case 'goal': return { status: rec.status, title: rec.title, priority: rec.priority, kind: rec.kind || 'goal' };
    case 'epic': return { goal_id: rec.goal_id, status: rec.status, repo: rec.repo || null };
    case 'task': return {
      goal_id: rec.goal_id, epic_id: rec.epic_id, repo: rec.repo || null, team: rec.team || null, status: rec.status, role: rec.role, kind: rec.kind,
      priority: rec.priority, depends_on: rec.depends_on, gate_deps: rec.gate_deps, files_owned: rec.files_owned,
      current_run_id: rec.current_run_id, updated_at: rec.updated_at,
    };
    default: return null;
  }
}

function apply(idx, kind, rec) {
  if (kind === 'goal') idx.goals[rec.id] = entry(kind, rec);
  else if (kind === 'epic') idx.epics[rec.id] = entry(kind, rec);
  else if (kind === 'task') idx.tasks[rec.id] = entry(kind, rec);
  else if (kind === 'run') {
    const set = new Set(idx.runs_active);
    if (ACTIVE_RUN.has(rec.status)) set.add(rec.id); else set.delete(rec.id);
    idx.runs_active = [...set].sort();
  } else if (kind === 'gate') {
    const set = new Set(idx.gates_pending);
    if (rec.status === 'pending') set.add(rec.id); else set.delete(rec.id);
    idx.gates_pending = [...set].sort();
  }
}

export function indexPath(home) { return join(home, 'state', 'index.json'); }

export function readIndex(home) { return readJson(indexPath(home), null) || emptyIndex(); }

export function patchIndex(home, kind, rec) {
  withMutex(home, () => {
    const idx = readIndex(home);
    apply(idx, kind, rec);
    idx.rev = (idx.rev || 0) + 1;
    writeJsonAtomic(indexPath(home), idx);
  });
}

/** Full rebuild from record files. */
export function rebuild(home) {
  return withMutex(home, () => {
    const old = readIndex(home);
    const idx = emptyIndex();
    idx.rev = (old.rev || 0) + 1;
    const scan = (dir, prefix, kind, nested) => {
      for (const name of listDir(join(home, dir)).sort()) {
        if (!name.startsWith(prefix)) continue;
        const file = nested ? join(home, dir, name, 'run.json') : join(home, dir, name);
        if (!nested && !name.endsWith('.json')) continue;
        const rec = readJson(file, null);
        if (rec) apply(idx, kind, rec);
      }
    };
    scan('goals', 'G-', 'goal');
    scan('epics', 'E-', 'epic');
    scan('tasks', 'T-', 'task');
    scan('runs', 'R-', 'run', true);
    scan('gates', 'GATE-', 'gate');
    writeJsonAtomic(indexPath(home), idx);
    return idx;
  });
}
