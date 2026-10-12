// Brief rendering: markdown with a ```json front block of every brief field plus readable sections.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextAtomic, readJson } from './fsutil.mjs';
import * as store from './store.mjs';
import { load as loadConfig } from './config.mjs';
import { cliPath, fwd } from './paths.mjs';
import * as repos from './repos.mjs';
import { goalDocsRel } from './actions.mjs';
import { BRANCH_KINDS, EPIC_CHECK_KINDS } from './roles.mjs';
import { OUTBOX_DIR, usesOutbox, agentHandoffPath } from './outbox.mjs';

const OVERLAY_MAX = 150;

function abs(home, rel) { return fwd(join(home, rel)); }

/** Output paths relative to the factory home (contracts �15.2). */
export function outputPaths(home, run, task, goal) {
  const docs = goalDocsRel(goal);
  const r = run.round || 1;
  if (run.review_role) {
    if (BRANCH_KINDS.has(task.kind)) {
      if (run.review_role === 'qa-engineer') return [`${docs}/qa/${task.id}-r${r}.md`];
      return [`${docs}/reviews/${task.id}-${run.review_role}-r${r}.md`];
    }
    return [`${docs}/critique/${task.id}-${run.review_role}-r${r}.md`];
  }
  switch (task.kind) {
    case 'prd': return [`${docs}/prd.md`];
    case 'spec': return [`${docs}/spec.md`];
    case 'mockup': return [`${docs}/design/`];
    case 'sequence': return [`${docs}/plan.md`];
    case 'research': return [`${docs}/research-${task.id}.md`];
    case 'qa_epic': return [`${docs}/qa/${task.epic_id}.md`];
    case 'qa_goal': return [`${docs}/qa/${goal.id}-goal.md`];
    case 'review_epic': return [`${docs}/reviews/${task.epic_id}.md`];
    case 'docs': return [`${docs}/release-notes.md`];
    case 'escalation': case 'intake': case 'breakdown': case 'pr_feedback':
      return [`${docs}/questions/`];
    default: return [];
  }
}

/** The CLI makes every worktree (contracts §20.4), so every worktree run starts with `worktree prepare`. */
export function needsSetup(run, task) {
  if (run.kind === 'integrate') return true;
  if (BRANCH_KINDS.has(task.kind) || EPIC_CHECK_KINDS.has(task.kind)) return run.isolation === 'worktree';
  return false;
}

function pickCommands(c) {
  return { build: c.build ?? null, test: c.test ?? null, lint: c.lint ?? null, typecheck: c.typecheck ?? null, run: c.run ?? null, e2e: c.e2e ?? null, screenshot: c.screenshot ?? null };
}

function readOverlay(home, role) {
  const f = join(home, 'roles', `${role}.md`);
  if (!existsSync(f)) return { path: null, text: null, truncated: false };
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  return { path: fwd(f), text: lines.slice(0, OVERLAY_MAX).join('\n'), truncated: lines.length > OVERLAY_MAX };
}

