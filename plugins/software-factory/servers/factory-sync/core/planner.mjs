// Planner: diffs local records against the map (ledger) and pulled remote items (design C §7-§8).
// Pure functions: no I/O. The engine executes what this returns.
import { footer, findSfId, hashValue, stripFooter } from './normalize.mjs';
import { classifyStatusChange, classPolicy, mapKeyForGoal, mapKeyForTask } from './ownership.mjs';
import { dedupeKey, isEcho, isOurComment, opId, unchangedSincePush } from './echo.mjs';
import { byRemote, entryFor } from './map.mjs';
import { classOf, cycleTrackerId, entryTeam, factoryCycleFor, goalKeys, goalKind, itemStatus, refOf, taskKey } from './teams.mjs';

export const DEFAULT_PUSH_KINDS = ['prd', 'spec', 'mockup', 'code', 'docs', 'triage'];
const ROLE_NAME = (r) => String(r || '').split('-').map((w) => (w === 'cto' ? 'CTO' : w === 'qa' ? 'QA' : w === 'ui' ? 'UI' : w === 'ux' ? 'UX' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

export function trackerLabels(t = {}) {
  const l = t.labels || {};
  return { managed: l.managed || 'software-factory', rolePrefix: l.role_prefix || 'role:', intake: l.intake || 'factory-intake', goal: l.goal || 'factory-goal' };
}

export function isFactoryLabel(name, labels) {
  const n = String(name).toLowerCase();
  return n === labels.managed.toLowerCase() || n.startsWith(labels.rolePrefix.toLowerCase()) || n === labels.goal.toLowerCase();
}

export function humanLabels(list, labels) { return (list || []).filter((x) => !isFactoryLabel(x, labels)); }

export function goalBody(goal) {
  const lines = [String(goal.outcome || '').trim(), '', 'Success criteria:'];
  for (const c of goal.success_criteria || []) lines.push(`- ${c}`);
  return lines.join('\n').trim();
}

export function taskBody(task) {
  const lines = [String(task.description || '').trim()];
  if ((task.acceptance_criteria || []).length) {
    lines.push('', 'Acceptance criteria:');
    for (const a of task.acceptance_criteria) lines.push(`- ${a.id}: ${a.text}`);
  }
  return lines.join('\n').trim();
}

export function withFooter(body, localId) { return `${body}\n\n${footer(localId)}`; }

/** Hashes we keep for a pushed/pulled canonical item. */
export function remoteHashes(item, labels) {
  return {
    title: hashValue(item.title),
    body: hashValue(stripFooter(item.bodyText ?? item.body ?? '')),
    status: item.statusId ?? null,
    labels: hashValue(humanLabels(item.labels, labels), 'labels'),
    priority: hashValue(item.priority, 'id'),
    assigneeId: hashValue(item.assigneeId, 'id'),
    dueDate: hashValue(item.dueDate, 'id'),
    parent: hashValue(item.parentRemoteId, 'id'),
    remoteUpdatedAt: item.updatedAt || null,
  };
}

function statusTarget(statusMap, key) { return key && statusMap && statusMap[key] ? statusMap[key].id : null; }

function handoffComment(h, task) {
  const head = `[software-factory] ${ROLE_NAME(h.from_role)} → ${ROLE_NAME(h.to_role)} · ${task.id} · ${task.status}`;
  const summary = String(h.summary || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const tail = [];
  if (h.evidence && h.evidence.command) tail.push(`Evidence: \`${String(h.evidence.command).slice(0, 80)}\` exit ${h.evidence.exit_code}.`);
  if (h.pr_url) tail.push(`PR: ${h.pr_url}`);
  return [head, ...summary, ...(tail.length ? [tail.join(' ')] : [])].slice(0, 8).join('\n');
}

/** True when a record carries a tracker_ref to link (§21.3.6): goal.tracker_ref or task.item.tracker_ref. */
export function hasRef(rec) { return !!refOf(rec); }

const KEY_RANK = { backlog: 0, ready: 1, in_progress: 2, in_review: 3, verified: 4, awaiting_approval: 5, done: 6 };
const TYPE_RANK = { triage: 0, backlog: 0, unstarted: 1, started: 2, completed: 6, canceled: 7 };

/** Rank of the remote state of an entry: the lowest mapped key with that state id, else its state type. */
export function remoteRank(sm, entry) {
  const id = (entry.pulled && entry.pulled.status) || entry.pushed.status || null;
  if (entry.remoteStatusType === 'canceled') return TYPE_RANK.canceled;
  let best = null;
  for (const [k, v] of Object.entries(sm || {})) if (v && v.id === id && KEY_RANK[k] !== undefined) best = best === null ? KEY_RANK[k] : Math.min(best, KEY_RANK[k]);
  return best !== null ? best : TYPE_RANK[entry.remoteStatusType] ?? null;
}

/**
 * Status push for a linked entry (a record that came in with a tracker_ref): only forward by rank, never to
 * cancelled. Returns 'push' | 'skip' | 'note_cancel'.
 */
export function linkedStatusRule(sm, entry, key) {
  if (key === 'cancelled') return 'note_cancel';
  const cur = remoteRank(sm, entry);
  return cur !== null && KEY_RANK[key] !== undefined && KEY_RANK[key] > cur ? 'push' : 'skip';
}

/** Goals that are pushed: kind goal only (stream and ops goals never are, §21.3.7). */
export function pushedGoal(g) { return !!g && goalKind(g) === 'goal'; }

/**
 * Tasks that are pushed: push_kinds tasks of kind-goal goals, and stream items (triage tasks) that carry a
 * tracker_ref or whose kind is in push_kinds. Stream code tasks and ops tasks never are.
 */
export function pushedTask(task, goal, pushKinds) {
  const gk = goalKind(goal);
  if (gk === 'ops') return false;
  if (task.kind === 'triage') return hasRef(task) || pushKinds.includes('triage');
  if (gk === 'stream') return false;
  return pushKinds.includes(task.kind);
}

/**
 * Plan push ops. ctx: {tracker (config.tracker), statusMap, map, goals[], tasks[], epics[], handoffs[], knownLabels:Set,
 * provider, scopeKey}, plus for teams (§21.3): multi, cfg, statusMapFor(key), knownLabelsFor(key), cyclesTracker, cycles.
 * Returns ops in execution order (labels, goals, tasks, then comments/links).
 */
export function planPush(ctx) {
  const t = ctx.tracker || {};
  const labels = trackerLabels(t);
  const pushKinds = t.push_kinds || DEFAULT_PUSH_KINDS;
  const createIn = t.create_in && t.create_in !== 'mapped' ? t.create_in : null;
  const multi = !!ctx.multi;
  const cfg = ctx.cfg || {};
  const projectMode = ctx.provider === 'linear' && t.goal_mapping === 'project';
  const smFor = (key) => (multi && ctx.statusMapFor ? ctx.statusMapFor(key) || {} : ctx.statusMap || {});
  const map = ctx.map;
  const labelOps = []; const itemOps = []; const tailOps = [];
  const needLabel = new Map(); // `${team}\n${name}` -> {team, name}
  const want = (team, name) => needLabel.set(`${team || ''}\n${name}`, { team: team || null, name });
  const mk = (o) => ({ ...o, opId: opId(o.localId, o.type, o.field || '', o.valueHash || '', o.localRev ?? '') });
  const goalsById = new Map((ctx.goals || []).map((g) => [g.id, g]));
  const configured = (k) => !!k && !!ctx.keys && [...ctx.keys].some((x) => x.toUpperCase() === String(k).toUpperCase());

  /** set_status for a mapped entry; linked entries move only forward and are never cancelled (a comment instead). */
  const statusOps = (rec, entry, key, target, kind, ok = true) => {
    if (!target || target === entry.pushed.status || target === entry.driftStatus || !ok) return;
    if (entry.linked) {
      const rule = linkedStatusRule(smFor(entryTeam(entry)), entry, key);
      if (rule === 'skip') return;
      if (rule === 'note_cancel') {
        if (entry.kind === 'project' || (entry.local && entry.local.noteCancelled)) return;
        tailOps.push(mk({ type: 'add_comment', localId: rec.id, kind, remoteId: entry.remoteId, field: 'cancelled', valueHash: 'cancelled',
          payload: { text: `[software-factory] ${rec.id} was cancelled in the factory. The tracker status is left as it is; close this item here if it is no longer needed.` }, meta: { note: 'cancelled' } }));
        return;
      }
    }
    itemOps.push(mk({ type: 'set_status', localId: rec.id, kind, remoteId: entry.remoteId, field: 'status', valueHash: target, payload: { statusId: target, mapKey: key } }));
  };

  const contentOps = (rec, entry, title, body) => {
    if (entry.linked) return; // a linked tracker item keeps its own text
    const th = hashValue(title); const bh = hashValue(body);
    if (entry.local && entry.local.title === th && entry.local.body === bh) return;
    if (!entry.local || (entry.local.title === undefined && entry.local.body === undefined)) return;
    itemOps.push(mk({ type: 'update_fields', localId: rec.id, kind: entry.kind, remoteId: entry.remoteId, field: 'content', valueHash: th + bh, localRev: rec.rev,
      payload: { title, body: withFooter(body, rec.id) }, local: { title: th, body: bh } }));
  };

  // ---- goals
  for (const g of ctx.goals || []) {
    if (!pushedGoal(g) || g.status === 'draft') continue;
    const entry = entryFor(map, g.id);
    const key = mapKeyForGoal(g.status);
    if (!entry || !entry.remoteId) {
      if (g.status === 'cancelled' || hasRef(g)) continue; // a tracker_ref is linked, never created
      const body = goalBody(g);
      if (projectMode) {
        const teams = multi ? goalKeys(cfg, g) : [];
        itemOps.push(mk({ type: 'create_item', localId: g.id, kind: 'project', localRev: 0,
          payload: { title: g.title, body: withFooter(body, g.id), ...(multi ? { teams } : {}) },
          local: { title: hashValue(g.title), body: hashValue(body) } }));
        continue;
      }
      const team = multi ? goalKeys(cfg, g)[0] : null;
      const lbl = [labels.managed, ...(ctx.provider === 'github' ? [labels.goal] : [])];
      lbl.forEach((l) => want(team, l));
      itemOps.push(mk({ type: 'create_item', localId: g.id, kind: 'goal', localRev: 0,
        payload: { title: g.title, body: withFooter(body, g.id), labels: lbl, statusId: createIn || statusTarget(smFor(team), key), priority: g.priority, ...(team ? { team } : {}) },
        local: { title: hashValue(g.title), body: hashValue(body) } }));
      continue;
    }
    if (entry.unlinked || entry.missing || entry.hold) continue;
    contentOps(g, entry, g.title, goalBody(g));
    if (entry.kind === 'project') {
      // goal.teams grew: add the new teams to the project. The project keeps every team it has now (entry.teams
      // and entry.teamIds are refreshed on each pull), including teams a human added.
      const have = (entry.teams || []).map((h) => String(h).toUpperCase());
      const add = multi ? goalKeys(cfg, g).filter((k) => !have.includes(k.toUpperCase())) : [];
      if (add.length) {
        const teams = [...have.filter(configured), ...add];
        itemOps.push(mk({ type: 'set_teams', localId: g.id, kind: 'project', remoteId: entry.remoteId, field: 'teams', valueHash: [...have, ...add].join(','),
          payload: { teams, keepIds: [...(entry.teamIds || [])] } }));
      }
      continue; // project status is not mapped
    }
    statusOps(g, entry, key, statusTarget(smFor(entryTeam(entry)), key), 'goal');
  }

  // ---- tasks
  const epics = new Map((ctx.epics || []).map((e) => [e.id, e]));
  const handoffs = new Map();
  for (const h of ctx.handoffs || []) { if (!handoffs.has(h.task_id)) handoffs.set(h.task_id, []); handoffs.get(h.task_id).push(h); }
  for (const task of ctx.tasks || []) {
    const goal = goalsById.get(task.goal_id) || null;
    if (!pushedTask(task, goal, pushKinds) || task.status === 'draft') continue;
    const isItem = task.kind === 'triage';
    const status = isItem ? itemStatus(task, epics) : task.status;
    const entry = entryFor(map, task.id);
    const key = mapKeyForTask(status);
    const epic = task.epic_id ? epics.get(task.epic_id) : null;
    const team = multi ? taskKey(cfg, task, { goal, epic }) : null;
    const cycleTracker = ctx.cyclesTracker && task.cycle ? cycleTrackerId(ctx.cycles, task.cycle) : null;
    if (!entry || !entry.remoteId) {
      if (status === 'cancelled' || hasRef(task)) continue; // a tracker_ref is linked, never created
      const sm = smFor(team);
      const target = statusTarget(sm, key);
      let parent = {};
      if (!isItem) {
        const goalEntry = entryFor(map, task.goal_id);
        if (!goalEntry || !goalEntry.remoteId) continue; // parent first; tasks follow next tick
        parent = goalEntry.kind === 'project' ? { projectId: goalEntry.remoteId } : { parentRemoteId: goalEntry.remoteId };
      }
      const lbl = [labels.managed, `${labels.rolePrefix}${task.role}`];
      lbl.forEach((l) => want(team, l));
      const body = taskBody(task);
      itemOps.push(mk({ type: 'create_item', localId: task.id, kind: 'task', localRev: 0,
        payload: { title: task.title, body: withFooter(body, task.id), labels: lbl, statusId: createIn || target || statusTarget(sm, 'backlog'), ...parent, priority: task.priority,
          ...(team ? { team } : {}), ...(cycleTracker ? { cycleId: cycleTracker } : {}) },
        local: { title: hashValue(task.title), body: hashValue(body), ...(cycleTracker ? { cycleRef: task.cycle } : {}) } }));
      continue;
    }
    if (entry.unlinked || entry.missing) continue;
    const target = statusTarget(smFor(entryTeam(entry) || team), key);
    if (!entry.hold) {
      contentOps(task, entry, task.title, taskBody(task));
      statusOps(task, entry, key, target, 'task', !task.done_override);
    }
    entry.local = entry.local || {};
    // cycle (§21.6.4): the factory sets it; push when task.cycle changed since the last push or pull. While a
    // human cycle change waits in the inbox (cycleHold) nothing is pushed; a null never clears a human's cycle.
    if (ctx.cyclesTracker && !entry.hold && !entry.cycleHold) {
      const ref = task.cycle ?? null;
      const last = entry.local.cycleRef;
      if (ref !== (last ?? null) && !(last === undefined && ref === null)) {
        const tid = ref ? cycleTrackerId(ctx.cycles, ref) : null;
        if (ref && !tid) { /* a local-only cycle: nothing to push */ } else if ((entry.remoteCycle ?? null) === tid) entry.local.cycleRef = ref;
        else if (!tid && entry.remoteCycle && entry.remoteCycle !== entry.factoryCycle) entry.local.cycleRef = ref;
        else itemOps.push(mk({ type: 'set_cycle', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'cycle', valueHash: tid || 'none', localRev: task.rev, payload: { cycleId: tid }, meta: { cycleRef: ref } }));
      }
    }
    if (!key && entry.local.side !== status) {
      const text = `[software-factory] ${task.id} is ${status}${task.status_reason ? `: ${String(task.status_reason).slice(0, 160)}` : ''}`;
      tailOps.push(mk({ type: 'add_comment', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'side', valueHash: status, localRev: task.rev, payload: { text }, meta: { side: status } }));
    } else if (key && entry.local.side) {
      entry.local.side = null; // back on a mapped state; the next side state gets a fresh comment
    }
    for (const h of handoffs.get(task.id) || []) {
      if ((entry.commentedRuns || []).includes(h.run_id)) continue;
      if (entry.created_at && h.ended_at && Date.parse(h.ended_at) < Date.parse(entry.created_at)) continue;
      if (!h.from_role || h.from_role === h.to_role) continue;
      tailOps.push(mk({ type: 'add_comment', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'handoff', valueHash: h.run_id, payload: { text: handoffComment(h, task) }, meta: { runId: h.run_id } }));
    }
    const pr = (epic && epic.pr && epic.pr.url) || task.pr_url || null;
    if (pr && !(entry.linkedPRs || []).includes(pr)) {
      tailOps.push(mk({ type: 'add_link', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'pr', valueHash: pr, payload: { url: pr, linkTitle: `PR for ${task.id}` } }));
    }
  }
  for (const { team, name } of needLabel.values()) {
    if (team) {
      const known = ctx.knownLabelsFor ? ctx.knownLabelsFor(team) : null;
      if (known && known.has(String(name).toLowerCase())) continue;
      labelOps.push(mk({ type: 'ensure_label', localId: `label:${team}:${name}`, kind: 'label', field: 'label', valueHash: `${team}:${name}`, payload: { name, team } }));
      continue;
    }
    if (ctx.knownLabels && ctx.knownLabels.has(String(name).toLowerCase())) continue;
    labelOps.push(mk({ type: 'ensure_label', localId: `label:${name}`, kind: 'label', field: 'label', valueHash: name, payload: { name } }));
  }
  return [...labelOps, ...itemOps, ...tailOps];
}

/**
 * Plan what a pull means. ctx: {items, comments, missing, map, goals[], tasks[], statusMap, tracker, provider,
 * firstSyncApproved}, plus for teams and streams (§21.3-21.6): multi, keys (Set of configured tracker keys),
 * statusMapFor(key), cfg, streams {enabled, mode, keys:Set}|null, projectIntake, cyclesTracker, cycles.
 * Mutates map entries (pulled hashes, relinks, missing, team). Returns {requests[], logs[], relinked[]}.
 * Request descriptor: {type, payload, needs_confirmation, auto_apply, key, track}.
 */
export function planPull(ctx) {
  const t = ctx.tracker || {};
  const labels = trackerLabels(t);
  const map = ctx.map;
  const remoteIdx = byRemote(map);
  const goals = new Map((ctx.goals || []).map((g) => [g.id, g]));
  const tasks = new Map((ctx.tasks || []).map((x) => [x.id, x]));
  const multi = !!ctx.multi;
  const keys = ctx.keys || new Set();
  const configured = (k) => !!k && [...keys].some((x) => x.toUpperCase() === String(k).toUpperCase());
  const smFor = (key) => (multi && ctx.statusMapFor ? ctx.statusMapFor(key) : ctx.statusMap);
  const refIds = new Set([...(ctx.goals || []), ...(ctx.tasks || [])].filter(hasRef).map((r) => String(refOf(r).remote_id)));
  const streams = ctx.streams && ctx.streams.enabled ? ctx.streams : null;
  const requests = []; const logs = []; const relinked = [];
  const subject = (localId) => (localId.startsWith('G-') ? { goal_id: localId } : { task_id: localId, goal_id: (tasks.get(localId) || {}).goal_id || null });
  const req = (type, localId, remote, field, after, payload, { confirm = false, auto = false, track = false, cls = null } = {}) => {
    requests.push({
      type, payload: { ...subject(localId), remote_key: remote.key, url: remote.url, ...payload },
      needs_confirmation: confirm, auto_apply: auto, key: dedupeKey(type, remote.remoteId, field, after),
      track: track ? { localId, field, cls } : null,
    });
  };
  const isIntake = (item) => (item.labels || []).some((l) => String(l).toLowerCase() === labels.intake.toLowerCase());
  const intake = (item, extra) => requests.push({
    type: 'tracker.intake', needs_confirmation: false, auto_apply: false, key: dedupeKey('tracker.intake', item.remoteId, 'intake', ''), track: null,
    payload: { remote_id: item.remoteId, remote_key: item.key, key: item.key, url: item.url, title: String(item.title).slice(0, 200), labels: (item.labels || []).slice(0, 20), body: String(item.bodyText || '').slice(0, 2000), ...extra },
  });
  const itemsById = new Map((ctx.items || []).map((i) => [String(i.remoteId), i]));

  for (const item of ctx.items || []) {
    const localId = remoteIdx.get(String(item.remoteId));
    if (!localId) {
      const sf = findSfId(item.body && typeof item.body === 'string' ? item.body : item.bodyText);
      const local = sf && (goals.get(sf) || tasks.get(sf));
      if (local) {
        const b = sf.startsWith('G-') ? map.goals : map.items;
        const e = b[sf];
        if (!e || !e.remoteId) {
          b[sf] = { ...(e || {}), kind: item.kind === 'project' ? 'project' : sf.startsWith('G-') ? 'goal' : 'task', remoteId: item.remoteId, key: item.key, url: item.url,
            pushed: remoteHashes(item, labels), pulled: {}, pendingCreate: false, scopeKey: ctx.scopeKey || null,
            local: sf.startsWith('G-') ? { title: hashValue(local.title), body: hashValue(goalBody(local)) } : { title: hashValue(local.title), body: hashValue(taskBody(local)) },
            ourCommentIds: (e && e.ourCommentIds) || [], linkedPRs: (e && e.linkedPRs) || [], commentedRuns: (e && e.commentedRuns) || [], created_at: item.updatedAt || null,
            ...(multi && item.teamKey ? { team: item.teamKey } : {}), ...(item.kind === 'project' ? { teams: item.teamKeys || [] } : {}) };
          relinked.push({ localId: sf, key: item.key });
          logs.push({ dir: 'pull', op: 'relink', localId: sf, remoteKey: item.key, result: 'ok', fields: ['sf-id'] });
        }
        continue;
      }
      if (sf || item.closed || refIds.has(String(item.remoteId))) continue;
      if (item.kind === 'project') {
        // §21.3.5: a project in the teams that carries the intake label becomes a draft goal
        const teams = (item.teamKeys || []).filter((k) => !multi || configured(k));
        if (ctx.projectIntake && isIntake(item) && teams.length) intake(item, { kind: 'project', teams });
        continue;
      }
      const cls = streams ? classOf(ctx.cfg, item.labels) : null;
      if (cls && item.teamKey && [...streams.keys].some((k) => k.toUpperCase() === item.teamKey.toUpperCase())) {
        // §21.4.5: a class-labelled issue becomes a stream item when streams.pull allows it
        const ok = streams.mode === 'all' || (streams.mode === 'cycle' ? !!item.cycleActive : isIntake(item));
        if (ok) {
          requests.push({
            type: 'tracker.backlog_item', needs_confirmation: false, auto_apply: true, key: `backlog:${item.remoteId}`, track: null,
            payload: { remote_id: item.remoteId, key: item.key, url: item.url, team_key: item.teamKey, class: cls, title: String(item.title).slice(0, 200),
              body: String(item.body || '').slice(0, 4000), author_id: item.authorId || null, priority: item.priority || null, cycle_tracker_id: item.cycleId || null },
          });
          continue;
        }
        if (isIntake(item)) continue; // a class-labelled item waits for its stream rule, never a goal
      }
      if (isIntake(item)) intake(item, { kind: 'issue', teams: item.teamKey ? [item.teamKey] : [] });
      continue;
    }
    const entry = (localId.startsWith('G-') ? map.goals : map.items)[localId];
    if (!entry || entry.unlinked) continue;
    const local = localId.startsWith('G-') ? goals.get(localId) : tasks.get(localId);
    if (!local) continue;
    // moved between configured teams: not missing, the entry follows the issue (§21.3.5)
    if (multi && item.kind !== 'project' && item.teamKey && entryTeam(entry) !== String(item.teamKey).toUpperCase() && configured(item.teamKey)) {
      logs.push({ dir: 'pull', op: 'team_moved', localId, remoteKey: item.key, result: 'ok', fields: ['team'] });
      entry.team = String(item.teamKey).toUpperCase();
    }
    // a project's teams as they are now (a human may have added one): set_teams keeps them all
    if (item.kind === 'project' && entry.kind === 'project') { entry.teams = (item.teamKeys || []).map((k) => String(k).toUpperCase()); entry.teamIds = [...(item.teamIds || [])]; }
    if (!ctx.full && unchangedSincePush(entry, item.updatedAt)) continue;
    entry.pulled = entry.pulled || {};
    const h = remoteHashes(item, labels);
    const changed = [];

    // title and body: shared, gated
    const localText = { title: local.title, body: localId.startsWith('G-') ? goalBody(local) : taskBody(local) };
    for (const f of ['title', 'body']) {
      if (isEcho(entry, f, h[f])) continue;
      changed.push(f);
      const localMoved = entry.local && entry.local[f] && entry.local[f] !== hashValue(localText[f]);
      const after = f === 'title' ? String(item.title).slice(0, 300) : String(stripFooter(item.bodyText || '')).slice(0, 2000);
      if (localMoved) {
        req('tracker.conflict', localId, item, f, h[f], { field: f, local: String(localText[f]).slice(0, 2000), remote: after }, { confirm: true, track: true, cls: 'conflict' });
      } else {
        req('tracker.scope_change', localId, item, f, h[f], { field: f, before: String(localText[f]).slice(0, 2000), after }, { confirm: true, track: true, cls: 'scope_change' });
      }
      entry.pulled[f] = h[f];
    }
    if (item.kind === 'project') {
      entry.pulled.remoteUpdatedAt = item.updatedAt;
      if (changed.length) logs.push({ dir: 'pull', op: 'changed', localId, remoteKey: item.key, result: 'ok', fields: changed });
      continue; // projects carry no mapped status, labels or parent
    }

    // status: factory-owned (shared while backlog/ready)
    if (item.statusId && item.statusId !== entry.pushed.status && item.statusId !== entry.pulled.status) {
      changed.push('status');
      entry.pulled.status = item.statusId;
      if (entry.linked) entry.remoteStatusType = item.statusType || null;
      if (localId.startsWith('T-')) {
        const cls = classifyStatusChange({ localStatus: local.status, remote: item, statusMap: smFor(entryTeam(entry) || item.teamKey) });
        const pol = classPolicy(t, cls);
        if (cls !== 'consistent') {
          if (pol === 'log') logs.push({ dir: 'pull', op: `status:${cls}`, localId, remoteKey: item.key, result: 'logged', fields: ['status'] });
          else req('tracker.status_change', localId, item, 'status', `${item.statusId}@${item.updatedAt}`, { class: cls, remote_status: item.statusName, remote_type: item.statusType },
            { confirm: pol === 'confirm', auto: pol === 'auto', track: pol === 'confirm', cls });
        }
      } else if (item.statusType === 'canceled' && local.status !== 'cancelled') {
        req('tracker.status_change', localId, item, 'status', `${item.statusId}@${item.updatedAt}`, { class: 'cancel', remote_status: item.statusName, remote_type: item.statusType }, { confirm: true, track: true, cls: 'cancel' });
      } else logs.push({ dir: 'pull', op: 'status:goal', localId, remoteKey: item.key, result: 'logged', fields: ['status'] });
    }

    // human-owned fields: auto-apply
    const human = { priority: item.priority, assigneeId: item.assigneeId, dueDate: item.dueDate, labels: humanLabels(item.labels, labels) };
    for (const f of ['priority', 'assigneeId', 'dueDate', 'labels']) {
      if (isEcho(entry, f, h[f])) continue;
      if (entry.pushed[f] === undefined && entry.pulled[f] === undefined) { entry.pulled[f] = h[f]; continue; }
      changed.push(f);
      entry.pulled[f] = h[f];
      if (f === 'priority' && !human.priority) continue;
      req('tracker.field_update', localId, item, f, `${h[f]}@${item.updatedAt}`, { field: f === 'assigneeId' ? 'assignee' : f === 'dueDate' ? 'due_date' : f, value: human[f] ?? null }, { auto: true });
    }

    // cycle (§21.6.4): a human change arrives as tracker.field_update {field: "cycle"}
    if (ctx.cyclesTracker && localId.startsWith('T-') && item.cycleId !== undefined) {
      const now = item.cycleId || null;
      if (entry.remoteCycle === undefined) entry.remoteCycle = now;
      else if ((entry.remoteCycle ?? null) !== now) {
        changed.push('cycle');
        entry.remoteCycle = now;
        // what the CLI will write (null for a cycle the factory does not know); pushes wait while it is pending
        entry.local = { ...(entry.local || {}), cycleRef: factoryCycleFor(ctx.cycles, now) };
        req('tracker.field_update', localId, item, 'cycle', `${now || 'none'}@${item.updatedAt}`, { field: 'cycle', value: now }, { auto: true, track: true, cls: 'cycle' });
      }
    }

    // factory labels removed by a human: log only (linked items never carried them)
    const hasManaged = (item.labels || []).some((l) => String(l).toLowerCase() === labels.managed.toLowerCase());
    if (!hasManaged && !entry.linked) { entry.labelsMissing = true; logs.push({ dir: 'pull', op: 'factory_label_removed', localId, remoteKey: item.key, result: 'logged', fields: ['labels'] }); }

    // parent moved: needs confirmation (tasks under a goal issue only)
    if (localId.startsWith('T-') && !entry.linked && !isEcho(entry, 'parent', h.parent)) {
      const goalEntry = entryFor(map, local.goal_id);
      if (goalEntry && goalEntry.remoteId && goalEntry.kind !== 'project' && item.parentRemoteId !== goalEntry.remoteId && entry.pushed.parent !== undefined) {
        changed.push('parent');
        req('tracker.scope_change', localId, item, 'parent', h.parent, { field: 'parent', before: goalEntry.key, after: item.parentRemoteId ? (remoteIdx.get(String(item.parentRemoteId)) || 'another item') : 'none' }, { confirm: true, track: true, cls: 'scope_change' });
      }
      entry.pulled.parent = h.parent;
    }
    entry.pulled.remoteUpdatedAt = item.updatedAt;
    if (changed.length) logs.push({ dir: 'pull', op: 'changed', localId, remoteKey: item.key, result: 'ok', fields: changed });
  }

  // human comments
  for (const c of ctx.comments || []) {
    const localId = remoteIdx.get(String(c.remoteId));
    if (!localId) continue;
    const entry = (localId.startsWith('G-') ? map.goals : map.items)[localId];
    if (!entry || entry.unlinked || isOurComment(entry, c.id)) continue;
    if (/^\s*\[software-factory\]/.test(c.body || '')) continue;
    entry.seenComments = entry.seenComments || [];
    if (entry.seenComments.includes(String(c.id))) continue;
    entry.seenComments.push(String(c.id));
    if (entry.seenComments.length > 200) entry.seenComments.splice(0, entry.seenComments.length - 200);
    requests.push({
      type: 'tracker.comment', needs_confirmation: false, auto_apply: false, key: dedupeKey('tracker.comment', c.remoteId, c.id, ''), track: null,
      payload: { ...subject(localId), remote_key: entry.key, url: entry.url, comment_id: String(c.id), author_id: c.authorId, author: c.author, text: String(c.body || '').slice(0, 2000) },
    });
  }

  // missing: deleted, archived, moved or transferred
  for (const rid of ctx.missing || []) {
    const localId = remoteIdx.get(String(rid));
    if (!localId) continue;
    const entry = (localId.startsWith('G-') ? map.goals : map.items)[localId];
    if (!entry || entry.unlinked || entry.missing) continue;
    const seen = itemsById.get(String(rid));
    if (multi && seen && seen.teamKey && entry.team && seen.teamKey === entry.team) {
      // its team was taken out of the config: the scope guard blocks its ops; nothing moved
      logs.push({ dir: 'pull', op: 'team_not_configured', localId, remoteKey: entry.key, result: 'logged', fields: ['team'] });
      continue;
    }
    entry.missing = true;
    requests.push({ type: 'tracker.missing', needs_confirmation: true, auto_apply: false, key: dedupeKey('tracker.missing', rid, 'missing', ''),
      track: { localId, field: 'missing', cls: 'missing' }, payload: { ...subject(localId), remote_key: entry.key, url: entry.url } });
  }
  return { requests, logs, relinked };
}

/** Bulk guard counts. */
export function bulkCounts(ops, statusMap, otherMaps = []) {
  const closing = new Set([statusMap, ...otherMaps].flatMap((m) => [m && m.done && m.done.id, m && m.cancelled && m.cancelled.id]).filter(Boolean));
  return {
    total: ops.filter((o) => o.type !== 'ensure_label').length,
    closing: ops.filter((o) => o.type === 'set_status' && closing.has(o.payload.statusId)).length,
  };
}
