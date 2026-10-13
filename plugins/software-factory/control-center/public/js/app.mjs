// App shell: header, tabs, global filters, view switch, footer.
import { html, render, useEffect, useRef, useState } from './html.mjs';
import { startStore, useStore, nextTickIn } from './store.mjs';
import { useRoute, setParams, buildHash, VIEWS } from './router.mjs';
import { Icon } from './components.mjs';
import { ArtifactViewer } from './artifact.mjs';
import { applyTheme, loadTheme, applyMotion, loadMotion, THEMES } from './lib/a11y.mjs';
import { nextTickText } from './lib/format.mjs';
import { workspaceRepos, teamList, cycleChips } from './lib/model.mjs';
import { BoardView } from './views/board.mjs';
import { TeamView } from './views/team.mjs';
import { TokensView } from './views/tokens.mjs';
import { ApprovalsView } from './views/approvals.mjs';
import { GoalsView } from './views/goals.mjs';
import { ReportsView } from './views/reports.mjs';
import { ActivityView } from './views/activity.mjs';

const VIEW_LABEL = { board: 'Board', team: 'Team', tokens: 'Tokens', approvals: 'Approvals', reports: 'Reports', goals: 'Goals', activity: 'Activity' };
const VIEW_COMPONENT = { board: BoardView, team: TeamView, tokens: TokensView, approvals: ApprovalsView, reports: ReportsView, goals: GoalsView, activity: ActivityView };

const LOOP_ICON = {
  running: ['play', 'ok'], stale: ['warn', 'warn'], stopped: ['stop', 'danger'], paused: ['pause', 'warn'], pausing: ['pause', 'warn'],
};
const CONN = {
  live: ['dot', 'ok', 'Live'], connecting: ['clock', 'info', 'Connecting'], reconnecting: ['warn', 'warn', 'Reconnecting'], offline: ['cross', 'danger', 'Offline'],
};
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

applyTheme(loadTheme());
applyMotion(loadMotion());

function CopyHint({ text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 2000); } catch { setDone(false); }
  };
  return html`<span class="copy-hint">Start it with <code>${text}</code>
    <button type="button" class="btn btn-ghost btn-sm" onClick=${copy}><${Icon} name=${done ? 'check' : 'copy'} />${done ? 'Copied' : 'Copy'}</button>
    <span class="sr-only" role="status">${done ? 'Copied to clipboard' : ''}</span></span>`;
}

function Header({ s, route }) {
  const snap = s.snap;
  const loop = snap && snap.factory && snap.factory.loop;
  const pending = snap ? (snap.gates || []).filter((g) => g.status === 'pending').length : 0;
  const [theme, setTheme] = useState(loadTheme());
  const [motion, setMotion] = useState(loadMotion());
  const [li, lt] = LOOP_ICON[loop && loop.state] || ['dot', 'idle'];
  const [ci, ct, cw] = CONN[s.conn] || CONN.offline;
  const tickText = nextTickText(nextTickIn(snap, s.nowMs));
  const cycleTheme = () => {
    const t = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    setTheme(t);
    applyTheme(t);
  };
  const toggleMotion = () => { setMotion(!motion); applyMotion(!motion); };
  const keep = {};
  for (const k of ['goal', 'role', 'q', 'repo', 'team']) if (route.params[k]) keep[k] = route.params[k];
  const cycles = cycleChips(snap, s.nowMs);

  return html`<header class="app-header">
    <div class="header-row">
      <h1 class="brand">software-factory${snap && snap.project && snap.project.name ? html`<span class="brand-project">${snap.project.name}</span>` : ''}</h1>
      <nav class="tabs" aria-label="Views">
        ${VIEWS.map((v) => html`<a href=${buildHash(v, keep)} class=${`tab${route.view === v ? ' is-active' : ''}`} aria-current=${route.view === v ? 'page' : undefined}>
          ${VIEW_LABEL[v]}${v === 'approvals' && pending ? html` <span class="count" aria-label=${`${pending} pending`}>${pending}</span>` : ''}
        </a>`)}
      </nav>
      <div class="header-tools">
        <button type="button" class="btn btn-ghost btn-sm" onClick=${cycleTheme} title="Change theme (system, light, dark)">
          <${Icon} name=${THEME_ICON[theme]} />Theme: ${theme.charAt(0).toUpperCase() + theme.slice(1)}</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-pressed=${motion ? 'true' : 'false'} onClick=${toggleMotion}>
          <${Icon} name="motion" />Reduce motion${motion ? ': on' : ''}</button>
      </div>
    </div>
    <div class="status-row">
      ${snap && snap.demo && html`<span class="tag tone-info"><${Icon} name="activity" />Demo data</span>`}
      ${loop && html`<span class=${`tag tone-${lt}`}><${Icon} name=${li} />${loop.label || loop.state}</span>`}
      ${loop && (loop.state === 'stale' || loop.state === 'stopped' || loop.label === 'Loop not running') && html`<${CopyHint} text="/software-factory:start" />`}
      ${tickText && html`<span class="muted">${tickText}</span>`}
      ${cycles.length > 0 && html`<ul class="cycle-chips" aria-label="Current cycles">
        ${cycles.map((c) => html`<li class="cycle-chip" title=${`${c.name} cycle ${c.text}`}><${Icon} name="clock" />${c.name} ${c.text}</li>`)}</ul>`}
      ${snap && html`<a class="status-link" href=${buildHash('approvals', keep)}>
        <${Icon} name=${pending ? 'hourglass' : 'check'} />${pending ? `${pending} approval${pending === 1 ? '' : 's'} waiting for you` : 'No approvals waiting'}</a>`}
      <span class=${`tag tone-${ct} conn`} role="status" aria-live="polite"><${Icon} name=${ci} />${cw}</span>
    </div>
  </header>`;
}

