// Hash router. Route shape: #/<view>?goal=G-001&role=backend-engineer&q=text
// Filters live in the hash only, never in the query string.
import { useEffect, useState } from './html.mjs';

export const VIEWS = ['board', 'team', 'tokens', 'approvals', 'reports', 'goals', 'activity'];
const listeners = new Set();

export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const view = VIEWS.includes(path) ? path : 'board';
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) if (v) params[k] = v;
  return { view, params };
}

export function buildHash(view, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#/${view}${s ? `?${s}` : ''}`;
}

function emit() {
  const r = parseHash();
  for (const fn of listeners) fn(r);
}

/** Navigate (adds a history entry). */
export function navigate(view, params) {
  const target = buildHash(view, params);
  if (location.hash === target) return;
  location.hash = target; // fires hashchange -> emit
}

/** Change filters on the current view without a new history entry. */
export function setParams(patch) {
  const { view, params } = parseHash();
  const next = { ...params, ...patch };
  for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
  history.replaceState(history.state, '', `${location.pathname}${location.search}${buildHash(view, next)}`);
  emit();
}

window.addEventListener('hashchange', emit);

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    listeners.add(setRoute);
    return () => listeners.delete(setRoute);
  }, []);
  return route;
}
