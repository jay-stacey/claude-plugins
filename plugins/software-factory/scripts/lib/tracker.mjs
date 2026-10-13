// Inbox handlers for tracker.* and sync.* requests (M5). The sync raises them; this file applies them, so
// task and goal files keep one writer. Requests with needs_confirmation arrive here only after their
// `tracker` gate is approved.
import { nowIso } from './fsutil.mjs';
import * as store from './store.mjs';
import { emit } from './events.mjs';
import { load as loadConfig } from './config.mjs';
import { ENUMS } from './schema.mjs';
import { canMove, move, setGoalStatus } from './lifecycle.mjs';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Plain-words gate summary for a confirmation request (shown in /approve and the control center). */
export function gateSummary(req) {
  const p = req.payload || {};
  const who = p.task_id || p.goal_id || p.local_id || 'the factory';
  const where = p.remote_key ? `${p.remote_key}: ` : '';
  switch (req.type) {
    case 'tracker.status_change': {
      const what = {
        cancel: `Someone moved ${who} to ${p.remote_status || 'Canceled'} in the tracker. Approve to cancel it here. Reject to keep it; the tracker status is restored.`,
        done_override: `Someone moved ${who} to ${p.remote_status || 'Done'} before the factory finished it. Approve to accept it without evidence (logged). Reject to keep working; the tracker status is restored.`,
        rework: `Someone moved ${who} back to ${p.remote_status || 'an earlier state'}. Approve to send it back for rework. Reject to restore the tracker status.`,
      }[p.class] || `Tracker status of ${who} changed to ${p.remote_status || '?'} (${p.class}). Approve to apply it.`;
      return `${where}${what}`.slice(0, 600);
    }
    case 'tracker.scope_change':
      return `${where}Someone changed the ${p.field} of ${who} in the tracker. Approve to send the change to the CTO for a replan. Reject to restore the factory text.`.slice(0, 600);
    case 'tracker.conflict':
      return `${where}The ${p.field} of ${who} changed both here and in the tracker. Approve to take the tracker version (CTO replans). Reject to keep the factory version.`.slice(0, 600);
    case 'tracker.missing':
      return `${where}${who} was deleted, archived or moved out of scope in the tracker. Approve to unlink it (nothing is deleted here). Reject to keep the link and check again.`.slice(0, 600);
    case 'sync.first_sync':
      return `First tracker sync: create ${p.creates ?? '?'} items and ${p.labels ?? '?'} labels (preview ${p.preview_id}, see .factory/sync/preview.md). Nothing is ever deleted in the tracker.`.slice(0, 600);
    case 'sync.bulk_confirm':
      return `One sync tick planned ${p.ops} tracker changes (${p.closing} close items). Approve to send them once. Reject to hold them; check the status map.`.slice(0, 600);
    default:
      return `${req.type}: ${clip(JSON.stringify(p), 500)}`;
  }
}

function subjectOf(home, p) {
  if (p.task_id) return { kind: 'task', rec: store.get(home, 'task', p.task_id) };
  if (p.goal_id) return { kind: 'goal', rec: store.get(home, 'goal', p.goal_id) };
  return { kind: null, rec: null };
}

function trusted(cfg, p) {
  const list = ((cfg.tracker && cfg.tracker.trusted_editors) || []).map((x) => String(x).toLowerCase());
  return [p.author_id, p.author].filter(Boolean).some((x) => list.includes(String(x).toLowerCase()));
}

function feedback(home, taskId, entry) {
  return store.update(home, 'task', taskId, (t) => { t.feedback.push({ path: null, at: nowIso(), ...entry }); });
}

async function escalateFromTracker(home, req, reason) {
  const { escalate, createTask } = await import('./actions.mjs');
  const p = req.payload || {};
  const { kind, rec } = subjectOf(home, p);
  if (!rec) return { status: 'rejected', reason: 'subject not found' };
  const detail = req.type === 'tracker.conflict' ? `tracker version: ${clip(p.remote, 900)}` : `tracker version: ${clip(p.after, 900)}`;
  if (kind === 'task') {
    feedback(home, rec.id, { source: 'tracker', ref: p.remote_key || null, text: `${reason}. ${detail}` });
    const esc = escalate(home, rec, reason);
    return { status: 'applied', reason: `escalated to the CTO as ${esc.id}` };
  }
  const esc = createTask(home, {
    goal_id: rec.id, kind: 'escalation', role: 'cto', status: 'ready', title: `Escalation: ${rec.id} ${reason}`.slice(0, 80),
    description: `${reason}. ${detail}`.slice(0, 1200), subject_task_id: null,
  });
  return { status: 'applied', reason: `escalated to the CTO as ${esc.id}` };
}

