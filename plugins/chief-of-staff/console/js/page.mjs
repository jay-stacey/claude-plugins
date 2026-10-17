// Full page view of one session (#/s/<id>): conversation history with paging, reply box,
// Open in app, Ask Chief about it, and Archive with the in-page confirm flow.
import { archive, getSession, getTranscript, openInApp, reply } from './api.mjs';
import { $, add, ageWords, clear, clock, h, modelName, stateClass, stateLabel, where } from './util.mjs';
import { on, state } from './store.mjs';
import { sendToChief } from './chief.mjs';
import { toast } from './toast.mjs';
import { inline, md } from './md.mjs';

const PAGE = 60;
let cur = null;            // { id, sess, cursor, loading, seen:Set, lastUuid, gone }
let pendingReply = null;   // actionId
let pendingArchive = null; // actionId
let liveTimer = 0;
let goHome = () => {};
let openSession = () => {};

export function initPage({ home, open }) {
  goHome = home;
  openSession = open;
  $('back').addEventListener('click', () => goHome());
  $('pOpen').addEventListener('click', onOpenInApp);
  $('pAsk').addEventListener('click', onAsk);
  $('pArchive').addEventListener('click', () => doArchive(false));
  $('pConfirmYes').addEventListener('click', () => doArchive(true));
  $('pConfirmNo').addEventListener('click', () => {
    hideConfirm();
    pageNote('Left it running.', 'ok');
    $('pArchive').focus();
  });
  $('pConfirm').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pConfirmNo').click(); });
  $('replyForm').addEventListener('submit', (e) => { e.preventDefault(); onReply(); });
  $('replyBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onReply(); }
  });
  $('transcript').addEventListener('scroll', () => {
    if ($('transcript').scrollTop < 160) loadOlder();
  });
  $('transcript').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-app]')) onOpenInApp();
  });
  $('pMeta').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) openSession(b.dataset.goto);
  });

  on('action', onAction);
  on('activity', (ev) => {
    if (!cur) return;
    const id = cur.id;
    if (ev.id === id || ev.to === id) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(loadNewer, 500);
    }
  });
  on('sessions', () => {
    if (!cur) return;
    const s = state.byId.get(cur.id);
    if (s) { cur.sess = s; renderHead(); renderMeta(); } else if (!cur.gone) markGone();
  });
}

export async function showPage(id) {
  hideConfirm();
  pageNote('');
  replyNote('Ctrl+Enter sends. Or say “Hey Chief, tell this session …”');
  pendingReply = null;
  pendingArchive = null;
  cur = { id, sess: state.byId.get(id) || null, cursor: null, loading: false, seen: new Set(), lastUuid: null, gone: false, older: true };
  setActions(true);
  clear($('transcript'));
  clear($('pMeta'));
  $('pTitle').textContent = cur.sess ? cur.sess.title : 'Loading…';
  $('pState').hidden = true;
  if (!cur.sess) {
    try {
      cur.sess = await getSession(id);
    } catch (err) {
      if (!cur || cur.id !== id) return;
      $('pTitle').textContent = err.status === 404 ? 'Session not found' : 'Could not load this session';
      $('transcript').appendChild(h('p', { class: 'missing', text: err.status === 404
        ? 'This session is not open any more. It may have been archived.'
        : err.message }));
      setActions(false);
      return;
    }
  }
  if (!cur || cur.id !== id) return;
  renderHead();
  renderMeta();
  await loadLatest();
}

export function leavePage() {
  cur = null;
  clearTimeout(liveTimer);
}

function setActions(on) {
  for (const b of ['pOpen', 'pAsk', 'pArchive', 'replySend']) $(b).disabled = !on;
  $('replyBox').disabled = !on;
}

function markGone() {
  cur.gone = true;
  setActions(false);
  hideConfirm();
  pageNote('This session is not open any more. It was archived or closed.', 'err');
}

// ------------------------------------------------------------------ head + meta

function renderHead() {
  const x = cur.sess;
  $('pTitle').textContent = x.title;
  document.title = `${x.title} · Chief of Staff`;
  const pill = clear($('pState'));
  pill.className = `state-pill ${stateClass(x.state)}`;
  pill.append(h('i', { class: 'dot', 'aria-hidden': 'true' }), stateLabel(x.state));
  pill.hidden = false;
}

