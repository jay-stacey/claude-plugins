// Approvals: pending gates with decide actions, recent decisions.
import { html, useState } from '../html.mjs';
import { Icon, Tag, ArtifactButton, roleInfo, goalColorClass, useQueueState, QueuedStatus, FieldError } from '../components.mjs';
import { submit } from '../api.mjs';
import { indexBy, changeLines } from '../lib/model.mjs';
import { timeAgo, fmtDateTime, fmtInt, statusWord } from '../lib/format.mjs';

const TYPE_LABEL = { G1: 'G1 plan', G2: 'G2 spec', G3: 'G3 design', G4: 'G4 merge', budget: 'Budget', destructive: 'Destructive', tracker: 'Tracker', improvement: 'Improvement' };
const DECIDED = {
  approved: ['ok', 'check', 'Approved'], rejected: ['danger', 'cross', 'Rejected'],
  changes_requested: ['warn', 'cross', 'Changes requested'], superseded: ['idle', 'idle', 'Superseded'],
};

function subjectText(gate, idx) {
  const prop = proposalOf(gate);
  if (prop) return `${prop.id ? `${prop.id} ` : ''}${prop.title || ''}`;
  const s = gate.subject || {};
  const rec = s.kind === 'goal' ? idx.goals.get(s.id) : s.kind === 'epic' ? idx.epics.get(s.id) : s.kind === 'task' ? idx.tasks.get(s.id) : null;
  return `${s.id || ''}${rec && rec.title ? ` ${rec.title}` : ''}`;
}

// Proposal on an improvement gate (contracts 21.7.5): request {action: 'proposal', proposal}.
const proposalOf = (gate) => (gate.type === 'improvement' && gate.request && gate.request.proposal && typeof gate.request.proposal === 'object' ? gate.request.proposal : null);
const RISK = { low: ['ok', 'check'], medium: ['warn', 'warn'], high: ['danger', 'blocked'] };

