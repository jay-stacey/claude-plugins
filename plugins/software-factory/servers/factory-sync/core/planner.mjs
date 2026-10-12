// Planner: diffs local records against the map (ledger) and pulled remote items (design C §7-§8).
// Pure functions: no I/O. The engine executes what this returns.
import { footer, findSfId, hashValue, stripFooter } from './normalize.mjs';
import { classifyStatusChange, classPolicy, mapKeyForGoal, mapKeyForTask } from './ownership.mjs';
import { dedupeKey, isEcho, isOurComment, opId, unchangedSincePush } from './echo.mjs';
import { byRemote, entryFor } from './map.mjs';

export const DEFAULT_PUSH_KINDS = ['prd', 'spec', 'mockup', 'code', 'docs'];
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

/**
 * Plan push ops. ctx: {tracker (config.tracker), statusMap, map, goals[], tasks[], epics[], handoffs[], knownLabels:Set,
 * provider, scopeKey}. Returns ops in execution order (labels, goals, tasks, then comments/links).
 */
export function planPush(ctx) {
  const t = ctx.tracker || {};
  const labels = trackerLabels(t);
  const pushKinds = t.push_kinds || DEFAULT_PUSH_KINDS;
  const createIn = t.create_in && t.create_in !== 'mapped' ? t.create_in : null;
  const sm = ctx.statusMap || {};
  const map = ctx.map;
  const labelOps = []; const itemOps = []; const tailOps = [];
  const needLabel = new Set();
  const mk = (o) => ({ ...o, opId: opId(o.localId, o.type, o.field || '', o.valueHash || '', o.localRev ?? '') });

  const contentOps = (rec, entry, title, body) => {
    const th = hashValue(title); const bh = hashValue(body);
    if (entry.local && entry.local.title === th && entry.local.body === bh) return;
    if (!entry.local || (entry.local.title === undefined && entry.local.body === undefined)) return;
    itemOps.push(mk({ type: 'update_fields', localId: rec.id, kind: entry.kind, remoteId: entry.remoteId, field: 'content', valueHash: th + bh, localRev: rec.rev,
      payload: { title, body: withFooter(body, rec.id) }, local: { title: th, body: bh } }));
  };

  // ---- goals
  for (const g of ctx.goals || []) {
    if (g.status === 'draft') continue;
    const entry = entryFor(map, g.id);
    const key = mapKeyForGoal(g.status);
    const target = statusTarget(sm, key);
    if (!entry || !entry.remoteId) {
      if (g.status === 'cancelled') continue;
      const lbl = [labels.managed, ...(ctx.provider === 'github' ? [labels.goal] : [])];
      lbl.forEach((l) => needLabel.add(l));
      const body = goalBody(g);
      itemOps.push(mk({ type: 'create_item', localId: g.id, kind: 'goal', localRev: 0,
        payload: { title: g.title, body: withFooter(body, g.id), labels: lbl, statusId: createIn || target, priority: g.priority },
        local: { title: hashValue(g.title), body: hashValue(body) } }));
      continue;
    }
    if (entry.unlinked || entry.missing || entry.hold) continue;
    contentOps(g, entry, g.title, goalBody(g));
    if (target && target !== entry.pushed.status && target !== entry.driftStatus) {
      itemOps.push(mk({ type: 'set_status', localId: g.id, kind: 'goal', remoteId: entry.remoteId, field: 'status', valueHash: target, payload: { statusId: target, mapKey: key } }));
    }
  }

  // ---- tasks
  const epics = new Map((ctx.epics || []).map((e) => [e.id, e]));
  const handoffs = new Map();
  for (const h of ctx.handoffs || []) { if (!handoffs.has(h.task_id)) handoffs.set(h.task_id, []); handoffs.get(h.task_id).push(h); }
  for (const task of ctx.tasks || []) {
    if (!pushKinds.includes(task.kind) || task.status === 'draft') continue;
    const entry = entryFor(map, task.id);
    const key = mapKeyForTask(task.status);
    const target = statusTarget(sm, key);
    if (!entry || !entry.remoteId) {
      if (task.status === 'cancelled') continue;
      const goalEntry = entryFor(map, task.goal_id);
      if (!goalEntry || !goalEntry.remoteId) continue; // parent first; tasks follow next tick
      const lbl = [labels.managed, `${labels.rolePrefix}${task.role}`];
      lbl.forEach((l) => needLabel.add(l));
      const body = taskBody(task);
      itemOps.push(mk({ type: 'create_item', localId: task.id, kind: 'task', localRev: 0,
        payload: { title: task.title, body: withFooter(body, task.id), labels: lbl, statusId: createIn || target || statusTarget(sm, 'backlog'), parentRemoteId: goalEntry.remoteId, priority: task.priority },
        local: { title: hashValue(task.title), body: hashValue(body) } }));
      continue;
    }
    if (entry.unlinked || entry.missing) continue;
    if (!entry.hold) {
      contentOps(task, entry, task.title, taskBody(task));
      if (target && target !== entry.pushed.status && target !== entry.driftStatus && !task.done_override) {
        itemOps.push(mk({ type: 'set_status', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'status', valueHash: target, payload: { statusId: target, mapKey: key } }));
      }
    }
    entry.local = entry.local || {};
    if (!key && entry.local.side !== task.status) {
      const text = `[software-factory] ${task.id} is ${task.status}${task.status_reason ? `: ${String(task.status_reason).slice(0, 160)}` : ''}`;
      tailOps.push(mk({ type: 'add_comment', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'side', valueHash: task.status, localRev: task.rev, payload: { text }, meta: { side: task.status } }));
    } else if (key && entry.local.side) {
      entry.local.side = null; // back on a mapped state; the next side state gets a fresh comment
    }
    for (const h of handoffs.get(task.id) || []) {
      if ((entry.commentedRuns || []).includes(h.run_id)) continue;
      if (entry.created_at && h.ended_at && Date.parse(h.ended_at) < Date.parse(entry.created_at)) continue;
      if (!h.from_role || h.from_role === h.to_role) continue;
      tailOps.push(mk({ type: 'add_comment', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'handoff', valueHash: h.run_id, payload: { text: handoffComment(h, task) }, meta: { runId: h.run_id } }));
    }
    const epic = task.epic_id ? epics.get(task.epic_id) : null;
    const pr = (epic && epic.pr && epic.pr.url) || task.pr_url || null;
    if (pr && !(entry.linkedPRs || []).includes(pr)) {
      tailOps.push(mk({ type: 'add_link', localId: task.id, kind: 'task', remoteId: entry.remoteId, field: 'pr', valueHash: pr, payload: { url: pr, linkTitle: `PR for ${task.id}` } }));
    }
  }
  for (const name of needLabel) {
    if (ctx.knownLabels && ctx.knownLabels.has(String(name).toLowerCase())) continue;
    labelOps.push(mk({ type: 'ensure_label', localId: `label:${name}`, kind: 'label', field: 'label', valueHash: name, payload: { name } }));
  }
  return [...labelOps, ...itemOps, ...tailOps];
}

