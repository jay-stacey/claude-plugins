// Session roster: state filter chips, in-view sessions grouped by state with helpers under their
// parent, and one collapsed "N older sessions" row for the rest.
import { $, age, clear, h, STATE_ORDER, stateClass, stateLabel, where } from './util.mjs';

let filter = null;
let olderOpen = false;
let last = null;
let onOpen = () => {};
let onHover = () => {};

export function initRoster({ open, hover }) {
  onOpen = open;
  onHover = hover;
  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = filter === b.dataset.f ? null : b.dataset.f;
    if (last) renderRoster(last);
  });
  const roster = $('roster');
  roster.addEventListener('click', (e) => {
    const older = e.target.closest('.older');
    if (older) { olderOpen = !olderOpen; if (last) renderRoster(last); return; }
    const r = e.target.closest('.row');
    if (r) onOpen(r.dataset.id);
  });
  roster.addEventListener('mouseover', (e) => {
    const r = e.target.closest('.row');
    onHover(r ? r.dataset.id : null);
  });
  roster.addEventListener('mouseleave', () => onHover(null));
}

function row(x, child, now) {
  return h('button', {
    type: 'button',
    class: `row ${stateClass(x.state)}${child ? ' child' : ''}${x.kind === 'bg' ? ' bg' : ''}`,
    'data-id': x.id,
    title: x.stateReason || '',
  },
  h('span', { class: 'stripe', 'aria-hidden': 'true' }),
  h('span', { class: 'tx' },
    h('span', { class: 't', text: x.title }),
    h('span', { class: 's', text: where(x) || x.stateReason || '' })),
  h('span', { class: 'age', text: x.state === 'active' ? 'now' : age(x.lastActivityAt, now) }));
}

export function renderRoster(body) {
  last = body;
  const now = Date.now();
  const all = body.sessions.filter((x) => !x.isChief);
  const counts = body.counts || {};
  const inView = all.filter((x) => x.inView);
  const older = all.filter((x) => !x.inView).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

  // filter chips
  const fa = document.activeElement;
  const chipFocus = fa && fa.closest && fa.closest('#filters') ? fa.dataset.f : null;
  const f = clear($('filters'));
  for (const k of STATE_ORDER) {
    f.appendChild(h('button', { type: 'button', class: `chip ${stateClass(k)}`, 'data-f': k, 'aria-pressed': String(filter === k) },
      h('i', { class: 'dot', 'aria-hidden': 'true' }), stateLabel(k), ' ', h('b', { text: counts[k] ?? 0 })));
  }
  $('count').textContent = `${inView.length} in view · ${all.length} open`;

  // in-view rows, grouped by state, helpers right under their parent when they share a state
  const byId = new Map(inView.map((x) => [x.id, x]));
  const kids = new Map();
  for (const x of inView) {
    if (x.parentId && byId.has(x.parentId)) {
      if (!kids.has(x.parentId)) kids.set(x.parentId, []);
      kids.get(x.parentId).push(x);
    }
  }
  const recent = (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
  const r = $('roster');
  const act = document.activeElement;
  const keep = act && r.contains(act) ? (act.dataset.id || (act.classList.contains('older') ? 'older' : null)) : null;
  const scroll = r.scrollTop;
  clear(r);
  let shown = 0;
  for (const k of STATE_ORDER) {
    if (filter && filter !== k) continue;
    const inState = inView.filter((x) => x.state === k);
    if (!inState.length) continue;
    r.appendChild(h('div', { class: 'group-title label', text: stateLabel(k) }));
    const placed = new Set();
    const put = (x, depth) => {
      if (placed.has(x.id)) return;
      placed.add(x.id);
      r.appendChild(row(x, depth > 0 || (x.parentId && byId.has(x.parentId)), now));
      shown += 1;
      (kids.get(x.id) || []).filter((c) => c.state === k).sort(recent).forEach((c) => put(c, depth + 1));
    };
    const tops = inState.filter((x) => !(x.parentId && byId.has(x.parentId) && byId.get(x.parentId).state === k)).sort(recent);
    tops.forEach((x) => put(x, 0));
    inState.filter((x) => !placed.has(x.id)).forEach((x) => put(x, 1)); // loops in parent links
  }
  const olderShown = filter ? older.filter((x) => x.state === filter) : older;
  if (!shown && !olderShown.length) {
    r.appendChild(h('p', { class: 'roster-empty', text: filter ? `No sessions are ${stateLabel(filter).toLowerCase()}.` : 'No open sessions.' }));
  }
  if (olderShown.length) {
    r.appendChild(h('button', { type: 'button', class: 'older', 'aria-expanded': String(olderOpen) },
      `${olderShown.length} older session${olderShown.length > 1 ? 's' : ''}`,
      h('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
    if (olderOpen) olderShown.forEach((x) => r.appendChild(row(x, false, now)));
  }
  r.scrollTop = scroll;
  if (keep) {
    const n = keep === 'older' ? r.querySelector('.older') : r.querySelector(`.row[data-id="${CSS.escape(keep)}"]`);
    if (n) n.focus({ preventScroll: true });
  }
  if (chipFocus) {
    const n = $('filters').querySelector(`[data-f="${chipFocus}"]`);
    if (n) n.focus();
  }
}

export function highlightRow(id) {
  for (const n of $('roster').querySelectorAll('.row')) n.classList.toggle('hl', n.dataset.id === id);
}

export function refreshAges() {
  if (last) renderRoster(last);
}
