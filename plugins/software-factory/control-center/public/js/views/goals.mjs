// Goals: factory card (pause/resume), goals table (pause/resume/remove), add-goal form.
import { html, useState } from '../html.mjs';
import { Icon, Tag, GoalStatus, Meter, Modal, RepoChip, KindBadge, goalColorClass, useQueueState, QueuedStatus, FieldError } from '../components.mjs';
import { submit } from '../api.mjs';
import { goalSpend, goalRepos, isWorkspace, goalKind, goalInTeam, streamItems, teamList, teamName } from '../lib/model.mjs';
import { timeAgo, fmtDateTime, nextTickText, fmtTokens, statusWord, itemClassWord } from '../lib/format.mjs';
import { nextTickIn } from '../store.mjs';

const FACTORY = {
  running: ['ok', 'play'], pausing: ['warn', 'pause'], paused: ['warn', 'pause'], stopped: ['danger', 'stop'],
};

function FactoryCard({ snap, nowMs }) {
  const f = snap.factory || {};
  const tick = f.tick || {};
  const loop = f.loop || {};
  const q = useQueueState('factory', snap);
  const [err, setErr] = useState('');
  const [tone, icon] = FACTORY[f.status] || ['idle', 'dot'];
  const send = async (type, payload) => {
    setErr('');
    const r = await submit('factory', type, payload);
    if (!r.ok) setErr(r.error);
  };
  const busyRuns = (snap.runs || []).filter((r) => r.status === 'running' || r.status === 'dispatching').length;
  return html`<section class="panel factory-card" aria-labelledby="fac-h">
    <h2 id="fac-h">Factory</h2>
    <div class="row wrap">
      <${Tag} tone=${tone} icon=${icon}>${statusWord(f.status || 'unknown')}<//>
      ${loop.label && html`<span class="muted small">Loop: ${loop.label}</span>`}
      <span class="small">${busyRuns} agent${busyRuns === 1 ? '' : 's'} running</span>
    </div>
    ${f.status_reason && html`<p class="small muted">${f.status_reason}</p>`}
    <dl class="kv small">
      <dt>Last tick</dt><dd>${tick.last_end_at ? html`<span title=${fmtDateTime(tick.last_end_at)}>${timeAgo(tick.last_end_at, nowMs)}</span>` : 'never'}${tick.count != null ? ` (tick ${tick.count})` : ''}</dd>
      <dt>Next tick</dt><dd>${nextTickText(nextTickIn(snap, nowMs)) || 'unknown'}</dd>
      ${tick.last_error && html`<dt>Last error</dt><dd class="tone-danger">${tick.last_error}${tick.consecutive_errors > 1 ? ` (${tick.consecutive_errors} in a row)` : ''}</dd>`}
    </dl>
    <div class="row wrap">
      ${(f.status === 'running') && html`
        <button type="button" class="btn btn-primary" disabled=${q.busy} onClick=${() => send('factory.pause', { mode: 'drain' })}><${Icon} name="pause" />Pause factory</button>
        <button type="button" class="btn" disabled=${q.busy} onClick=${() => send('factory.pause', { mode: 'now' })}>Pause now</button>
        <span class="small muted">Pause finishes current agents and starts nothing new. Pause now also stops running agents at the next tick.</span>`}
      ${(f.status === 'paused' || f.status === 'pausing') && html`
        <button type="button" class="btn btn-primary" disabled=${q.busy} onClick=${() => send('factory.resume', {})}><${Icon} name="play" />Resume factory</button>`}
      ${(f.status === 'stopped' || !f.status) && html`<span class="small">The factory is stopped. Start it with <code>/software-factory:start</code>.</span>`}
    </div>
    <${FieldError} id="fac-err" text=${err} />
    <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} />
  </section>`;
}