function Proposal({ gate, snap, proposal }) {
  const c = changeLines(proposal.change);
  const [tone, icon] = RISK[proposal.risk] || ['neutral', 'dot'];
  const paths = (gate.artifact && gate.artifact.paths) || [];
  return html`<div class="proposal">
    <h4 class="proposal-title">${proposal.id ? html`<span class="mono small">${proposal.id}</span> ` : ''}${proposal.title}</h4>
    <dl class="kv small proposal-kv">
      <dt>Why</dt><dd class="prewrap">${proposal.why || '-'}</dd>
      <dt>Change</dt><dd>
        ${c.kind === 'config' && html`<span class="muted">Sets in the factory config:</span><pre class="proposal-change mono">${c.lines.join('\n') || '(no keys)'}</pre>`}
        ${c.kind === 'overlay_note' && html`<span class="muted">Adds a note to the ${roleInfo(snap, c.role).name} role file:</span><pre class="proposal-change prewrap">${c.lines[0]}</pre>`}
        ${c.kind === 'advice' && html`<span>Advice only. Nothing changes if you approve; the decision is recorded.</span>`}
      </dd>
      <dt>Expected effect</dt><dd class="prewrap">${proposal.expected_effect || '-'}</dd>
      <dt>Risk</dt><dd>${proposal.risk ? html`<${Tag} tone=${tone} icon=${icon}>${statusWord(proposal.risk)}<//>` : '-'}</dd>
    </dl>
    ${paths.length > 0 && html`<div class="row wrap"><span class="small muted">Report</span>${paths.map((p) => html`<${ArtifactButton} path=${p} label="Open report" />`)}</div>`}
  </div>`;
}

function actorText(snap, a) {
  if (!a) return 'the factory';
  if (typeof a === 'string') return roleInfo(snap, a).name;
  if (a.role) return roleInfo(snap, a.role).name;
  return a.name || a.kind || 'the factory';
}

function Diffstat({ d }) {
  if (!d) return null;
  if (typeof d === 'string') return html`<span class="small mono">${d}</span>`;
  const add = d.additions ?? d.insertions;
  const del = d.deletions;
  const files = d.files ?? d.changed_files;
  return html`<span class="small mono">${add != null ? `+${fmtInt(add)} ` : ''}${del != null ? `-${fmtInt(del)} ` : ''}${files != null ? `${files} files` : ''}</span>`;
}

function GateCard({ gate, snap, idx, nowMs }) {
  const key = `gate:${gate.id}`;
  const q = useQueueState(key, snap);
  const [notes, setNotes] = useState('');
  const [add, setAdd] = useState(gate.request && gate.request.add_tokens_suggested != null ? String(gate.request.add_tokens_suggested) : '');
  const [confirmReject, setConfirmReject] = useState(false);
  const [errs, setErrs] = useState({});
  const [sending, setSending] = useState(false);
  const goal = idx.goals.get(gate.goal_id);
  const a = gate.artifact || {};
  const req = gate.request || {};
  const disabled = sending || q.busy;
  const nid = `notes-${gate.id}`;
  const proposal = proposalOf(gate);

  const decide = async (decision) => {
    const er = {};
    const n = notes.trim();
    if ((decision === 'changes' || decision === 'reject') && !n) er.notes = 'Write feedback (1 to 4000 characters) to request changes or reject.';
    if (n.length > 4000) er.notes = 'Feedback can be at most 4000 characters.';
    let addTokens;
    if (gate.type === 'budget' && add !== '') {
      addTokens = Number(add);
      if (!Number.isInteger(addTokens) || addTokens <= 0) er.add = 'Enter a whole number of tokens above 0, or leave it empty.';
    }
    setErrs(er);
    if (Object.keys(er).length) return;
    if (decision === 'reject' && !confirmReject) { setConfirmReject(true); return; }
    setSending(true);
    const payload = { gate_id: gate.id, decision };
    if (n) payload.notes = n;
    if (addTokens) payload.add_tokens = addTokens;
    const r = await submit(key, 'gate.decide', payload);
    setSending(false);
    setConfirmReject(false);
    if (!r.ok) setErrs({ form: r.error });
  };

  return html`<li class=${`gate-card ${goalColorClass(snap, gate.goal_id)}`}>
    <div class="gate-head">
      <span class="gate-type">${TYPE_LABEL[gate.type] || gate.type}</span>
      <h3 class="gate-subject">${proposal ? 'CTO proposal' : subjectText(gate, idx)}</h3>
      ${gate.auto && html`<${Tag} tone="info" icon="activity">auto<//>`}
    </div>
    <p class="small muted">
      ${goal ? html`<span class="goal-chip">${goal.id} ${goal.title}</span> ` : ''}
      Opened <span title=${fmtDateTime(gate.opened_at)}>${timeAgo(gate.opened_at, nowMs)}</span> by ${actorText(snap, gate.opened_by && gate.opened_by.actor)}
    </p>
    ${proposal && html`<${Proposal} gate=${gate} snap=${snap} proposal=${proposal} />`}
    ${a.summary && !proposal && html`<p class="gate-summary prewrap">${a.summary}</p>`}
    ${!proposal && ((a.paths || []).length > 0 || a.pr_url || a.diffstat) && html`<div class="row wrap">
      ${(a.paths || []).map((p) => html`<${ArtifactButton} path=${p} />`)}
      ${a.pr_url && html`<a class="pr-link" href=${a.pr_url} rel="noreferrer" target="_blank"><${Icon} name="external" />Open PR<span class="sr-only"> (opens in a new tab)</span></a>`}
      <${Diffstat} d=${a.diffstat} />
    </div>`}
    ${req.action && !proposal && html`<p class="small"><strong>Action:</strong> ${req.action}</p>`}
    ${(req.impact || []).length > 0 && html`<div class="small"><strong>Impact</strong><ul>${req.impact.map((i) => html`<li>${i}</li>`)}</ul></div>`}
    <div class="gate-form">
      ${gate.type === 'budget' && html`<div class="field">
        <label for=${`add-${gate.id}`}>Add tokens (optional)</label>
        <input id=${`add-${gate.id}`} type="number" min="1" step="100000" value=${add} onInput=${(e) => setAdd(e.currentTarget.value)} disabled=${disabled}
          aria-invalid=${errs.add ? 'true' : undefined} aria-describedby=${errs.add ? `${nid}-add-err` : undefined} />
        <${FieldError} id=${`${nid}-add-err`} text=${errs.add} />
      </div>`}
      <div class="field">
        <label for=${nid}>Feedback <span class="muted small">(required to request changes or reject)</span></label>
        <textarea id=${nid} rows="2" maxlength="4000" value=${notes} onInput=${(e) => setNotes(e.currentTarget.value)} disabled=${disabled}
          aria-invalid=${errs.notes ? 'true' : undefined} aria-describedby=${errs.notes ? `${nid}-err` : undefined}></textarea>
        <${FieldError} id=${`${nid}-err`} text=${errs.notes} />
      </div>
      ${confirmReject ? html`<div class="confirm" role="group" aria-label="Confirm reject">
        <p class="small"><${Icon} name="warn" />${proposal ? `Reject ${gate.id}? Nothing is changed. The proposal is recorded as rejected.` : `Reject ${gate.id}? The work behind this gate stops until it is planned again.`}</p>
        <button type="button" class="btn btn-danger" disabled=${disabled} onClick=${() => decide('reject')} data-autofocus>Yes, reject</button>
        <button type="button" class="btn btn-ghost" onClick=${() => setConfirmReject(false)}>Cancel</button>
      </div>` : html`<div class="row">
        <button type="button" class="btn btn-primary" disabled=${disabled} onClick=${() => decide('approve')}>${gate.type === 'G4' ? 'Approve merge' : proposal && proposal.change && proposal.change.kind !== 'advice' ? 'Approve and apply' : 'Approve'}</button>
        <button type="button" class="btn" disabled=${disabled} onClick=${() => decide('changes')}>Request changes</button>
        <button type="button" class="btn btn-danger-ghost" disabled=${disabled} onClick=${() => decide('reject')}>Reject...</button>
      </div>`}
      <${FieldError} id=${`${nid}-form-err`} text=${errs.form} />
      <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} />
    </div>
  </li>`;
}

function Decided({ gate, snap, idx, nowMs }) {
  const [tone, icon, word] = DECIDED[gate.status] || ['neutral', 'dot', statusWord(gate.status)];
  const d = gate.decision || {};
  const q = useQueueState(`gate:${gate.id}`, snap);
  return html`<li class="decided">
    <span class="gate-type">${TYPE_LABEL[gate.type] || gate.type}</span>
    <span class="decided-subject">${subjectText(gate, idx)}</span>
    <${Tag} tone=${tone} icon=${icon}>${word}<//>
    <span class="small muted">${d.at ? html`<span title=${fmtDateTime(d.at)}>${timeAgo(d.at, nowMs)}</span>` : ''}${d.by ? ` by ${d.by}` : ''}${d.via ? ` via ${d.via}` : ''}${d.add_tokens ? `, +${fmtInt(d.add_tokens)} tokens` : ''}</span>
    ${d.notes && html`<blockquote class="small prewrap">${d.notes}</blockquote>`}
    ${q.rec && html`<div class="decided-queue"><span class="small muted">Your decision from this dashboard:</span>
      <${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} /></div>`}
  </li>`;
}

export function ApprovalsView({ snap, params, nowMs }) {
  const idx = { goals: indexBy(snap.goals), epics: indexBy(snap.epics), tasks: indexBy(snap.tasks) };
  const gates = (snap.gates || []).filter((g) => !params.goal || g.goal_id === params.goal);
  const pending = gates.filter((g) => g.status === 'pending');
  const decided = gates.filter((g) => g.status !== 'pending')
    .sort((a, b) => String((b.decision && b.decision.at) || b.opened_at || '').localeCompare(String((a.decision && a.decision.at) || a.opened_at || '')));
  return html`<div class="approvals">
    <section class="panel" aria-labelledby="pend-h">
      <h2 id="pend-h">Pending <span class="count">${pending.length}</span></h2>
      ${pending.length ? html`<ul class="gate-list">${pending.map((g) => html`<${GateCard} key=${g.id} gate=${g} snap=${snap} idx=${idx} nowMs=${nowMs} />`)}</ul>`
        : html`<p class="muted"><${Icon} name="check" />Nothing is waiting for you.</p>`}
    </section>
    <section class="panel" aria-labelledby="dec-h">
      <h2 id="dec-h">Recent decisions</h2>
      ${decided.length ? html`<ul class="decided-list">${decided.slice(0, 50).map((g) => html`<${Decided} key=${g.id} gate=${g} snap=${snap} idx=${idx} nowMs=${nowMs} />`)}</ul>`
        : html`<p class="muted small">No decisions yet.</p>`}
    </section>
  </div>`;
}
