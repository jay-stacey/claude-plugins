// Toasts for `notify` events and short confirmations. At most 3 on screen.
import { $, h } from './util.mjs';

const LABEL = { you: 'Waiting on you', done: 'Finished', stale: 'Stale', info: 'Done' };
let onOpen = () => {};

export function initToasts({ open }) {
  onOpen = open;
}

/** { kind: 'you' | 'done' | 'stale' | 'info', text, sessionId?, label? } */
export function toast(n) {
  const box = $('toasts');
  const kind = LABEL[n.kind] ? n.kind : 'info';
  const el = h('div', { class: `toast ${kind}`, role: 'status', title: n.sessionId ? 'Open this session' : '' },
    h('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', text: '×' }),
    h('span', { class: 'label', text: n.label || LABEL[kind] }),
    h('p', { text: n.text || '' }));
  let timer = 0;
  const close = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(close, kind === 'you' ? 20000 : 10000); };
  el.addEventListener('click', (e) => {
    if (e.target.closest('.x')) { close(); return; }
    if (n.sessionId) { close(); onOpen(n.sessionId); }
  });
  if (n.sessionId) {
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) { close(); onOpen(n.sessionId); } });
  }
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  arm();
}
