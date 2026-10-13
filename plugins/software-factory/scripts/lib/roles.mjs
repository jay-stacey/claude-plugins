// Static role facts: default model, isolation, slot class; task kind -> default role.

export const ROLE_INFO = {
  cto: { model: 'opus', isolation: 'none', slot: 'planners' },
  'product-manager': { model: 'opus', isolation: 'none', slot: 'planners' },
  'project-manager': { model: 'sonnet', isolation: 'none', slot: 'planners' },
  'staff-engineer': { model: 'opus', isolation: 'none', slot: 'planners' },
  'ui-ux-designer': { model: 'sonnet', isolation: 'none', slot: 'planners' },
  'data-engineer': { model: 'sonnet', isolation: 'worktree', slot: 'builders' },
  'backend-engineer': { model: 'sonnet', isolation: 'worktree', slot: 'builders' },
  'frontend-engineer': { model: 'sonnet', isolation: 'worktree', slot: 'builders' },
  'devops-release': { model: 'sonnet', isolation: 'worktree', slot: 'builders' },
  'tech-writer': { model: 'sonnet', isolation: 'worktree', slot: 'builders' },
  'qa-engineer': { model: 'sonnet', isolation: 'worktree', slot: 'reviewers' },
  'code-reviewer': { model: 'sonnet', isolation: 'worktree', slot: 'reviewers' },
  'security-reviewer': { model: 'sonnet', isolation: 'worktree', slot: 'reviewers' },
  critic: { model: 'opus', isolation: 'none', slot: 'reviewers' },
};

export const KIND_ROLE = {
  intake: 'cto', prd: 'product-manager', spec: 'staff-engineer', mockup: 'ui-ux-designer', breakdown: 'staff-engineer',
  sequence: 'project-manager', code: 'backend-engineer', docs: 'tech-writer', qa_epic: 'qa-engineer',
  review_epic: 'code-reviewer', qa_goal: 'qa-engineer', pr_feedback: 'staff-engineer', escalation: 'cto', research: 'staff-engineer',
  assess: 'cto', report: 'cto', cycle_plan: 'cto', triage: 'staff-engineer',
};

/** Standing CTO work in the ops goal (contracts §21.1): dispatched as run kind escalation. */
export const OPS_KINDS = new Set(['assess', 'report', 'cycle_plan']);

export const CODE_ROLES = ['backend-engineer', 'frontend-engineer', 'data-engineer', 'devops-release'];

/** Kinds whose work lives on a git branch. */
export const BRANCH_KINDS = new Set(['code', 'docs']);
/** Kinds that inspect integrated branches (detached). `qa_goal` spans every epic of a goal (§20.6). */
export const EPIC_CHECK_KINDS = new Set(['qa_epic', 'review_epic', 'qa_goal']);
export const PLANNING_KINDS = new Set(['intake', 'breakdown', 'sequence', 'escalation', 'research', 'pr_feedback']);
export const GATE_KINDS = { prd: 'G1', spec: 'G2', mockup: 'G3' };

export function subagentType(role) { return `software-factory:${role}`; }

/** Agent types that are part of the plugin but never factory runs. */
export const NON_RUN_AGENTS = new Set(['software-factory:setup-interviewer']);

export function isFactoryRunAgent(agentType) {
  return typeof agentType === 'string' && agentType.startsWith('software-factory:') && !NON_RUN_AGENTS.has(agentType);
}

export function estimateFor(cfg, task, runKind) {
  const e = cfg.budget.estimates || {};
  if (runKind === 'fixup') return e.fixup ?? 150000;
  if (runKind === 'review') return e.review ?? 150000;
  if (runKind === 'qa') return e.qa ?? 300000;
  if (runKind === 'integrate') return e.fixup ?? 150000;
  if (task.estimate_tokens) return task.estimate_tokens;
  switch (task.kind) {
    case 'code': return task.size === 'S' ? (e.code_S ?? 250000) : (e.code_M ?? 600000);
    case 'qa_epic': return e.qa ?? 300000;
    case 'qa_goal': return e.qa_goal ?? 400000;
    case 'review_epic': return e.review ?? 150000;
    case 'pr_feedback': return e.breakdown ?? 300000;
    case 'research': return e.spec ?? 500000;
    default: return e[task.kind] ?? 200000;
  }
}