function RemoveModal({ goal, onClose }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = text.trim() === goal.id;
  const send = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    const r = await submit(`goal.remove:${goal.id}`, 'goal.remove', { goal_id: goal.id, confirm_text: text.trim(), discard: false });
    setBusy(false);
    if (r.ok) onClose(); else setErr(r.error);
  };
  return html`<${Modal} open=${true} onClose=${onClose} title=${`Remove ${goal.id}?`} labelId="remove-title">
    <form onSubmit=${send} class="stack">
      <p>${goal.title}</p>
      <ul class="small">
        <li>New work for this goal stops.</li>
        <li>Running agents for this goal are stopped at the next tick.</li>
        <li>Branches and pull requests are kept. Nothing is deleted.</li>
      </ul>
      <label for="remove-confirm">Type <code>${goal.id}</code> to confirm</label>
      <input id="remove-confirm" type="text" autocomplete="off" value=${text} onInput=${(e) => setText(e.currentTarget.value)} data-autofocus
        aria-describedby=${err ? 'remove-err' : undefined} />
      <${FieldError} id="remove-err" text=${err} />
      <div class="row">
        <button type="submit" class="btn btn-danger" disabled=${!ok || busy}>Remove goal</button>
        <button type="button" class="btn btn-ghost" onClick=${onClose}>Cancel</button>
      </div>
    </form>
  <//>`;
}

// Item status -> tag colour. Words always carry the meaning.
const ITEM_TONE = { done: 'ok', cancelled: 'idle', in_review: 'info', in_progress: 'info', blocked: 'danger', failed: 'danger', paused: 'warn' };

// Items of a stream goal (triage tasks) with their effective status (contracts 21.4.6).
function StreamItems({ goal, snap }) {
  const items = streamItems(goal.id, snap);
  if (!items.length) return html`<p class="small muted">No items yet.</p>`;
  const open = items.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length;
  return html`<details class="stream-items">
    <summary>${items.length} item${items.length === 1 ? '' : 's'}, ${open} open</summary>
    <ul class="plain">${items.map(({ task, status }) => html`<li class="stream-item">
      <span class="mono small">${task.id}</span>
      <span class="small">${task.priority || 'P2'}</span>
      ${task.item && task.item.class && html`<span class="kind-tag">${itemClassWord(task.item.class)}</span>`}
      <span class="stream-item-title">${task.title}</span>
      <${Tag} tone=${ITEM_TONE[status] || 'neutral'} icon=${status === 'done' ? 'check' : status === 'cancelled' ? 'cross' : undefined}>${statusWord(status)}<//>
    </li>`)}</ul>
  </details>`;
}

function GoalRow({ goal, snap, nowMs, onRemove }) {
  const q = useQueueState(`goal:${goal.id}`, snap);
  const qr = useQueueState(`goal.remove:${goal.id}`, snap);
  const [err, setErr] = useState('');
  const s = goalSpend(goal, snap);
  const tc = goal.task_counts || {};
  const send = async (type) => {
    setErr('');
    const r = await submit(`goal:${goal.id}`, type, { goal_id: goal.id });
    if (!r.ok) setErr(r.error);
  };
  const canPause = ['active', 'planning', 'awaiting_g1', 'draft', 'budget_blocked'].includes(goal.status);
  const live = goal.status !== 'cancelled' && goal.status !== 'done';
  return html`<tr>
    <th scope="row" class="mono">${goal.id}</th>
    <td><span class=${`goal-dot ${goalColorClass(snap, goal.id)}`} aria-hidden="true"></span><span class="sr-only">colour ${(goal.color_index ?? 0) + 1}</span></td>
    <td><span class="goal-title">${goal.title}</span> <${KindBadge} kind=${goalKind(goal)} />${goal.status_reason && html`<div class="small muted">${goal.status_reason}</div>`}
      ${teamList(snap).length > 0 && (goal.team || (goal.teams || []).length > 0) && html`<div class="small muted">Team${(goal.team ? 1 : goal.teams.length) === 1 ? '' : 's'}: ${(goal.team ? [goal.team] : goal.teams).map((t) => teamName(snap, t)).join(', ')}</div>`}
      ${isWorkspace(snap) && goalRepos(goal.id, snap).length > 0 && html`<div class="repo-chips">${goalRepos(goal.id, snap).map((r) => html`<${RepoChip} repo=${r} />`)}</div>`}</td>
    <td><${GoalStatus} status=${goal.status} /></td>
    <td>${goal.priority || '-'}</td>
    <td class="cell-meter">${s.limit > 0 ? html`<${Meter} value=${s.spent} max=${s.limit} warn=${(snap.config || {}).warn_pct ?? 80} stop=${(snap.config || {}).stop_pct ?? 100}
      label=${`${Math.round(s.pct)}% of ${fmtTokens(s.limit)}`} />` : html`<span class="small muted">No limit</span>`}</td>
    <td class="num">${tc.done ?? 0}/${tc.total ?? 0}</td>
    <td class="actions">
      ${live && canPause && html`<button type="button" class="btn btn-sm" disabled=${q.busy} onClick=${() => send('goal.pause')}>Pause</button>`}
      ${live && goal.status === 'paused' && html`<button type="button" class="btn btn-sm" disabled=${q.busy} onClick=${() => send('goal.resume')}>Resume</button>`}
      ${live && html`<button type="button" class="btn btn-sm btn-danger-ghost" disabled=${qr.busy} onClick=${() => onRemove(goal)}>Remove...</button>`}
      <${FieldError} id=${`goal-err-${goal.id}`} text=${err} />
      <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} />
      <${QueuedStatus} rec=${qr.rec} res=${qr.res} snap=${snap} nowMs=${nowMs} />
    </td>
  </tr>
  ${goalKind(goal) === 'stream' && html`<tr class="stream-items-row"><td></td><td colspan="7"><${StreamItems} goal=${goal} snap=${snap} /></td></tr>`}`;
}

