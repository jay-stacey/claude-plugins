// Console entry: token, router (#/ and #/s/<id>), header, footer, and wiring between the views.
import { initToken } from './api.mjs';
import { $, clear, h, STATE_ORDER, stateClass, stateLabel } from './util.mjs';
import { inViewSessions, on, startStore, state } from './store.mjs';
import { highlightNode, initGraph, onActivity, renderGraph } from './graph.mjs';
import { highlightRow, initRoster, refreshAges, renderRoster } from './roster.mjs';
import { initChief, level, partial, renderChat, renderVoice } from './chief.mjs';
import { initPage, leavePage, showPage } from './page.mjs';
import { initToasts, toast } from './toast.mjs';

const openSession = (id) => { location.hash = `#/s/${encodeURIComponent(id)}`; };
const goHome = () => { location.hash = '#/'; };
const hover = (id) => { highlightNode(id); highlightRow(id); };

function route() {
  if (state.conn === 'unauthorized') return;
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) {
    let id;
    try { id = decodeURIComponent(m[1]); } catch { id = m[1]; }
    $('console').hidden = true;
    $('page').hidden = false;
    $('tip').hidden = true;
    showPage(id);
    window.scrollTo(0, 0);
  } else {
    leavePage();
    document.title = 'Chief of Staff';
    $('page').hidden = true;
    $('console').hidden = false;
    renderAll();
  }
}

// ------------------------------------------------------------------ header + footer

const CONN_TEXT = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Server not answering',
  unauthorized: 'Access key rejected',
};

function renderConn() {
  const c = $('conn');
  c.dataset.state = state.conn;
  c.textContent = CONN_TEXT[state.conn] || state.conn;
  if (state.conn === 'unauthorized') {
    $('console').hidden = true;
    $('page').hidden = true;
    $('gate').hidden = false;
    $('gateText').textContent = 'The server did not accept this page\'s access key. It changes every time the server starts. Open the console again from the /chief command, or from the link in the server\'s server.json file.';
  }
  renderFresh();
}

function renderStats() {
  const counts = (state.sessions && state.sessions.counts) || {};
  const box = clear($('stats'));
  for (const k of STATE_ORDER) {
    box.appendChild(h('span', { class: `stat ${stateClass(k)}` }, stateLabel(k), h('b', { text: counts[k] ?? 0 })));
  }
}

function renderFresh() {
  const el = $('fresh');
  const b = state.sessions;
  if (!b) { el.textContent = 'waiting for data'; return; }
  const secs = Math.max(0, Math.round((Date.now() - (b.generatedAt || Date.now())) / 1000));
  const when = secs < 2 ? 'just now' : secs < 120 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  const live = state.conn === 'live' ? 'live' : 'paused';
  el.textContent = b.liveStale ? `${live} · live status is behind · refreshed ${when}` : `${live} · refreshed ${when}`;
}

function renderFooter() {
  const v = state.voice || {};
  const c = state.chief;
  const box = clear($('footStatus'));
  const dev = (d) => (d === 'cuda' ? 'GPU' : d === 'cpu' ? 'CPU' : '');
  const item = (cls, text) => box.appendChild(h('span', { class: cls, text }));
  if (!v.state || v.state === 'not-installed') item('off', 'Voice: not installed');
  else if (v.state === 'error') item('bad', `Voice: ${v.detail || 'error'}`);
  else {
    item(v.listen === 'off' ? 'off' : 'ok', `Ears: ${[v.stt || 'speech to text', dev(v.device)].filter(Boolean).join(' · ')}${v.listen === 'off' ? ' (off)' : ''}`);
    item(v.speak ? 'ok' : 'off', `Voice: ${[v.tts || 'speech', dev(v.device)].filter(Boolean).join(' · ')}${v.speak ? '' : ' (muted)'}`);
  }
  const stale = state.sessions && state.sessions.liveStale;
  item(stale ? 'bad' : state.sessions ? 'ok' : 'off', `Desktop link: ${stale ? 'behind' : state.sessions ? 'live' : 'waiting'}`);
  item(c.connected ? 'ok' : 'off', `Chief: ${c.connected ? 'connected' : 'not connected'}`);
  const wake = v.wakeWord ? v.wakeWord.replace(/\b\w/g, (m) => m.toUpperCase()) : 'Hey Chief';
  $('hint').textContent = !v.state || v.state === 'not-installed' || v.listen === 'off'
    ? 'Type · to talk' : v.listen === 'ptt' ? 'Hold the mic · to talk' : `${wake} · to talk`;
}

function coreInfo() {
  const v = state.voice || {};
  const c = state.chief;
  let label;
  if (!c.connected) label = 'NO CHIEF';
  else if (c.busy && !['hearing', 'speaking'].includes(v.state)) label = 'THINKING';
  else if (!v.state || v.state === 'not-installed') label = 'TYPE TO TALK';
  else label = ({ listening: v.listen === 'ptt' ? 'READY' : 'LISTENING', hearing: 'HEARING', thinking: 'THINKING', speaking: 'SPEAKING', off: 'MIC OFF', starting: 'STARTING', error: 'VOICE ERROR' })[v.state] || String(v.state).toUpperCase();
  return { connected: !!c.connected, label };
}

function renderAll() {
  if (!state.sessions) return;
  renderStats();
  renderFresh();
  if (!$('console').hidden) {
    renderRoster(state.sessions);
    renderGraph(inViewSessions(), coreInfo());
  }
}

// ------------------------------------------------------------------ boot

function boot() {
  const token = initToken();
  if (!token) {
    $('console').hidden = true;
    $('gate').hidden = false;
    $('conn').dataset.state = 'offline';
    $('conn').textContent = 'No access key';
    return;
  }
  initGraph({ open: openSession, hover });
  initRoster({ open: openSession, hover });
  initChief();
  initPage({ home: goHome, open: openSession });
  initToasts({ open: openSession });

  on('conn', renderConn);
  on('sessions', renderAll);
  on('chat', renderChat);
  on('voice', () => { renderVoice(); renderFooter(); if (!$('console').hidden && state.sessions) renderGraph(inViewSessions(), coreInfo()); });
  on('chief', () => { renderVoice(); renderFooter(); if (!$('console').hidden && state.sessions) renderGraph(inViewSessions(), coreInfo()); });
  on('activity', (ev) => { if (!$('console').hidden) onActivity(ev); });
  on('level', (d) => level(d.rms));
  on('partial', (d) => partial(d.text));
  on('notify', (n) => toast(n));

  window.addEventListener('hashchange', route);
  renderVoice();
  renderFooter();
  renderChat();
  renderConn();
  route();
  startStore();

  const tickClock = () => { $('clock').textContent = new Date().toTimeString().slice(0, 8); renderFresh(); };
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { if (!$('console').hidden) refreshAges(); }, 30000);
}

boot();