const TAKE = {
  you: 'This one is waiting on you. A short answer unblocks it.',
  active: 'Working. No need to step in yet.',
  wait: 'Parked until something else finishes. Nothing for you yet.',
  stale: 'Nothing has moved here in a while. Archive it if the work is done.',
};

function renderMeta() {
  const x = cur.sess;
  const m = clear($('pMeta'));
  const byId = state.byId;
  const parent = x.parentId ? byId.get(x.parentId) : null;
  const kids = (x.childIds || []).map((k) => byId.get(k)).filter(Boolean);
  const row = (k, v) => (v ? [h('dt', { text: k }), h('dd', {}, v)] : []);
  add(m,
    h('div', { class: `summary-box ${stateClass(x.state)}` },
      h('span', { class: 'label', text: 'Where it stands' }), x.summary || x.stateReason || 'No summary yet.'),
    x.needsAction ? h('div', { class: 'summary-box needs st-you' }, h('span', { class: 'label', text: 'Needs you' }), x.needsAction) : null,
    h('dl', {},
      row('State', x.stateReason || stateLabel(x.state)),
      row('Last', x.state === 'active' ? 'working now' : ageWords(x.lastActivityAt)),
      row('Where', where(x) || null),
      row('Folder', x.cwd || null),
      row('PR', x.prNumber ? `${x.prNumber}${x.prState ? ` · ${x.prState.toLowerCase()}` : ''}` : null),
      row('Model', [modelName(x.model), x.effort].filter(Boolean).join(' · ') || null),
      row('Mode', x.permissionMode || null),
      row('Kind', x.kind === 'background' ? 'background job' : null),
      row('Live', x.live ? [x.liveStatus || 'running', x.waitingFor ? `waiting for ${x.waitingFor}` : null].filter(Boolean).join(' · ') : 'no process'),
      row('Parent', parent ? h('button', { type: 'button', 'data-goto': parent.id, text: parent.title }) : x.parentId ? 'not open' : 'None'),
      row('Helpers', kids.length ? kids.flatMap((k, i) => [i ? ', ' : null, h('button', { type: 'button', 'data-goto': k.id, text: k.title })]) : 'None'),
      row('Started', x.createdAt ? clock(x.createdAt) : null)),
    h('span', { class: 'label', text: 'What to do' }),
    h('div', { text: TAKE[x.state] || '' }),
  );
}

// ------------------------------------------------------------------ transcript

const mark = (cls, glyph) => h('span', { class: `mark ${cls}`, 'aria-hidden': 'true', text: glyph });

/** One turn, drawn like a Claude Code chat: › you, ● Claude, ● Tool(args) with ⎿ result. */
function turnEl(t) {
  const when = clock(t.at);
  if (t.role === 'tool') {
    if (t.toolName === 'AskUserQuestion') return questionEl(t, when);
    const args = t.toolSummary || (t.text && t.text !== t.toolName ? t.text : '');
    return h('div', { class: `turn tool${t.toolError ? ' err' : ''}`, 'data-uuid': t.uuid, title: when },
      mark('tool', '●'),
      h('div', { class: 'tool-body' },
        h('div', { class: 'tool-call' }, h('b', { text: t.toolName || 'Tool' }), args ? h('span', { class: 'args', text: `(${args})` }) : null),
        t.toolResult ? h('div', { class: 'tool-result' }, h('span', { class: 'elbow', 'aria-hidden': 'true', text: '⎿' }), h('span', { text: t.toolResult })) : null));
  }
  if (t.role === 'user') {
    return h('div', { class: `turn user${t.fromSession ? ' from' : ''}`, 'data-uuid': t.uuid, title: when },
      mark('you', '›'),
      h('div', { class: 'body2' },
        h('div', { class: 'who' }, t.fromSession ? `From ${t.fromSession}` : 'You', h('span', { class: 'when', text: when })),
        h('div', { class: 'md' }, md(t.text))));
  }
  return h('div', { class: 'turn asst', 'data-uuid': t.uuid, title: when },
    mark('claude', '●'), h('div', { class: 'body2 md' }, md(t.text)));
}

/** AskUserQuestion: the question and its options. Answers happen in the Claude app, where the
 *  session is paused on the prompt; a typed reply here would only queue behind it. */