/**
 * Plan what a pull means. ctx: {items, comments, missing, map, goals[], tasks[], statusMap, tracker, provider,
 * firstSyncApproved}. Mutates map entries (pulled hashes, relinks, missing). Returns {requests[], logs[], relinked[]}.
 * Request descriptor: {type, payload, needs_confirmation, auto_apply, key, track}.
 */
export function planPull(ctx) {
  const t = ctx.tracker || {};
  const labels = trackerLabels(t);
  const map = ctx.map;
  const remoteIdx = byRemote(map);
  const goals = new Map((ctx.goals || []).map((g) => [g.id, g]));
  const tasks = new Map((ctx.tasks || []).map((x) => [x.id, x]));
  const requests = []; const logs = []; const relinked = [];
  const subject = (localId) => (localId.startsWith('G-') ? { goal_id: localId } : { task_id: localId, goal_id: (tasks.get(localId) || {}).goal_id || null });
  const req = (type, localId, remote, field, after, payload, { confirm = false, auto = false, track = false, cls = null } = {}) => {
    requests.push({
      type, payload: { ...subject(localId), remote_key: remote.key, url: remote.url, ...payload },
      needs_confirmation: confirm, auto_apply: auto, key: dedupeKey(type, remote.remoteId, field, after),
      track: track ? { localId, field, cls } : null,
    });
  };

  for (const item of ctx.items || []) {
    const localId = remoteIdx.get(String(item.remoteId));
    if (!localId) {
      const sf = findSfId(item.body && typeof item.body === 'string' ? item.body : item.bodyText);
      const local = sf && (goals.get(sf) || tasks.get(sf));
      if (local) {
        const b = sf.startsWith('G-') ? map.goals : map.items;
        const e = b[sf];
        if (!e || !e.remoteId) {
          b[sf] = { ...(e || {}), kind: sf.startsWith('G-') ? 'goal' : 'task', remoteId: item.remoteId, key: item.key, url: item.url,
            pushed: remoteHashes(item, labels), pulled: {}, pendingCreate: false, scopeKey: ctx.scopeKey || null,
            local: sf.startsWith('G-') ? { title: hashValue(local.title), body: hashValue(goalBody(local)) } : { title: hashValue(local.title), body: hashValue(taskBody(local)) },
            ourCommentIds: (e && e.ourCommentIds) || [], linkedPRs: (e && e.linkedPRs) || [], commentedRuns: (e && e.commentedRuns) || [], created_at: item.updatedAt || null };
          relinked.push({ localId: sf, key: item.key });
          logs.push({ dir: 'pull', op: 'relink', localId: sf, remoteKey: item.key, result: 'ok', fields: ['sf-id'] });
        }
        continue;
      }
      const isIntake = (item.labels || []).some((l) => String(l).toLowerCase() === labels.intake.toLowerCase());
      if (isIntake && !sf && !item.closed) {
        requests.push({
          type: 'tracker.intake', needs_confirmation: false, auto_apply: false, key: dedupeKey('tracker.intake', item.remoteId, 'intake', ''), track: null,
          payload: { remote_id: item.remoteId, remote_key: item.key, url: item.url, title: String(item.title).slice(0, 200), labels: (item.labels || []).slice(0, 20), body: String(item.bodyText || '').slice(0, 2000) },
        });
      }
      continue;
    }
    const entry = (localId.startsWith('G-') ? map.goals : map.items)[localId];
    if (!entry || entry.unlinked) continue;
    const local = localId.startsWith('G-') ? goals.get(localId) : tasks.get(localId);
    if (!local) continue;
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

    // status: factory-owned (shared while backlog/ready)
    if (item.statusId && item.statusId !== entry.pushed.status && item.statusId !== entry.pulled.status) {
      changed.push('status');
      entry.pulled.status = item.statusId;
      if (localId.startsWith('T-')) {
        const cls = classifyStatusChange({ localStatus: local.status, remote: item, statusMap: ctx.statusMap });
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

    // factory labels removed by a human: log only
    const hasManaged = (item.labels || []).some((l) => String(l).toLowerCase() === labels.managed.toLowerCase());
    if (!hasManaged) { entry.labelsMissing = true; logs.push({ dir: 'pull', op: 'factory_label_removed', localId, remoteKey: item.key, result: 'logged', fields: ['labels'] }); }

    // parent moved: needs confirmation
    if (localId.startsWith('T-') && !isEcho(entry, 'parent', h.parent)) {
      const goalEntry = entryFor(map, local.goal_id);
      if (goalEntry && goalEntry.remoteId && item.parentRemoteId !== goalEntry.remoteId && entry.pushed.parent !== undefined) {
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
    entry.missing = true;
    requests.push({ type: 'tracker.missing', needs_confirmation: true, auto_apply: false, key: dedupeKey('tracker.missing', rid, 'missing', ''),
      track: { localId, field: 'missing', cls: 'missing' }, payload: { ...subject(localId), remote_key: entry.key, url: entry.url } });
  }
  return { requests, logs, relinked };
}

/** Bulk guard counts. */
export function bulkCounts(ops, statusMap) {
  const closing = new Set([statusMap && statusMap.done && statusMap.done.id, statusMap && statusMap.cancelled && statusMap.cancelled.id].filter(Boolean));
  return {
    total: ops.filter((o) => o.type !== 'ensure_label').length,
    closing: ops.filter((o) => o.type === 'set_status' && closing.has(o.payload.statusId)).length,
  };
}