/** Build the brief object (all fields) for a run. */
export function briefFields(home, run, { cfg = loadConfig(home) } = {}) {
  const task = store.mustGet(home, 'task', run.task_id);
  const goal = store.mustGet(home, 'goal', run.goal_id);
  const epic = run.epic_id ? store.get(home, 'epic', run.epic_id) : null;
  const cli = fwd(cliPath());
  const handoffPath = run.handoff_path || abs(home, `runs/${run.id}/handoff.json`);
  const docs = goalDocsRel(goal);
  const isReviewer = !!run.review_role;
  const overlay = readOverlay(home, run.role);
  let checksResult = null;
  if (isReviewer && BRANCH_KINDS.has(task.kind) && task.checked_run_id) {
    const res = readJson(join(home, 'run', 'checks', `${task.checked_run_id}.json`), null);
    checksResult = { status: res ? res.status : (task.checks_status || null), evidence_index: abs(home, `runs/${task.checked_run_id}/evidence/index.jsonl`) };
  }
  let integrate = null;
  let filesOwned = task.files_owned;
  if (run.kind === 'integrate') {
    integrate = { epic_branch: epic ? epic.branch : null, task_branches: [task.branch], conflict_files: task.conflict_files || [] };
    filesOwned = task.conflict_files || [];
  }
  const ws = repos.isWorkspace(cfg);
  const repo = repos.forRecord(home, cfg, { task, epic, run });
  const H = fwd(home); // every CLI string names the home, so agents never depend on home lookup
  const setup = needsSetup(run, task) ? `node "${cli}" worktree prepare --run ${run.id} --home "${H}"` : null;
  const headSha = run.head_sha || null;
  const worktree = run.worktree_path ? fwd(run.worktree_path) : null;
  const goalQa = task.kind === 'qa_goal';
  const extra = {};
  if (goalQa) {
    extra.repo_worktrees = run.repo_worktrees || [];
    extra.commands_by_repo = {};
    for (const rw of extra.repo_worktrees) {
      try { extra.commands_by_repo[rw.repo] = pickCommands(repos.get(home, cfg, rw.repo).commands); } catch { /* unknown repo */ }
    }
  }
  if (ws) {
    extra.repos = repos.list(home, cfg).map((r) => ({ name: r.name, path: r.path, stack: r.stack, base_branch: r.delivery.base_branch }));
  }
  return {
    run_id: run.id, task_id: task.id, goal_id: goal.id, epic_id: run.epic_id || null, role: run.role,
    kind: task.kind, run_kind: run.kind, review_role: run.review_role || null, tier: goal.tier, round: run.round,
    attempt: task.attempts, factory_home: fwd(home), cli,
    constitution: abs(home, 'constitution.md'), overlay: overlay.path,
    goal_title: goal.title, goal_outcome: goal.outcome, success_criteria: goal.success_criteria,
    title: task.title, description: task.description,
    acceptance_criteria: task.acceptance_criteria, ac_version: task.ac_version,
    files_owned: filesOwned, files_shared: task.files_shared, files_read: task.files_read, risk_flags: task.risk_flags || [],
    setup, worktree, cd_prefix: worktree ? `cd "${worktree}" && ` : null,
    workspace: ws,
    repo: (run.repo || worktree || !ws) && !goalQa ? { name: repo.name, path: repo.path, base_branch: repo.delivery.base_branch } : null,
    validate: usesOutbox(run) ? `node "${cli}" handoff validate --run ${run.id} --home "${H}"` : `node "${cli}" handoff validate "${handoffPath}" --home "${H}"`,
    outbox: usesOutbox(run) ? `${worktree || '<worktree>'}/${OUTBOX_DIR}/` : null,
    base_ref: task.base_ref || (epic ? epic.branch : null), branch: task.branch || null, head_sha: headSha,
    merge_first: run.merge_first || [],
    evidence_required: BRANCH_KINDS.has(task.kind) && !isReviewer,
    evidence_cmd: `node "${cli}" evidence run --run ${run.id} --home "${H}" --label <label> -- <command>`,
    commands: pickCommands(repo.commands),
    diff_cmd: isReviewer && BRANCH_KINDS.has(task.kind) && task.base_ref && headSha ? `git diff ${task.base_ref}...${headSha}` : null,
    checks_result: checksResult, integrate,
    artifacts: {
      prd: abs(home, `${docs}/prd.md`), spec: abs(home, `${docs}/spec.md`), design: abs(home, `${docs}/design/`),
      plan: abs(home, `${docs}/plan.md`),
    },
    output_paths: run.output_paths || outputPaths(home, run, task, goal),
    run_dir: abs(home, `runs/${run.id}/`),
    feedback: (task.feedback || []).slice(-10), answers: task.answers || [], resume_from: task.resume_from || null,
    findings_open: isReviewer ? [] : (task.findings || []).filter((f) => f.round === (task.rework_count || 0) && ['blocker', 'major'].includes(f.severity)).slice(0, 20),
    handoff_path: agentHandoffPath(run, handoffPath), to_role: 'cto', token_hint: run.estimate_tokens,
    ...extra,
    _overlay: overlay,
  };
}

