// Live snapshot store: GET /api/state, then SSE /api/stream (snapshot | patch | event).
import { useEffect, useState } from './html.mjs';
import { initToken, getToken, getState, setUnauthorizedHandler, ApiError } from './api.mjs';

const EVENTS_CAP = 300;
const SLICES = ['factory', 'goals', 'epics', 'tasks', 'gates', 'runs', 'usage', 'budget', 'inbox', 'config'];

let state = {
  auth: 'ok', // ok | unauthorized
  conn: 'connecting', // connecting | live | reconnecting | offline
  snap: null,
  error: null,
  received: 0, // SSE events received this session
  nowMs: Date.now(),
};

const listeners = new Set();
const msgListeners = new Set();
let pending = false;
let es = null;
let retryTimer = null;
let retryDelay = 2000;

function notify() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    for (const fn of listeners) fn(state);
  }, 0);
}

function set(patch) {
  state = { ...state, ...patch };
  notify();
}

export const getStoreState = () => state;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called with each new msg.* event line (Team view pulses). */
export function onMessage(fn) {
  msgListeners.add(fn);
  return () => msgListeners.delete(fn);
}

export function useStore() {
  const [s, setS] = useState(state);
  useEffect(() => {
    setS(state);
    return subscribe(setS);
  }, []);
  return s;
}

function unauthorized() {
  if (es) { es.close(); es = null; }
  clearTimeout(retryTimer);
  set({ auth: 'unauthorized', conn: 'offline' });
}

function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  const tail = Array.isArray(snap.events_tail) ? snap.events_tail.slice(-EVENTS_CAP) : [];
  set({ snap: { ...snap, events_tail: tail }, error: null });
}

function applyPatch(p) {
  if (!state.snap || !p || !p.slices) return;
  const next = { ...state.snap };
  for (const k of Object.keys(p.slices)) if (SLICES.includes(k)) next[k] = p.slices[k];
  if (p.rev != null) next.rev = p.rev;
  set({ snap: next });
}

function applyEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (state.snap) {
    const tail = state.snap.events_tail || [];
    if (ev.id && tail.length && tail[tail.length - 1].id === ev.id) return; // duplicate after reconnect
    const nextTail = tail.length >= EVENTS_CAP ? tail.slice(tail.length - EVENTS_CAP + 1) : tail.slice();
    nextTail.push(ev);
    set({ snap: { ...state.snap, events_tail: nextTail }, received: state.received + 1 });
  } else {
    set({ received: state.received + 1 });
  }
  if (String(ev.type || '').startsWith('msg.')) {
    for (const fn of msgListeners) {
      try { fn(ev); } catch (e) { console.error(e); }
    }
  }
}

function parse(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}

function connect() {
  if (es) es.close();
  set({ conn: state.snap ? 'reconnecting' : 'connecting' });
  es = new EventSource(`/api/stream?k=${encodeURIComponent(getToken() || '')}`);
  es.onopen = () => { retryDelay = 2000; set({ conn: 'live' }); };
  es.addEventListener('snapshot', (e) => applySnapshot(parse(e)));
  es.addEventListener('patch', (e) => applyPatch(parse(e)));
  es.addEventListener('event', (e) => applyEvent(parse(e)));
  es.onerror = () => {
    if (!es) return;
    if (es.readyState === EventSource.CLOSED) {
      // The browser gave up (non-200, e.g. 401 or server gone). Probe, then retry ourselves.
      es.close();
      es = null;
      set({ conn: 'offline' });
      clearTimeout(retryTimer);
      retryTimer = setTimeout(probeAndReconnect, retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
    } else {
      set({ conn: 'reconnecting' });
    }
  };
}

async function probeAndReconnect() {
  try {
    applySnapshot(await getState());
    connect();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return unauthorized();
    set({ conn: 'offline' });
    retryTimer = setTimeout(probeAndReconnect, retryDelay);
    retryDelay = Math.min(30000, retryDelay * 2);
  }
}

export async function startStore() {
  setUnauthorizedHandler(unauthorized);
  const token = initToken();
  if (!token) return unauthorized();
  setInterval(() => set({ nowMs: Date.now() }), 15000);
  try {
    applySnapshot(await getState());
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return unauthorized();
    set({ error: e.message || 'Could not load state', conn: 'offline' });
  }
  if (state.auth === 'ok') connect();
}

/** Seconds to the next tick, kept fresh between snapshots when next_tick_at is known. */
export function nextTickIn(snap, nowMs = Date.now()) {
  const loop = snap && snap.factory && snap.factory.loop;
  if (!loop) return null;
  if (loop.next_tick_at) {
    const t = Date.parse(loop.next_tick_at);
    if (Number.isFinite(t)) return Math.round((t - nowMs) / 1000);
  }
  return typeof loop.next_tick_in_s === 'number' ? loop.next_tick_in_s : null;
}
