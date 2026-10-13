#!/usr/bin/env node
// software-factory CLI. `node <P>/scripts/factory.mjs <cmd> ...`. Node >= 20, built-ins only.
// Exit codes: 0 ok, 1 validation, 2 usage, 3 lease held by another session, 4 not initialized, 5 rev conflict.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

const BOOL = new Set(['json', 'quick', 'reindex', 'takeover', 'now', 'stop', 'loop', 'discard', 'force', 'once', 'all-done', 'all', 'help', 'workspace', 'quiet']);
const MULTI = new Set(['criteria', 'constraint', 'depends']);

export function parseArgs(argv) {
  const pos = []; const flags = {}; let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      let k = a.slice(2); let v;
      const eq = k.indexOf('=');
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); } else if (BOOL.has(k)) v = true;
      else { v = argv[i + 1]; i++; if (v === undefined) throw usage(`--${k} needs a value`); }
      if (MULTI.has(k)) (flags[k] = flags[k] || []).push(v); else flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags, rest };
}

function usage(msg) { const e = new Error(msg); e.exitCode = 2; return e; }
function fail(msg, code = 1) { const e = new Error(msg); e.exitCode = code; return e; }

const lib = async (name) => import(`./lib/${name}.mjs`);

function readJsonFile(file) {
  if (!file) throw usage('--file is required');
  try { return JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^﻿/, '')); } catch (e) { throw fail(`cannot read JSON ${file}: ${e.message}`); }
}

function parseValue(s) { try { return JSON.parse(s); } catch { return s; } }

function out(ctx, lines, obj) {
  if (ctx.json) { process.stdout.write(JSON.stringify(obj ?? lines, null, 2) + '\n'); return; }
  const arr = Array.isArray(lines) ? lines : [lines];
  if (arr.length) process.stdout.write(arr.join('\n') + '\n');
}

function short(rec, kind) {
  if (kind === 'task') return `${rec.id} ${rec.status} ${rec.kind}/${rec.role}${rec.repo ? ` ${rec.repo}` : ''} ${rec.title}`;
  if (kind === 'goal') return `${rec.id} ${rec.status} ${rec.priority} ${rec.title}`;
  if (kind === 'epic') return `${rec.id} ${rec.status}${rec.repo ? ` ${rec.repo}` : ''} ${rec.branch} ${rec.title}`;
  if (kind === 'gate') return `${rec.id} ${rec.status} ${rec.type} ${rec.subject.kind} ${rec.subject.id || ''} ${rec.artifact.summary ? `- ${rec.artifact.summary.split('\n')[0].slice(0, 80)}` : ''}`.trim();
  if (kind === 'run') return `${rec.id} ${rec.status} ${rec.kind} ${rec.role} ${rec.task_id}`;
  return rec.id;
}

async function intentOk(home, ctx, command) {
  const { hasIntent } = await lib('intent');
  return hasIntent(home, ctx.session, command);
}

function needIntent(command) {
  return fail(`human intent required: type /software-factory:${command} yourself so the factory knows a person asked`);
}