function questionEl(t, when) {
  const q = t.question && Array.isArray(t.question.questions) ? t.question : null;
  const answered = q && q.answer;
  const card = h('div', { class: `qcard${answered ? ' answered' : ''}` });
  const openBtn = () => h('button', { type: 'button', class: 'linkish', 'data-open-app': '1', text: 'Open in app' });
  if (!q) {
    card.append(h('div', { class: 'q-text', text: 'Asked you a question.' }),
      h('div', { class: 'q-foot' }, 'Open it in the Claude app to see and answer it. ', openBtn()));
  } else {
    const picked = answered ? String(q.answer).split(/,\s*/) : [];
    for (const one of q.questions) {
      card.appendChild(h('div', { class: 'q-one' },
        one.header ? h('span', { class: 'q-chip', text: one.header }) : null,
        h('div', { class: 'q-text' }, inline(one.question || '')),
        h('ol', { class: 'q-opts' }, (one.options || []).map((o) => h('li', { class: picked.includes(o.label) ? 'picked' : null },
          h('span', { class: 'q-label', text: o.label || '' }), o.description ? h('span', { class: 'q-desc', text: o.description }) : null))),
        one.multiSelect ? h('div', { class: 'q-note', text: 'Pick one or more.' }) : null));
    }
    card.appendChild(answered
      ? h('div', { class: 'q-foot ok', text: `Answered: ${q.answer}` })
      : h('div', { class: 'q-foot' }, 'Waiting for your answer in the Claude app. ', openBtn()));
  }
  return h('div', { class: 'turn tool question', 'data-uuid': t.uuid, title: when },
    mark('ask', '?'), h('div', { class: 'tool-body' }, h('div', { class: 'tool-call' }, h('b', { text: 'Question for you' })), card));
}

function topMarker() {
  const box = $('transcript');
  const old = box.querySelector('.page-marker');
  if (old) old.remove();
  let m;
  if (cur.cursor) m = h('div', { class: 'page-marker', text: cur.loading ? 'Loading older turns…' : 'Scroll up for older turns' });
  else m = h('div', { class: 'page-marker', text: 'Start of the conversation' });
  box.prepend(m);
}

async function loadLatest() {
  const id = cur.id;
  const box = $('transcript');
  cur.loading = true;
  box.appendChild(h('div', { class: 'page-marker', text: 'Loading the conversation…' }));
  let r;
  try {
    r = await getTranscript(id, { limit: PAGE });
  } catch (err) {
    if (!cur || cur.id !== id) return;
    cur.loading = false;
    clear(box);
    box.appendChild(h('button', { type: 'button', class: 'page-marker err', text: `${err.message} Try again.`, onclick: () => { clear(box); loadLatest(); } }));
    return;
  }
  if (!cur || cur.id !== id) return;
  cur.loading = false;
  clear(box);
  cur.cursor = r.cursor;
  for (const t of r.turns) { cur.seen.add(t.uuid); box.appendChild(turnEl(t)); }
  cur.lastUuid = r.turns.length ? r.turns[r.turns.length - 1].uuid : null;
  if (!r.turns.length) box.appendChild(h('p', { class: 'missing', text: 'No conversation yet.' }));
  topMarker();
  box.scrollTop = box.scrollHeight;
  // Short pages do not scroll, so fetch older turns until the box can scroll.
  for (let i = 0; i < 3 && cur && cur.cursor && box.scrollHeight <= box.clientHeight + 40; i += 1) await loadOlder();
}

async function loadOlder() {
  if (!cur || cur.loading || !cur.cursor) return;
  const id = cur.id;
  const box = $('transcript');
  cur.loading = true;
  topMarker();
  let r;
  try {
    r = await getTranscript(id, { limit: PAGE, before: cur.cursor });
  } catch (err) {
    if (!cur || cur.id !== id) return;
    cur.loading = false;
    const m = box.querySelector('.page-marker');
    if (m) m.replaceWith(h('button', { type: 'button', class: 'page-marker err', text: `${err.message} Try again.`, onclick: loadOlder }));
    return;
  }
  if (!cur || cur.id !== id) return;
  const before = box.scrollHeight;
  const top = box.scrollTop;
  const marker = box.querySelector('.page-marker');
  const frag = document.createDocumentFragment();
  for (const t of r.turns) {
    if (cur.seen.has(t.uuid)) continue;
    cur.seen.add(t.uuid);
    frag.appendChild(turnEl(t));
  }
  if (marker) marker.after(frag); else box.prepend(frag);
  cur.cursor = r.cursor;
  cur.loading = false;
  topMarker();
  box.scrollTop = top + (box.scrollHeight - before);
}

