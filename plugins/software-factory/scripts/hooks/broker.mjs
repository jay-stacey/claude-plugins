// PreToolUse broker: factory agents go through lib/broker.mjs decide(); the main session may not hand-edit state.
import { runHook, preToolDecision } from './_run.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

runHook('broker', async ({ payload, home, env }) => {
  const agentType = payload.agent_type;
  const tool = payload.tool_name;
  if (typeof agentType !== 'string' || !agentType.startsWith('software-factory:')) {
    if (payload.agent_id || !WRITE_TOOLS.has(tool)) return null;
    // Main session (or a non-factory subagent without agent_type): guard factory state files.
    const { resolve, relative, isAbsolute } = await import('node:path');
    const p = (payload.tool_input || {}).file_path || (payload.tool_input || {}).notebook_path;
    if (!p) return null;
    const abs = resolve(payload.cwd || process.cwd(), p);
    let rel = relative(home, abs).replace(/\\/g, '/');
    if (process.platform === 'win32') rel = relative(home.toLowerCase(), abs.toLowerCase()).replace(/\\/g, '/');
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    // An outbox is imported by collect as agent output (handoff, reports): never hand-written.
    if (/(^|\/)\.factory-out(\/|$)/i.test(rel)) {
      return preToolDecision('deny', 'software-factory: .factory-out/ is an agent outbox that collect imports; the main session may not write it');
    }
    // CLI-made worktrees live under the home (contracts §20.4); their files are repo files, not state.
    if (/^worktrees(\/|$)/i.test(rel)) return null;
    if (/^(state|run|inbox)(\/|$)/i.test(rel) || /\.json$/i.test(rel)) {
      return preToolDecision('deny', 'software-factory: factory state is changed only through the factory CLI (node <plugin>/scripts/factory.mjs ...)');
    }
    return null;
  }
  const { isFactoryRunAgent } = await import('../lib/roles.mjs');
  const deps = await import('../lib/deps.mjs');
  const broker = await deps.load('broker');
  if (!isFactoryRunAgent(agentType)) {
    const r = broker.decide({ tool_name: tool, tool_input: payload.tool_input || {}, agent_type: agentType, agent_id: payload.agent_id }, {});
    return r.decision === 'pass' ? null : preToolDecision(r.decision, r.reason);
  }
  const store = await import('../lib/store.mjs');
  const { load } = await import('../lib/config.mjs');
  const { pluginRoot, cliPath } = await import('../lib/paths.mjs');
  const { pluginDataDir } = await import('../lib/hmac.mjs');
  const role = agentType.slice('software-factory:'.length);
  let run = payload.agent_id ? store.list(home, 'run', (r) => r.agent_id === payload.agent_id).pop() || null : null;
  if (!run) {
    const running = store.list(home, 'run', (r) => r.role === role && ['running', 'suspect', 'dispatching'].includes(r.status));
    run = running.sort((a, b) => String(a.dispatched_at).localeCompare(String(b.dispatched_at))).pop() || null;
  }
  const task = run ? store.get(home, 'task', run.task_id) : null;
  // Workspace mode (contracts §20): the broker picks the run's repo from task > epic > run.
  const epicId = (task && task.epic_id) || (run && run.epic_id) || null;
  const epic = epicId ? store.get(home, 'epic', epicId) : null;
  const ctx = {
    home, pluginRoot: env.CLAUDE_PLUGIN_ROOT || pluginRoot(), pluginDataDir: pluginDataDir(home, env.CLAUDE_PLUGIN_DATA) || null,
    cliPath: cliPath(), run, task, epic, config: load(home), role, worktreePath: run ? run.worktree_path || null : null,
    outputPaths: run ? run.output_paths || [] : [], cwd: payload.cwd || null,
    integrate: run && run.kind === 'integrate' ? { conflict_files: (task && task.conflict_files) || [] } : null,
  };
  const r = broker.decide({ tool_name: tool, tool_input: payload.tool_input || {}, agent_type: agentType, agent_id: payload.agent_id }, ctx);
  if (!r || r.decision === 'pass') return null;
  return preToolDecision(r.decision, r.reason);
});