async function statusChange(home, req, by) {
  const p = req.payload || {};
  const actions = await import('./actions.mjs');
  const { kind, rec } = subjectOf(home, p);
  if (!rec) return { status: 'rejected', reason: 'subject not found' };
  const why = `${p.remote_key || 'tracker'} moved to ${p.remote_status || p.class}`;
  if (kind === 'goal') {
    if (p.class !== 'cancel') return { status: 'applied', reason: 'logged (goal status follows the factory)' };
    const r = actions.removeGoal(home, rec.id, { discard: false, by, via: 'tracker' });
    return { status: 'applied', reason: `goal cancelled (${r.impact.tasks_open.length} tasks)` };
  }
  const t = rec;
  switch (p.class) {
    case 'cancel':
      actions.cancelTask(home, t.id, `cancelled in the tracker (${why}), confirmed`);
      emit(home, { type: 'task.status', goal_id: t.goal_id, task_id: t.id, actor: { kind: 'human' }, msg: `${t.id} ${t.status} -> cancelled (tracker)`, data: { from: t.status, to: 'cancelled' } });
      return { status: 'applied', reason: 'task cancelled' };
    case 'done_override': {
      const note = `accepted without evidence: ${why} (confirmed by ${by})`;
      if (canMove(t, 'done', 'flow').ok) move(home, t.id, 'done', { reason: note, data: (x) => { x.done_override = { by, at: nowIso() }; } });
      else store.update(home, 'task', t.id, (x) => { x.done_override = { by, at: nowIso() }; });
      emit(home, { type: 'msg.approval_result', goal_id: t.goal_id, task_id: t.id, actor: { kind: 'human' }, msg: `${t.id} ${note}`.slice(0, 140), data: { from: { role: 'user' }, to: { role: 'cto' }, done_override: true } });
      return { status: 'applied', reason: canMove(t, 'done', 'flow').ok ? 'task done (accepted without evidence)' : 'accepted without evidence; logged, the factory stops pushing status' };
    }
    case 'rework': {
      if (['ready', 'backlog', 'draft'].includes(t.status)) return { status: 'applied', reason: `already ${t.status}` };
      if (!canMove(t, 'changes_requested', 'flow').ok) return { status: 'rejected', reason: `${t.id} is ${t.status}; it cannot go back to rework` };
      move(home, t.id, 'changes_requested', { reason: `rework requested in the tracker (${why})`, data: (x) => {
        x.rework_count += 1;
        x.feedback.push({ source: 'tracker', ref: p.remote_key || null, path: null, text: `Moved back in the tracker: ${why}`, at: nowIso() });
      } });
      move(home, t.id, 'ready', { reason: 'rework from tracker' });
      return { status: 'applied', reason: 'task back to ready for rework' };
    }
    case 'pause':
      if (!canMove(t, 'paused', 'human').ok) return { status: 'applied', reason: `logged (${t.status} cannot pause)` };
      actions.pauseTask(home, t.id, `paused from the tracker (${why})`);
      return { status: 'applied', reason: 'task paused' };
    case 'promote':
      if (t.status !== 'backlog') return { status: 'applied', reason: `logged (task is ${t.status})` };
      move(home, t.id, 'ready', { actor: 'human', reason: `promoted in the tracker (${why})` });
      return { status: 'applied', reason: 'task ready' };
    case 'demote':
      if (t.status !== 'ready') return { status: 'applied', reason: `logged (task is ${t.status})` };
      move(home, t.id, 'backlog', { actor: 'human', reason: `moved back to backlog in the tracker (${why})` });
      return { status: 'applied', reason: 'task back to backlog' };
    default:
      return { status: 'applied', reason: 'logged' };
  }
}