// ---------------------------------------------------------------- commands
const COMMANDS = {
  async init(ctx) {
    const { init } = await lib('state');
    const created = init(ctx.home);
    const lines = [`INIT ${ctx.home.replace(/\\/g, '/')}`, ...(created.length ? [`created: ${created.join(', ')}`] : ['already initialized'])];
    let repoList = [];
    if (ctx.flags.workspace) {
      // Workspace mode (contracts §20.1): `.factory` in a plain folder of repos. `--repos a,b` registers
      // those sub-folders and turns workspace mode on; without it, setup merges the repos later.
      const cfg = await lib('config');
      const repos = await lib('repos');
      const { runGit } = await lib('fsutil');
      const root = dirname(resolve(ctx.home));
      repoList = String(ctx.flags.repos || '').split(',').map((s) => s.trim()).filter(Boolean);
      const patch = { workspace: { enabled: false } };
      if (repoList.length) {
        patch.repos = {};
        for (const name of repoList) {
          if (!repos.validName(name)) throw fail(`bad repo name ${name}`);
          const dir = join(root, name);
          const top = existsSync(dir) ? runGit(['rev-parse', '--show-toplevel'], dir) : null;
          if (!top || top.code !== 0) throw fail(`${name} is not a git repo under ${root.replace(/\\/g, '/')}`);
          const head = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
          patch.repos[name] = { path: name, ...(head.code === 0 && head.stdout.trim() ? { default_branch: head.stdout.trim() } : {}) };
        }
        const cur = cfg.readRaw(ctx.home) || {};
        patch.workspace = { enabled: true, default_repo: (cur.workspace && cur.workspace.default_repo) || repoList[0] };
      }
      cfg.merge(ctx.home, patch);
      lines.push(repoList.length ? `workspace: ${repoList.length} repos (${repoList.join(', ')})` : 'workspace: no repos yet; setup adds them');
    }
    out(ctx, lines, { home: ctx.home, created, workspace: !!ctx.flags.workspace, repos: repoList });
  },

  async doctor(ctx) {
    const { doctor } = await lib('doctor');
    const r = await doctor(ctx.homeMaybe, { quick: !!ctx.flags.quick, reindex: !!ctx.flags.reindex });
    out(ctx, r.lines, r);
    return r.exitCode;
  },

  async config(ctx) {
    const cfg = await lib('config');
    const [sub, key, val] = ctx.pos;
    if (sub === 'get') { const v = cfg.getKey(cfg.load(ctx.home), key); out(ctx, [JSON.stringify(v ?? null, null, 2)], v ?? null); return 0; }
    if (sub === 'set') { if (!key || val === undefined) throw usage('config set <key> <json>'); cfg.set(ctx.home, key, parseValue(val)); out(ctx, [`SET ${key}`]); return 0; }
    if (sub === 'merge') { cfg.merge(ctx.home, readJsonFile(key)); out(ctx, ['MERGED']); return 0; }
    if (sub === 'validate') {
      const v = cfg.validateHome(ctx.home);
      out(ctx, v.ok ? ['config valid'] : v.errors.map((e) => `invalid ${e}`), v);
      return v.ok ? 0 : 1;
    }
    throw usage('config get|set|merge|validate');
  },

  async setup(ctx) {
    const [sub, section, file] = ctx.pos;
    if (sub !== 'save' || !section || !file) throw usage('setup save <section> <file>');
    const { readJson, writeJsonAtomic } = await lib('fsutil');
    const { deepMerge } = await lib('config');
    const p = join(ctx.home, 'setup', 'answers.json');
    const cur = readJson(p, {}) || {};
    cur[section] = deepMerge(cur[section] || {}, readJsonFile(file));
    writeJsonAtomic(p, cur);
    out(ctx, [`SAVED ${section}`]);
  },

  async start(ctx) {
    if (!ctx.session) throw usage('--session is required');
    const c = await lib('control');
    const lines = c.start(ctx.home, { session: ctx.session, takeover: !!ctx.flags.takeover });
    // `start` collects the baseline every time and asks for an assessment (contracts §21.5.1).
    const cfg = (await lib('config')).load(ctx.home);
    if (cfg.baseline && cfg.baseline.enabled !== false) {
      try {
        const bl = await (await lib('baseline')).collect(ctx.home, { cfg });
        (await lib('state')).updateFactory(ctx.home, (s) => { s.baseline.assess_requested = true; });
        lines.splice(lines.length - 1, 0, `baseline collected (${Object.keys(bl.repos).length} repos); assessment requested`);
      } catch { /* the baseline never blocks start */ }
    }
    out(ctx, lines);
  },

  async pause(ctx) {
    const c = await lib('control');
    if (ctx.flags.stop && !(await intentOk(ctx.home, ctx, 'pause'))) throw needIntent('pause');
    const lines = c.pause(ctx.home, { mode: ctx.flags.now || ctx.flags.stop ? 'now' : 'drain', stop: !!ctx.flags.stop, goal: ctx.flags.goal || null, session: ctx.session });
    out(ctx, lines);
  },

  async resume(ctx) {
    const c = await lib('control');
    out(ctx, c.resume(ctx.home));
  },

  async status(ctx) {
    const s = await lib('status');
    out(ctx, s.lines(ctx.home, { goal: ctx.flags.goal || null }));
  },

  async sync(ctx) {
    const ss = await lib('syncstate');
    const sub = ctx.pos[0];
    if (sub === 'status') { out(ctx, ss.statusLines(ctx.home), ss.readState(ctx.home)); return 0; }
    if (sub === 'approve-preview') {
      if (!(await intentOk(ctx.home, ctx, 'sync-approve'))) throw needIntent('sync --approve-preview');
      const s = ss.approvePreview(ctx.home, ctx.flags.preview || null, { by: 'human' });
      const store = await lib('store');
      const { nowIso } = await lib('fsutil');
      for (const g of store.list(ctx.home, 'gate', (x) => x.type === 'tracker' && x.status === 'pending' && x.request && x.request.action === 'sync.first_sync')) {
        store.update(ctx.home, 'gate', g.id, (x) => { x.status = 'superseded'; x.decision = { by: 'human', via: 'cli', at: nowIso(), notes: 'approved with /software-factory:sync --approve-preview' }; });
      }
      out(ctx, [`APPROVED first sync (preview ${s.preview.id})`], s);
      return 0;
    }
    throw usage('sync status|approve-preview [--preview <id>]');
  },

  async tick(ctx) {
    const t = await lib('tick');
    const sub = ctx.pos[0];
    if (!ctx.session) throw usage('--session is required');
    let r;
    if (sub === 'begin') r = await t.begin(ctx.home, { session: ctx.session, force: !!ctx.flags.force });
    else if (sub === 'plan') r = await t.plan(ctx.home, { session: ctx.session });
    else if (sub === 'end') r = await t.end(ctx.home, { session: ctx.session, loop: !!ctx.flags.loop });
    else throw usage('tick begin|plan|end --session S');
    out(ctx, r.lines, r);
  },

  async goal(ctx) {
    const store = await lib('store');
    const a = await lib('actions');
    const [sub, id] = ctx.pos;
    const f = ctx.flags;
    switch (sub) {
      case 'new': {
        const g = a.newGoal(ctx.home, { title: f.title, outcome: f.outcome, success_criteria: f.criteria || [], priority: f.priority, budget_tokens: f.budget, constraints: f.constraint || [] });
        out(ctx, [g.id], g); return 0;
      }
      case 'show': { const g = store.mustGet(ctx.home, 'goal', id); out(ctx, [JSON.stringify(g, null, 2)], g); return 0; }
      case 'list': { const l = store.list(ctx.home, 'goal'); out(ctx, l.map((x) => short(x, 'goal')), l); return 0; }
      case 'impact': {
        const im = a.goalImpact(ctx.home, id);
        const b = (await lib('budget')).read(ctx.home);
        const slot = b.goals[id] || {};
        const gates = store.list(ctx.home, 'gate', (x) => x.goal_id === id && x.status === 'pending');
        out(ctx, [`${im.goal} ${im.status}`, `open tasks: ${im.tasks_open.length} ${im.tasks_open.slice(0, 10).join(' ')}`,
          `running agents: ${im.runs_active.length} ${im.runs_active.map((r) => r.run_id).join(' ')}`,
          `branches: ${im.branches.length} ${im.branches.slice(0, 6).join(' ')}`, `open PRs: ${im.prs.join(' ') || 'none'}`,
          `gates pending: ${gates.map((x) => x.id).join(' ') || 'none'}`, `tokens spent: ${slot.spent || 0} of ${slot.limit || 0}`], im);
        return 0;
      }
      case 'activate': a.activateGoal(ctx.home, id); out(ctx, [`ACTIVATED ${id}`]); return 0;
      case 'pause': a.setGoalPaused(ctx.home, id, true, 'paused by user'); out(ctx, [`PAUSED ${id}`]); return 0;
      case 'resume': a.setGoalPaused(ctx.home, id, false, 'resumed by user'); out(ctx, [`RESUMED ${id}`]); return 0;
      case 'remove': {
        if (f.confirm !== id) throw usage(`goal remove ${id} --confirm ${id}`);
        if (!(await intentOk(ctx.home, ctx, 'remove-goal'))) throw needIntent('remove-goal');
        const im = a.goalImpact(ctx.home, id);
        const lines = im.runs_active.map((r) => `STOP ${r.run_id} ${r.agent_id || 'unknown'}`);
        const r = a.removeGoal(ctx.home, id, { discard: !!f.discard });
        lines.push(`REMOVED ${id}; ${im.tasks_open.length} tasks cancelled; branches ${f.discard ? 'pending discard approval' : 'kept'}`);
        if (r.gate) lines.push(`GATE ${r.gate.id} destructive: approve the discard with /software-factory:approve`);
        out(ctx, lines, r); return 0;
      }
      case 'set': {
        // --tier/--needs-ui/--pod: the CTO run of this goal. --teams/--lead-team: any active CTO run (an
        // assessment in the ops goal reconciles teams across goals, contracts §21.5.5).
        const ctoRuns = store.list(ctx.home, 'run', (r) => r.role === 'cto' && ['dispatching', 'running', 'suspect'].includes(r.status));
        const goalOnly = f.tier !== undefined || f['needs-ui'] !== undefined || f.pod !== undefined;
        const runs = goalOnly ? ctoRuns.filter((r) => r.goal_id === id) : ctoRuns;
        const human = (await intentOk(ctx.home, ctx, 'approve')) || (await intentOk(ctx.home, ctx, 'pause'));
        if (!runs.length && !human) throw fail(goalOnly ? `goal set --tier/--needs-ui/--pod is for the CTO run of ${id}; no active cto run` : 'goal set --teams/--lead-team needs an active CTO run');
        const patch = {};
        if (f.tier !== undefined) patch.tier = f.tier;
        if (f['needs-ui'] !== undefined) patch.needs_ui = String(f['needs-ui']) === 'true';
        if (f.pod !== undefined) patch.pod = parseValue(f.pod);
        if (f.teams !== undefined) patch.teams = String(f.teams).split(',').map((s) => s.trim()).filter(Boolean);
        if (f['lead-team'] !== undefined) patch.lead_team = String(f['lead-team']).trim() || null;
        const g = a.setGoal(ctx.home, id, patch);
        const teamsTxt = patch.teams !== undefined || patch.lead_team !== undefined ? ` teams ${(g.teams || []).join(',') || '-'} lead ${g.lead_team || '-'}` : '';
        out(ctx, [`SET ${id} tier ${g.tier} needs_ui ${g.needs_ui} budget ${g.budget.limit_tokens}${teamsTxt}`], g); return 0;
      }
      default: throw usage('goal new|show|list|impact|activate|pause|resume|remove|set');
    }
  },

  async epic(ctx) {
    const store = await lib('store');
    const a = await lib('actions');
    const [sub, id] = ctx.pos;
    if (sub === 'new') {
      const e = a.newEpic(ctx.home, { goal_id: ctx.flags.goal, title: ctx.flags.title, summary: ctx.flags.summary || '', depends_on: ctx.flags.depends || [], repo: ctx.flags.repo || null, team: ctx.flags.team || null, item: ctx.flags.item || null });
      out(ctx, [e.id], e); return 0;
    }
    if (sub === 'show') { const e = store.mustGet(ctx.home, 'epic', id); out(ctx, [JSON.stringify(e, null, 2)], e); return 0; }
    if (sub === 'list') { const l = store.list(ctx.home, 'epic', (e) => !ctx.flags.goal || e.goal_id === ctx.flags.goal); out(ctx, l.map((x) => short(x, 'epic')), l); return 0; }
    throw usage('epic new|show|list');
  },

  async task(ctx) {
    const store = await lib('store');
    const a = await lib('actions');
    const { move } = await lib('lifecycle');
    const { nowIso } = await lib('fsutil');
    const { emit } = await lib('events');
    const [sub, id, arg] = ctx.pos;
    const f = ctx.flags;
    switch (sub) {
      case 'new': { const l = a.newTasks(ctx.home, readJsonFile(f.file)); out(ctx, l.map((t) => `${t.id} ${t.status} ${t.title}`), l); return 0; }
      case 'show': { const t = store.mustGet(ctx.home, 'task', id); out(ctx, [JSON.stringify(t, null, 2)], t); return 0; }
      case 'list': {
        const l = store.list(ctx.home, 'task', (t) => (!f.goal || t.goal_id === f.goal) && (!f.status || t.status === f.status) && (!f.epic || t.epic_id === f.epic));
        out(ctx, l.map((x) => short(x, 'task')), l); return 0;
      }
      case 'move': { if (!arg) throw usage('task move <T> <status>'); const t = move(ctx.home, id, arg, { actor: 'human', reason: f.reason || 'moved by hand' }); out(ctx, [`${t.id} ${t.status}`]); return 0; }
      case 'retry': { const t = a.retryTask(ctx.home, id); out(ctx, [`${t.id} ${t.status}`]); return 0; }
      case 'cancel': { const t = a.cancelTask(ctx.home, id, f.reason || 'cancelled'); out(ctx, [`${t.id} ${t.status}`]); return 0; }
      case 'answer': {
        if (!f.text) throw usage('task answer <T> --question Q-1 --text "..."');
        const t = a.answerTask(ctx.home, id, f.question || null, f.text, { by: ctx.agentRole || 'human' });
        out(ctx, [`${t.id} ${t.status}`]); return 0;
      }
      case 'replan': { const t = a.replanTask(ctx.home, id, readJsonFile(f.file)); out(ctx, [`${t.id} replanned (ac_version ${t.ac_version})`], t); return 0; }
      case 'waive': {
        if (!f.finding || !f.reason) throw usage('task waive <T> --finding F-1 --reason "..."');
        const t0 = store.mustGet(ctx.home, 'task', id);
        const fd = [...(t0.findings || [])].reverse().find((x) => x.id === f.finding);
        if (!fd) throw fail(`finding ${f.finding} not found on ${id}`);
        if (fd.severity !== 'major') throw fail(`only major findings can be waived (${f.finding} is ${fd.severity})`);
        const t = store.update(ctx.home, 'task', id, (x) => { x.waivers = [...(x.waivers || []), { finding: f.finding, reason: f.reason, by: ctx.agentRole || 'cto', at: nowIso(), run_id: fd.run_id || null }]; });
        emit(ctx.home, { type: 'msg.review_result', goal_id: t.goal_id, task_id: id, msg: `${id} ${f.finding} waived: ${f.reason}`.slice(0, 140), data: { from: { role: 'cto' }, to: { role: fd.role || 'code-reviewer' }, waived: f.finding } });
        out(ctx, [`WAIVED ${id} ${f.finding}`]); return 0;
      }
      case 'block': {
        if (!f.needs || !f.question) throw usage('task block <T> --needs human|cto|<role> --question "..."');
        const t0 = store.mustGet(ctx.home, 'task', id);
        const qid = `Q-${(t0.answers || []).length + (t0.questions_asked || 0) + 1}`;
        const t = move(ctx.home, id, 'blocked', { actor: 'cto', reason: f.question.slice(0, 200), data: (x) => { x.questions_asked = (x.questions_asked || 0) + 1; x.blocked = { reason: f.question.slice(0, 300), question_id: qid, needs: f.needs, since: nowIso() }; } });
        emit(ctx.home, { type: 'msg.question', goal_id: t.goal_id, task_id: id, msg: `${id} asks ${f.needs}: ${f.question}`.slice(0, 140), data: { from: { role: 'cto' }, to: { role: f.needs === 'human' ? 'user' : f.needs }, question_id: qid } });
        out(ctx, [`BLOCKED ${id} ${qid} needs ${f.needs}`]); return 0;
      }
      default: throw usage('task new|show|list|move|retry|cancel|answer|replan|waive|block');
    }
  },

  async run(ctx) {
    const store = await lib('store');
    const c = await lib('control');
    const [sub, id] = ctx.pos;
    if (sub === 'show') { const r = store.mustGet(ctx.home, 'run', id); out(ctx, [JSON.stringify(r, null, 2)], r); return 0; }
    if (sub === 'checkpoint') { out(ctx, await c.checkpointRun(ctx.home, id)); return 0; }
    if (sub === 'stop') { out(ctx, c.stopRun(ctx.home, id, { reason: ctx.flags.reason || 'stopped by hand' })); return 0; }
    throw usage('run show|checkpoint|stop <R>');
  },

  async handoff(ctx) {
    const [sub, file] = ctx.pos;
    if (sub !== 'validate' || (!file && !ctx.flags.run)) throw usage('handoff validate <path> | handoff validate --run R');
    const { validateHandoff } = await lib('handoff');
    let target = file ? resolve(file) : null;
    let run = null;
    if (ctx.flags.run) {
      const store = await lib('store');
      const ob = await lib('outbox');
      run = store.mustGet(ctx.home, 'run', ctx.flags.run);
      if (!target) {
        const dir = ob.outboxDir(run);
        target = ob.usesOutbox(run) && dir ? join(dir, 'handoff.json') : (run.handoff_path || join(ctx.home, 'runs', run.id, 'handoff.json'));
      }
    }
    const v = validateHandoff(ctx.home, target, run ? { run } : {});
    out(ctx, v.ok ? ['VALID'] : ['INVALID', ...v.errors.map((e) => `- ${e}`)], { ok: v.ok, errors: v.errors });
    return v.ok ? 0 : 1;
  },

  async evidence(ctx) {
    if (ctx.pos[0] !== 'run' || !ctx.flags.run || !ctx.flags.label || !ctx.rest || !ctx.rest.length) throw usage('evidence run --run R --label L -- <cmd...>');
    const store = await lib('store');
    const deps = await lib('deps');
    const run = store.mustGet(ctx.home, 'run', ctx.flags.run);
    const ev = await deps.load('evidence');
    const git = await deps.load('git');
    const command = ctx.rest.length === 1 ? ctx.rest[0] : ctx.rest.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)).join(' ');
    // Run where the agent works: its cwd when that is inside the run's worktree (or one of a qa_goal's repo
    // worktrees), else the run's worktree. Runs without a worktree keep the cwd.
    let cwd = process.cwd();
    const inside = (p) => { try { return git.isInside(cwd, p); } catch { return false; } };
    if (run.worktree_path && existsSync(run.worktree_path)) {
      const spots = [...(run.repo_worktrees || []).map((x) => x.path), run.worktree_path];
      if (!spots.some(inside)) cwd = run.worktree_path;
    }
    const goalParent = (run.repo_worktrees || []).length && !(run.repo_worktrees || []).some((x) => inside(x.path));
    let head; // undefined: the evidence module reads it (a qa_goal parent folder is not a git worktree)
    if (!goalParent) { try { head = git.headSha(cwd); } catch { head = null; } }
    const e = ev.run({ runDir: join(ctx.home, 'runs', run.id), label: ctx.flags.label, command, cwd, source: 'agent', headSha: head });
    out(ctx, [`${e.id} exit ${e.exit_code}${e.exit_code === 0 ? '' : ' FAILED'} log ${String(e.log_path).replace(/\\/g, '/')}`], e);
  },

  async gate(ctx) {
    const store = await lib('store');
    const [sub, id] = ctx.pos;
    if (sub === 'list') {
      const l = store.list(ctx.home, 'gate', (g) => (ctx.flags.all ? true : g.status === 'pending'));
      out(ctx, l.length ? l.map((x) => short(x, 'gate')) : ['no gates pending'], l); return 0;
    }
    if (sub === 'show') {
      const g = store.mustGet(ctx.home, 'gate', id);
      const H = ctx.home.replace(/\\/g, '/');
      const lines = [`${g.id} ${g.type} ${g.status} goal ${g.goal_id || '-'} subject ${g.subject.kind} ${g.subject.id || '-'}`, `summary: ${g.artifact.summary || ''}`,
        ...(g.artifact.paths || []).map((p) => `artifact: ${p.startsWith('repo:') ? p : `${H}/${p}`}`)];
      if (g.artifact.pr_url) lines.push(`pr: ${g.artifact.pr_url}`);
      if (g.artifact.diffstat) lines.push(`diffstat: ${g.artifact.diffstat.split('\n').slice(-2).join(' ')}`);
      if (g.request && g.request.add_tokens_suggested) lines.push(`suggested top-up: ${g.request.add_tokens_suggested} tokens`);
      if (g.request && g.request.action) lines.push(`action: ${g.request.action}`);
      for (const i of (g.request && g.request.impact) || []) lines.push(`impact: ${i}`);
      out(ctx, lines, g); return 0;
    }
    if (sub === 'decide') {
      if (!(await intentOk(ctx.home, ctx, 'approve'))) throw needIntent('approve');
      const flow = await lib('flow');
      const g = await flow.decideGate(ctx.home, id, { decision: ctx.flags.decision, by: 'human', via: ctx.flags.via || 'cli', notes: ctx.flags.notes || '', add_tokens: ctx.flags['add-tokens'] });
      out(ctx, [`${g.id} ${g.type} ${g.status}`], g); return 0;
    }
    throw usage('gate list|show|decide');
  },

  async budget(ctx) {
    const b = await lib('budget');
    const [sub, id] = ctx.pos;
    if (sub === 'show' || !sub) {
      const r = b.compute(ctx.home);
      const lines = Object.entries(r.goals).filter(([g]) => !id || g === id).map(([g, s]) => `${g} spent ${s.spent} reserved ${s.reserved} limit ${s.limit} (${s.pct}%)`);
      lines.push(`overhead ${r.overhead}; unattributed ${r.unattributed}`);
      out(ctx, lines, r); return 0;
    }
    if (sub === 'override') {
      if (!(await intentOk(ctx.home, ctx, 'approve'))) throw needIntent('approve');
      const g = b.override(ctx.home, id, Number(ctx.flags.add), { by: 'human', via: 'cli', note: ctx.flags.note || '' });
      out(ctx, [`${g.id} limit ${g.budget.limit_tokens} (${g.status})`], g); return 0;
    }
    throw usage('budget show|override G --add N');
  },

  async inbox(ctx) {
    const inbox = await lib('inbox');
    const sub = ctx.pos[0];
    if (sub === 'add') {
      if (!ctx.flags.type) throw usage('inbox add --type T --payload <json>');
      const payload = ctx.flags.payload ? parseValue(ctx.flags.payload) : {};
      const cmdFor = { 'gate.decide': 'approve', 'budget.override': 'approve', 'goal.remove': 'remove-goal', 'factory.stop': 'pause' };
      const human = inbox.HUMAN_TYPES.includes(ctx.flags.type);
      const sign = human && (await intentOk(ctx.home, ctx, cmdFor[ctx.flags.type]));
      const req = inbox.write(ctx.home, { type: ctx.flags.type, payload, source: 'cli', actor: { kind: 'human' } }, { sign });
      out(ctx, [`QUEUED ${req.id} ${req.type}${human && !sign ? ' (unsigned: it will be rejected without human intent)' : ''}`], req); return 0;
    }
    if (sub === 'process') {
      const { readFactory } = await lib('state');
      const r = await inbox.process(ctx.home, { tick: (readFactory(ctx.home) || { tick: {} }).tick.count, session: ctx.session });
      out(ctx, r.length ? r.map((x) => `${x.type} ${x.status}${x.reason ? `: ${x.reason}` : ''}`) : ['inbox empty'], r); return 0;
    }
    if (sub === 'list') { const l = inbox.pending(ctx.home); out(ctx, l.length ? l : ['inbox empty'], l); return 0; }
    throw usage('inbox add|process|list');
  },

  async events(ctx) {
    if (ctx.pos[0] !== 'tail') throw usage('events tail [--n 50]');
    const { tail } = await lib('events');
    const l = tail(ctx.home, Number(ctx.flags.n) || 50);
    out(ctx, l.map((e) => `${e.ts} ${e.type} ${e.msg}`), l);
  },

  async note(ctx) {
    const text = ctx.pos.join(' ').trim();
    if (!text) throw usage('note "<text>"');
    const { emit } = await lib('events');
    emit(ctx.home, { type: 'factory.status', actor: { kind: 'system', role: ctx.agentRole || 'cto' }, msg: text, data: { note: true } });
    out(ctx, ['NOTED']);
  },

  async worktree(ctx) {
    const store = await lib('store');
    const deps = await lib('deps');
    const { fwd } = await lib('paths');
    const repos = await lib('repos');
    const cfg = (await lib('config')).load(ctx.home);
    const sub = ctx.pos[0];
    if (sub === 'prepare') {
      if (!ctx.flags.run) throw usage('worktree prepare --run R');
      const { writeJsonAtomic, nowIso } = await lib('fsutil');
      const run = store.mustGet(ctx.home, 'run', ctx.flags.run);
      const task = store.mustGet(ctx.home, 'task', run.task_id);
      const epic = task.epic_id ? store.get(ctx.home, 'epic', task.epic_id) : null;
      const wt = await deps.load('worktree');
      const git = await deps.load('git');
      // Runs from before A9 ran inside Claude Code's native worktree (cwd); newer runs get a CLI worktree (§20.4).
      const native = !run.worktree_path || /\/\.claude\/worktrees\/agent-/.test(fwd(run.worktree_path));
      const isWt = (dir) => { try { return existsSync(dir) && git.samePath(git.toplevel(dir), dir); } catch { return false; } };
      if (task.kind === 'qa_goal' && !native) {
        // One detached worktree per epic under the run folder (§20.6.4); the folder itself holds the outbox.
        const { mkdirSync } = await import('node:fs');
        mkdirSync(run.worktree_path, { recursive: true });
        const plan = (run.repo_worktrees || []).length ? run.repo_worktrees : (await lib('dispatch')).goalRepoWorktrees(ctx.home, cfg, run.goal_id, run.worktree_path);
        const done = [];
        for (const rw of plan) {
          const ep = store.get(ctx.home, 'epic', rw.epic_id);
          const repo = repos.get(ctx.home, cfg, rw.repo);
          const branch = rw.branch || (ep && ep.branch);
          const sha = git.headSha(repo.path, branch);
          if (!sha) throw fail(`${rw.epic_id}: branch ${branch} not found in repo ${repo.name}`);
          if (!(isWt(rw.path) && git.headSha(rw.path) === sha)) {
            try { wt.addDetached({ repoRoot: repo.path, dir: rw.path, sha }); } catch (e) { throw fail(`worktree add failed in ${repo.name}: ${e.message}`); }
          }
          done.push({ repo: rw.repo, epic_id: rw.epic_id, path: fwd(rw.path), branch, head_sha: sha });
        }
        store.update(ctx.home, 'run', run.id, (x) => { x.repo_worktrees = done; });
        out(ctx, [`PREPARED ${fwd(run.worktree_path)} detached ${done.length} repos`, ...done.map((d) => `REPO ${d.repo} ${d.path} ${d.head_sha.slice(0, 12)}`)], { worktree_path: fwd(run.worktree_path), repo_worktrees: done });
        return 0;
      }
      const repo = repos.forRecord(ctx.home, cfg, { task, epic, run });
      const root = repo.path;
      let detach = null;
      if (run.review_role || run.detach_ref) {
        detach = run.head_sha || (run.detach_ref ? git.headSha(root, run.detach_ref) : null) || task.head_sha;
        if (!detach) throw fail('no head SHA to check out for this review');
      } else if (!task.branch) throw fail(`${task.id} has no branch`);
      const fromRef = (task.resume_from && task.resume_from.commit) || task.base_ref || (epic && epic.branch);
      let dir = process.cwd();
      if (!native) {
        dir = run.worktree_path;
        if (!isWt(dir)) { // create it once; a second prepare reuses it
          const start = detach || (git.branchExists(root, task.branch) ? task.branch : fromRef);
          if (!start) throw fail(`${task.id}: no start point for the worktree`);
          try { wt.addDetached({ repoRoot: root, dir, sha: start }); } catch (e) { throw fail(`worktree add failed in ${repo.name}: ${e.message}`); }
        }
      }
      const opts = detach ? { cwd: dir, repoRoot: root, detachSha: detach } : { cwd: dir, repoRoot: root, branch: task.branch, fromRef, mergeFirst: [] };
      let r;
      try { r = wt.prepare(opts); } catch (e) {
        if (e.code === 'MERGE_CONFLICT') { out(ctx, [`MERGE_CONFLICT ${(e.files || []).join(' ')}`]); return 1; }
        throw fail(`prepare failed: ${e.message}`);
      }
      if (!native) r.worktree_path = fwd(run.worktree_path); // keep the path the brief and broker know
      store.update(ctx.home, 'run', run.id, (x) => {
        x.worktree_path = fwd(r.worktree_path); x.branch = r.branch || null; if (!x.head_sha || !x.review_role) x.head_sha = r.head_sha;
        if (!x.repo && repos.isWorkspace(cfg)) x.repo = repo.name;
      });
      // Keep the agent's outbox (.factory-out/) out of git: info/exclude is shared by all worktrees.
      try {
        const ex = git.git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd: r.worktree_path });
        const exFile = String(ex.stdout || '').trim();
        if (ex.code === 0 && exFile) {
          const { readFileSync, existsSync, appendFileSync, mkdirSync } = await import('node:fs');
          const cur = existsSync(exFile) ? readFileSync(exFile, 'utf8') : '';
          // Also hide the agents' native worktrees, which Claude Code creates under .claude/worktrees/.
          const want = ['.factory-out/', '.claude/worktrees/'].filter((p) => !new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm').test(cur));
          if (want.length) { mkdirSync(dirname(exFile), { recursive: true }); appendFileSync(exFile, `${cur && !cur.endsWith('\n') ? '\n' : ''}${want.join('\n')}\n`); }
        }
      } catch { /* best effort */ }
      if (r.branch) {
        writeJsonAtomic(join(ctx.home, 'run', 'branch-locks', `${r.branch.replace(/[\\/:*?"<>|]/g, '__')}.json`), { branch: r.branch, run_id: run.id, task_id: task.id, worktree_path: fwd(r.worktree_path), pid: process.pid, at: nowIso() });
      }
      out(ctx, [`PREPARED ${fwd(r.worktree_path)} ${r.branch || 'detached'} ${String(r.head_sha || '').slice(0, 12)}`], r); return 0;
    }
    if (sub === 'prune') {
      const wt = await deps.load('worktree');
      let tasks = [];
      if (ctx.flags.task) tasks = [store.mustGet(ctx.home, 'task', ctx.flags.task)];
      else if (ctx.flags.epic) tasks = store.list(ctx.home, 'task', (t) => t.epic_id === ctx.flags.epic);
      else if (ctx.flags['all-done']) tasks = store.list(ctx.home, 'task', (t) => ['done', 'cancelled'].includes(t.status));
      else throw usage('worktree prune --task T|--epic E|--all-done');
      const byRepo = new Map(); // each task's branches live in its own repo
      for (const t of tasks.filter((x) => x.branch)) {
        const name = repos.nameFor(ctx.home, cfg, { task: t, epic: t.epic_id ? store.get(ctx.home, 'epic', t.epic_id) : null });
        byRepo.set(name, [...(byRepo.get(name) || []), t.branch]);
      }
      const r = { deleted: [], skipped: [] };
      for (const [name, branches] of byRepo) {
        const one = wt.pruneBranches({ repoRoot: repos.get(ctx.home, cfg, name).path, branches });
        r.deleted.push(...(one.deleted || [])); r.skipped.push(...(one.skipped || []));
      }
      out(ctx, [`PRUNED ${[...byRepo.values()].flat().length} branches`], r); return 0;
    }
    throw usage('worktree prepare|prune');
  },

  async integrate(ctx) {
    if (!ctx.flags.epic) throw usage('integrate --epic E');
    const flow = await lib('flow');
    const r = await flow.integrateEpic(ctx.home, ctx.flags.epic);
    out(ctx, [`MERGED ${(r.merged || []).length}${r.conflict ? `; CONFLICT ${r.conflict.branch}` : ''}${r.post_merge ? `; post_merge ${r.post_merge.status}` : ''}`], r);
  },

  async pr(ctx) {
    const flow = await lib('flow');
    const store = await lib('store');
    const sub = ctx.pos[0];
    if (sub === 'create') { if (!ctx.flags.epic) throw usage('pr create --epic E'); const e = await flow.createPr(ctx.home, ctx.flags.epic); out(ctx, [`PR ${e.pr.url || '(local)'}`], e.pr); return 0; }
    if (sub === 'poll') {
      const epics = store.list(ctx.home, 'epic', (e) => e.status === 'pr_open' && (!ctx.flags.epic || e.id === ctx.flags.epic));
      const lines = [];
      for (const e of epics) { const r = await flow.pollPr(ctx.home, e.id, { force: true }); lines.push(`${e.id} ${r ? r.status : 'skipped'}`); }
      out(ctx, lines.length ? lines : ['no open PRs']); return 0;
    }
    throw usage('pr create|poll');
  },

  async collect(ctx) {
    const { collect } = await lib('collect');
    const r = await collect(ctx.home);
    out(ctx, r.length ? r.map((x) => `${x.run_id || x.task_id} ${x.outcome}`) : ['nothing to collect'], r);
  },

  // ---------------------------------------------------------------- contracts §21
  async baseline(ctx) {
    const bl = await lib('baseline');
    const cfg = (await lib('config')).load(ctx.home);
    const sub = ctx.pos[0];
    if (sub === 'collect') {
      const b = await bl.collect(ctx.home, { cfg });
      const prs = Object.values(b.repos).reduce((n, r) => n + r.open_prs.filter((p) => !p.factory).length, 0);
      const lines = ctx.flags.quiet ? [] : [`BASELINE ${Object.keys(b.repos).length} repos; ${prs} open human PRs${b.error ? `; error: ${b.error}` : ''}`,
        `files: state/baseline.json, ${bl.factoryDocRel()}, ${(await lib('teams')).ids(ctx.home, cfg).map((t) => bl.teamDocRel(t)).join(', ')}`];
      out(ctx, lines, b); return 0;
    }
    if (sub === 'show') {
      if (ctx.json) { out(ctx, [], bl.read(ctx.home)); return 0; }
      out(ctx, bl.showLines(ctx.home, cfg, { team: ctx.flags.team || null })); return 0;
    }
    throw usage('baseline collect [--quiet] | baseline show [--team T]');
  },

  async item(ctx) {
    const streams = await lib('streams');
    const store = await lib('store');
    const cfg = (await lib('config')).load(ctx.home);
    const [sub, id] = ctx.pos;
    const f = ctx.flags;
    const row = (t) => `${t.id} ${streams.itemStatus(ctx.home, t)} ${(t.item && t.item.class) || '?'} ${t.priority} ${t.team || '-'}${t.cycle ? ` ${t.cycle}` : ''} ${t.title}`;
    if (sub === 'new') {
      const tracker = f.tracker !== undefined ? parseValue(f.tracker) : null;
      if (tracker !== null && (typeof tracker !== 'object' || Array.isArray(tracker))) throw usage('--tracker must be a JSON object {provider, remote_id, key, url, kind}');
      const r = streams.newItem(ctx.home, { team: f.team, class: f.class, title: f.title, description: f.description || '', priority: f.priority, repo: f.repo || null, tracker_ref: tracker, reported_by: ctx.agentRole ? 'agent' : 'human' }, { cfg });
      out(ctx, [r.created ? `ITEM ${r.task.id} ${r.task.team} ${r.task.item.class} ${r.task.priority}` : `EXISTS ${r.task.id} (${r.reason})`], r.task); return 0;
    }
    if (sub === 'list') {
      if (f.class && !['bug', 'tech_debt', 'chore'].includes(f.class)) throw usage('--class must be bug|tech_debt|chore');
      const l = streams.items(ctx.home, { team: f.team || null, cls: f.class || null });
      out(ctx, l.length ? l.map(row) : ['no items'], l.map((t) => ({ ...t, effective_status: streams.itemStatus(ctx.home, t) }))); return 0;
    }
    if (sub === 'show') {
      const t = store.mustGet(ctx.home, 'task', id);
      if (t.kind !== 'triage') throw fail(`${id} is a ${t.kind} task, not an item`);
      const eff = streams.itemStatus(ctx.home, t);
      const epics = (t.item_epic_ids || []).map((e) => store.get(ctx.home, 'epic', e)).filter(Boolean);
      const ref = t.item && t.item.tracker_ref;
      out(ctx, [row(t), `status ${t.status}; effective ${eff}; reported by ${(t.item && t.item.reported_by) || '?'}${t.repo ? `; repo ${t.repo}` : ''}`,
        `tracker: ${ref ? `${ref.key || ref.remote_id} ${ref.url || ''}`.trim() : 'none'}`,
        `epics: ${epics.map((e) => `${e.id} ${e.status}${e.pr && e.pr.url ? ` ${e.pr.url}` : ''}`).join('; ') || 'none'}`,
        `note: docs/streams/${t.team || 'core'}/items/${t.id}.md`, ...(t.description ? [`description: ${t.description.split('\n')[0].slice(0, 200)}`] : [])],
      { ...t, effective_status: eff }); return 0;
    }
    throw usage('item new --team T --class bug|tech_debt|chore --title <t> --description <d> [--priority P1] [--repo R] [--tracker <json>] | item list [--team T] [--class C] | item show <T>');
  },

  async cycle(ctx) {
    const cycles = await lib('cycles');
    const cfg = (await lib('config')).load(ctx.home);
    const [sub, id] = ctx.pos;
    if (sub === 'show') {
      if (ctx.json) { out(ctx, [], cycles.readState(ctx.home)); return 0; }
      out(ctx, cycles.showLines(ctx.home, cfg, { team: ctx.flags.team || null })); return 0;
    }
    if (sub === 'roll') {
      if (!cycles.enabled(cfg)) { out(ctx, ['cycles off (set cycles.enabled true)']); return 0; }
      const r = await cycles.roll(ctx.home, cfg);
      out(ctx, r.lines.length ? r.lines : [r.first ? 'cycles recorded (first roll)' : 'no cycle change'], r); return 0;
    }
    if (sub === 'commit') {
      if (!id || ctx.flags.cycle === undefined) throw usage('cycle commit <T> --cycle current|next|none|<cycle id>');
      const t = cycles.commit(ctx.home, cfg, id, String(ctx.flags.cycle), { by: ctx.agentRole || 'human' });
      out(ctx, [`COMMITTED ${t.id} ${t.cycle || 'none'}`], t); return 0;
    }
    throw usage('cycle show [--team T] | cycle roll | cycle commit <T> --cycle current|next|none|<id>');
  },

  async report(ctx) {
    const ops = await lib('ops');
    const sub = ctx.pos[0];
    if (sub === 'data') {
      const metrics = await lib('metrics');
      const cfg = (await lib('config')).load(ctx.home);
      if (ctx.flags.team) (await lib('teams')).get(ctx.home, cfg, ctx.flags.team);
      if (ctx.flags.since && Number.isNaN(Date.parse(ctx.flags.since))) throw usage('--since must be an ISO date');
      const m = metrics.build(ctx.home, { cfg, since: ctx.flags.since ? new Date(ctx.flags.since).toISOString() : null, team: ctx.flags.team || null });
      if (ctx.flags.out) {
        const { writeJsonAtomic } = await lib('fsutil');
        writeJsonAtomic(resolve(String(ctx.flags.out)), m);
      }
      out(ctx, [...metrics.textLines(m).slice(0, ctx.flags.out ? 39 : 40), ...(ctx.flags.out ? [`WROTE ${resolve(String(ctx.flags.out)).replace(/\\/g, '/')}`] : [])], m); return 0;
    }
    if (sub === 'request') { ops.requestReport(ctx.home); out(ctx, ['REQUESTED a CTO report; the next tick creates it']); return 0; }
    if (sub === 'list') {
      const l = ops.listReports(ctx.home, { n: Number(ctx.flags.n) || 20 });
      const sm = ops.summary(ctx.home);
      out(ctx, [`last report: ${sm.last_report_path || 'none'} (${sm.report_age}); last assess ${sm.assess_age}`, ...l.map((x) => `${new Date(x.mtime).toISOString().slice(0, 16)}Z ${x.kind} ${x.path}`)], { ...sm, files: l }); return 0;
    }
    throw usage('report data [--since ISO] [--team T] [--out <file>] [--json] | report request | report list');
  },

  async checks(ctx) {
    if (ctx.pos[0] !== 'run' || !ctx.flags.run) throw usage('checks run --run R');
    const store = await lib('store');
    const deps = await lib('deps');
    const cfg = (await lib('config')).load(ctx.home);
    const repos = await lib('repos');
    const run = store.mustGet(ctx.home, 'run', ctx.flags.run);
    const task = store.get(ctx.home, 'task', run.task_id);
    const epic = task && task.epic_id ? store.get(ctx.home, 'epic', task.epic_id) : null;
    const repo = repos.forRecord(ctx.home, cfg, { task, epic, run }); // §20.5: the run's repo, its checks and include files
    const ck = await deps.load('checks');
    const r = ck.runChecks({ repoRoot: repo.path, home: ctx.home, runId: run.id, runDir: join(ctx.home, 'runs', run.id), sha: run.head_sha || (task && task.head_sha), commands: repo.checks.pre_review, includeFiles: repo.include_files || [] });
    out(ctx, [`CHECKS ${r.status}${r.failed_command ? ` ${r.failed_command}` : ''}`], r);
    return 0;
  },

  async telemetry(ctx) {
    if (ctx.pos[0] !== 'reconcile') throw usage('telemetry reconcile');
    const { reconcile } = await lib('telemetry');
    const r = reconcile(ctx.home, { session: ctx.session });
    out(ctx, [`RECONCILED snapshots ${r.snapshots}; bound ${r.bound.length}; ended ${r.finished.length}`], r);
  },

  async watch(ctx) {
    const interval = Math.max(1, Number(ctx.flags.interval) || 5) * 1000;
    const timeout = ctx.flags.timeout ? Number(ctx.flags.timeout) * 1000 : 0;
    const { pending } = await lib('inbox');
    const store = await lib('store');
    const seenInbox = new Set(pending(ctx.home));
    const doneStates = new Set(['completed', 'deferred', 'failed', 'orphaned', 'stopped']);
    const seenRuns = new Set(store.list(ctx.home, 'run', (r) => doneStates.has(r.status)).map((r) => r.id));
    const started = Date.now();
    return new Promise((res) => {
      const poll = () => {
        let fired = false;
        for (const n of pending(ctx.home)) if (!seenInbox.has(n)) { seenInbox.add(n); process.stdout.write(`INBOX ${n}\n`); fired = true; }
        for (const r of store.list(ctx.home, 'run', (x) => doneStates.has(x.status))) {
          if (!seenRuns.has(r.id)) { seenRuns.add(r.id); process.stdout.write(`RUN ${r.id} ${r.status} ${r.task_id}\n`); fired = true; }
        }
        if ((fired && ctx.flags.once) || (timeout && Date.now() - started > timeout)) { res(0); return; }
        setTimeout(poll, interval);
      };
      setTimeout(poll, ctx.flags.once ? 50 : interval);
    });
  },

  async dashboard(ctx) {
    const { pluginRoot, repoRoot } = await lib('paths');
    const cli = join(pluginRoot(), 'control-center', 'server', 'cli.mjs');
    if (!existsSync(cli)) throw fail('control center is not installed (control-center/server/cli.mjs missing)');
    const r = spawnSync(process.execPath, [cli, ctx.pos[0] || 'status', '--project', repoRoot(ctx.home), ...ctx.argvRest], { stdio: 'inherit', windowsHide: true });
    return r.status ?? 1;
  },

  async hook(ctx) {
    const ev = ctx.pos[0];
    if (!ev || !/^[a-z-]+$/.test(ev)) throw usage('hook <event>');
    const file = join(dirname(SELF), 'hooks', `${ev}.mjs`);
    if (!existsSync(file)) throw usage(`unknown hook ${ev}`);
    await import(pathToFileURL(file).href);
    return null;
  },
};

