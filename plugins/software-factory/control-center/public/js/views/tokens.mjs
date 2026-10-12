// Tokens: totals, per goal vs budget (with override), per role, per model, hourly stacked bars.
import { html, useMemo, useState } from '../html.mjs';
import { Icon, Tag, roleInfo, goalColorClass, useQueueState, QueuedStatus, FieldError, Tokens, tokensTitle } from '../components.mjs';
import { submit } from '../api.mjs';
import { goalSpend } from '../lib/model.mjs';
import { fmtTokens, fmtInt, modelFamily, toMs } from '../lib/format.mjs';
import { budgetGeometry, stackedBars, hbarScale } from '../lib/svg-charts.mjs';

function Tiles({ usage }) {
  const t = usage.totals || {};
  const tiles = [
    ['Billed-equivalent', t.billed], ['Input', t.input], ['Output', t.output],
    ['Cache write', t.cache_creation], ['Cache read', t.cache_read], ['Requests', t.requests, true],
  ];
  return html`<section aria-labelledby="tot-h" class="panel">
    <h2 id="tot-h">Totals</h2>
    <ul class="tiles">
      ${tiles.map(([label, v, plain]) => html`<li class="tile">
        <span class="tile-label small muted">${label}</span>
        <span class="tile-value" title=${plain ? fmtInt(v) : tokensTitle(v)}>${plain ? fmtInt(v) : fmtTokens(v)}</span>
      </li>`)}
    </ul>
    <p class="small muted">Billed-equivalent = input + output + 1.25 x cache write + 0.1 x cache read.
      Unattributed <${Tokens} n=${usage.unattributed} />, factory overhead <${Tokens} n=${usage.overhead} />.</p>
  </section>`;
}

function OverrideForm({ goal, limit, onDone }) {
  const [add, setAdd] = useState(String(Math.max(100000, Math.round((limit * 0.2) / 100000) * 100000)));
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    const n = Number(add);
    const er = {};
    if (!Number.isInteger(n) || n <= 0) er.add = 'Enter a whole number of tokens above 0.';
    if (!note.trim() || note.trim().length > 500) er.note = 'Give a reason of 1 to 500 characters.';
    setErrs(er);
    if (Object.keys(er).length) return;
    setBusy(true);
    const r = await submit(`budget.override:${goal.id}`, 'budget.override', { goal_id: goal.id, add_tokens: n, note: note.trim() });
    setBusy(false);
    if (r.ok) onDone(); else setErrs({ form: r.error });
  };
  const id = `ovr-${goal.id}`;
  return html`<form class="inline-form" onSubmit=${send} aria-label=${`Override budget for ${goal.id}`}>
    <label for=${`${id}-add`}>Add tokens</label>
    <input id=${`${id}-add`} type="number" min="1" step="100000" value=${add} onInput=${(e) => setAdd(e.currentTarget.value)}
      aria-invalid=${errs.add ? 'true' : undefined} aria-describedby=${errs.add ? `${id}-add-err` : undefined} />
    <${FieldError} id=${`${id}-add-err`} text=${errs.add} />
    <label for=${`${id}-note`}>Reason</label>
    <textarea id=${`${id}-note`} rows="2" maxlength="500" value=${note} onInput=${(e) => setNote(e.currentTarget.value)}
      aria-invalid=${errs.note ? 'true' : undefined} aria-describedby=${errs.note ? `${id}-note-err` : undefined}></textarea>
    <${FieldError} id=${`${id}-note-err`} text=${errs.note} />
    <${FieldError} id=${`${id}-form-err`} text=${errs.form} />
    <div class="row"><button type="submit" class="btn btn-primary" disabled=${busy}>Queue override</button>
      <button type="button" class="btn btn-ghost" onClick=${onDone}>Cancel</button></div>
  </form>`;
}