/** The session grew: append turns after the last one shown. */
async function loadNewer() {
  if (!cur || cur.loading) return;
  const id = cur.id;
  let r;
  try {
    r = await getTranscript(id, { limit: 30 });
  } catch {
    return; // the next activity event tries again
  }
  if (!cur || cur.id !== id) return;
  const box = $('transcript');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const fresh = r.turns.filter((t) => !cur.seen.has(t.uuid));
  if (!fresh.length) return;
  const empty = box.querySelector('.missing');
  if (empty) empty.remove();
  for (const t of fresh) {
    cur.seen.add(t.uuid);
    const el = turnEl(t);
    el.classList.add('fresh');
    box.appendChild(el);
  }
  cur.lastUuid = fresh[fresh.length - 1].uuid;
  if (near) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ actions

function pageNote(text, kind = '', extra = null) {
  const n = clear($('pNote'));
  n.className = `page-note${kind ? ` ${kind}` : ''}`;
  if (text) n.append(text, extra ? ' ' : '', extra || '');
  n.hidden = !text;
}

function replyNote(text, kind = '') {
  const n = $('replyNote');
  n.textContent = text;
  n.className = `note${kind ? ` ${kind}` : ''}`;
}

async function onReply() {
  if (!cur || cur.gone) return;
  const box = $('replyBox');
  const text = box.value.trim();
  if (!text) { replyNote('Type a reply first.', 'err'); box.focus(); return; }
  $('replySend').disabled = true;
  try {
    const r = await reply(cur.id, text);
    pendingReply = r.actionId;
    box.value = '';
    replyNote('Queued. The Chief is sending it to this session…');
  } catch (err) {
    replyNote(err.status === 409 ? (err.body.error || 'No Chief is connected to send it.') : err.message, 'err');
  } finally {
    $('replySend').disabled = !!(cur && cur.gone);
  }
}

async function onOpenInApp() {
  if (!cur) return;
  try {
    await openInApp(cur.id);
    pageNote('Opened it in the Claude app.', 'ok');
  } catch (err) {
    pageNote(err.message, 'err');
  }
}

async function onAsk() {
  if (!cur || !cur.sess) return;
  const ok = await sendToChief(`Tell me about ${cur.sess.title}.`);
  if (ok) {
    pageNote('Asked the Chief. The answer is in the Chief panel.', 'ok',
      h('button', { type: 'button', class: 'linkish', text: 'Go to the Chief', onclick: () => goHome() }));
  } else {
    const n = $('composerNote');
    pageNote(n.textContent || 'The Chief could not take the question.', 'err');
  }
}

function showConfirm(reason) {
  $('pConfirmText').textContent = `${reason} Archive it anyway?`;
  $('pConfirm').hidden = false;
  $('pConfirmNo').focus();
}

function hideConfirm() {
  $('pConfirm').hidden = true;
}

async function doArchive(confirmed) {
  if (!cur || cur.gone) return;
  const id = cur.id;
  $('pArchive').disabled = true;
  $('pConfirmYes').disabled = true;
  try {
    const r = await archive(id, confirmed);
    hideConfirm();
    pendingArchive = { actionId: r.actionId, title: cur.sess ? cur.sess.title : id };
    pageNote('Archiving…');
  } catch (err) {
    if (err.status === 409 && err.body && err.body.needsConfirm) {
      showConfirm(err.body.reason || 'This session is working right now.');
    } else {
      hideConfirm();
      pageNote(err.message, 'err');
    }
  } finally {
    $('pConfirmYes').disabled = false;
    if (cur && !cur.gone) $('pArchive').disabled = false;
  }
}

function onAction(a) {
  if (pendingReply && a.actionId === pendingReply) {
    pendingReply = null;
    if (a.ok) replyNote(a.detail || 'Sent.', 'ok'); else replyNote(a.detail || 'The reply was not sent.', 'err');
  }
  if (pendingArchive && a.actionId === pendingArchive.actionId) {
    const { title } = pendingArchive;
    pendingArchive = null;
    if (a.ok) {
      toast({ kind: 'info', label: 'Archived', text: a.detail || `${title} is archived.` });
      if (cur) { cur.gone = true; goHome(); }
    } else {
      pageNote(a.detail || 'The archive did not go through.', 'err');
    }
  }
}