const NO_HOME = new Set(['init', 'doctor', 'hook']);

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`usage: factory <${Object.keys(COMMANDS).join('|')}> ... [--json] [--home <path>]\n`);
    return cmd ? 0 : 2;
  }
  const fn = COMMANDS[cmd];
  if (!fn) throw usage(`unknown command ${cmd}`);
  const { pos, flags, rest: after } = parseArgs(rest);
  const { findHome } = await lib('paths');
  const homeMaybe = flags.home ? resolve(flags.home) : findHome(process.cwd());
  const ctx = {
    pos, flags, rest: after, json: !!flags.json, homeMaybe, home: homeMaybe,
    session: flags.session || process.env.CLAUDE_CODE_SESSION_ID || null,
    agentRole: null, argvRest: [],
  };
  if (cmd === 'dashboard') ctx.argvRest = rest.slice(1).filter((a) => a !== '--json');
  if (cmd === 'init' && flags.workspace) {
    // `.factory` at cwd unless --home or FACTORY_HOME says otherwise; never inside a git repo.
    const { commonDirFs } = await lib('paths');
    if (!flags.home && !process.env.FACTORY_HOME) ctx.home = ctx.homeMaybe = join(process.cwd(), '.factory');
    if (commonDirFs(dirname(resolve(ctx.home)))) throw fail('init --workspace needs a plain folder that holds repos, not a git repository (run init without --workspace here)', 2);
  } else if (cmd === 'init' && !flags.home && !process.env.FACTORY_HOME) {
    // Plain init always targets this repo's own `<main checkout>/.factory`, never a workspace above it.
    const { repoHomeOf } = await lib('paths');
    ctx.home = ctx.homeMaybe = repoHomeOf(process.cwd());
  }
  if (!NO_HOME.has(cmd)) {
    if (!homeMaybe) throw fail('not inside a git repository or a factory workspace (or set --home)', 4);
    const { isInitialized } = await lib('state');
    if (!isInitialized(homeMaybe)) throw fail(`factory not initialized at ${homeMaybe}; run /software-factory:setup`, 4);
  } else if (cmd === 'init' && !ctx.home) throw fail('not inside a git repository (or pass --home, or --workspace for a folder of repos)', 2);
  const code = await fn(ctx);
  return typeof code === 'number' ? code : 0;
}

const isMain = (() => {
  try { return resolve(process.argv[1] || '').toLowerCase() === resolve(SELF).toLowerCase(); } catch { return false; }
})();

if (isMain) {
  main().then((code) => {
    if (code !== null) process.exitCode = code;
  }).catch((e) => {
    process.stderr.write(`error: ${e.message}\n`);
    if (process.env.FACTORY_DEBUG) process.stderr.write(`${e.stack}\n`);
    process.exitCode = e.exitCode || (e.code === 'REV_CONFLICT' ? 5 : 1);
  });
}

export { COMMANDS, statSync as _statSync };