function GoalBudget({ goal, snap, nowMs }) {
  const cfg = snap.config || {};
  const warn = cfg.warn_pct ?? 80;
  const stop = cfg.stop_pct ?? 100;
  const s = goalSpend(goal, snap);
  const g = budgetGeometry(s.spent, s.live, s.limit, warn, stop);
  const blocked = goal.status === 'budget_blocked' || !!s.blocked_at || (s.limit > 0 && s.pct >= stop);
  const warned = !blocked && s.limit > 0 && s.pct > warn;
  const tone = blocked ? 'danger' : warned ? 'warn' : 'ok';
  const [open, setOpen] = useState(false);
  const q = useQueueState(`budget.override:${goal.id}`, snap);
  return html`<li class=${`budget-row ${goalColorClass(snap, goal.id)}`}>
    <div class="budget-name"><span class="goal-dot" aria-hidden="true"></span><span class="mono small">${goal.id}</span> ${goal.title}</div>
    ${s.limit > 0 ? html`<div class="budget-track-wrap">
      <div class=${`budget-track tone-${tone}`} role="img"
        aria-label=${`${Math.round(s.pct)}% of ${fmtTokens(s.limit)} budget used${s.live ? `, plus ${fmtTokens(s.live)} live` : ''}`}>
        <span class="budget-fill" style=${{ width: `${g.spentPct}%` }}></span>
        ${s.live > 0 && html`<span class="budget-live" style=${{ left: `${g.spentPct}%`, width: `${g.livePct}%` }}></span>`}
        <span class="budget-tick" style=${{ left: `${g.warnAt}%` }}></span>
        <span class="budget-tick budget-tick-stop" style=${{ left: `${g.stopAt}%` }}></span>
      </div>
      <div class="budget-ticklabels small muted" aria-hidden="true">
        <span style=${{ left: `${g.warnAt}%` }}>${warn}%</span><span style=${{ left: `${g.stopAt}%` }}>${stop}%</span>
      </div>
    </div>` : html`<div class="small muted">No budget limit set</div>`}
    <div class="budget-text small">
      ${s.limit > 0 && html`<strong>${Math.round(s.pct)}%</strong> `}<${Tokens} n=${s.spent} />${s.limit > 0 ? html` of <${Tokens} n=${s.limit} />` : ''}
      ${s.live > 0 && html`<span class="muted"> + <${Tokens} n=${s.live} /> live</span>`}
    </div>
    <div class="budget-state">
      ${blocked && html`<${Tag} tone="danger" icon="blocked">Blocked: waiting for you<//>`}
      ${warned && html`<${Tag} tone="warn" icon="warn">Warning<//>`}
      ${blocked && !open && html`<button type="button" class="btn btn-sm" disabled=${q.busy} onClick=${() => setOpen(true)}>Override budget</button>`}
    </div>
    ${open && html`<div class="budget-form"><${OverrideForm} goal=${goal} limit=${s.limit} onDone=${() => setOpen(false)} /></div>`}
    ${q.rec && html`<div class="budget-form"><${QueuedStatus} rec=${q.rec} res=${q.res} snap=${snap} nowMs=${nowMs} /></div>`}
  </li>`;
}

function RoleBars({ snap }) {
  const by = (snap.usage && snap.usage.by_role) || {};
  const rows = Object.entries(by).map(([id, v]) => ({ id, billed: v.billed || 0, live: v.live || 0 })).sort((a, b) => b.billed + b.live - (a.billed + a.live));
  const scale = hbarScale(rows.map((r) => r.billed + r.live), 100);
  if (!rows.length) return html`<p class="muted small">No usage yet.</p>`;
  return html`<ul class="hbars">
    ${rows.map((r) => {
      const ri = roleInfo(snap, r.id);
      return html`<li class=${`hbar rc-${ri.ci % 14}`}>
        <span class="hbar-label small">${ri.short}</span>
        <span class="hbar-track" aria-hidden="true">
          <span class="hbar-fill" style=${{ width: `${scale(r.billed)}%` }}></span>
          ${r.live > 0 && html`<span class="hbar-live" style=${{ width: `${scale(r.live)}%` }}></span>`}
        </span>
        <span class="hbar-value small"><${Tokens} n=${r.billed} />${r.live > 0 ? html`<span class="muted"> +<${Tokens} n=${r.live} /> live</span>` : ''}
          <span class="sr-only"> tokens for ${ri.name}</span></span>
      </li>`;
    })}
  </ul>`;
}

function ModelTable({ usage }) {
  const rows = Object.entries(usage.by_model || {}).sort((a, b) => (b[1].billed || 0) - (a[1].billed || 0));
  if (!rows.length) return html`<p class="muted small">No usage yet.</p>`;
  return html`<div class="table-wrap"><table class="data small">
    <thead><tr><th scope="col">Model</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Input</th>
      <th scope="col" class="num">Output</th><th scope="col" class="num">Cache write</th><th scope="col" class="num">Cache read</th><th scope="col" class="num">Billed-eq.</th></tr></thead>
    <tbody>${rows.map(([id, m]) => html`<tr>
      <th scope="row" title=${id}>${modelFamily(id)}</th><td class="num">${fmtInt(m.requests)}</td>
      <td class="num" title=${tokensTitle(m.input)}>${fmtTokens(m.input)}</td><td class="num" title=${tokensTitle(m.output)}>${fmtTokens(m.output)}</td>
      <td class="num" title=${tokensTitle(m.cache_creation)}>${fmtTokens(m.cache_creation)}</td><td class="num" title=${tokensTitle(m.cache_read)}>${fmtTokens(m.cache_read)}</td>
      <td class="num" title=${tokensTitle(m.billed)}>${fmtTokens(m.billed)}</td></tr>`)}</tbody>
  </table></div>`;
}

const hourMs = (h) => toMs(/T\d{2}$/.test(h) ? `${h}:00:00Z` : h);
const hourLabel = (h) => { const d = new Date(hourMs(h)); return `${String(d.getHours()).padStart(2, '0')}:00`; };

function Hourly({ snap }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const all = (snap.usage && snap.usage.hourly) || [];
  // Last 24 hours of data, anchored on the newest hour present (works for demo data too).
  const newest = all.reduce((m, r) => Math.max(m, hourMs(r.hour) || 0), 0);
  const byHour = new Map(all.map((r) => [hourMs(r.hour), r]));
  const rows = [];
  if (newest) {
    for (let i = 23; i >= 0; i -= 1) {
      const t = newest - i * 3600 * 1000;
      const iso = new Date(t).toISOString().slice(0, 13);
      rows.push(byHour.get(t) || { hour: iso, total: 0, by_goal: {} });
    }
  }
  const goals = (snap.goals || []).filter((g) => rows.some((r) => (r.by_goal || {})[g.id]));
  const series = [...goals.map((g) => g.id), ...(rows.some((r) => (r.by_goal || {})._overhead) ? ['_overhead'] : [])];
  const layout = useMemo(() => stackedBars(rows.map((r) => ({ key: r.hour, label: hourLabel(r.hour), values: r.by_goal || {} })), series,
    { width: 760, height: 220, padL: 52, padB: 26 }), [rows, series.join()]);
  const name = (k) => (k === '_overhead' ? 'Overhead' : k);
  if (!rows.some((r) => r.total > 0)) return html`<p class="muted small">No usage in the last 24 hours.</p>`;
  const hb = hover != null ? layout.bars[hover] : null;
  return html`<div>
    <div class="row wrap legend-row small">
      ${series.map((k) => html`<span class=${`legend-item ${k === '_overhead' ? 'gc-overhead' : goalColorClass(snap, k)}`}><span class="swatch swatch-goal" aria-hidden="true"></span>${name(k)}</span>`)}
      <button type="button" class="btn btn-ghost btn-sm" aria-pressed=${table ? 'true' : 'false'} onClick=${() => setTable(!table)}>${table ? 'Show chart' : 'Show table'}</button>
    </div>
    ${table ? html`<div class="table-wrap"><table class="data small"><thead><tr><th scope="col">Hour</th>${series.map((k) => html`<th scope="col" class="num">${name(k)}</th>`)}<th scope="col" class="num">Total</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><th scope="row">${hourLabel(r.hour)}</th>${series.map((k) => html`<td class="num">${fmtTokens((r.by_goal || {})[k])}</td>`)}<td class="num">${fmtTokens(r.total)}</td></tr>`)}</tbody></table></div>`
    : html`<div class="chart-wrap">
      <p class="chart-readout small" aria-hidden="true">${hb ? `${hb.label}: ${fmtTokens(hb.total)} total${hb.segs.length ? ` (${hb.segs.map((s) => `${name(s.series)} ${fmtTokens(s.value)}`).join(', ')})` : ''}` : 'Hover a bar for details.'}</p>
      <svg viewBox="0 0 760 220" class="chart" role="img" aria-label=${`Hourly billed-equivalent tokens by goal, last 24 hours of data. Use Show table for values.`}>
        ${layout.ticks.map((t) => html`<g><line class="grid" x1=${layout.plot.x} x2=${layout.plot.x + layout.plot.w} y1=${t.y} y2=${t.y} />
          <text class="axis" x=${layout.plot.x - 6} y=${t.y + 4} text-anchor="end">${fmtTokens(t.v)}</text></g>`)}
        <line class="baseline" x1=${layout.plot.x} x2=${layout.plot.x + layout.plot.w} y1=${layout.plot.y + layout.plot.h} y2=${layout.plot.y + layout.plot.h} />
        ${layout.bars.map((b, i) => html`<g class="bar-group" onMouseEnter=${() => setHover(i)} onMouseLeave=${() => setHover(null)}>
          <rect class="bar-hit" x=${b.cx - (layout.plot.w / layout.bars.length) / 2} y=${layout.plot.y} width=${layout.plot.w / layout.bars.length} height=${layout.plot.h} />
          ${b.segs.map((s, j) => html`<rect class=${`bar-seg ${s.series === '_overhead' ? 'gc-overhead' : goalColorClass(snap, s.series)}`}
            x=${b.x} y=${s.y} width=${b.w} height=${s.h} rx=${j === b.segs.length - 1 ? 3 : 0} />`)}
          ${(i % 3 === 0 || i === layout.bars.length - 1) && html`<text class="axis" x=${b.cx} y=${layout.plot.y + layout.plot.h + 16} text-anchor="middle">${b.label}</text>`}
        </g>`)}
      </svg>
    </div>`}
  </div>`;
}

