// Board: epic strip + kanban columns + task detail drawer.
import { html, useMemo, useState } from '../html.mjs';
import {
  Avatar, GateBadges, Meter, SideBadge, Tag, Icon, PrLink, Drawer, ArtifactButton, openArtifact, RepoChip,
  goalColorClass, roleInfo, useQueueState, QueuedStatus, FieldError, Tokens,
} from '../components.mjs';
import { submit } from '../api.mjs';
import { COLUMNS, SIDE_STATES, columnOf, indexBy, taskMatches, taskGateBadges, epicProgress, isWorkspace } from '../lib/model.mjs';
import { fmtDuration, fmtTokens, statusWord, timeAgo, fmtDateTime, kindWord } from '../lib/format.mjs';
import { buildHash } from '../router.mjs';

const DONE_LIMIT = 20;
const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3 };
const byPriority = (a, b) => (PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9) || String(a.id).localeCompare(String(b.id));

function EpicStrip({ snap, epics, gatesById, goalFilter, repoFilter }) {
  const ws = isWorkspace(snap);
  const list = epics.filter((e) => e.status !== 'cancelled' && (!goalFilter || e.goal_id === goalFilter) && (!repoFilter || e.repo === repoFilter));
  if (!list.length) return null;
  return html`<section class="epic-strip" aria-label="Epics">
    <h2 class="sr-only">Epics</h2>
    <ul class="epic-list">
      ${list.map((e) => {
        const steps = epicProgress(e, gatesById, { workspace: ws });
        return html`<li class=${`epic-chip ${goalColorClass(snap, e.goal_id)}`}>
          <div class="epic-top">
            <span class="mono small">${e.id}</span>
            <span class="epic-title" title=${e.title}>${e.title}</span>
            ${ws && html`<${RepoChip} repo=${e.repo} />`}
          </div>
          <div class="epic-bottom">
            <span class="small muted">${statusWord(e.status)}</span>
            <ol class="steps" aria-label=${`${e.id} progress`}>
              ${steps.map((s) => html`<li class=${`step step-${s.state}`}>
                <${Icon} name=${s.state === 'done' ? 'check' : s.state === 'current' ? 'half' : s.state === 'failed' ? 'cross' : 'open'} />
                <span>${s.label}</span><span class="sr-only">: ${s.state === 'todo' ? 'not reached' : s.state}</span></li>`)}
            </ol>
            <${PrLink} pr=${e.pr} />
          </div>
        </li>`;
      })}
    </ul>
  </section>`;
}

