// Shared UI pieces: icons, avatars, status tags, gate badges, meters, drawer, modal, queued status.
import { html, useEffect, useState } from './html.mjs';
import { useFocusTrap } from './lib/a11y.mjs';
import { useQueued } from './api.mjs';
import { resolveInbox, GATE_STATE_WORD } from './lib/model.mjs';
import { nextTickMinutes, fmtTokens, statusWord } from './lib/format.mjs';
import { nextTickIn } from './store.mjs';

// ---------- icons (16x16, currentColor, decorative) ----------
export const ICONS = {
  play: { d: 'M5 3l8 5-8 5z' },
  pause: { d: 'M4 3h3v10H4zM9 3h3v10H9z' },
  stop: { d: 'M4 4h8v8H4z' },
  warn: { d: 'M8 1.2L15.2 14.5H.8zM7.2 5.5v4.6h1.6V5.5zM7.2 11.2v1.6h1.6v-1.6z', evenodd: true },
  check: { d: 'M3 8.5l3.2 3.2L13 4.8', stroke: true },
  cross: { d: 'M4 4l8 8M12 4l-8 8', stroke: true },
  open: { d: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z', stroke: true },
  half: { d: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z', stroke: true, extra: 'M8 2.5a5.5 5.5 0 0 1 0 11z' },
  blocked: { d: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM3.8 3.8l8.4 8.4', stroke: true },
  clock: { d: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 4.5V8l2.5 1.5', stroke: true },
  hourglass: { d: 'M4 2h8M4 14h8M5 2c0 3.5 6 3.5 6 6s-6 2.5-6 6M11 2c0 3.5-6 3.5-6 6s6 2.5 6 6', stroke: true },
  activity: { d: 'M1 8h3l2-5 4 10 2-5h3', stroke: true },
  idle: { d: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM5 8h6', stroke: true },
  dot: { d: 'M8 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z' },
  ring: { d: 'M8 3a5 5 0 1 0 0 10a5 5 0 1 0 0-10z', stroke: true },
  external: { d: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4', stroke: true },
  file: { d: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3', stroke: true },
  close: { d: 'M4 4l8 8M12 4l-8 8', stroke: true },
  sun: { d: 'M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3', stroke: true },
  moon: { d: 'M13 10A6 6 0 0 1 6 3a6 6 0 1 0 7 7z', stroke: true },
  monitor: { d: 'M2 3h12v8H2zM6 14h4M8 11v3', stroke: true },
  motion: { d: 'M2 8h7M2 4.5h4M2 11.5h4M11 5l3 3-3 3', stroke: true },
  copy: { d: 'M5 5h8v9H5zM3 11V2h8', stroke: true },
  user: { d: 'M8 2.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM2.5 14c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4', stroke: true },
  plus: { d: 'M8 3v10M3 8h10', stroke: true },
};

export function Icon({ name, cls = '' }) {
  const ic = ICONS[name] || ICONS.dot;
  return html`<svg class=${`icon ${cls}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d=${ic.d} fill=${ic.stroke ? 'none' : 'currentColor'} stroke=${ic.stroke ? 'currentColor' : 'none'}
      stroke-width=${ic.stroke ? 1.6 : 0} stroke-linecap="round" stroke-linejoin="round" fill-rule=${ic.evenodd ? 'evenodd' : 'nonzero'} />
    ${ic.extra && html`<path d=${ic.extra} fill="currentColor" />`}
  </svg>`;
}

export const SrOnly = ({ children }) => html`<span class="sr-only">${children}</span>`;

// ---------- roles, goals ----------
export function roleInfo(snap, id) {
  const r = snap && snap.roles ? snap.roles.find((x) => x.id === id) : null;
  if (r) return { id, name: r.name || id, short: r.short || r.name || id, monogram: r.monogram || id.slice(0, 2).toUpperCase(), ci: r.color_index ?? 0, line: r.line };
  if (!id) return { id: '', name: 'Unknown', short: 'Unknown', monogram: '?', ci: 0 };
  const name = id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { id, name, short: name, monogram: id.split('-').map((w) => w[0]).join('').slice(0, 2).toUpperCase(), ci: 0 };
}
export const roleName = (snap, id) => roleInfo(snap, id).name;

export function goalColorClass(snap, goalId) {
  const g = snap && snap.goals ? snap.goals.find((x) => x.id === goalId) : null;
  return `gc-${g && g.color_index != null ? g.color_index % 8 : 0}`;
}

export function Avatar({ snap, role, live = false, size = 'md' }) {
  const r = roleInfo(snap, role);
  return html`<span class=${`avatar avatar-${size} rc-${r.ci % 14}${live ? ' is-live' : ''}`} title=${r.name}>
    <span aria-hidden="true">${r.monogram}</span>
    <span class="sr-only">${r.name}${live ? ', agent running' : ''}</span>
    ${live && html`<span class="avatar-live" aria-hidden="true"><${Icon} name="activity" /></span>`}
  </span>`;
}

// ---------- status tags ----------
const TONE_ICON = { ok: 'check', warn: 'warn', danger: 'blocked', info: 'activity', idle: 'idle', neutral: 'dot' };

export function Tag({ tone = 'neutral', icon, children, title }) {
  return html`<span class=${`tag tone-${tone}`} title=${title}><${Icon} name=${icon || TONE_ICON[tone]} />${children}</span>`;
}

const SIDE = {
  blocked: { tone: 'danger', icon: 'blocked', word: 'Blocked' },
  failed: { tone: 'danger', icon: 'cross', word: 'Failed' },
  paused: { tone: 'warn', icon: 'pause', word: 'Paused' },
  deferred: { tone: 'idle', icon: 'clock', word: 'Deferred' },
};
export const SideBadge = ({ status }) => {
  const s = SIDE[status];
  return s ? html`<${Tag} tone=${s.tone} icon=${s.icon}>${s.word}<//>` : null;
};

const GOAL_STATUS = {
  draft: ['idle', 'dot'], planning: ['info', 'activity'], awaiting_g1: ['warn', 'hourglass'], active: ['ok', 'play'],
  paused: ['warn', 'pause'], budget_blocked: ['danger', 'blocked'], done: ['ok', 'check'], cancelled: ['idle', 'cross'],
};
export function GoalStatus({ status }) {
  const [tone, icon] = GOAL_STATUS[status] || ['neutral', 'dot'];
  return html`<${Tag} tone=${tone} icon=${icon}>${statusWord(status || 'unknown')}<//>`;
}

// ---------- gate badges ----------
const GATE_ICON = { open: 'open', pending: 'half', approved: 'check', rejected: 'cross', changes: 'cross' };
export function GateBadges({ badges }) {
  return html`<span class="gates">
    ${badges.map((b) => html`<span class=${`gate gate-${b.state}`} title=${`${b.name} ${GATE_STATE_WORD[b.state]}`}>
      <${Icon} name=${GATE_ICON[b.state]} /><span aria-hidden="true">${b.name.slice(1)}</span>
      <span class="sr-only">${b.name} ${GATE_STATE_WORD[b.state]}</span>
    </span>`)}
  </span>`;
}

// ---------- meter ----------
/** Usage meter with text label. tone from pct (amber > warn, red >= stop). */
export function Meter({ value, max, warn = 80, stop = 100, label }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const tone = pct >= stop ? 'danger' : pct > warn ? 'warn' : 'ok';
  const word = pct >= stop ? 'over budget' : pct > warn ? 'warning' : '';
  return html`<span class=${`meter-row tone-${tone}`}>
    <span class="meter" role="img" aria-label=${`${Math.round(pct)}% of estimate used${word ? `, ${word}` : ''}`}>
      <span class="meter-fill" style=${{ width: `${Math.min(100, pct)}%` }}></span>
    </span>
    <span class="meter-text">${label || `${Math.round(pct)}%`}${word ? html` <span class="meter-word">${word}</span>` : ''}</span>
  </span>`;
}

// ---------- overlays ----------
export function Drawer({ open, onClose, title, children, wide = false, labelId = 'drawer-title' }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return html`<div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <aside class=${`drawer${wide ? ' drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby=${labelId} ref=${ref} tabindex="-1">
      <header class="drawer-head">
        <h2 id=${labelId}>${title}</h2>
        <button type="button" class="btn btn-ghost btn-icon" onClick=${onClose} aria-label="Close panel"><${Icon} name="close" /></button>
      </header>
      <div class="drawer-body">${children}</div>
    </aside>
  </div>`;
}

export function Modal({ open, onClose, title, children, labelId = 'modal-title' }) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return html`<div class="overlay overlay-center" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby=${labelId} ref=${ref} tabindex="-1">
      <h2 id=${labelId}>${title}</h2>
      ${children}
    </div>
  </div>`;
}

// ---------- queued inbox requests ----------
/** {rec, res, busy} for a queued key. busy = waiting for the tick to apply it. */
export function useQueueState(key, snap) {
  const rec = useQueued(key);
  const res = rec ? resolveInbox(rec.id, snap) : null;
  return { rec, res, busy: !!(rec && res && res.state === 'queued') };
}

export function QueuedStatus({ rec, res, snap, nowMs }) {
  if (!rec || !res) return null;
  if (res.state === 'queued') {
    const n = nextTickMinutes(nextTickIn(snap, nowMs));
    return html`<p class="queued tone-info" role="status"><${Icon} name="clock" />
      ${rec.conflict ? 'A decision for this gate is already queued. ' : ''}Queued, applies at next tick${n ? ` (~${n} min)` : ''}.</p>`;
  }
  if (res.state === 'applied') return html`<p class="queued tone-ok" role="status"><${Icon} name="check" />Applied${res.tick != null ? ` at tick ${res.tick}` : ''}.</p>`;
  const word = res.state === 'rejected' ? 'Rejected' : res.state === 'superseded' ? 'Superseded' : res.state === 'gated' ? 'Needs confirmation' : res.state;
  return html`<p class="queued tone-danger" role="status"><${Icon} name="warn" />${word}${res.reason ? `: ${res.reason}` : ''}.</p>`;
}

/** Inline form error list, linked via aria-describedby by the caller. */
export function FieldError({ id, text }) {
  return text ? html`<p class="field-error" id=${id}><${Icon} name="warn" />${text}</p>` : null;
}

// ---------- artifact viewer bus ----------
const artListeners = new Set();
let artPath = null;
export function openArtifact(path) {
  artPath = path;
  for (const fn of artListeners) fn(artPath);
}
export function closeArtifact() { openArtifact(null); }
export function useArtifactPath() {
  const [p, setP] = useState(artPath);
  useEffect(() => { artListeners.add(setP); return () => artListeners.delete(setP); }, []);
  return p;
}

export function ArtifactButton({ path, label }) {
  const name = label || String(path).split(/[\\/]/).pop();
  return html`<button type="button" class="btn btn-chip" onClick=${() => openArtifact(path)} title=${path}>
    <${Icon} name="file" />${name}</button>`;
}

export function PrLink({ pr }) {
  if (!pr || !pr.url) return null;
  return html`<a class="pr-link" href=${pr.url} rel="noreferrer" target="_blank">
    <${Icon} name="external" />PR${pr.number != null ? ` #${pr.number}` : ''}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

export const tokensTitle = (n) => `${Math.round(n || 0).toLocaleString('en-US')} tokens`;
export const Tokens = ({ n }) => html`<span title=${tokensTitle(n)}>${fmtTokens(n)}</span>`;
