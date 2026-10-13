// Reports: the latest CTO report, a baseline card, and the documents the CTO writes
// (reports, assessments, cycle plans, team baselines). Documents open in the artifact viewer.
import { html, useState } from '../html.mjs';
import { Icon, Tag, ArtifactButton } from '../components.mjs';
import { timeAgo, fmtDateTime, statusWord } from '../lib/format.mjs';
import { buildHash } from '../router.mjs';

const GROUPS = [
  { kind: 'report', title: 'Reports', empty: 'No reports yet. The CTO writes one every day, or when the factory has been busy.' },
  { kind: 'assessment', title: 'Assessments', empty: 'No assessments yet. The CTO compares plans with work already in flight once a day.' },
  { kind: 'cycle', title: 'Cycle plans', empty: 'No cycle plans yet. They appear when cycles are on.' },
  { kind: 'team_baseline', title: 'Team baselines', empty: 'No team baselines yet.' },
];
const SHOW = 10;

function DocList({ group, docs, nowMs }) {
  const [all, setAll] = useState(false);
  const id = `rep-${group.kind}`;
  const list = all ? docs : docs.slice(0, SHOW);
  return html`<section class="panel" aria-labelledby=${`${id}-h`}>
    <h2 id=${`${id}-h`}>${group.title} <span class="count">${docs.length}</span></h2>
    ${docs.length ? html`<ul class="plain doc-list">${list.map((d) => html`<li class="doc-row">
      <${ArtifactButton} path=${d.path} label=${d.title} />
      <span class="small muted" title=${fmtDateTime(d.mtime)}>${timeAgo(d.mtime, nowMs)}</span>
    </li>`)}</ul>` : html`<p class="muted small">${group.empty}</p>`}
    ${docs.length > SHOW && html`<button type="button" class="btn btn-ghost btn-sm" aria-expanded=${all ? 'true' : 'false'} onClick=${() => setAll(!all)}>
      ${all ? `Show the latest ${SHOW}` : `Show all ${docs.length}`}</button>`}
  </section>`;
}

function Latest({ snap, report, nowMs }) {
  const pending = (snap.gates || []).filter((g) => g.type === 'improvement' && g.status === 'pending').length;
  const last = (snap.factory && snap.factory.reports) || null;
  const type = last && last.last_path === report.path ? last.last_type : null;
  const off = snap.config && snap.config.reports && snap.config.reports.enabled === false;
  return html`<section class="panel latest-report" aria-labelledby="rep-latest-h">
    <h2 id="rep-latest-h">Latest CTO report</h2>
    ${report ? html`<div class="stack">
      <p class="latest-title">${report.title}</p>
      <div class="row wrap">
        <${ArtifactButton} path=${report.path} label="Open" />
        <span class="small muted" title=${fmtDateTime(report.mtime)}>${timeAgo(report.mtime, nowMs)}</span>
        ${type && html`<${Tag} tone="neutral" icon="file">${statusWord(type)}<//>`}
      </div>
      ${pending > 0 && html`<p class="small"><${Icon} name="hourglass" /><a href=${buildHash('approvals')}>${pending} proposal${pending === 1 ? '' : 's'} waiting for your decision</a></p>`}
    </div>` : html`<p class="muted">No report yet. The CTO writes the first one after the factory has done some work.</p>`}
    ${off && html`<p class="small tone-warn"><${Icon} name="warn" />CTO reports are turned off (<code>reports.enabled</code> in the factory config).</p>`}
  </section>`;
}

function Baseline({ snap, doc, nowMs }) {
  const b = snap.baseline_summary;
  const assessAt = snap.factory && snap.factory.baseline && snap.factory.baseline.last_assess_at;
  const totalNon = b ? b.repos.reduce((n, r) => n + r.non_factory_prs, 0) : 0;
  return html`<section class="panel baseline-card" aria-labelledby="rep-base-h">
    <h2 id="rep-base-h">Baseline</h2>
    ${b ? html`<div class="stack">
      <p class="small">${b.at ? html`Collected <span title=${fmtDateTime(b.at)}>${timeAgo(b.at, nowMs)}</span>.` : 'Collection time unknown.'}
        ${assessAt ? html` Last assessment <span title=${fmtDateTime(assessAt)}>${timeAgo(assessAt, nowMs)}</span>.` : ''}</p>
      ${b.repos.length ? html`<div class="table-wrap"><table class="data">
        <caption class="sr-only">Open pull requests and branches per repository</caption>
        <thead><tr><th scope="col">Repo</th><th scope="col" class="num">Open PRs</th><th scope="col" class="num">Not from the factory</th><th scope="col" class="num">Branches</th></tr></thead>
        <tbody>${b.repos.map((r) => html`<tr>
          <th scope="row" class="mono">${r.repo}</th>
          <td class="num">${r.open_prs}</td>
          <td class="num">${r.non_factory_prs}</td>
          <td class="num">${r.branches}</td>
        </tr>${r.pr_error && html`<tr><td colspan="4" class="small muted"><${Icon} name="warn" />${r.repo}: pull request list unavailable. ${String(r.pr_error).slice(0, 160)}</td></tr>`}`)}</tbody>
      </table></div>
      <p class=${`small ${totalNon ? 'tone-warn' : 'muted'}`}>${totalNon ? html`<${Icon} name="warn" />${totalNon} open pull request${totalNon === 1 ? '' : 's'} not from the factory. Planned work may overlap them.` : 'No pull requests from outside the factory.'}</p>`
        : html`<p class="muted small">No repositories in the baseline.</p>`}
    </div>` : html`<p class="muted">No baseline yet. The factory collects one when it starts.</p>`}
    ${doc && html`<div class="row"><${ArtifactButton} path=${doc.path} label="Open baseline" /></div>`}
  </section>`;
}

export function ReportsView({ snap, nowMs }) {
  const docs = snap.reports || [];
  const of = (k) => docs.filter((d) => d.kind === k);
  const latest = of('report')[0] || null;
  return html`<div class="reports">
    <div class="reports-top">
      <${Latest} snap=${snap} report=${latest} nowMs=${nowMs} />
      <${Baseline} snap=${snap} doc=${of('baseline')[0] || null} nowMs=${nowMs} />
    </div>
    <div class="reports-lists">
      ${GROUPS.map((g) => html`<${DocList} key=${g.kind} group=${g} docs=${of(g.kind)} nowMs=${nowMs} />`)}
    </div>
  </div>`;
}
