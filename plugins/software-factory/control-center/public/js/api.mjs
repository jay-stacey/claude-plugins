// HTTP access: token handling, JSON fetch, inbox POSTs and the queued-request ledger.
import { useEffect, useState } from './html.mjs';

const TOKEN_KEY = 'sf-token';
const QUEUE_KEY = 'sf-queued';

function ssGet(k) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function ssSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* storage blocked: keep in memory only */ }
}

let token = null;

/** Move ?k=<token> into sessionStorage and strip it from the address bar (keeps the hash). */
export function initToken() {
  const url = new URL(location.href);
  const k = url.searchParams.get('k');
  if (k) {
    token = k;
    ssSet(TOKEN_KEY, k);
    url.searchParams.delete('k');
    const search = url.searchParams.toString();
    history.replaceState(history.state, '', `${url.pathname}${search ? `?${search}` : ''}${location.hash}`);
  } else {
    token = ssGet(TOKEN_KEY);
  }
  return token;
}

export const getToken = () => token;

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function apiFetch(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Factory-Token': token || '' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store',
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const getState = () => apiFetch('/api/state');

export function getEvents({ before, limit = 100, role, goal, task, type } = {}) {
  const q = new URLSearchParams();
  if (before) q.set('before', before);
  q.set('limit', String(limit));
  if (role) q.set('role', role);
  if (goal) q.set('goal', goal);
  if (task) q.set('task', task);
  if (type) q.set('type', type);
  return apiFetch(`/api/events?${q}`);
}

export const getArtifact = (path) => apiFetch(`/api/artifact?path=${encodeURIComponent(path)}`);

/** POST /api/inbox. Returns {ok, id, status, error, errors, pendingId}. Never throws. */
export async function postInbox(type, payload) {
  try {
    const r = await apiFetch('/api/inbox', { method: 'POST', body: { type, payload } });
    return { ok: true, id: r.id, status: 201 };
  } catch (e) {
    if (e instanceof ApiError) {
      let error = e.body.error || `Request failed (HTTP ${e.status})`;
      if (e.status === 409) error = 'A decision for this gate is already queued';
      if (e.status === 413) error = 'The request is too large';
      if (e.status === 429) error = 'Too many requests. Wait a moment and try again';
      if (e.status === 403) error = 'The server refused the request (403)';
      return { ok: false, status: e.status, error, errors: e.body.errors || [], pendingId: e.body.pending_id };
    }
    return { ok: false, status: 0, error: 'Network error. Is the control center still running?' };
  }
}

// ---------- queued ledger (survives reloads within the tab) ----------

const qListeners = new Set();
let queued = (() => {
  try { return JSON.parse(ssGet(QUEUE_KEY) || '{}') || {}; } catch { return {}; }
})();

export function getQueued(key) { return queued[key] || null; }

export function setQueued(key, rec) {
  queued = { ...queued };
  if (rec) queued[key] = rec; else delete queued[key];
  ssSet(QUEUE_KEY, JSON.stringify(queued));
  for (const fn of qListeners) fn(queued);
}

/** Submit and remember the inbox id under `key`. A 409 also records the pending id. */
export async function submit(key, type, payload) {
  const r = await postInbox(type, payload);
  if (r.ok) setQueued(key, { id: r.id, type, at: new Date().toISOString() });
  else if (r.status === 409 && r.pendingId) setQueued(key, { id: r.pendingId, type, at: new Date().toISOString(), conflict: true });
  return r;
}

export function useQueued(key) {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    qListeners.add(fn);
    return () => qListeners.delete(fn);
  }, []);
  return key ? queued[key] || null : null;
}