function Filters({ snap, params }) {
  const [q, setQ] = useState(params.q || '');
  const timer = useRef(null);
  useEffect(() => { setQ(params.q || ''); }, [params.q]);
  const onSearch = (e) => {
    const v = e.currentTarget.value;
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setParams({ q: v.trim() }), 200);
  };
  const goals = (snap && snap.goals) || [];
  const roles = ((snap && snap.roles) || []).filter((r) => r.id !== 'user');
  const repos = workspaceRepos(snap);
  const teams = teamList(snap);
  return html`<form class="filters" role="search" aria-label="Filters" onSubmit=${(e) => e.preventDefault()}>
    <label class="field-inline">Goal
      <select value=${params.goal || ''} onChange=${(e) => setParams({ goal: e.currentTarget.value })}>
        <option value="">All goals</option>
        ${goals.map((g) => html`<option value=${g.id}>${g.id} ${g.title}</option>`)}
      </select></label>
    <label class="field-inline">Role
      <select value=${params.role || ''} onChange=${(e) => setParams({ role: e.currentTarget.value })}>
        <option value="">All roles</option>
        ${roles.map((r) => html`<option value=${r.id}>${r.name}</option>`)}
      </select></label>
    ${repos.length > 0 && html`<label class="field-inline">Repo
      <select value=${params.repo || ''} onChange=${(e) => setParams({ repo: e.currentTarget.value })}>
        <option value="">All repos</option>
        ${repos.map((r) => html`<option value=${r}>${r}</option>`)}
      </select></label>`}
    ${teams.length > 0 && html`<label class="field-inline">Team
      <select value=${params.team || ''} onChange=${(e) => setParams({ team: e.currentTarget.value })}>
        <option value="">All teams</option>
        ${teams.map((t) => html`<option value=${t.id}>${t.name}</option>`)}
      </select></label>`}
    <label class="field-inline field-grow">Search
      <input type="search" value=${q} onInput=${onSearch} placeholder="Task id, title, epic" autocomplete="off" /></label>
    ${(params.goal || params.role || params.q || params.repo || params.team) && html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setQ(''); setParams({ goal: '', role: '', q: '', repo: '', team: '' }); }}>Clear filters</button>`}
  </form>`;
}

function Footer({ s }) {
  const snap = s.snap;
  const d = (snap && snap.diagnostics) || {};
  const [, , cw] = CONN[s.conn] || CONN.offline;
  return html`<footer class="app-footer small muted">
    <span>Poll interval ${d.poll_ms != null ? `${d.poll_ms} ms` : 'unknown'}</span>
    <span>${snap ? (snap.events_tail || []).length : 0} events in memory, ${s.received} received live</span>
    <span>Connection: ${cw}</span>
    ${snap && snap.rev != null && html`<span>State rev ${snap.rev}</span>`}
    ${d.bad_lines ? html`<span class="tone-warn">${d.bad_lines} unreadable lines</span>` : ''}
  </footer>`;
}

function Unauthorized() {
  return html`<main class="fullpage" id="main">
    <div class="fullpage-card">
      <h1><${Icon} name="warn" />Cannot open the dashboard</h1>
      <p>Session token missing or expired. Reopen the dashboard with <code>/software-factory:control-center open</code></p>
    </div>
  </main>`;
}

function App() {
  const s = useStore();
  const route = useRoute();
  const snap = s.snap;
  const pending = snap ? (snap.gates || []).filter((g) => g.status === 'pending').length : 0;

  useEffect(() => {
    document.title = pending ? `(${pending}) software-factory` : 'software-factory';
  }, [pending]);
  useEffect(() => {
    const m = document.getElementById('main');
    if (m) m.scrollTop = 0;
  }, [route.view]);

  if (s.auth === 'unauthorized') return html`<${Unauthorized} />`;
  const View = VIEW_COMPONENT[route.view];
  return html`<div class="app">
    <button type="button" class="skip-link" onClick=${() => document.getElementById('main').focus()}>Skip to content</button>
    <${Header} s=${s} route=${route} />
    <${Filters} snap=${snap} params=${route.params} />
    <main class=${`main view-${route.view}`} id="main" tabindex="-1">
      ${!snap && s.error && html`<div class="empty"><p class="tone-danger"><${Icon} name="warn" />Could not reach the control center server: ${s.error}</p></div>`}
      ${!snap && !s.error && html`<div class="empty"><p class="muted" role="status">Loading factory state...</p></div>`}
      ${snap && html`<${View} snap=${snap} params=${route.params} nowMs=${s.nowMs} />`}
    </main>
    <${Footer} s=${s} />
    <${ArtifactViewer} />
  </div>`;
}

const root = document.getElementById('app');
root.textContent = ''; // drop the static boot message
render(html`<${App} />`, root);
startStore();
