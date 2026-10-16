// Small shared helpers: DOM builders, state names, time formats.

export const STATE_ORDER = ['you', 'active', 'wait', 'stale'];
export const STATES = {
  you: { label: 'Waiting on you' },
  active: { label: 'Active' },
  wait: { label: 'Waiting' },
  stale: { label: 'Stale' },
};
export const stateLabel = (s) => (STATES[s] ? STATES[s].label : 'Unknown');
export const stateClass = (s) => `st-${STATES[s] ? s : 'stale'}`;

/** Build an HTML element. attrs: class, text, on<Event>, dataset via data-*, everything else as attributes. */
export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';
/** Build an SVG element. Same attrs rules as h(). */
export function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  setAttrs(n, attrs);
  append(n, kids);
  return n;
}

function setAttrs(n, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(n, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    n.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
}

/** Append children, skipping null, undefined and false (native append would print "null"). */
export function add(n, ...kids) {
  append(n, kids);
  return n;
}

export function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
  return n;
}

export const $ = (id) => document.getElementById(id);

export function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** "now", "4m", "3h", "2d" since a ms timestamp. */
export function age(ms, now = Date.now()) {
  if (!ms) return '';
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}

/** Longer words for the page view: "working now", "4 minutes ago", "3 days ago". */
export function ageWords(ms, now = Date.now()) {
  if (!ms) return 'unknown';
  const d = Math.max(0, now - ms);
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return unit(Math.floor(d / 60_000), 'minute');
  if (d < 86_400_000) return unit(Math.floor(d / 3_600_000), 'hour');
  return unit(Math.floor(d / 86_400_000), 'day');
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "9:04" today, "Oct 12 9:04" on another day. */
export function clock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, new Date())) return t;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

export function cut(text, n) {
  const t = String(text || '');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** Two or three letters for a graph node. Ticket keys keep their prefix (DP1-676 -> DP1). */
export function glyph(title, n) {
  const t = String(title || '?');
  const key = t.match(/\b([A-Z][A-Z0-9]{1,4})-\d+/);
  if (key) return key[1].slice(0, n);
  const words = t.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, n).map((w) => w[0]).join('').toUpperCase();
  return (words[0] || '?').slice(0, n).toUpperCase();
}

/** Where a session runs, short: "dp-web-ui · DP/dp1-676" or the last folder of cwd. */
export function where(sess) {
  const parts = [];
  if (sess.repo) parts.push(sess.repo);
  if (sess.prNumber) parts.push(`PR ${sess.prNumber}`);
  else if (sess.branch) parts.push(sess.branch);
  if (parts.length) return parts.join(' · ');
  if (sess.cwd) return String(sess.cwd).split(/[\\/]/).filter(Boolean).pop() || sess.cwd;
  return sess.kind === 'background' ? 'background job' : '';
}

export function modelName(id) {
  if (!id) return null;
  const m = String(id).match(/claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}