function TaskCard({ task, snap, idx, onOpen }) {
  const ws = isWorkspace(snap);
  const badges = taskGateBadges(task, idx.goals, idx.epics, idx.gates);
  const epic = task.epic_id ? idx.epics.get(task.epic_id) : null;
  const ev = (task.evidence || [])[task.evidence ? task.evidence.length - 1 : 0];
  const r = roleInfo(snap, task.role);
  const open = (e) => {
    if (e.target.closest('a, button:not(.card-title)')) return;
    onOpen(task.id);
  };
  return html`<li class=${`card ${goalColorClass(snap, task.goal_id)}`} onClick=${open}>
    <div class="card-top">
      <span class="mono small">${task.id}</span>
      ${ws && html`<${RepoChip} repo=${task.repo} kind=${task.kind} />`}
      ${task.status === 'draft' && html`<${Tag} tone="idle" icon="dot">Draft<//>`}
      ${task.status === 'changes_requested' && html`<${Tag} tone="warn" icon="cross">Changes requested<//>`}
      <${SideBadge} status=${task.status} />
      ${task.attempts > 1 && html`<span class="small muted" title="Attempt number">try ${task.attempts}/${task.max_attempts || 3}</span>`}
    </div>
    <button type="button" class="card-title" onClick=${() => onOpen(task.id)} aria-haspopup="dialog">${task.title}</button>
    <div class="card-meta">
      <${Avatar} snap=${snap} role=${task.role} live=${!!task.live} size="sm" />
      <span class="small muted card-role">${r.short}</span>
      <${GateBadges} badges=${badges} />
    </div>
    ${task.estimate_tokens > 0 && html`<${Meter} value=${task.tokens || 0} max=${task.estimate_tokens}
      label=${`${Math.round(((task.tokens || 0) / task.estimate_tokens) * 100)}% of ${fmtTokens(task.estimate_tokens)}`} />`}
    <div class="card-foot small">
      ${epic && epic.pr && html`<${PrLink} pr=${epic.pr} />`}
      ${ev && ev.log_path && html`<button type="button" class="link-btn" onClick=${() => openArtifact(ev.log_path)} title=${ev.log_path}>
        <${Icon} name="file" />${ev.label || 'evidence'}${ev.exit_code != null && ev.exit_code !== 0 ? ` (exit ${ev.exit_code})` : ''}</button>`}
      ${task.time_in_status_s != null && html`<span class="muted card-age" title="Time in this column"><${Icon} name="clock" />${fmtDuration(task.time_in_status_s)}</span>`}
    </div>
  </li>`;
}

function Column({ col, tasks, snap, idx, onOpen }) {
  const [showAll, setShowAll] = useState(false);
  const id = `col-${col.id}`;
  if (col.id === 'stuck' && !tasks.length) {
    return html`<section class="col col-collapsed" aria-labelledby=${id}>
      <h2 class="col-head" id=${id}><span>Stuck</span> <span class="count">0</span></h2>
    </section>`;
  }
  let list = tasks;
  if (col.id === 'done') {
    list = [...tasks].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    if (!showAll) list = list.slice(0, DONE_LIMIT);
  } else list = [...tasks].sort(byPriority);
  return html`<section class=${`col col-${col.id}`} aria-labelledby=${id}>
    <h2 class="col-head" id=${id}>
      ${col.id === 'stuck' && html`<${Icon} name="warn" />`}<span>${col.label}</span> <span class="count">${tasks.length}</span>
    </h2>
    ${list.length ? html`<ul class="col-cards">${list.map((t) => html`<${TaskCard} key=${t.id} task=${t} snap=${snap} idx=${idx} onOpen=${onOpen} />`)}</ul>`
      : html`<p class="col-empty small muted">No tasks</p>`}
    ${col.id === 'done' && tasks.length > DONE_LIMIT && html`<button type="button" class="btn btn-ghost btn-sm col-more" onClick=${() => setShowAll(!showAll)}>
      ${showAll ? `Show last ${DONE_LIMIT}` : `Show all ${tasks.length}`}</button>`}
  </section>`;
}

function NoteForm({ task, snap, nowMs }) {
  const key = `task.note:${task.id}`;
  const q = useQueueState(key, snap);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || v.length > 2000) { setErr('Write a note of 1 to 2000 characters.'); return; }
    setErr(''); setBusy(true);
    const r = await submit(key, 'task.note', { task_id: task.id, text: v });
    setBusy(false);
    if (r.ok) setText(''); else setErr(r.error);
  };
  const errId = `note-err-${task.id}`;
  return html`<form class="stack" onSubmit=${send}>
    <label for=${`note-${task.id}`} class="label">Send note to next agent</label>
    <textarea id=${`note-${task.id}`} rows="3" maxlength="2000" value=${text} onInput=${(e) => setText(e.currentTarget.value)}
      aria-describedby=${err ? errId : undefined} aria-invalid=${err ? 'true' : undefined}
      placeholder="The next agent that works on this task reads this note in its brief."></textarea>
    <${FieldError} id=${errId} text=${err} />
    <div class="row"><button type="submit" class="btn btn-primary" disabled=${busy}>Send note</button>
      <span class="small muted">${text.length}/2000</span></div>
    <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} />
  </form>`;
}

function TaskDetail({ task, snap, idx, nowMs }) {
  const goal = idx.goals.get(task.goal_id);
  const epic = task.epic_id ? idx.epics.get(task.epic_id) : null;
  const runsById = indexBy(snap.runs || []);
  const reviews = Object.entries(task.reviews || {});
  const ws = isWorkspace(snap);
  return html`<div class="detail">
    <p class="row wrap">
      ${SIDE_STATES.includes(task.status) ? html`<${SideBadge} status=${task.status} />` : html`<${Tag} tone="neutral" icon="dot">${statusWord(task.status)}<//>`}
      <${Avatar} snap=${snap} role=${task.role} live=${!!task.live} size="sm" /><span>${roleInfo(snap, task.role).name}</span>
      ${ws && html`<${RepoChip} repo=${task.repo} kind=${task.kind} />`}
      ${goal && html`<span class=${`goal-chip ${goalColorClass(snap, goal.id)}`}>${goal.id} ${goal.title}</span>`}
      ${epic && html`<span class="small muted">${epic.id} ${epic.title}</span>`}
      ${epic && html`<${PrLink} pr=${epic.pr} />`}
    </p>
    <dl class="kv small">
      <dt>Kind</dt><dd>${kindWord(task.kind) || '-'}${task.size ? `, size ${task.size}` : ''}${task.priority ? `, ${task.priority}` : ''}</dd>
      <dt>Tokens</dt><dd><${Tokens} n=${task.tokens} />${task.estimate_tokens ? html` of <${Tokens} n=${task.estimate_tokens} /> estimate` : ''}</dd>
      <dt>Attempts</dt><dd>${task.attempts || 0} of ${task.max_attempts || 3}${task.rework_count ? `, rework ${task.rework_count}` : ''}</dd>
      ${ws && html`<dt>Repo</dt><dd>${task.repo || (task.kind === 'qa_goal' ? 'All repos of the goal' : '-')}</dd>`}
      ${task.branch && html`<dt>Branch</dt><dd class="mono">${task.branch}</dd>`}
    </dl>
    ${task.status_reason && html`<p class="callout tone-info"><${Icon} name="activity" />${task.status_reason}</p>`}
    ${task.blocked && html`<div class="callout tone-danger"><${Icon} name="blocked" /><div>
      <strong>Blocked</strong>${task.blocked.needs ? `, needs ${task.blocked.needs}` : ''}${task.blocked.since ? ` since ${timeAgo(task.blocked.since, nowMs)}` : ''}
      <p>${task.blocked.reason}</p>${task.blocked.question_id && html`<p class="small">Question ${task.blocked.question_id}</p>`}</div></div>`}
    <h3>Description</h3>
    <p class="prewrap">${task.description || 'No description.'}</p>
    <h3>Acceptance criteria${task.ac_version ? html` <span class="small muted">v${task.ac_version}</span>` : ''}</h3>
    ${(task.acceptance_criteria || []).length ? html`<ul class="ac-list">${task.acceptance_criteria.map((ac) => html`<li><span class="mono small">${ac.id}</span> <span class="prewrap">${ac.text}</span></li>`)}</ul>`
      : html`<p class="muted">None recorded.</p>`}
    ${(task.evidence || []).length > 0 && html`<h3>Evidence (latest run)</h3><ul class="plain">
      ${task.evidence.map((ev) => html`<li class="row">
        ${ev.exit_code === 0 ? html`<${Tag} tone="ok" icon="check">exit 0<//>` : html`<${Tag} tone="danger" icon="cross">exit ${ev.exit_code}<//>`}
        <${ArtifactButton} path=${ev.log_path} label=${`${ev.id} ${ev.label || ''}`} /><span class="small muted">${ev.source}</span></li>`)}</ul>`}
    <h3>Runs</h3>
    ${(task.runs || []).length ? html`<ul class="plain">${[...task.runs].reverse().map((id) => {
      const r = runsById.get(id);
      return html`<li class="row small"><span class="mono">${id}</span>
        ${r ? html`<span>${kindWord(r.kind)} by ${roleInfo(snap, r.role).short}</span>${ws && r.repo && html`<${RepoChip} repo=${r.repo} />`}<${Tag} tone="info" icon="activity">${r.status}<//>
          ${r.model && html`<span class="muted" title=${r.model}>${r.model}</span>`}<span><${Tokens} n=${r.tokens} /> tokens</span>` : html`<span class="muted">finished</span>`}
      </li>`;
    })}</ul>` : html`<p class="muted">No runs yet.</p>`}
    <p><a href=${buildHash('activity', { task: task.id })}>Show all activity for ${task.id}</a></p>
    ${reviews.length > 0 && html`<h3>Reviews</h3><ul class="plain">${reviews.map(([role, rv]) => html`<li class="row small">
      <span>${roleInfo(snap, role).name}</span>
      ${rv.verdict === 'pass' ? html`<${Tag} tone="ok" icon="check">pass<//>` : html`<${Tag} tone=${rv.verdict ? 'danger' : 'idle'} icon=${rv.verdict ? 'cross' : 'open'}>${rv.verdict || 'pending'}<//>`}
      ${rv.round != null && html`<span class="muted">round ${rv.round}</span>`}${rv.at && html`<span class="muted">${timeAgo(rv.at, nowMs)}</span>`}</li>`)}</ul>`}
    ${(task.feedback || []).length > 0 && html`<h3>Feedback</h3><ul class="plain">${task.feedback.map((f) => html`<li class="row small">
      <span>${f.source}${f.ref ? ` ${f.ref}` : ''}</span>${f.path && html`<${ArtifactButton} path=${f.path} />`}
      ${f.at && html`<span class="muted" title=${fmtDateTime(f.at)}>${timeAgo(f.at, nowMs)}</span>`}</li>`)}</ul>`}
    <h3>Note</h3>
    <${NoteForm} task=${task} snap=${snap} nowMs=${nowMs} />
  </div>`;
}

export function BoardView({ snap, params, nowMs }) {
  const [openId, setOpenId] = useState(null);
  const idx = useMemo(() => ({ goals: indexBy(snap.goals), epics: indexBy(snap.epics), gates: indexBy(snap.gates) }), [snap.goals, snap.epics, snap.gates]);
  const grouped = useMemo(() => {
    const g = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
    for (const t of snap.tasks || []) {
      const c = columnOf(t.status);
      if (c && taskMatches(t, params)) g[c].push(t);
    }
    return g;
  }, [snap.tasks, params.goal, params.role, params.q, params.repo]);
  const total = Object.values(grouped).reduce((n, l) => n + l.length, 0);
  const task = openId ? (snap.tasks || []).find((t) => t.id === openId) : null;

  return html`<div class="board">
    <${EpicStrip} snap=${snap} epics=${snap.epics || []} gatesById=${idx.gates} goalFilter=${params.goal} repoFilter=${params.repo} />
    <p class="sr-only" role="status">${total} tasks shown</p>
    <div class="board-cols" tabindex="0" aria-label="Task columns, scroll sideways for more">
      ${COLUMNS.map((c) => html`<${Column} key=${c.id} col=${c} tasks=${grouped[c.id]} snap=${snap} idx=${idx} onOpen=${setOpenId} />`)}
    </div>
    <${Drawer} open=${!!task} onClose=${() => setOpenId(null)} title=${task ? `${task.id} ${task.title}` : ''} labelId="task-title">
      ${task && html`<${TaskDetail} task=${task} snap=${snap} idx=${idx} nowMs=${nowMs} />`}
    <//>
  </div>`;
}
