// Handoff validation: the same checks `handoff validate` and `collect` run.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readLines } from './fsutil.mjs';
import * as store from './store.mjs';
import { validateHandoffShape } from './schema.mjs';
import { BRANCH_KINDS, EPIC_CHECK_KINDS } from './roles.mjs';

export function evidenceIds(home, runId) {
  return new Set(readLines(join(home, 'runs', runId, 'evidence', 'index.jsonl')).map((e) => e.id).filter(Boolean));
}

export function readHandoff(file) {
  try {
    const txt = readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(txt.charCodeAt(0) === 0xfeff ? txt.slice(1) : txt) };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? `handoff file not found: ${file}` : `handoff is not valid JSON: ${e.message}` };
  }
}

/** Validate a handoff. Returns {ok, errors[], handoff, run, task}. */
export function validateHandoff(home, file, { run = null } = {}) {
  const errors = [];
  const r = readHandoff(file);
  if (!r.ok) return { ok: false, errors: [r.error], handoff: null, run, task: null };
  const h = r.value;
  const shape = validateHandoffShape(h);
  errors.push(...shape.errors);
  const runId = run ? run.id : (h && h.run_id) || basename(dirname(file));
  run = run || store.get(home, 'run', runId);
  if (!run) { errors.push(`run ${runId} not found`); return { ok: false, errors, handoff: h, run: null, task: null }; }
  if (h.run_id && h.run_id !== run.id) errors.push(`run_id ${h.run_id} does not match ${run.id}`);
  const task = store.get(home, 'task', run.task_id);
  if (!task) errors.push(`task ${run.task_id} not found`);
  if (h.task_id && h.task_id !== run.task_id) errors.push(`task_id ${h.task_id} does not match ${run.task_id}`);
  if (h.from_role && h.from_role !== run.role) errors.push(`from_role ${h.from_role} does not match ${run.role}`);

  const isBench = !!run.review_role;
  const isEpicCheck = !!task && EPIC_CHECK_KINDS.has(task.kind);
  if ((isBench || isEpicCheck) && h.status === 'handed_off' && !['pass', 'fail', 'escalate'].includes(h.verdict)) {
    errors.push('verdict: reviewers and QA must give pass, fail or escalate');
  }
  if (h.status === 'blocked' && !(h.open_questions || []).some((q) => q && q.blocking)) {
    errors.push('open_questions: a blocked handoff needs at least one blocking question');
  }
  const ev = evidenceIds(home, run.id);
  for (const id of h.evidence || []) if (!ev.has(id)) errors.push(`evidence ${id} not found in runs/${run.id}/evidence/index.jsonl`);
  if (task && !isBench && h.status === 'handed_off' && run.kind !== 'integrate' && run.kind !== 'escalation') {
    const want = (task.acceptance_criteria || []).map((a) => a.id);
    const got = new Map((h.acceptance_criteria || []).map((a) => [a && a.id, a]));
    for (const id of want) if (!got.has(id)) errors.push(`acceptance_criteria: ${id} missing`);
    for (const id of got.keys()) if (id && !want.includes(id)) errors.push(`acceptance_criteria: ${id} is not a criterion of ${task.id}`);
    const needEvidence = BRANCH_KINDS.has(task.kind);
    for (const a of h.acceptance_criteria || []) {
      if (!a) continue;
      for (const id of a.evidence || []) if (!ev.has(id)) errors.push(`acceptance_criteria ${a.id}: evidence ${id} not found`);
      if (needEvidence && a.met && !(a.evidence || []).length) errors.push(`acceptance_criteria ${a.id}: met without evidence`);
    }
    if (BRANCH_KINDS.has(task.kind) && task.branch && h.branch && h.branch !== task.branch) {
      errors.push(`branch ${h.branch} does not match ${task.branch}`);
    }
  }
  if ((isBench || isEpicCheck) && h.status === 'handed_off') {
    if (!h.report_path) errors.push('report_path: required for reviewers and QA');
    else {
      const abs = isAbsolute(h.report_path) ? h.report_path : join(home, h.report_path);
      if (!existsSync(abs)) errors.push(`report_path ${h.report_path} does not exist`);
    }
  }
  if (h.risk_flags !== undefined && !(Array.isArray(h.risk_flags) && h.risk_flags.every((x) => typeof x === 'string'))) {
    errors.push('risk_flags: must be an array of strings');
  }
  return { ok: errors.length === 0, errors, handoff: h, run, task };
}