const EMPTY = { title: '', outcome: '', criteria: [''], priority: 'P2', budget: '', constraints: '', notes: '' };

function validate(f) {
  const e = {};
  const t = f.title.trim();
  if (!t) e.title = 'Give the goal a title.'; else if (t.length > 80) e.title = 'Keep the title to 80 characters or fewer.';
  const o = f.outcome.trim();
  if (!o) e.outcome = 'Describe the outcome: what done looks like.'; else if (o.length > 600) e.outcome = 'Keep the outcome to 600 characters or fewer.';
  const crit = f.criteria.map((c) => c.trim()).filter(Boolean);
  if (!crit.length) e.criteria = 'Add at least one success criterion.';
  else if (crit.length > 7) e.criteria = 'Use at most 7 success criteria.';
  else if (crit.some((c) => c.length > 200)) e.criteria = 'Keep each criterion to 200 characters or fewer.';
  if (f.budget !== '') {
    const n = Number(f.budget);
    if (!Number.isInteger(n) || n < 1e5 || n > 1e9) e.budget = 'Budget must be a whole number from 100,000 to 1,000,000,000 tokens.';
  }
  if (f.notes.length > 2000) e.notes = 'Keep notes to 2000 characters or fewer.';
  return e;
}

function AddGoal({ snap, nowMs }) {
  const [f, setF] = useState(EMPTY);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const q = useQueueState('goal.add', snap);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const setCrit = (i, v) => setF({ ...f, criteria: f.criteria.map((c, j) => (j === i ? v : c)) });
  const d = (k) => (errs[k] ? `ag-${k}-err` : undefined);
  const send = async (e) => {
    e.preventDefault();
    const er = validate(f);
    setErrs(er);
    if (Object.keys(er).length) {
      const first = document.getElementById(`ag-${Object.keys(er)[0]}`);
      if (first) first.focus();
      return;
    }
    const payload = {
      title: f.title.trim(), outcome: f.outcome.trim(),
      success_criteria: f.criteria.map((c) => c.trim()).filter(Boolean), priority: f.priority,
    };
    if (f.budget !== '') payload.budget_tokens = Number(f.budget);
    const cons = f.constraints.split('\n').map((c) => c.trim()).filter(Boolean);
    if (cons.length) payload.constraints = cons;
    if (f.notes.trim()) payload.notes = f.notes.trim();
    setBusy(true);
    const r = await submit('goal.add', 'goal.add', payload);
    setBusy(false);
    if (r.ok) setF(EMPTY);
    else setErrs({ form: r.errors && r.errors.length ? `${r.error}: ${r.errors.map((x) => (typeof x === 'string' ? x : x.message || JSON.stringify(x))).join('; ')}` : r.error });
  };
  return html`<section class="panel" aria-labelledby="add-h">
    <h2 id="add-h">Add goal</h2>
    <form class="goal-form" onSubmit=${send} novalidate>
      <div class="field"><label for="ag-title">Title</label>
        <input id="ag-title" type="text" maxlength="80" value=${f.title} onInput=${set('title')} aria-invalid=${errs.title ? 'true' : undefined} aria-describedby=${d('title')} />
        <${FieldError} id="ag-title-err" text=${errs.title} /></div>
      <div class="field"><label for="ag-outcome">Outcome <span class="muted small">(what done means, up to 600 characters)</span></label>
        <textarea id="ag-outcome" rows="3" maxlength="600" value=${f.outcome} onInput=${set('outcome')} aria-invalid=${errs.outcome ? 'true' : undefined} aria-describedby=${d('outcome')}></textarea>
        <${FieldError} id="ag-outcome-err" text=${errs.outcome} /></div>
      <fieldset class="field" aria-describedby=${d('criteria')}>
        <legend>Success criteria <span class="muted small">(1 to 7)</span></legend>
        ${f.criteria.map((c, i) => html`<div class="row crit-row">
          <label class="sr-only" for=${i === 0 ? 'ag-criteria' : `ag-crit-${i}`}>Criterion ${i + 1}</label>
          <input id=${i === 0 ? 'ag-criteria' : `ag-crit-${i}`} type="text" maxlength="200" value=${c} onInput=${(e) => setCrit(i, e.currentTarget.value)} />
          ${f.criteria.length > 1 && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setF({ ...f, criteria: f.criteria.filter((_, j) => j !== i) })}
            aria-label=${`Remove criterion ${i + 1}`}><${Icon} name="close" /></button>`}
        </div>`)}
        ${f.criteria.length < 7 && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setF({ ...f, criteria: [...f.criteria, ''] })}><${Icon} name="plus" />Add criterion</button>`}
        <${FieldError} id="ag-criteria-err" text=${errs.criteria} />
      </fieldset>
      <fieldset class="field">
        <legend>Priority</legend>
        <div class="row">${['P0', 'P1', 'P2', 'P3'].map((p) => html`<label class="radio"><input type="radio" name="ag-priority" value=${p} checked=${f.priority === p} onChange=${() => setF({ ...f, priority: p })} />${p}</label>`)}</div>
        <p class="small muted">P0 is most urgent. P2 is normal.</p>
      </fieldset>
      <div class="field"><label for="ag-budget">Budget tokens <span class="muted small">(optional; default comes from the goal size)</span></label>
        <input id="ag-budget" type="number" min="100000" max="1000000000" step="100000" value=${f.budget} onInput=${set('budget')} aria-invalid=${errs.budget ? 'true' : undefined} aria-describedby=${d('budget')} />
        <${FieldError} id="ag-budget-err" text=${errs.budget} /></div>
      <div class="field"><label for="ag-constraints">Constraints <span class="muted small">(optional, one per line)</span></label>
        <textarea id="ag-constraints" rows="2" value=${f.constraints} onInput=${set('constraints')}></textarea></div>
      <div class="field"><label for="ag-notes">Notes <span class="muted small">(optional)</span></label>
        <textarea id="ag-notes" rows="2" maxlength="2000" value=${f.notes} onInput=${set('notes')} aria-invalid=${errs.notes ? 'true' : undefined} aria-describedby=${d('notes')}></textarea>
        <${FieldError} id="ag-notes-err" text=${errs.notes} /></div>
      <${FieldError} id="ag-form-err" text=${errs.form} />
      <div class="row"><button type="submit" class="btn btn-primary" disabled=${busy}>Add goal</button>
        <span class="small muted">The CTO plans it at the next tick, then asks you at G1.</span></div>
      <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} />
    </form>
  </section>`;
}

