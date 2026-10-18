// HTTP access: the per-run token and JSON fetch with plain error messages.
// The server opens the console at /#<token> (or /?k=<token>). The token moves into
// sessionStorage and the hash becomes the router's ("#/" or "#/s/<id>").

const TOKEN_KEY = 'cos-token';
let token = '';

function ssGet(k) {
  try { return sessionStorage.getItem(k) || ''; } catch { return ''; }
}
function ssSet(k, v) {
  try { sessionStorage.setItem(k, v); } catch { /* storage blocked: keep it in memory */ }
}

export function initToken() {
  const url = new URL(location.href);
  const raw = location.hash.replace(/^#/, '');
  let found = url.searchParams.get('k') || '';
  let route = raw.startsWith('/') ? raw : '/';
  if (!found && raw && !raw.startsWith('/')) {
    try { found = decodeURIComponent(raw).trim(); } catch { found = raw.trim(); }
  }
  if (found) {
    token = found;
    ssSet(TOKEN_KEY, found);
    url.searchParams.delete('k');
    const q = url.searchParams.toString();
    history.replaceState(null, '', `${url.pathname}${q ? `?${q}` : ''}#${route}`);
  } else {
    token = ssGet(TOKEN_KEY);
  }
  return token;
}

export const getToken = () => token;

export class ApiError extends Error {
  constructor(status, body, fallback) {
    super((body && body.error) || fallback || `The server answered ${status}.`);
    this.status = status;
    this.body = body || {};
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-COS-Token': token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin', cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, null, 'The console server is not answering.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const enc = encodeURIComponent;
export const getSessions = () => api('/api/sessions');
export const getSession = (id) => api(`/api/sessions/${enc(id)}`);
export const getHealth = () => api('/api/health');
export const getChat = () => api('/api/chat');
export function getTranscript(id, { limit = 60, before } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set('before', before);
  return api(`/api/sessions/${enc(id)}/transcript?${q}`);
}
export const say = (text, source = 'typed') => api('/api/chief/say', { method: 'POST', body: { text, source } });
export const reply = (id, text) => api(`/api/sessions/${enc(id)}/reply`, { method: 'POST', body: { text } });
export const archive = (id, confirmed) => api(`/api/sessions/${enc(id)}/archive`, { method: 'POST', body: { confirmed } });
export const stop = (id, confirmed) => api(`/api/sessions/${enc(id)}/stop`, { method: 'POST', body: { confirmed } });
export const openInApp = (id) => api(`/api/sessions/${enc(id)}/open`, { method: 'POST', body: {} });
export const voiceControl = (body) => api('/api/voice/control', { method: 'POST', body });
export const streamUrl = () => `/api/stream?k=${enc(token)}`;