export function renderText(b) {
  const { _overlay: overlay, ...fields } = b;
  const L = [];
  L.push(`# Brief ${b.run_id}: [${b.task_id}] ${b.title}`, '');
  L.push('```json', JSON.stringify(fields, null, 2), '```', '');
  L.push(`Role: ${b.role}. Run kind: ${b.run_kind}${b.review_role ? ` (reviewing as ${b.review_role})` : ''}. Round ${b.round}, attempt ${b.attempt}.`, '');
  L.push('## Start', '');
  L.push('Paths in output_paths are relative to factory_home. Commit with a plain `git commit -m "<message>"`; never use `$(...)`, backticks or heredocs.');
  L.push(`1. Read the constitution: ${b.constitution}`);
  L.push(`2. Read your overlay${b.overlay ? `: ${b.overlay} (inlined below)` : ': none for this repo'}.`);
  L.push(b.setup ? `3. Run setup first: \`${b.setup}\`` : '3. No setup command: work from the main checkout, read only.');
  if (b.worktree) {
    L.push(`4. Your worktree is ${b.worktree}. Your shell may not keep its folder between calls, so start every Bash command with \`${b.cd_prefix}\` (for example \`${b.cd_prefix}git status\`). Use absolute paths under the worktree with Read, Edit and Write.`);
  }
  L.push('');
  if (b.workspace && b.repos) {
    L.push('## Repos', '', 'This factory drives several repos in one workspace:', ...b.repos.map((r) => `- ${r.name}: ${r.path} (${(r.stack || []).join(', ') || 'no stack'}, base ${r.base_branch})`));
    if (b.repo) L.push('', `This run works in repo ${b.repo.name} only.`);
    L.push('');
  }
  if (b.repo_worktrees && b.repo_worktrees.length) {
    L.push('## Repo worktrees', '', `Setup makes one detached worktree per epic under ${b.worktree}. Test the joined flow across them; never write in them, only in your outbox.`);
    for (const rw of b.repo_worktrees) {
      const c = (b.commands_by_repo || {})[rw.repo] || {};
      L.push(`- ${rw.repo} (${rw.epic_id}, ${rw.branch}): ${rw.path}${c.run ? `; run: \`${c.run}\`` : ''}${c.test ? `; test: \`${c.test}\`` : ''}`);
    }
    L.push('');
  }
  L.push('## Goal', '', b.goal_outcome, '');
  L.push('## Task', '', b.description || b.title, '');
  if (b.acceptance_criteria.length) {
    L.push('## Acceptance criteria', '');
    for (const a of b.acceptance_criteria) L.push(`- ${a.id}: ${a.text}`);
    L.push('');
  }
  if (b.files_owned.length || b.files_shared.length) {
    L.push('## Files', '', `Owned: ${b.files_owned.join(', ') || 'none'}`, `Shared: ${b.files_shared.join(', ') || 'none'}`, '');
  }
  if (b.outbox) {
    L.push('## Write only here', '',
      b.worktree
        ? `Write every factory output inside your worktree's outbox folder \`${b.outbox}\`. The factory moves these files into place after you finish. The outbox is git-ignored, so never commit it.`
        : `You work in a git worktree, and you cannot write files outside it. Write every factory output inside your worktree's outbox folder \`${OUTBOX_DIR}/\`. Replace \`<worktree>\` with the worktree path that setup printed (the PREPARED line). The factory moves these files into place after you finish. The outbox is git-ignored, so never commit it.`,
      ...b.output_paths.map((p) => `- ${b.outbox}${p}`), `- ${b.outbox}handoff.json`, '');
  } else if (b.output_paths.length) {
    L.push('## Write only here', '', ...b.output_paths.map((p) => `- ${b.factory_home}/${p}`), `- ${b.run_dir}`, '');
  }
  if (b.diff_cmd) L.push('## Review', '', `Diff: \`${b.diff_cmd}\``, '');
  if (b.checks_result) L.push(`CLI checks: ${b.checks_result.status}. Evidence: ${b.checks_result.evidence_index}`, '');
  if (b.integrate) L.push('## Integrate', '', `Merge ${b.integrate.epic_branch} into ${b.integrate.task_branches.join(', ')} and resolve: ${b.integrate.conflict_files.join(', ') || '(see git status)'}`, '');
  if (b.feedback.length) {
    L.push('## Feedback to address', '');
    for (const f of b.feedback) L.push(`- ${f.source}${f.ref ? ` (${f.ref})` : ''}: ${f.text || ''}${f.path ? ` See ${f.path}` : ''}`);
    L.push('');
  }
  if (b.answers.length) L.push('## Answers', '', ...b.answers.map((a) => `- ${a.question_id || 'note'}: ${a.text}`), '');
  if (b.resume_from) L.push('## Resume', '', `Continue from ${b.resume_from.branch} at ${b.resume_from.commit}.${b.resume_from.checkpoint_path ? ` Notes: ${b.resume_from.checkpoint_path}` : ''}`, '');
  L.push('## Finish', '');
  if (b.evidence_required) L.push(`- Record proof with: \`${b.evidence_cmd}\``);
  L.push(`- Write your handoff JSON to: ${b.handoff_path}`);
  L.push(`- Validate it: \`${b.validate}\``);
  L.push(`- Reply with one line: HANDOFF ${b.handoff_path} <status>`, '');
  if (overlay && overlay.text) {
    L.push(`## Overlay (${b.role})`, '', overlay.text);
    if (overlay.truncated) L.push('', `(overlay cut at ${OVERLAY_MAX} lines; read the rest at ${overlay.path})`);
    L.push('');
  }
  return L.join('\n');
}

/** Render runs/<id>/brief.md and return its absolute path. */
export function render(home, run, opts = {}) {
  const b = briefFields(home, run, opts);
  const file = join(home, 'runs', run.id, 'brief.md');
  writeTextAtomic(file, renderText(b));
  return file;
}

/** Parse the json front block back (tests, doctor). */
export function parseBrief(text) {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  return m ? JSON.parse(m[1]) : null;
}