export function GoalsView({ snap, params = {}, nowMs }) {
  const [removing, setRemoving] = useState(null);
  const goals = (snap.goals || []).filter((g) => goalInTeam(g, params.team));
  return html`<div class="goals">
    <div class="goals-main">
      <${FactoryCard} snap=${snap} nowMs=${nowMs} />
      <section class="panel" aria-labelledby="gl-h">
        <h2 id="gl-h">Goals</h2>
        ${goals.length ? html`<div class="table-wrap"><table class="data">
          <thead><tr><th scope="col">Id</th><th scope="col"><span class="sr-only">Colour</span></th><th scope="col">Title</th><th scope="col">Status</th>
            <th scope="col">Priority</th><th scope="col">Budget</th><th scope="col" class="num">Tasks done</th><th scope="col">Actions</th></tr></thead>
          <tbody>${goals.map((g) => html`<${GoalRow} key=${g.id} goal=${g} snap=${snap} nowMs=${nowMs} onRemove=${setRemoving} />`)}</tbody>
        </table></div>` : html`<p class="muted">${params.team ? 'No goals for this team.' : 'No goals yet. Add one below.'}</p>`}
      </section>
    </div>
    <${AddGoal} snap=${snap} nowMs=${nowMs} />
    ${removing && html`<${RemoveModal} goal=${removing} onClose=${() => setRemoving(null)} />`}
  </div>`;
}
