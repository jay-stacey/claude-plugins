// Chief panel: the orb and wave (VoiceStatus + level events), voice toggles, hold-to-talk,
// the chat with confirm buttons, and the typed input.
import { say, voiceControl } from './api.mjs';
import { $, clear, clock, h, reducedMotion } from './util.mjs';
import { addChat, setVoice, state } from './store.mjs';
import { md } from './md.mjs';

const BARS = 22;
const SHAPE = Array.from({ length: BARS }, (_, i) => 0.45 + 0.55 * Math.sin((Math.PI * (i + 0.5)) / BARS));
let bars = [];
let levelTimer = 0;
let held = false;
let noteTimer = 0;
const rendered = new Map(); // message id -> element

const VOICE_WORD = {
  'not-installed': 'Voice not installed',
  starting: 'Starting',
  off: 'Mic off',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Voice error',
};

export function initChief() {
  const wave = $('wave');
  bars = Array.from({ length: BARS }, (_, i) => {
    const b = h('i');
    b.style.animationDelay = `${(i * 0.07).toFixed(2)}s`;
    wave.appendChild(b);
    return b;
  });

  $('tWake').addEventListener('click', () => {
    const v = state.voice || {};
    control({ listen: v.listen === 'wake' ? 'off' : 'wake' });
  });
  $('tPtt').addEventListener('click', () => {
    const v = state.voice || {};
    control({ listen: v.listen === 'ptt' ? 'off' : 'ptt' });
  });
  $('tSpeak').addEventListener('click', () => control({ speak: !(state.voice && state.voice.speak) }));
  $('tStop').addEventListener('click', () => control({ stop: true }));

  const mic = $('mic');
  mic.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!pttMode()) { hintPtt(); return; }
    e.preventDefault();
    try { mic.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    press(true);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) mic.addEventListener(t, () => press(false));
  mic.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (!pttMode()) { hintPtt(); return; }
      press(true);
    }
  });
  mic.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') press(false); });
  mic.addEventListener('click', (e) => e.preventDefault());
  window.addEventListener('blur', () => press(false));

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ask');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const ok = await sendToChief(text);
    if (!ok) input.value = text;
  });

  $('chat').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-answer]');
    if (!b) return;
    const box = b.closest('.confirm');
    box.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    const ok = await sendToChief(b.dataset.answer);
    if (!ok) box.querySelectorAll('button').forEach((x) => { x.disabled = false; });
  });
}

const pttMode = () => state.voice && state.voice.listen === 'ptt' && state.voice.state !== 'not-installed';

function hintPtt() {
  if (!state.voice || state.voice.state === 'not-installed') note('Voice is not installed, so the mic button does nothing. Type instead.', true);
  else note('Turn on Push to talk, then hold this button while you speak.', true);
}

async function press(down) {
  if (down === held) return;
  if (down && !pttMode()) return;
  held = down;
  $('mic').classList.toggle('held', down);
  try {
    setVoice(await voiceControl({ pttDown: down }));
  } catch (err) {
    held = false;
    $('mic').classList.remove('held');
    note(err.message);
  }
}

async function control(body) {
  try {
    setVoice(await voiceControl(body));
  } catch (err) {
    note(err.message);
  }
}

/** Send a typed line (or a confirm label) to the Chief. Returns true when the server took it. */
export async function sendToChief(text) {
  try {
    const r = await say(text, 'typed');
    if (r && r.id && !state.chat.some((m) => m.id === r.id)) {
      addChat({ id: r.id, role: 'me', source: 'typed', text, at: Date.now(), confirm: null });
    }
    note('');
    return true;
  } catch (err) {
    note(err.status === 409 ? (err.body.error || 'No Chief is connected. Type /chief in a Claude session first.') : err.message);
    return false;
  }
}

function note(text, info = false) {
  const n = $('composerNote');
  clearTimeout(noteTimer);
  n.textContent = text;
  n.hidden = !text;
  n.classList.toggle('info', info);
  if (text) noteTimer = setTimeout(() => { n.hidden = true; }, info ? 5000 : 9000);
}

// ------------------------------------------------------------------ chat

function who(m) {
  if (m.source === 'notice') return h('div', { class: 'who' }, `NOTICE · ${clock(m.at)}`);
  if (m.role === 'chief') return h('div', { class: 'who' }, h('b', { text: 'CHIEF' }), ` · ${clock(m.at)}`);
  return h('div', { class: 'who', text: `YOU · ${m.source || 'typed'} · ${clock(m.at)}` });
}

function msgEl(m) {
  const cls = m.source === 'notice' ? 'notice' : m.role === 'chief' ? 'chief' : 'me';
  const el = h('div', { class: `msg ${cls}`, 'data-id': m.id }, who(m),
    m.role === 'chief' ? h('div', { class: 'text md' }, md(m.text)) : h('div', { class: 'text', text: m.text }));
  return el;
}

/** Only the latest Chief question with no answer after it keeps its buttons. */
function syncConfirm() {
  const chat = state.chat;
  let open = null;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i].role === 'me') break;
    if (chat[i].role === 'chief' && chat[i].confirm) { open = chat[i]; break; }
  }
  for (const [id, el] of rendered) {
    const box = el.querySelector('.confirm');
    if (open && id === open.id) {
      if (!box) {
        const c = open.confirm;
        el.appendChild(h('div', { class: 'confirm', role: 'group', 'aria-label': c.question || 'Confirm' },
          h('button', { type: 'button', class: 'btn primary', 'data-answer': c.yes, text: c.yes }),
          h('button', { type: 'button', class: 'btn ghost', 'data-answer': c.no, text: c.no })));
      }
      el.querySelectorAll('.confirm button').forEach((b) => { b.disabled = !state.chief.connected; });
    } else if (box) box.remove();
  }
}