export function TokensView({ snap, params, nowMs }) {
  const usage = snap.usage || {};
  const goals = (snap.goals || []).filter((g) => g.status !== 'cancelled' && (!params.goal || g.id === params.goal));
  return html`<div class="tokens">
    <${Tiles} usage=${usage} />
    <section class="panel" aria-labelledby="pg-h">
      <h2 id="pg-h">Per goal vs budget</h2>
      ${goals.length ? html`<ul class="budget-list">${goals.map((g) => html`<${GoalBudget} key=${g.id} goal=${g} snap=${snap} nowMs=${nowMs} />`)}</ul>`
        : html`<p class="muted small">No goals.</p>`}
      <p class="small muted"><span class="legend-live" aria-hidden="true"></span> Dotted segment = live spend of running agents.</p>
    </section>
    <div class="grid-2">
      <section class="panel" aria-labelledby="pr-h"><h2 id="pr-h">Per role</h2><${RoleBars} snap=${snap} /></section>
      <section class="panel" aria-labelledby="pm-h"><h2 id="pm-h">Per model</h2><${ModelTable} usage=${usage} /></section>
    </div>
    <section class="panel" aria-labelledby="hr-h"><h2 id="hr-h">Hourly, last 24 hours (stacked by goal)</h2><${Hourly} snap=${snap} /></section>
  </div>`;
}
