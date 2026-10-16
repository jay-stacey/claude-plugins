// Live state from the SSE stream, with reconnect (2 s doubling to 30 s) and a tiny event bus.
import { ApiError, getChat, getHealth, getSessions, setUnauthorizedHandler, streamUrl } from './api.mjs';

export const state = {
  conn: 'connecting',          // connecting | live | reconnecting | offline | unauthorized
  sessions: null,              // GET /api/sessions body
  byId: new Map(),
  chat: [],
  voice: null,                 // VoiceStatus
  chief: { connected: false, sessionId: null, busy: false },
};

const subs = new Map();
export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}
export function emit(topic, data) {
  for (const fn of subs.get(topic) || []) {
    try { fn(data); } catch (e) { console.error(`[cos] ${topic} handler failed`, e); }
  }
}

function setConn(c) {
  if (state.conn === c) return;
  state.conn = c;
  emit('conn', c);
}

export function setSessions(body) {
  if (!body || !Array.isArray(body.sessions)) return;
  state.sessions = body;
  state.byId = new Map(body.sessions.map((x) => [x.id, x]));
  emit('sessions', body);
}

export function setVoice(v) {
  if (!v) return;
  state.voice = v;
  emit('voice', v);
}

export function setChief(c) {
  if (!c) return;
  state.chief = { ...state.chief, ...c };
  emit('chief', state.chief);
}

export function addChat(m) {
  if (!m || !m.id) return;
  const i = state.chat.findIndex((x) => x.id === m.id);
  if (i >= 0) state.chat[i] = m; else state.chat.push(m);
  if (state.chat.length > 100) state.chat.splice(0, state.chat.length - 100);
  emit('chat', { message: m });
}

function setChat(list) {
  state.chat = Array.isArray(list) ? list.slice(-100) : [];
  emit('chat', { reset: true });
}

function parse(e) {
  try { return JSON.parse(e.data); } catch { return null; }
}

let es = null;
let retryTimer = null;
let retryDelay = 2000;

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(probeAndConnect, retryDelay);
  retryDelay = Math.min(30000, retryDelay * 2);
}

function connect() {
  if (es) es.close();
  setConn(state.sessions ? 'reconnecting' : 'connecting');
  es = new EventSource(streamUrl());
  es.onopen = () => { retryDelay = 2000; setConn('live'); };
  es.addEventListener('snapshot', (e) => {
    const d = parse(e);
    if (!d) return;
    setSessions(d.sessions);
    setChat(d.chat);
    setVoice(d.voice);
    setChief(d.chief);
    setConn('live');
  });
  es.addEventListener('sessions', (e) => setSessions(parse(e)));
  es.addEventListener('chat', (e) => addChat(parse(e)));
  es.addEventListener('voice', (e) => setVoice(parse(e)));
  es.addEventListener('chief', (e) => setChief(parse(e)));
  for (const t of ['activity', 'level', 'partial', 'action', 'notify']) {
    es.addEventListener(t, (e) => { const d = parse(e); if (d) emit(t, d); });
  }
  es.onerror = () => {
    // Close and retry on our own clock so the delay can back off; the browser's retry does not.
    if (es) es.close();
    es = null;
    setConn(state.sessions ? 'reconnecting' : 'connecting');
    scheduleRetry();
  };
}

/** Check the server answers (and the token is good) before opening a new stream. */
async function probeAndConnect() {
  try {
    const [health, sessions, chat] = await Promise.all([getHealth(), getSessions(), getChat()]);
    setSessions(sessions);
    setChat(chat.messages);
    setVoice(health.voice);
    setChief(health.chief);
    connect();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    setConn(state.sessions ? 'reconnecting' : 'offline');
    scheduleRetry();
  }
}

function unauthorized() {
  clearTimeout(retryTimer);
  if (es) es.close();
  es = null;
  setConn('unauthorized');
}

export function startStore() {
  setUnauthorizedHandler(unauthorized);
  connect();
  // An EventSource that gets a 401 only reports "error". The probe on retry finds the 401.
}

export const inViewSessions = () => (state.sessions ? state.sessions.sessions.filter((x) => x.inView && !x.isChief) : []);