export function renderChat(change) {
  const chat = $('chat');
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  if (!change || change.reset) {
    clear(chat);
    rendered.clear();
    for (const m of state.chat) {
      const el = msgEl(m);
      rendered.set(m.id, el);
      chat.appendChild(el);
    }
  } else if (change.message) {
    const m = change.message;
    const el = msgEl(m);
    const old = rendered.get(m.id);
    if (old) old.replaceWith(el); else chat.appendChild(el);
    rendered.set(m.id, el);
    for (const id of [...rendered.keys()]) if (!state.chat.some((x) => x.id === id)) { rendered.get(id).remove(); rendered.delete(id); }
  }
  syncConfirm();
  renderEmpty();
  if (nearBottom || (change && change.message && change.message.role === 'me')) chat.scrollTop = chat.scrollHeight;
}

function renderEmpty() {
  const chat = $('chat');
  let card = chat.querySelector('.chat-empty');
  const c = state.chief;
  if (c.connected && state.chat.length) { if (card) card.remove(); return; }
  if (card) card.remove();
  card = c.connected
    ? h('div', { class: 'chat-empty' }, h('strong', { text: 'Chief is ready' }), 'Ask what needs you, or say “Hey Chief”.')
    : h('div', { class: 'chat-empty' }, h('strong', { text: 'No Chief connected' }),
      'Type ', h('code', { text: '/chief' }), ' in any Claude desktop session to make it your Chief. Until then you can browse sessions, but nobody answers here.');
  chat.appendChild(card);
}

// ------------------------------------------------------------------ voice + chief status

export function renderVoice() {
  const v = state.voice || { state: 'starting', listen: 'off', speak: false };
  const c = state.chief;
  const installed = v.state !== 'not-installed';
  let word = VOICE_WORD[v.state] || v.state;
  if (v.state === 'listening' && v.listen === 'ptt') word = 'Ready';
  if (c.busy && ['listening', 'off', 'not-installed', 'error'].includes(v.state)) word = 'Thinking';
  if (!c.connected) word = 'No Chief';
  const orbState = !c.connected ? 'none' : c.busy && !['hearing', 'speaking'].includes(v.state) ? 'thinking' : v.state;
  $('orb').dataset.state = orbState;
  const st = $('orbState');
  st.textContent = word;
  st.classList.toggle('dim', !c.connected || !installed || v.state === 'off');

  const wake = v.wakeWord ? v.wakeWord.replace(/\b\w/g, (m) => m.toUpperCase()) : 'Hey Chief';
  let sub;
  if (!c.connected) sub = 'type /chief in a Claude session to start one';
  else if (!installed) sub = v.detail || 'run server/setup.ps1 to add voice · typing works';
  else if (v.state === 'error') sub = v.detail || 'the voice server stopped · typing works';
  else if (v.listen === 'wake') sub = `say “${wake}” to talk`;
  else if (v.listen === 'ptt') sub = 'hold the mic button to talk';
  else sub = 'the mic is off · type below';
  $('orbSub').textContent = sub;

  const wave = $('wave');
  wave.classList.toggle('speaking', v.state === 'speaking' && !reducedMotion());
  wave.classList.toggle('flat', !installed || v.state === 'off' || !c.connected);
  if (v.state !== 'hearing' && v.state !== 'listening') level(0);
  if (v.state !== 'hearing') $('partial').hidden = true;

  const setT = (id, on) => {
    const b = $(id);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !installed;
  };
  setT('tWake', v.listen === 'wake');
  setT('tSpeak', !!v.speak);
  setT('tPtt', v.listen === 'ptt');
  $('tStop').hidden = v.state !== 'speaking';

  const mic = $('mic');
  mic.disabled = !installed;
  mic.classList.toggle('idle', v.listen !== 'ptt');
  mic.title = v.listen === 'ptt' ? 'Hold to talk' : 'Push to talk is off';
  if (v.listen !== 'ptt' && held) { held = false; mic.classList.remove('held'); }

  $('chiefWho').textContent = c.connected ? `connected · ${c.sessionId ? c.sessionId.slice(0, 14) : ''}` : 'not connected';
  const ask = $('ask');
  ask.disabled = !c.connected;
  ask.placeholder = c.connected ? `Ask the Chief${installed && v.listen === 'wake' ? `, or say “${wake}”` : ''}` : 'No Chief connected';
  syncConfirm();
  renderEmpty();
}

/** Mic level 0..1 drives the wave and the orb core. Falls back to flat after 300 ms of silence. */
export function level(rms) {
  const v = Math.max(0, Math.min(1, Number(rms) || 0));
  const core = $('orbCore');
  core.style.transform = `scale(${(1 + v * 0.55).toFixed(3)})`;
  bars.forEach((b, i) => {
    const jitter = v ? 0.65 + Math.random() * 0.35 : 1;
    b.style.height = `${(4 + v * 22 * SHAPE[i] * jitter).toFixed(1)}px`;
  });
  clearTimeout(levelTimer);
  if (v > 0) levelTimer = setTimeout(() => level(0), 300);
}

export function partial(text) {
  const p = $('partial');
  p.textContent = text || '';
  p.hidden = !text;
}