/** Apply one tracker.* or sync.* request. Returns {status, reason}. */
export async function applyTracker(home, req, { by = 'human' } = {}) {
  const p = req.payload || {};
  const cfg = loadConfig(home);
  switch (req.type) {
    case 'tracker.field_update': {
      const { kind, rec } = subjectOf(home, p);
      if (!rec) return { status: 'rejected', reason: 'subject not found' };
      if (p.field === 'cycle') { // a human moved the issue to another cycle (§21.6.4)
        if (kind !== 'task') return { status: 'applied', reason: 'logged (cycles apply to tasks)' };
        const cycles = await import('./cycles.mjs');
        const teams = await import('./teams.mjs');
        const goal = store.get(home, 'goal', rec.goal_id);
        const teamId = rec.team || teams.resolve(home, cfg, { task: rec, goal });
        const id = cycles.fromTrackerId(home, cfg, teamId, p.value ?? null);
        store.update(home, 'task', rec.id, (x) => { x.cycle = id; });
        return { status: 'applied', reason: `cycle ${id || 'none'}` };
      }
      if (p.field === 'priority') {
        if (!ENUMS.priority.includes(p.value)) return { status: 'rejected', reason: `priority ${p.value} is not P0..P3` };
        store.update(home, kind, rec.id, (x) => { x.priority = p.value; });
        return { status: 'applied', reason: `priority ${p.value}` };
      }
      store.update(home, kind, rec.id, (x) => { x.tracker_fields = { ...(x.tracker_fields || {}), [p.field]: p.value ?? null }; });
      return { status: 'applied', reason: `${p.field} recorded` };
    }
    case 'tracker.status_change': return statusChange(home, req, by);
    case 'tracker.scope_change': return escalateFromTracker(home, req, `tracker scope change on ${p.field} (${p.remote_key || 'tracker'})`);
    case 'tracker.conflict': return escalateFromTracker(home, req, `tracker conflict on ${p.field} (${p.remote_key || 'tracker'})`);
    case 'tracker.intake': {
      const { newGoal } = await import('./actions.mjs');
      const teams = await import('./teams.mjs');
      const key = p.key || p.remote_key || null;
      // Link the source issue or project (§21.3.6): never a second goal for the same remote item.
      if (p.remote_id) {
        const dup = store.list(home, 'goal', (g) => g.tracker_ref && String(g.tracker_ref.remote_id) === String(p.remote_id) && g.status !== 'cancelled')[0];
        if (dup) return { status: 'applied', reason: `already linked as ${dup.id}` };
      }
      const title = `[${key || 'tracker'}] ${clip(p.title, 70)}`.slice(0, 80);
      const tracker_ref = p.remote_id ? { provider: (cfg.tracker && cfg.tracker.provider) || null, remote_id: p.remote_id, key, url: p.url || null, kind: p.kind === 'project' ? 'project' : 'issue' } : null;
      const g = newGoal(home, {
        title, outcome: `Triage tracker item ${key || ''} (${p.url || 'no url'}) into a goal or task.`.slice(0, 600),
        success_criteria: [`${key || 'The tracker item'} is triaged by the CTO`], priority: 'P2',
        notes: p.body ? `Tracker text (local copy): ${String(p.body).slice(0, 2000)}` : null, tracker_ref,
      }, { via: 'tracker', kind: 'tracker' });
      const teamIds = [...new Set((Array.isArray(p.teams) ? p.teams : []).flatMap((k) => teams.forTrackerKey(home, cfg, k)))];
      setGoalStatus(home, g.id, 'draft', `tracker intake ${key || ''}; activate with goal.activate`.trim(), (x) => {
        if (teamIds.length) { x.teams = [...new Set([...teamIds, ...(x.teams || [])])]; }
      });
      return { status: 'applied', reason: `draft goal ${g.id} created; activate it to start` };
    }
    case 'tracker.backlog_item': { // a bug or tech-debt issue pulled into a stream (§21.4.5)
      const streams = await import('./streams.mjs');
      const teams = await import('./teams.mjs');
      const cycles = await import('./cycles.mjs');
      if (!streams.enabled(cfg)) return { status: 'rejected', reason: 'streams are off; set streams.enabled true' };
      const dup = streams.findByRemoteId(home, p.remote_id);
      if (dup) return { status: 'applied', reason: `already linked as ${dup.id}` };
      const st = streams.streamTeams(home, cfg);
      const team = teams.forTrackerKey(home, cfg, p.team_key).find((id) => st.includes(id));
      if (!team) return { status: 'rejected', reason: `no stream team for tracker team ${p.team_key || '?'}` };
      const cycle = cycles.enabled(cfg) ? cycles.fromTrackerId(home, cfg, team, p.cycle_tracker_id || null) : null;
      const r = streams.newItem(home, {
        team, class: p.class, title: p.title, priority: p.priority ?? null, reported_by: 'tracker', cycle,
        description: trusted(cfg, p) ? String(p.body || '').slice(0, 1200) : `See ${p.url || p.key || 'the tracker'}`,
        tracker_ref: { provider: (cfg.tracker && cfg.tracker.provider) || null, remote_id: p.remote_id, key: p.key || null, url: p.url || null, kind: 'issue' },
      }, { cfg });
      return { status: 'applied', reason: r.created ? `created ${r.task.id}` : r.reason };
    }
    case 'tracker.cycles': { // tracker cycles per team key (§21.6.2)
      const cycles = await import('./cycles.mjs');
      const r = cycles.applyTrackerCycles(home, cfg, p);
      return { status: 'applied', reason: `${r.keys} tracker teams, ${r.teams.length} factory teams` };
    }
    case 'tracker.comment': {
      const { rec } = subjectOf(home, p);
      if (!rec || !p.task_id) return { status: 'applied', reason: 'logged only (no task)' };
      if (!trusted(cfg, p)) return { status: 'applied', reason: 'logged only (author not in tracker.trusted_editors)' };
      const quoted = String(p.text || '').split(/\r?\n/).slice(0, 30).map((l) => `> ${l}`).join('\n');
      feedback(home, rec.id, { source: 'tracker', ref: p.remote_key || null, text: `${quoted}\n(comment by ${clip(p.author || p.author_id, 60)} on ${p.remote_key || 'the tracker'}, ${p.url || ''})`.slice(0, 2500) });
      return { status: 'applied', reason: 'added to task feedback' };
    }
    case 'tracker.missing':
      return { status: 'applied', reason: 'confirmed; the sync unlinks the item (nothing deleted here)' };
    case 'sync.first_sync': {
      const { approvePreview } = await import('./syncstate.mjs');
      approvePreview(home, p.preview_id || null, { by });
      return { status: 'applied', reason: `first sync approved (preview ${p.preview_id})` };
    }
    case 'sync.bulk_confirm':
      return { status: 'applied', reason: 'confirmed; the sync sends the held changes next tick' };
    default:
      return { status: 'applied', reason: 'logged' };
  }
}
