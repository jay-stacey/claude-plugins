/* Day Desk page. Plain script, no framework, no build step.
   Contract: dashboard/API.md. Every server string is escaped before it reaches innerHTML. */
(() => {
  'use strict';

  // ------------------------------------------------------------ utils ------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const pad = n => String(n).padStart(2, '0');
  const safeUrl = u => {
    if (!u) return null;
    try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; }
    catch (e) { return null; }
  };
  const toMin = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const hm = m => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.floor(m % 60))}`;
  const dur = m => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${pad(r)}m` : `${r}m`; };
  const parseLocal = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
  };
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
  const timeOf = iso => (/T(\d{2}:\d{2})/.exec(String(iso || '')) || [])[1] || '';
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WD3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = MON.map(m => m.slice(0, 3));
  const LISTNAME = { now: 'Now', today: 'Today', week: 'This week', later: 'Later', done: 'Done', dropped: 'Dropped' };
  const POINTS = { high: 3, med: 2, low: 1 };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const isTyping = el => !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"], .cm-editor'));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const icon = {
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // ------------------------------------------------------------ token ------
  let TOKEN = '';
  try { TOKEN = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim(); } catch (e) { TOKEN = ''; }

  // ------------------------------------------------------------ clock ------
  // The server clock is the truth. It sends minute precision, so a gap of under
  // a minute means the clocks agree (the server runs on this machine).
  let skew = 0;
  function syncClock(serverNow) {
    const s = parseLocal(serverNow);
    if (!s) return;
    const diff = s.getTime() - Date.now();
    skew = diff > -61000 && diff < 1000 ? 0 : diff + 30000;
  }
  const now = () => new Date(Date.now() + skew);
  const nowMin = () => { const d = now(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
  const today = () => ymd(now());

  // ------------------------------------------------------------ state ------
  const S = {
    view: 'today', state: null, tasks: [], counts: {}, todayUsed: 0, todayCap: 5, loaded: false,
    gate: false, focusLen: 25, parkFor: null, parkText: '', showLater: false,
    seenNudges: new Set(), nudgeToasts: new Map(), madeFu: new Set(), fuList: [], pendingList: [],
    checkinFor: null, layer: null, lastFocus: null, dragging: false, tlScrolled: false,
    schedPending: false, schedPollUntil: 0, pendingRender: false,
  };
  const ctx = () => (S.state && S.state.context && typeof S.state.context === 'object' ? S.state.context : {});
  const stats = () => ctx().stats || {};
  const brief = () => (S.state && S.state.brief) || null;
  const sched = () => (S.state && S.state.schedule && typeof S.state.schedule === 'object' ? S.state.schedule : {});
  const profile = () => (S.state && S.state.profile) || {};
  const byId = id => S.tasks.find(t => t.id === id) || null;
  const inList = l => S.tasks.filter(t => t.list === l);
  const nowTask = () => S.tasks.find(t => t.list === 'now') || (ctx().now && ctx().now.list === 'now' ? ctx().now : null);
  const openTasks = () => S.tasks.filter(t => t.list !== 'done' && t.list !== 'dropped');
  const doneToday = () => S.tasks.filter(t => t.list === 'done' && String(t.done_at || '').startsWith(today()))
    .sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const speed = () => { const s = +stats().speed; return s > 0 ? s : 1; };
  const realMin = est => Math.ceil(est * speed() / 5) * 5;
  const focusSession = () => { const f = S.state && S.state.focus; return f && f.running && f.session ? f.session : null; };
  const focusLeftSec = f => { const e = parseLocal(f.ends_at); return e ? Math.max(0, (e.getTime() - now().getTime()) / 1000) : 0; };

  // ------------------------------------------------------------ api --------
  class ApiError extends Error {
    constructor(status, message, data) { super(message); this.status = status; this.data = data || null; }
  }
  const FALLBACK = {
    0: 'The Day Desk server is not answering. Start it again with /dashboard.',
    400: 'The server did not accept that. Check the values and try again.',
    404: 'That item was not found. It may have been moved or deleted.',
    409: 'That changed on disk since you opened it.',
    422: 'A list limit was reached.',
    500: 'The server hit an error. Try again in a moment.',
  };
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    const opt = { method, headers: { 'X-Day-Desk-Token': TOKEN }, cache: 'no-store' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opt); }
    catch (e) { setOffline(FALLBACK[0]); throw new ApiError(0, FALLBACK[0]); }
    setOffline(null);
    if (res.status === 403) { showGate(); throw new ApiError(403, 'Forbidden'); }
    if (raw && res.ok) return res;
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && typeof data.error === 'string' && data.error) || FALLBACK[res.status] || FALLBACK[500];
      throw new ApiError(res.status, msg, data);
    }
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: body || {} });
  const enc = encodeURIComponent;
  // A path segment may keep ":" (nudge ids look like meeting_10:evt123).
  const encSeg = v => encodeURIComponent(v).replace(/%3A/gi, ':');

  function showGate() {
    if (S.gate) return;
    S.gate = true;
    $('#app').hidden = true;
    $('#toasts').hidden = true;
    $('#layer').innerHTML = '';
    $('#gate').hidden = false;
  }
  function setOffline(msg) {
    const el = $('#offline');
    if (!el) return;
    if (!msg) { if (!el.hidden) el.hidden = true; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  // ------------------------------------------------------------ refresh ----
  let inflight = null, again = false;
  function refresh() {
    if (S.gate) return Promise.resolve();
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      try {
        const [st, tl] = await Promise.all([api('/api/state'), api('/api/tasks?lists=now,today,week,later,done')]);
        S.state = st || {};
        S.tasks = (tl && Array.isArray(tl.tasks)) ? tl.tasks : [];
        S.counts = (tl && tl.counts) || {};
        S.todayCap = (tl && tl.today_cap) || 5;
        S.todayUsed = tl && typeof tl.today_used === 'number' ? tl.today_used : inList('now').length + inList('today').length;
        syncClock(S.state.now);
        S.loaded = true;
        if (S.schedPending && sched().refreshing) S.schedPending = false;
        renderAll();
        handleNudges();
        checkFocus();
        updateChatBusy();
      } catch (e) {
        if (e.status && e.status !== 403) setOffline(`Day Desk could not load your day: ${e.message}`);
      } finally {
        inflight = null;
        if (again) { again = false; refresh(); }
      }
    })();
    return inflight;
  }

  // ------------------------------------------------------------ render core
  // Replace a region only when its markup changed. Never replace it while the
  // user types inside it; keep keyboard focus and inner scroll positions.
  function patch(el, html) {
    if (!el || el._html === html) return;
    const a = document.activeElement;
    if (a && el.contains(a) && isTyping(a)) { S.pendingRender = true; return; }
    let key = null;
    if (a && el.contains(a)) key = a.dataset.fk || (a.dataset.act ? `${a.dataset.act}|${a.dataset.id || a.dataset.i || a.dataset.len || ''}` : null);
    const scrolls = $$('[data-keep-scroll]', el).map(x => [x.dataset.keepScroll, x.scrollTop]);
    el.innerHTML = html;
    el._html = html;
    applyStyles(el);
    scrolls.forEach(([k, top]) => { const x = el.querySelector(`[data-keep-scroll="${k}"]`); if (x) x.scrollTop = top; });
    if (key) {
      const t = $$('[data-fk], [data-act]', el).find(x => (x.dataset.fk || `${x.dataset.act}|${x.dataset.id || x.dataset.i || x.dataset.len || ''}`) === key);
      if (t) t.focus({ preventScroll: true });
    }
  }
  // Positions go in data-s and are applied through the CSSOM, so the page works
  // under a strict style-src policy.
  function applyStyles(root) { $$('[data-s]', root).forEach(x => { x.style.cssText = x.dataset.s; }); }

  function renderAll() {
    if (S.gate) return;
    renderTop();
    renderNav();
    if (S.view === 'today') renderToday();
    else if (S.view === 'tasks') renderBoard();
    else if (S.view === 'week') renderWeek();
    if (S.layer === 'focus') updateRings();
  }

  // ------------------------------------------------------------ top bar ----
  function renderTop() {
    if (!S.loaded) { patch($('#topbar'), '<div class="date"><h1>Day Desk</h1><div class="sub">Loading your day…</div></div>'); return; }
    const d = now(), m = nowMin(), p = profile();
    const start = toMin(p.start) ?? 390, stop = toMin(p.stop) ?? 900;
    const evs = Array.isArray(sched().events) ? sched().events : [];
    const span = Math.max(1, stop - start);
    const pct = v => ((Math.min(Math.max(v, start), stop) - start) / span * 100);
    const segs = evs.filter(e => e.kind === 'meet' || e.kind === 'focus').map(e => {
      const a = toMin(e.start), b = toMin(e.end);
      if (a == null || b == null) return '';
      const l = pct(a), w = pct(b) - l;
      return w > 0 ? `<i class="seg ${e.kind}" data-s="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"></i>` : '';
    }).join('');
    const meetLeft = evs.filter(e => e.kind === 'meet').reduce((acc, e) => {
      const a = toMin(e.start), b = toMin(e.end);
      if (a == null || b == null) return acc;
      return acc + Math.max(0, Math.min(b, stop) - Math.max(a, m, start));
    }, 0);
    let meta;
    const range = `${esc(p.start || hm(start))} to ${esc(p.stop || hm(stop))}`;
    if (m < start) meta = `<span>Your workday starts at <strong>${esc(p.start || hm(start))}</strong> (${range})</span><span>${dur(meetLeft)} of it is meetings</span>`;
    else if (m >= stop) meta = `<span><strong>Workday is over</strong> (${range})</span><span>Night work is fine when you plan it.</span>`;
    else meta = `<span><strong>${dur(stop - m)}</strong> left in your workday (${range})</span><span>${dur(meetLeft)} of it is meetings</span>`;
    const b = brief();
    const sub = b ? `brief at ${esc(timeOf(b.generated_at) || 'this morning')}${b.mode && b.mode !== 'normal' ? ` · ${esc(b.mode)} mode` : ''}` : 'no brief yet today';
    const st = stats();
    patch($('#topbar'), `
      <div class="date"><h1>${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}</h1><div class="sub mono">${hm(d.getHours() * 60 + d.getMinutes())} · ${sub}</div></div>
      <div class="dayline">
        <div class="dayline-meta">${meta}</div>
        <div class="daybar" role="img" aria-label="Workday progress: ${Math.round(pct(m))} percent gone">${segs}<i class="past" data-s="width:${pct(m).toFixed(2)}%"></i><i class="nowmark" data-s="left:calc(${pct(m).toFixed(2)}% - 1px)"></i></div>
      </div>
      <div class="chips">
        <span class="chip amber" title="Workdays in a row with a brief and a shutdown"><strong>${+st.streak || 0}</strong> day streak</span>
        <span class="chip" title="Points today and this week"><strong>${+st.points_today || 0}</strong> today · <strong>${+st.points_week || 0}</strong> this week</span>
        <button class="btn" type="button" data-act="shutdown">${st.shutdown_done ? 'Day closed · run again' : 'Shut down the day'}</button>
        <button class="btn ghost" type="button" data-act="chat-toggle" aria-controls="chat">Ask</button>
      </div>`);
  }

  function renderNav() {
    $$('.nav-btn[data-view]').forEach(b => {
      if (b.dataset.view === S.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const c = $('#navTasks');
    const txt = S.loaded ? String(S.todayUsed) : '';
    if (c.textContent !== txt) c.textContent = txt;
  }

  // ------------------------------------------------------------ helpers ----
  function dueLabel(due) {
    if (!due) return '';
    const t = today();
    if (due === t) return 'today';
    const d = parseLocal(due);
    if (!d) return due;
    if (due < t) return `overdue, ${MON3[d.getMonth()]} ${d.getDate()}`;
    const diff = Math.round((d - parseLocal(t)) / 86400000);
    if (diff === 1) return 'tomorrow';
    if (diff < 7) return WD3[d.getDay()];
    return `${MON3[d.getMonth()]} ${d.getDate()}`;
  }
  function dueTag(t) {
    if (!t.due) return '';
    const late = t.due < today();
    return `<span class="tag${late ? ' late' : ''}">${esc(late ? dueLabel(t.due) : 'due ' + dueLabel(t.due))}</span>`;
  }
  function srcLabel(s) {
    if (!s) return '';
    const u = safeUrl(s);
    if (u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
    return String(s);
  }
  const estOf = t => (typeof t.estimate_min === 'number' && t.estimate_min > 0 ? t.estimate_min : null);
  const prioDot = p => `<span class="prio ${POINTS[p] ? p : 'med'}" aria-hidden="true"></span>`;

  // ------------------------------------------------------------ today ------
  function ringHtml(kind, taskId) {
    const f = focusSession();
    const mine = f && (kind === 'big' || f.task === taskId);
    const total = mine ? (+f.minutes || 25) * 60 : S.focusLen * 60;
    const left = mine ? focusLeftSec(f) : total;
    const r = 52, c = 2 * Math.PI * r, frac = total ? left / total : 0;
    const label = mine ? (left > 0 ? 'focusing' : 'time is up') : 'ready';
    const sec = Math.ceil(left);
    return `<div class="ring${kind === 'big' ? ' big' : ''}" data-ring="${kind}" data-task="${esc(taskId || '')}" role="timer" aria-label="Focus timer">
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--raise)" stroke-width="8"/><circle class="ring-arc" cx="60" cy="60" r="${r}" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"/></svg>
      <div class="t"><div><b class="ring-time">${pad(Math.floor(sec / 60))}:${pad(sec % 60)}</b><span class="ring-label">${label}</span></div></div></div>`;
  }
  function updateRings() {
    $$('.ring[data-ring]').forEach(el => {
      const f = focusSession();
      const mine = f && (el.dataset.ring === 'big' || f.task === el.dataset.task);
      if (!mine) return;
      const total = (+f.minutes || 25) * 60, left = focusLeftSec(f), sec = Math.ceil(left);
      const c = 2 * Math.PI * 52;
      const t = el.querySelector('.ring-time'), arc = el.querySelector('.ring-arc'), lab = el.querySelector('.ring-label');
      if (t) t.textContent = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
      if (arc) arc.setAttribute('stroke-dashoffset', (c * (1 - left / total)).toFixed(1));
      if (lab) lab.textContent = left > 0 ? 'focusing' : 'time is up';
    });
  }

  function nowCard(n) {
    const f = focusSession();
    const running = f && f.task === n.id;
    const est = estOf(n);
    const bits = [`${prioDot(n.priority)}${esc(n.priority || 'med')} priority`];
    if (est) {
      const real = realMin(est);
      bits.push(speed() !== 1 && real !== est ? `you planned ${est}m, which is about ${real}m at your usual speed` : `you planned ${est}m`);
    } else bits.push('no estimate yet');
    if (n.due) bits.push(n.due < today() ? `<span class="tag late">${esc(dueLabel(n.due))}</span>` : `due ${esc(dueLabel(n.due))}`);
    const u = safeUrl(n.source);
    if (u) bits.push(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">open in ${esc(srcLabel(u))}</a>`);
    const step = n.next_step ? ['Next step', n.next_step] : n.first_step ? ['First step, 5 minutes', n.first_step] : null;
    let primary;
    if (running && focusLeftSec(f) <= 0) primary = `<button class="btn primary" type="button" data-act="checkin">Check in</button>`;
    else if (running) primary = `<button class="btn primary" type="button" data-act="focus-open" data-id="${esc(n.id)}">Back to focus</button>`;
    else primary = `<button class="btn primary" type="button" data-act="focus-open" data-id="${esc(n.id)}">Start focus</button>`;
    const park = S.parkFor === n.id ? `
      <form class="park-form" data-form="park" data-id="${esc(n.id)}">
        <label for="parkNext">Where were you? Write the next step, so you can restart fast.</label>
        <div class="park-row"><input id="parkNext" autocomplete="off" value="${esc(S.parkText)}"><button class="btn small primary" type="submit">Park</button><button class="btn small ghost" type="button" data-act="park-cancel">Cancel</button></div>
      </form>` : '';
    return `<article class="now" aria-labelledby="nowTitle">
      <div>
        <span class="now-pill">NOW</span>
        <h2 id="nowTitle">${esc(n.title)}</h2>
        <div class="why-line">${bits.join(' · ')}</div>
        ${step ? `<div class="step"><div class="label">${step[0]}</div><p>${esc(step[1])}</p></div>`
              : `<div class="step none"><div class="label">First step</div><p>No first step yet. Break it down, or open the task and add one.</p></div>`}
        <div class="now-actions">
          ${primary}
          <button class="btn ok" type="button" data-act="done" data-id="${esc(n.id)}">Done</button>
          <button class="btn" type="button" data-act="breakdown" data-id="${esc(n.id)}">Break it down</button>
          <button class="btn" type="button" data-act="park-open" data-id="${esc(n.id)}">Park it</button>
        </div>
        ${park}
      </div>
      <div class="ring-wrap">${ringHtml('now', n.id)}${running ? '' : `<div class="seg-btns" role="group" aria-label="Focus length in minutes">${[10, 25, 50].map(l => `<button class="btn small" type="button" data-act="len" data-len="${l}" aria-pressed="${S.focusLen === l}">${l}</button>`).join('')}</div>`}</div>
    </article>`;
  }

  function taskRow(t) {
    const est = estOf(t);
    const src = srcLabel(t.source);
    return `<li class="trow"><button class="check" type="button" data-act="done" data-id="${esc(t.id)}" aria-label="Mark done: ${esc(t.title)}"></button>
      <button class="title" type="button" data-act="edit" data-id="${esc(t.id)}">${prioDot(t.priority)}${esc(t.title)}${src || t.parked_at ? `<small>${t.parked_at ? `parked at ${esc(timeOf(t.parked_at))}${src ? ' · ' : ''}` : ''}${esc(src)}</small>` : ''}</button>
      <div class="meta-r">${est ? `<span class="mono">${est}m</span>` : ''}${dueTag(t)}<button class="btn small ghost" type="button" data-act="make-now" data-id="${esc(t.id)}">Make Now</button></div></li>`;
  }

  function timelinePanel() {
    const sc = sched(), m = nowMin(), p = profile();
    const evs = (Array.isArray(sc.events) ? sc.events : []).filter(e => toMin(e.start) != null && toMin(e.end) != null && e.kind !== 'allday');
    const allday = (Array.isArray(sc.events) ? sc.events : []).filter(e => e.kind === 'allday' || toMin(e.start) == null);
    const flags = Array.isArray(sc.flags) ? sc.flags : [];
    const prep = new Set(flags.filter(f => f.kind === 'prep_needed' && f.event_id).map(f => f.event_id));
    const start = toMin(p.start) ?? 390, stop = toMin(p.stop) ?? 900;
    let h0 = Math.floor(start / 60), h1 = Math.ceil(stop / 60) + 1;
    evs.forEach(e => { h0 = Math.min(h0, Math.floor(toMin(e.start) / 60)); h1 = Math.max(h1, Math.ceil(toMin(e.end) / 60)); });
    h0 = Math.max(0, h0); h1 = Math.min(24, Math.max(h1, h0 + 1));
    const PX = 58, y = mins => (mins - h0 * 60) / 60 * PX;

    // Lay overlapping events side by side.
    const sorted = evs.slice().sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(b.end) - toMin(a.end));
    const placed = [];
    let cluster = [], clusterEnd = -1;
    const closeCluster = () => {
      const lanes = cluster.reduce((n, x) => Math.max(n, x.lane + 1), 1);
      cluster.forEach(x => { x.lanes = lanes; });
      cluster = [];
    };
    sorted.forEach(e => {
      const a = toMin(e.start), b = toMin(e.end);
      if (a >= clusterEnd) { closeCluster(); clusterEnd = -1; }
      const used = new Set(cluster.filter(x => x.b > a).map(x => x.lane));
      let lane = 0; while (used.has(lane)) lane++;
      const item = { e, a, b, lane };
      cluster.push(item); placed.push(item);
      clusterEnd = Math.max(clusterEnd, b);
    });
    closeCluster();

    const evHtml = placed.map(({ e, a, b, lane, lanes }) => {
      const w = 100 / lanes;
      const style = `top:${y(a).toFixed(1)}px;height:${Math.max(18, (b - a) / 60 * PX - 3).toFixed(1)}px;left:calc(${(lane * w).toFixed(2)}% + 6px);width:calc(${w.toFixed(2)}% - 10px)`;
      const kind = ['meet', 'focus', 'personal'].includes(e.kind) ? e.kind : 'meet';
      const inner = `<b>${esc(e.title)}${prep.has(e.id) ? '<span class="flag">PREP</span>' : ''}</b><span>${esc(e.start)} to ${esc(e.end)}${e.attendees > 1 ? ` · ${+e.attendees} people` : ''}</span>`;
      const u = safeUrl(e.link);
      const cls = `ev ${kind}${b <= m ? ' past' : ''}`;
      return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-s="${style}" title="${esc(e.title)}">${inner}</a>`
               : `<div class="${cls}" data-s="${style}" title="${esc(e.title)}">${inner}</div>`;
    }).join('');
    const hours = []; for (let h = h0; h <= h1; h++) hours.push(h);
    const showNow = m >= h0 * 60 && m <= h1 * 60;

    // Next meeting countdown, or the meeting you are in.
    const meets = evs.filter(e => e.kind === 'meet');
    const cur = meets.find(e => toMin(e.start) <= m && toMin(e.end) > m);
    const next = meets.filter(e => toMin(e.start) > m).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
    let nm = '';
    if (cur) nm = `<div class="next-meet"><b>now</b><span>${esc(cur.title)} until ${esc(cur.end)}.${next ? ` Then ${esc(next.title)} at ${esc(next.start)}.` : ''}</span></div>`;
    else if (next) nm = `<div class="next-meet"><b>${dur(toMin(next.start) - m)}</b><span>until ${esc(next.title)} at ${esc(next.start)}. You get a heads-up at 10 and at 2 minutes.</span></div>`;

    const refreshing = !!sc.refreshing || S.schedPending;
    let asOf;
    if (refreshing) asOf = `<span class="spin" aria-hidden="true"></span><span>Reading your calendar…</span>`;
    else if (sc.source === 'none' || !sc.as_of) asOf = `<span>No calendar read yet today.</span> <button class="linkish" type="button" data-act="sched-refresh">Refresh</button>`;
    else {
      const d = parseLocal(sc.as_of);
      const stale = d && ymd(d) !== today();
      const ageMin = d ? (now() - d) / 60000 : 0;
      const when = stale ? `${WD3[d.getDay()]} ${timeOf(sc.as_of)}` : timeOf(sc.as_of);
      asOf = `<span class="${stale || ageMin > 180 ? 'old' : ''}">Schedule as of ${esc(when)}${sc.source === 'brief' ? ' (from the brief)' : ''}</span> · <button class="linkish" type="button" data-act="sched-refresh">Refresh</button>`;
    }
    // A failed refresh must not pass for a fresh calendar.
    if (!refreshing && sc.refresh_error) asOf += `<br><span class="old" role="status">Refresh failed: ${esc(sc.refresh_error)} This is the older schedule.</span>`;
    const body = evs.length || allday.length ? `
      ${nm}
      ${allday.length ? `<div class="allday">${allday.map(e => `<span class="chip">${esc(e.title)}</span>`).join('')}</div>` : ''}
      <div class="tl-scroll" data-keep-scroll="tl" id="tlScroll"><div class="tl" data-s="height:${(h1 - h0) * PX + 10}px">
        ${hours.map(h => `<div class="hour" data-s="top:${y(h * 60).toFixed(1)}px"><span>${pad(h)}:00</span></div>`).join('')}
        ${evHtml}
        ${showNow ? `<div class="nowline" data-s="top:${y(m).toFixed(1)}px" aria-hidden="true"></div>` : ''}
      </div></div>`
      : `<div class="empty"><b>Nothing on the calendar yet.</b><br>Refresh reads today from your calendar, or the morning brief fills it in.</div>`;
    return `<section class="panel" aria-labelledby="tlHead">
      <div class="panel-head"><h2 id="tlHead">Today</h2><span class="meta mono">${pad(h0)}:00 to ${pad(h1)}:00</span></div>
      <div class="sched-line" role="status">${asOf}</div>
      ${body}
    </section>`;
  }

  const PENDING_KIND = {
    email_confirm: 'Email cleanup waiting for a yes', blocks: 'Focus blocks waiting to be booked', rule: 'A new email rule',
    filter: 'A Gmail filter offer', placeholder: 'A setting to fill in',
  };

  function briefPanels() {
    const b = brief();
    if (!b) {
      return `<section class="panel hello"><h2>Morning brief</h2>
        <p>No brief today. Run /morning-brief in Claude, or ask the assistant here.</p>
        <button class="btn" type="button" data-act="chat-ask" data-text="Give me a quick start for today: what matters and what should I do first?">Ask the assistant</button></section>`;
    }
    const out = [];
    // Waiting for you
    S.pendingList = Array.isArray(b.pending) ? b.pending : [];
    if (S.pendingList.length) {
      out.push(`<section class="panel wait" aria-labelledby="waitHead"><div class="panel-head"><h2 id="waitHead">Waiting for you</h2><span class="meta">decisions the brief left open</span></div>
        <div class="fu">${S.pendingList.map((x, i) => `<div class="fu-item"><div>${esc(x.summary)}<small>${esc(PENDING_KIND[x.kind] || x.kind || 'Decision')}</small></div><button class="btn small" type="button" data-act="answer" data-i="${i}">Answer in chat</button></div>`).join('')}</div></section>`);
    }
    // Promises to keep
    const openTitles = new Set(S.tasks.map(t => String(t.title || '').trim().toLowerCase()));
    const fu = [];
    (Array.isArray(b.followups) ? b.followups : []).forEach(f => fu.push({ text: f.text, why: f.why, url: f.url, due: f.due }));
    const em = b.email && Array.isArray(b.email.commitments) ? b.email.commitments : [];
    em.forEach(c => fu.push({ text: c.text, why: [c.said ? `You wrote "${c.said}"` : '', c.due ? `due ${dueLabel(c.due)}` : ''].filter(Boolean).join(', '), url: c.url, due: c.due }));
    S.fuList = fu.filter(f => f.text && !S.madeFu.has(f.text) && !openTitles.has(String(f.text).trim().toLowerCase()));
    out.push(`<section class="panel" aria-labelledby="fuHead"><div class="panel-head"><h2 id="fuHead">Promises to keep</h2><span class="meta">from meetings and sent mail</span></div>
      <div class="fu">${S.fuList.map((f, i) => {
        const u = safeUrl(f.url);
        return `<div class="fu-item"><div>${esc(f.text)}${f.why || u ? `<small>${esc(f.why)}${u ? `${f.why ? ' · ' : ''}<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</small>` : ''}</div><button class="btn small" type="button" data-act="fu-task" data-i="${i}">Make a task</button></div>`;
      }).join('') || `<div class="empty">Nothing waiting. Promises you make in meetings and sent mail show up here.</div>`}</div></section>`);
    // Needs you elsewhere
    const ext = Array.isArray(b.elsewhere) ? b.elsewhere : [];
    out.push(`<section class="panel" aria-labelledby="extHead"><div class="panel-head"><h2 id="extHead">Needs you elsewhere</h2><span class="meta">links out, not tasks</span></div>
      <div class="ext">${ext.map(x => {
        const u = safeUrl(x.url);
        const inner = `<span class="src">${esc(x.source || 'link')}</span><span>${esc(x.title)}${x.why ? `<small>${esc(x.why)}</small>` : ''}</span>`;
        return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<div class="row">${inner}</div>`;
      }).join('') || `<div class="empty">Nothing needs you in Linear, Slack, Jira or GitHub right now.</div>`}</div></section>`);
    return out.join('');
  }

  function renderToday() {
    const el = $('#v-today');
    if (!S.loaded) { patch(el, '<div class="panel"><div class="empty">Loading your day…</div></div>'); return; }
    const n = nowTask();
    const up = inList('today');
    const done = doneToday();
    const parked = S.tasks.filter(t => t.parked_at && t.list !== 'done' && t.list !== 'dropped' && t.list !== 'now');
    let nowHtml;
    if (n) nowHtml = nowCard(n);
    else if (up.length) nowHtml = `<article class="panel hello"><h2>No Now task.</h2><p>Pick one from Up next with Make Now. One thing at a time.</p></article>`;
    else nowHtml = `<article class="panel hello"><h2>Nothing planned yet.</h2><p>Add a task, or ask the assistant what to do first.</p>
      <div class="now-actions"><button class="btn primary" type="button" data-act="go-add">Add a task</button><button class="btn" type="button" data-act="chat-ask" data-text="What should I do next?">What should I do next?</button></div></article>`;
    const parkedHtml = parked.map(t => `<div class="resume"><div><div class="label">Parked at ${esc(timeOf(t.parked_at))}</div><b>${esc(t.title)}</b>${t.next_step ? `<p>Next: ${esc(t.next_step)}</p>` : ''}</div><button class="btn small" type="button" data-act="resume" data-id="${esc(t.id)}">Resume</button></div>`).join('');
    const pts = +stats().points_today || 0;
    const html = `<div class="grid-today">
      <div class="col">
        ${nowHtml}
        ${parkedHtml}
        <section class="panel" aria-labelledby="upHead">
          <div class="panel-head"><h2 id="upHead">Up next</h2><span class="meta">${S.todayUsed} of ${S.todayCap} for today</span></div>
          <ul class="tlist">${up.map(taskRow).join('') || `<li class="empty">${n ? 'Nothing else today. Good place to be.' : 'Today is empty. Pull something in from This week on the Tasks board.'}</li>`}</ul>
        </section>
        <section class="panel" aria-labelledby="doneHead">
          <div class="panel-head"><h2 id="doneHead">Done today</h2><span class="meta">${done.length} finished · ${pts} points</span></div>
          ${done.map(t => `<div class="done-row"><span class="mono">${esc(timeOf(t.done_at))}</span><span>${esc(t.title)}</span><span class="pts">+${POINTS[t.priority] || 2}</span></div>`).join('')
            || `<div class="empty">Nothing finished yet. Each finished task lands here with its time and points.</div>`}
        </section>
      </div>
      <div class="col">
        ${timelinePanel()}
        ${briefPanels()}
      </div>
    </div>`;
    patch(el, html);
    const sc = $('#tlScroll');
    if (sc && !S.tlScrolled && sc.clientHeight) {
      const line = sc.querySelector('.nowline');
      sc.scrollTop = Math.max(0, (line ? line.offsetTop : 0) - 140);
      S.tlScrolled = true;
    }
  }

  // ------------------------------------------------------------ task actions
  async function act(fn, okMsg) {
    try { const r = await fn(); if (okMsg) okMsg(r); return r; }
    catch (e) { if (e.status !== 403) toast(e.status === 422 ? 'Limit reached' : 'Not saved', e.message, { kind: 'bad' }); return null; }
    finally { refresh(); }
  }
  function completeTask(id) {
    const t = byId(id);
    return act(() => post(`/api/tasks/${enc(id)}/done`), r => {
      const pts = r && r.points ? `+${r.points} points` : 'Done';
      const nx = r && r.suggest_now;
      if (nx && nx.id) toast(pts, `Done. Next up: ${nx.title}.`, { actions: [{ label: 'Make it Now', fn: () => moveTask(nx.id, 'now') }] });
      else toast(pts, `Done: ${t ? t.title : 'task'}.`);
    });
  }
  function moveTask(id, list) {
    return act(() => post(`/api/tasks/${enc(id)}/move`, { list }), r => {
      if (list === 'done') toast(r && r.points ? `+${r.points} points` : 'Done', `Done: ${(r && r.task && r.task.title) || 'task'}.`);
      else if (r && r.demoted) { const d = byId(r.demoted); toast('Moved', `${d ? d.title : r.demoted} moved from Now to Today.`); }
    });
  }

  // ------------------------------------------------------------ tasks board
  function card(t) {
    const est = estOf(t);
    return `<div class="card${t.list === 'now' ? ' is-now' : ''}" role="button" tabindex="0" draggable="true" data-act="edit" data-id="${esc(t.id)}" aria-label="${esc(t.title)}, ${esc(LISTNAME[t.list] || t.list)}. Open to edit.">
      <span class="t">${prioDot(t.priority)}${esc(t.title)}</span>
      <span class="m">${t.list === 'now' ? '<span class="tag now">Now</span>' : ''}${t.parked_at && t.list !== 'done' ? '<span class="tag">parked</span>' : ''}${est ? `<span class="mono">${est}m</span>` : ''}${t.list !== 'done' && t.due ? `<span${t.due < today() ? ' class="tag late"' : ''}>due ${esc(dueLabel(t.due))}</span>` : ''}${t.done_at && t.list === 'done' ? `<span class="mono">${esc(String(t.done_at).slice(0, 10) === today() ? timeOf(t.done_at) : dueLabel(String(t.done_at).slice(0, 10)).replace(/^overdue, /, ''))}</span>` : ''}${(t.tags || []).map(g => `<span class="tag">#${esc(g)}</span>`).join('')}</span></div>`;
  }
  function renderBoard() {
    if (S.dragging) return;
    const el = $('#board');
    if (!S.loaded) { patch(el, '<div class="panel"><div class="empty">Loading tasks…</div></div>'); return; }
    const cols = [['today', 'Today'], ['week', 'This week'], ['later', 'Later'], ['done', 'Done']];
    const full = S.todayUsed >= S.todayCap;
    const html = `<div class="board">${cols.map(([k, label]) => {
      let items = k === 'today' ? [...inList('now'), ...inList('today')] : inList(k);
      if (k === 'done') items = items.slice().sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
      const cap = k === 'today' ? `<span class="cap${full ? ' full' : ''}">${S.todayUsed} of ${S.todayCap}</span>` : `<span class="cap">${items.length}</span>`;
      let body;
      if (k === 'later' && !S.showLater) body = items.length ? `<button class="fold" type="button" data-act="unfold">${plural(items.length, 'task')} folded away. Show them.</button>` : `<div class="empty">Empty. Someday ideas go here.</div>`;
      else {
        body = items.map(card).join('') || `<div class="empty">${{ today: 'Nothing for today. Drag a card here.', week: 'Nothing this week yet.', later: 'Empty.', done: 'Nothing finished in the last 7 days.' }[k]}</div>`;
        if (k === 'later' && items.length) body += `<button class="fold again" type="button" data-act="fold">Fold Later away</button>`;
      }
      return `<div class="colm" data-col="${k}" aria-label="${label}"><div class="colm-head"><h3>${label}</h3>${cap}</div>${body}</div>`;
    }).join('')}</div>`;
    patch(el, html);
  }

  // quick add
  let parseSeq = 0;
  const qaDefault = 'Words like fri, tomorrow, 15m, !high and #tag are read for you.';
  const previewParse = debounce(async text => {
    const seq = ++parseSeq;
    const el = $('#qaPrev');
    if (!text.trim()) { el.textContent = qaDefault; return; }
    try {
      const r = await api(`/api/parse?text=${enc(text)}`);
      if (seq !== parseSeq) return;
      const p = (r && (r.parse || r.fields)) || r || {};
      const list = p.list || 'week';
      const willBeFull = list === 'today' && S.todayUsed >= S.todayCap;
      el.innerHTML = [
        `<span class="tag">${esc(p.title || 'untitled')}</span>`,
        `<span class="tag">${esc(LISTNAME[willBeFull ? 'week' : list] || list)}</span>`,
        p.due ? `<span class="tag">due ${esc(dueLabel(p.due))}</span>` : '',
        `<span class="tag">${p.estimate ? esc(p.estimate) : 'no estimate'}</span>`,
        `<span class="tag">${prioDot(p.priority)}${esc(p.priority || 'med')}</span>`,
        ...(Array.isArray(p.tags) ? p.tags : []).map(x => `<span class="tag">#${esc(x)}</span>`),
        willBeFull ? '<span class="warnline">Today is full, so this goes to This week.</span>' : '',
      ].join('');
    } catch (e) {
      if (seq === parseSeq && e.status !== 403) el.textContent = `Preview not available: ${e.message}`;
    }
  }, 200);
  async function quickAdd() {
    const qa = $('#qa');
    const text = qa.value.trim();
    if (!text) { qa.focus(); return; }
    try {
      const r = await post('/api/tasks', { parse: text });
      const t = (r && r.task) || {};
      qa.value = '';
      $('#qaPrev').textContent = qaDefault;
      toast('Task added', `${t.title || text}, in ${LISTNAME[t.list] || 'your list'}.${r && r.note ? ' ' + r.note : ''}`);
    } catch (e) {
      if (e.status !== 403) toast('Not added', e.message, { kind: 'bad' });
    }
    refresh();
    qa.focus();
  }

  // drag and drop
  function wireBoardDrag() {
    const board = $('#board');
    board.addEventListener('dragstart', e => {
      const c = e.target.closest && e.target.closest('.card');
      if (!c) return;
      S.dragging = true;
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.id);
    });
    board.addEventListener('dragend', e => {
      const c = e.target.closest && e.target.closest('.card');
      if (c) c.classList.remove('dragging');
      $$('.colm.drop', board).forEach(x => x.classList.remove('drop'));
      S.dragging = false;
      setTimeout(renderBoard, 0);
    });
    board.addEventListener('dragover', e => {
      const col = e.target.closest && e.target.closest('.colm');
      if (!col) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      $$('.colm.drop', board).forEach(x => { if (x !== col) x.classList.remove('drop'); });
      col.classList.add('drop');
    });
    board.addEventListener('dragleave', e => {
      const col = e.target.closest && e.target.closest('.colm');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop');
    });
    board.addEventListener('drop', e => {
      const col = e.target.closest && e.target.closest('.colm');
      if (!col) return;
      e.preventDefault();
      col.classList.remove('drop');
      S.dragging = false;
      const id = e.dataTransfer.getData('text/plain');
      const t = byId(id);
      const to = col.dataset.col;
      if (!t || t.list === to || (to === 'today' && t.list === 'now')) { renderBoard(); return; }
      moveTask(id, to);
    });
  }

  // ------------------------------------------------------------ drawer -----
  const D = { id: null, task: null, busy: false };
  function openLayer(name, html) {
    if (!S.layer) S.lastFocus = document.activeElement;
    S.layer = name;
    const layer = $('#layer');
    layer.innerHTML = html;
    applyStyles(layer);
  }
  function closeLayer() {
    if (!S.layer) return false;
    const was = S.layer;
    S.layer = null;
    $('#layer').innerHTML = '';
    D.id = null;
    let back = S.lastFocus;
    S.lastFocus = null;
    // The opener may have been re-rendered while the layer was open; find its twin.
    if (back && !document.contains(back) && back.dataset && back.dataset.act) {
      back = $$(`[data-act="${back.dataset.act}"]`).find(x => (x.dataset.id || '') === (back.dataset.id || '')) || null;
    }
    if (back && document.contains(back)) back.focus({ preventScroll: true });
    if (was === 'focus' || was === 'checkin' || was === 'shutdown') renderAll();
    if (S.pendingRender) { S.pendingRender = false; renderAll(); }
    return true;
  }
  async function openDrawer(id) {
    D.id = id; D.task = byId(id);
    openLayer('drawer', `<div class="scrim" data-act="close-layer"></div><div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dHead">
      <div class="drawer-head"><h2 id="dHead">Edit task</h2><button class="icon-btn" type="button" data-act="close-layer" aria-label="Close">${icon.close}</button></div>
      <div class="drawer-body" id="dBody"><div class="empty">Loading the task…</div></div>
      <div class="drawer-foot"><button class="btn danger" type="button" data-act="d-drop" disabled>Drop task</button><div><button class="btn ok" type="button" data-act="d-done" disabled>Mark done</button><button class="btn primary" type="button" data-act="d-save" disabled>Save</button></div></div>
    </div>`);
    $('.drawer [data-act="close-layer"]').focus();
    await loadDrawer(id);
  }
  async function loadDrawer(id) {
    try {
      const r = await api(`/api/tasks/${enc(id)}`);
      if (D.id !== id || S.layer !== 'drawer') return;
      D.task = r.task;
      fillDrawer();
    } catch (e) {
      if (e.status === 403 || D.id !== id) return;
      $('#dBody').innerHTML = `<div class="drawer-warn"><span>${esc(e.status === 404 ? 'This task is gone. It may have been archived or deleted.' : e.message)}</span></div>`;
    }
  }
  function fillDrawer() {
    const x = D.task || {};
    const lists = ['now', 'today', 'week', 'later', 'done'];
    if (x.list === 'dropped') lists.push('dropped');
    $('#dBody').innerHTML = `
      <div id="dWarn"></div>
      <div class="field"><label for="dTitle">Title</label><input id="dTitle" value="${esc(x.title)}"></div>
      <div class="field"><label for="dFirst">First step (something you can do in 5 minutes)</label><input id="dFirst" value="${esc(x.first_step)}"></div>
      <div class="field"><label for="dNext">Next step (where you stopped)</label><input id="dNext" value="${esc(x.next_step)}"></div>
      <div class="field-row">
        <div class="field"><label for="dList">List</label><select id="dList">${lists.map(l => `<option value="${l}"${x.list === l ? ' selected' : ''}>${LISTNAME[l]}</option>`).join('')}</select></div>
        <div class="field"><label for="dPrio">Priority</label><select id="dPrio">${['high', 'med', 'low'].map(p => `<option value="${p}"${(x.priority || 'med') === p ? ' selected' : ''}>${p}</option>`).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="dDue">Due</label><input id="dDue" type="date" value="${esc(x.due || '')}"></div>
        <div class="field"><label for="dEst">Estimate</label><input id="dEst" value="${esc(x.estimate || '')}" placeholder="30m, 1h, 1h30m" aria-describedby="dEstHint"><span class="hint" id="dEstHint">${estOf(x) && speed() !== 1 ? `About ${realMin(estOf(x))}m at your usual speed.` : 'Like 30m or 1h30m.'}</span></div>
      </div>
      <div class="field"><label for="dTags">Tags, comma separated</label><input id="dTags" value="${esc((x.tags || []).join(', '))}"></div>
      <div class="field"><label for="dSource">Source (a link or a word)</label><input id="dSource" value="${esc(x.source || '')}"></div>
      <div class="field"><label for="dBodyText">Notes (markdown)</label><textarea id="dBodyText">${esc(x.body || '')}</textarea></div>
      <div class="field"><span class="label">Stored as</span><div class="stored">${esc(x.path || x.id)}${x.actual ? ` · time spent ${esc(x.actual)}` : ''}${x.slipped ? ` · moved later ${esc(x.slipped)} times` : ''}</div></div>`;
    $$('.drawer-foot button').forEach(b => { b.disabled = false; });
    const done = x.list === 'done';
    $('.drawer [data-act="d-done"]').disabled = done;
    $('.drawer [data-act="d-drop"]').disabled = x.list === 'dropped';
    $('#dTitle').focus();
  }
  function drawerWarn(html) { const w = $('#dWarn'); if (w) { w.innerHTML = html; w.scrollIntoView({ block: 'nearest' }); } }
  async function saveDrawer() {
    if (D.busy || !D.task) return;
    const x = D.task;
    const v = id => $(id).value;
    const tags = v('#dTags').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
    const want = {
      title: v('#dTitle').trim() || x.title, first_step: v('#dFirst').trim(), next_step: v('#dNext').trim(),
      priority: v('#dPrio'), due: v('#dDue'), estimate: v('#dEst').trim(), source: v('#dSource').trim(), body: v('#dBodyText'),
    };
    const body = {};
    Object.keys(want).forEach(k => { if (String(want[k] ?? '') !== String(x[k] ?? '')) body[k] = want[k]; });
    if (tags.join(',') !== (x.tags || []).join(',')) body.tags = tags;
    const list = v('#dList');
    const toDone = list === 'done' && x.list !== 'done';
    if (!toDone && list !== x.list) body.list = list;
    if (!Object.keys(body).length && !toDone) { closeLayer(); toast('No changes', 'The task file is unchanged.'); return; }
    D.busy = true;
    try {
      if (Object.keys(body).length) {
        body.if_sha = x.sha;
        await api(`/api/tasks/${enc(x.id)}`, { method: 'PATCH', body });
      }
      if (toDone) {
        const r = await post(`/api/tasks/${enc(x.id)}/done`);
        closeLayer();
        toast(r && r.points ? `+${r.points} points` : 'Done', `Done: ${want.title}.`);
      } else {
        closeLayer();
        toast('Saved', 'Task file updated.');
      }
    } catch (e) {
      if (e.status === 409) drawerWarn(`<div class="drawer-warn" role="alert"><span>This task changed on disk. Reload it?</span><button class="btn small" type="button" data-act="d-reload">Reload</button></div>`);
      else if (e.status !== 403) drawerWarn(`<div class="drawer-warn" role="alert"><span>${esc(e.message)}</span></div>`);
    } finally {
      D.busy = false;
      refresh();
    }
  }

  // ------------------------------------------------------------ week -------
  const TRAIN = /code freeze|go\s*\/\s*no[\s-]*go|deploy|release/i;
  const WARN_FLAGS = new Set(['heavy_day', 'back_to_back', 'double_booked', 'train_collision', 'no_lunch']);
  const FLAG_NAME = { heavy_day: 'Heavy day.', prep_needed: 'Needs prep.', back_to_back: 'Back to back.', double_booked: 'Double-booked.', train_collision: 'Release train clash.', no_lunch: 'No lunch.', unanswered_invite: 'Invite not answered.' };
  function renderWeek() {
    const el = $('#v-week');
    if (!S.loaded) { patch(el, '<div class="panel"><div class="empty">Loading the week…</div></div>'); return; }
    const sc = sched();
    const days = Array.isArray(sc.days) ? sc.days : [];
    const summary = sc.week_summary || (brief() && brief().week_summary) || '';
    if (!days.length) {
      patch(el, `<div class="panel hello"><h2>No week view yet.</h2><p>${brief() ? 'Today\'s brief has no calendar days in it. Ask the assistant to look at your week.' : 'No brief today. Run /morning-brief in Claude, or ask the assistant here.'}</p>
        <button class="btn" type="button" data-act="chat-ask" data-text="Look at my next five workdays. What needs prep, and which day is heaviest?">Ask about my week</button></div>`);
      return;
    }
    const flags = Array.isArray(sc.flags) ? sc.flags : [];
    const p = profile();
    const work = Math.max(1, ((toMin(p.stop) ?? 900) - (toMin(p.start) ?? 390)) / 60);
    const open = openTasks();
    const t = today();
    patch(el, `${summary ? `<p class="week-sum">${esc(summary)}</p>` : ''}
      <div class="week">${days.map(d => {
        const date = d.date || '';
        const dd = parseLocal(date);
        const head = dd ? `${WD3[dd.getDay()]} ${dd.getDate()}` : esc(d.weekday || date);
        const mh = +d.meeting_hours || 0, fh = +d.focus_hours || 0;
        const evs = (Array.isArray(d.events) ? d.events : []);
        const trains = evs.filter(e => TRAIN.test(e.title || '')).map(e => `<span class="train">${esc(e.title)}${toMin(e.start) != null && e.kind !== 'allday' ? ' ' + esc(e.start) : ''}</span>`);
        const shown = evs.filter(e => e.kind === 'meet' || e.kind === 'allday');
        const dayFlags = flags.filter(f => f.date === date);
        const due = open.filter(x => x.due === date);
        return `<div class="day${date === t ? ' today' : ''}">
          <h3>${head}${date === t ? '<small>today</small>' : ''}</h3>
          <div class="load"><div class="load-bar" role="img" aria-label="${mh} hours of meetings and ${fh} hours of focus"><i class="m" data-s="width:${Math.min(100, mh / work * 100).toFixed(1)}%"></i><i class="f" data-s="width:${Math.min(100, fh / work * 100).toFixed(1)}%"></i></div><small>${mh}h meetings · ${fh}h focus</small></div>
          ${trains.length ? `<div class="trains">${trains.join('')}</div>` : ''}
          ${shown.map(e => `<div class="wk-ev"><span class="mono">${e.kind === 'allday' ? 'all day' : esc(e.start)}</span><span>${esc(e.title)}</span></div>`).join('') || '<div class="wk-none">No meetings.</div>'}
          ${due.map(x => `<button class="wk-due" type="button" data-act="edit" data-id="${esc(x.id)}">${esc(x.title)}</button>`).join('')}
          ${dayFlags.map(f => `<div class="wk-flag${WARN_FLAGS.has(f.kind) ? ' warn' : ''}"><b>${esc(FLAG_NAME[f.kind] || 'Note.')}</b> ${esc(f.text)}</div>`).join('')}
        </div>`;
      }).join('')}</div>`);
  }

  // ------------------------------------------------------------ notes ------
  const N = { list: [], all: [], q: '', path: null, sha: null, ed: null, ta: null, state: 'clean', timer: null, saving: false, again: false, conflict: false, live: true, seq: 0 };
  function noteStem(p) { return String(p || '').split('/').pop().replace(/\.md$/i, ''); }
  function findNote(target) {
    const k = String(target || '').split('|')[0].split('#')[0].trim().toLowerCase().replace(/\.md$/, '');
    if (!k) return null;
    return N.all.find(n => String(n.title || '').toLowerCase() === k) || N.all.find(n => noteStem(n.path).toLowerCase() === k)
      || N.all.find(n => String(n.path || '').toLowerCase().replace(/\.md$/, '') === k) || null;
  }
  function fmtUpdated(v) {
    let d = null;
    if (typeof v === 'number') d = new Date(v > 1e12 ? v : v * 1000);
    else if (typeof v === 'string') d = parseLocal(v);
    if (!d || isNaN(d)) return v ? String(v) : '';
    if (ymd(d) === today()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now().getFullYear()) return `${MON3[d.getMonth()]} ${d.getDate()}`;
    return ymd(d);
  }
  async function loadNotes(q) {
    const seq = ++N.seq;
    try {
      const r = await api(`/api/notes?q=${enc(q || '')}&limit=200`);
      if (seq !== N.seq) return;
      N.list = (r && Array.isArray(r.notes)) ? r.notes : [];
      if (!q) N.all = N.list;
      renderNoteList();
      if (N.ed && N.ed.refresh) N.ed.refresh();
    } catch (e) {
      if (seq === N.seq && e.status !== 403) $('#nList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }
  function renderNoteList() {
    const el = $('#nList');
    el.innerHTML = N.list.map(n => `<button class="n-item" type="button" data-act="note-open" data-path="${esc(n.path)}" aria-current="${n.path === N.path}"><b>${esc(n.title || noteStem(n.path))}</b><small class="mono">${esc(n.path)}${n.updated ? ' · ' + esc(fmtUpdated(n.updated)) : ''}</small></button>`).join('')
      || `<div class="empty">${N.q ? 'No note matches that search.' : 'No notes yet. Start one with New note.'}</div>`;
  }
  function setSave(state, text) {
    N.state = state;
    const el = $('#saveState');
    const labels = { clean: '', dirty: 'Saving…', saving: 'Saving…', saved: 'Saved to disk', conflict: 'Changed on disk — reload or keep yours', error: text || 'Not saved' };
    el.textContent = labels[state] ?? '';
    el.className = 'save-state' + (state === 'dirty' || state === 'saving' ? ' busy' : state === 'conflict' || state === 'error' ? ' bad' : '');
  }
  function editorDoc() { return N.ed ? N.ed.getDoc() : N.ta ? N.ta.value : ''; }
  function ensureEditor() {
    if (N.ed || N.ta) return;
    const host = $('#nHost');
    if (window.NotesEditor && typeof window.NotesEditor.createEditor === 'function') {
      try {
        N.ed = window.NotesEditor.createEditor({
          parent: host, doc: '', readOnly: true, live: N.live,
          onChange: onNoteChange,
          onOpenLink: url => { const u = safeUrl(url); if (u) window.open(u, '_blank', 'noopener,noreferrer'); },
          onOpenWiki: target => { const n = findNote(target); if (n) openNote(n.path); else toast('No such note', `No note named "${target}". Start it with New note.`); },
          resolveWiki: target => findNote(target),
        });
        return;
      } catch (e) { N.ed = null; }
    }
    // Fallback: a plain text box when the editor bundle did not load.
    N.ta = document.createElement('textarea');
    N.ta.setAttribute('aria-label', 'Note text');
    N.ta.addEventListener('input', onNoteChange);
    host.parentNode.insertBefore(N.ta, host);
    host.hidden = true;
  }
  function setDoc(text) {
    if (N.ed) N.ed.setDoc(text, { readOnly: false });
    else if (N.ta) N.ta.value = text;
  }
  function onNoteChange() {
    if (!N.path) return;
    if (N.conflict) return; // the user decides first; their text stays in the editor
    setSave('dirty');
    clearTimeout(N.timer);
    N.timer = setTimeout(flushNote, 800);
  }
  async function flushNote() {
    clearTimeout(N.timer);
    if (!N.path || N.conflict || (N.state !== 'dirty' && N.state !== 'error')) return;
    if (N.saving) { N.again = true; return; }
    N.saving = true;
    const path = N.path, content = editorDoc();
    setSave('saving');
    try {
      const r = await api('/api/notes/file', { method: 'PUT', body: { path, content, base_sha: N.sha } });
      if (N.path !== path) return;
      N.sha = r && r.sha ? r.sha : N.sha;
      if (editorDoc() === content) setSave('saved'); else setSave('dirty');
    } catch (e) {
      if (N.path !== path) return;
      if (e.status === 409) { N.conflict = true; $('#nConflict').hidden = false; setSave('conflict'); }
      else if (e.status !== 403) setSave('error', `Not saved: ${e.message}`);
    } finally {
      N.saving = false;
      if (N.again || (N.state === 'dirty' && N.path === path)) { N.again = false; if (N.state === 'dirty') N.timer = setTimeout(flushNote, 800); }
    }
  }
  async function openNote(path) {
    if (N.path && N.path !== path && (N.state === 'dirty' || N.saving)) await flushNote();
    ensureEditor();
    try {
      const r = await api(`/api/notes/file?path=${enc(path)}`);
      N.path = r.path || path; N.sha = r.sha || null; N.conflict = false;
      $('#nConflict').hidden = true;
      $('#nEmpty').hidden = true;
      if (N.ed) $('#nHost').hidden = false;
      $('#nPath').textContent = N.path;
      setDoc(typeof r.content === 'string' ? r.content : '');
      setSave('clean');
      renderNoteList();
    } catch (e) {
      if (e.status !== 403) toast('Note not opened', e.status === 404 ? 'That note is gone. It may have been moved or deleted.' : e.message, { kind: 'bad' });
    }
  }
  async function reloadNote() {
    if (!N.path) return;
    N.conflict = false; N.state = 'clean';
    await openNote(N.path);
  }
  async function saveCopy() {
    if (!N.path) return;
    const d = now();
    const copy = `${N.path.replace(/\.md$/i, '')}.conflict-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
    const content = editorDoc();
    try {
      const r = await api('/api/notes/file', { method: 'PUT', body: { path: copy, content, base_sha: null } });
      N.path = r.path || copy; N.sha = r.sha || null; N.conflict = false;
      $('#nConflict').hidden = true;
      $('#nPath').textContent = N.path;
      setSave('saved');
      toast('Copy saved', `Your text is in ${N.path}. The original keeps the version on disk.`);
      loadNotes(N.q);
    } catch (e) {
      if (e.status !== 403) toast('Copy not saved', e.status === 409 ? 'A copy with that name already exists. Wait a minute and try again.' : e.message, { kind: 'bad' });
    }
  }
  function cleanNotePath(raw) {
    let p = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p) return { err: 'Type a path, like inbox/idea.md.' };
    if (!/\.md$/i.test(p)) p += '.md';
    const parts = p.split('/');
    if (parts.some(s => !s || s === '..' || s.startsWith('.'))) return { err: 'Use a plain path inside your notes folder, like inbox/idea.md. No "..", no hidden folders.' };
    if (/^(tasks|\.assistant)\//i.test(p)) return { err: 'Notes cannot go in tasks/. Pick another folder.' };
    return { path: p };
  }
  async function createNote() {
    const err = $('#nNewErr');
    const c = cleanNotePath($('#nNewPath').value);
    if (c.err) { err.textContent = c.err; $('#nNewPath').focus(); return; }
    err.textContent = '';
    const title = noteStem(c.path).replace(/[-_]+/g, ' ').replace(/^\w/, ch => ch.toUpperCase());
    try {
      if (N.state === 'dirty' || N.saving) await flushNote();
      const r = await api('/api/notes/file', { method: 'PUT', body: { path: c.path, content: `# ${title}\n\n`, base_sha: null } });
      $('#nNewForm').hidden = true;
      $('#nNewPath').value = '';
      await loadNotes(N.q);
      await openNote((r && r.path) || c.path);
      if (N.ed && N.ed.scrollToLine) N.ed.scrollToLine(1e6);
      else if (N.ed) N.ed.focus();
      else if (N.ta) N.ta.focus();
    } catch (e) {
      if (e.status === 409) err.textContent = 'A note already exists at that path. Pick another name.';
      else if (e.status !== 403) err.textContent = e.message;
    }
  }
  function setLive(on) {
    N.live = on;
    if (N.ed) N.ed.setLive(on);
    $$('#v-notes .seg button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.mode === 'live') === on)));
    try { localStorage.setItem('daydesk.live', on ? '1' : '0'); } catch (e) { /* storage blocked */ }
  }

  // ------------------------------------------------------------ chat -------
  const C = { msgs: [], busy: false };
  const SUGGEST = ['What should I do next?', 'Move my focus block to after lunch', 'Add: call the bank fri 15m !high', 'How did the inbox go this morning?'];
  function mdInline(s) {
    const codes = [];
    let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }
  function mdLite(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let html = '', list = null, para = [];
    const flushP = () => { if (para.length) { html += `<p>${para.map(mdInline).join('<br>')}</p>`; para = []; } };
    const closeL = () => { if (list) { html += `</${list}>`; list = null; } };
    lines.forEach(line => {
      let m;
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flushP(); if (list !== 'ul') { closeL(); html += '<ul>'; list = 'ul'; } html += `<li>${mdInline(m[1])}</li>`; }
      else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { flushP(); if (list !== 'ol') { closeL(); html += '<ol>'; list = 'ol'; } html += `<li>${mdInline(m[1])}</li>`; }
      else if (!line.trim()) { flushP(); closeL(); }
      else if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { flushP(); closeL(); html += `<p><strong>${mdInline(m[1])}</strong></p>`; }
      else { closeL(); para.push(line); }
    });
    flushP(); closeL();
    return html;
  }
  function msgHtml(m) {
    if (m.role === 'user') return esc(m.text);
    if (m.role === 'note') return esc(m.text);
    const tools = (m.tools || []).map(t => `<div class="tool-line${t.run ? ' run' : ''}"><span class="dot" aria-hidden="true"></span>${esc(t.label)}</div>`).join('');
    const typing = m.pending && !m.text ? '<div class="typing" aria-label="The assistant is working"><i></i><i></i><i></i></div>' : '';
    return `${tools}${mdLite(m.text)}${typing}${m.error ? `<p class="err">${esc(m.error)}</p>` : ''}`;
  }
  function msgEl(m) {
    const el = document.createElement('div');
    el.className = `msg ${m.role === 'user' ? 'me' : m.role === 'note' ? 'note' : 'bot'}`;
    el.innerHTML = msgHtml(m);
    m.el = el;
    return el;
  }
  function chatScroll(force) {
    const l = $('#chatLog');
    if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 120) l.scrollTop = l.scrollHeight;
  }
  function renderChatLog() {
    const l = $('#chatLog');
    l.replaceChildren(...C.msgs.map(msgEl));
    chatScroll(true);
  }
  function addMsg(m) { C.msgs.push(m); $('#chatLog').appendChild(msgEl(m)); chatScroll(true); return m; }
  let msgRaf = 0;
  const pendingMsgs = new Set();
  function updateMsg(m) {
    pendingMsgs.add(m);
    if (msgRaf) return;
    msgRaf = requestAnimationFrame(() => {
      msgRaf = 0;
      pendingMsgs.forEach(x => { if (x.el) x.el.innerHTML = msgHtml(x); });
      pendingMsgs.clear();
      chatScroll(false);
    });
  }
  async function loadHistory() {
    try {
      const r = await api('/api/chat/history');
      const msgs = (r && Array.isArray(r.messages)) ? r.messages : [];
      C.msgs = msgs.map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', text: x.text || '' }));
      if (!C.msgs.length) C.msgs.push({ role: 'assistant', text: 'Ask me anything about your day. I can read your tasks, your calendar and this morning\'s brief, move tasks, and add new ones.' });
      renderChatLog();
    } catch (e) {
      if (e.status !== 403) { C.msgs = [{ role: 'note', text: `Chat history did not load: ${e.message}` }]; renderChatLog(); }
    }
  }
  function updateChatBusy() {
    const el = $('#chatBusy');
    const busy = C.busy || !!(S.state && S.state.chat && S.state.chat.busy);
    const txt = busy && !C.busy ? 'The assistant is still answering.' : '';
    if (el.textContent !== txt) el.textContent = txt;
    $('#chatSend').disabled = C.busy;
  }
  async function sendChat(text) {
    text = String(text || '').trim();
    if (!text) return;
    openChat();
    if (C.busy) { addMsg({ role: 'note', text: 'The assistant is still answering.' }); return; }
    C.busy = true; updateChatBusy();
    const me = addMsg({ role: 'user', text });
    const bot = addMsg({ role: 'assistant', text: '', tools: [], pending: true });
    const stopTools = () => bot.tools.forEach(t => { t.run = false; });
    const handle = ev => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool') { stopTools(); bot.tools.push({ label: ev.label || ev.name || 'Working', run: true }); }
      else if (ev.type === 'text') { stopTools(); bot.text += String(ev.delta || ''); }
      else if (ev.type === 'done') { stopTools(); bot.pending = false; if (ev.is_error && !bot.text) bot.error = 'The assistant hit an error. Try again.'; }
      else if (ev.type === 'error') { stopTools(); bot.pending = false; bot.error = String(ev.text || 'The assistant hit an error.'); }
      updateMsg(bot);
    };
    try {
      const res = await api('/api/chat', { method: 'POST', body: { message: text, new: false }, raw: true });
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const line = s => { s = s.trim(); if (!s) return; try { handle(JSON.parse(s)); } catch (e) { /* skip a broken line */ } };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
        }
        buf += dec.decode();
        line(buf);
      } else {
        (await res.text()).split('\n').forEach(s => { s = s.trim(); if (s) { try { handle(JSON.parse(s)); } catch (e) { /* skip */ } } });
      }
      if (bot.pending) { bot.pending = false; stopTools(); if (!bot.text && !bot.error) bot.error = 'The answer stopped early. Try again.'; }
    } catch (e) {
      bot.pending = false; stopTools();
      if (e.status === 409) {
        C.msgs = C.msgs.filter(x => x !== me && x !== bot);
        if (me.el) me.el.remove();
        if (bot.el) bot.el.remove();
        const inp = $('#chatInput');
        if (!inp.value) inp.value = text;
        addMsg({ role: 'note', text: 'The assistant is still answering.' });
      } else if (e.status !== 403) bot.error = e.message;
    } finally {
      updateMsg(bot);
      C.busy = false; updateChatBusy();
      refresh();
    }
  }
  const isWide = () => window.matchMedia('(min-width: 1181px)').matches;
  function openChat() { const c = $('#chat'); if (c.hidden) { c.hidden = false; $('#chatNav').setAttribute('aria-pressed', 'true'); chatScroll(true); } }
  function toggleChat(force) {
    const c = $('#chat');
    const show = typeof force === 'boolean' ? force : c.hidden;
    c.hidden = !show;
    $('#chatNav').setAttribute('aria-pressed', String(show));
    if (show) { chatScroll(true); $('#chatInput').focus(); }
  }
  function prefillChat(text) {
    openChat();
    const inp = $('#chatInput');
    inp.value = text;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  async function resetChat() {
    if (C.busy) { addMsg({ role: 'note', text: 'The assistant is still answering.' }); return; }
    try {
      await post('/api/chat/reset');
      C.msgs = [{ role: 'note', text: 'New conversation. The assistant starts fresh.' }];
      renderChatLog();
      $('#chatInput').focus();
    } catch (e) { if (e.status !== 403) toast('Chat not reset', e.message, { kind: 'bad' }); }
  }

  // ------------------------------------------------------------ focus ------
  async function startFocus(id) {
    const f = focusSession();
    if (f) { drawFocus(); return; }
    try {
      const r = await post('/api/focus/start', { id, minutes: S.focusLen });
      S.state.focus = { running: true, session: r.session };
      S.checkinFor = null;
      drawFocus();
      renderAll();
    } catch (e) {
      if (e.status !== 403) toast(e.status === 422 ? 'Timer already running' : 'Focus not started', e.message, { kind: 'bad' });
    }
    refresh();
  }
  function drawFocus() {
    const f = focusSession();
    if (!f) return;
    if (focusLeftSec(f) <= 0) { drawCheckin(); return; }
    const t = byId(f.task) || {};
    const step = t.next_step ? ['Next step', t.next_step] : t.first_step ? ['First step', t.first_step] : null;
    openLayer('focus', `<div class="focus-ov" role="dialog" aria-modal="true" aria-labelledby="fHead"><div class="focus-in">
      <span class="now-pill">FOCUS · ${+f.minutes || 25} MIN</span>
      <h2 id="fHead">${esc(f.title || t.title || 'Focus')}</h2>
      ${ringHtml('big', f.task)}
      ${step ? `<div class="step"><div class="label">${step[0]}</div><p>${esc(step[1])}</p></div>` : ''}
      <div class="now-actions" data-s="justify-content:center">
        <button class="btn ok" type="button" data-act="f-end" data-result="done">Done</button>
        <button class="btn" type="button" data-act="f-end" data-result="stuck">I'm stuck</button>
        <button class="btn" type="button" data-act="f-end" data-result="stopped">Stop</button>
        <button class="btn ghost" type="button" data-act="close-layer">Leave focus</button>
      </div>
      <p class="focus-hint">Leaving keeps the timer running. It checks in with you when time is up.</p>
    </div></div>`);
    $('.focus-ov [data-act="close-layer"]').focus();
  }
  function drawCheckin() {
    const f = focusSession();
    if (!f) return;
    const t = byId(f.task) || {};
    const pts = POINTS[t.priority] || 2;
    openLayer('checkin', `<div class="scrim"></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="ciHead">
      <div class="label">Check-in</div><h2 id="ciHead">Time is up. How did it go?</h2>
      <p class="lead">${esc(f.title || t.title || 'Your focus session')}</p>
      <div class="now-actions">
        <button class="btn primary" type="button" data-act="f-end" data-result="done">Done, +${pts} and 2 for the session</button>
        <button class="btn" type="button" data-act="f-end" data-result="more">15 more minutes</button>
        <button class="btn" type="button" data-act="f-end" data-result="stuck">I'm stuck</button>
        <button class="btn ghost" type="button" data-act="f-end" data-result="stopped">Stop</button>
      </div></div>`);
    $('.modal [data-act="f-end"]').focus();
  }
  async function endFocus(result) {
    const f = focusSession();
    const title = (f && (f.title || (byId(f.task) || {}).title)) || 'this task';
    const body = { result };
    if (result === 'more') body.more = 15;
    try {
      const r = await post('/api/focus/end', body);
      if (result === 'more') {
        if (r && r.session) S.state.focus = { running: true, session: r.session };
        S.checkinFor = null;
        drawFocus();
        toast('15 more minutes', 'The timer is running again.');
      } else {
        S.state.focus = { running: false, session: null };
        closeLayer();
        const spent = r && typeof r.spent_min === 'number' ? `${r.spent_min} minutes logged.` : '';
        if (result === 'done') {
          const nx = r && r.suggest_now;
          toast(r && r.points ? `+${r.points} points` : 'Done', `Done: ${title}.${nx && nx.title ? ` Next up: ${nx.title}.` : ''}`,
            nx && nx.id ? { actions: [{ label: 'Make it Now', fn: () => moveTask(nx.id, 'now') }] } : {});
        } else if (result === 'stuck') {
          toast('Stuck is normal', `${spent} Asking the assistant for a smaller step.`.trim());
          sendChat(`I'm stuck on ${title}`);
        } else toast('Focus stopped', spent || 'The timer is off.');
      }
    } catch (e) {
      if (e.status === 404) { S.state.focus = { running: false, session: null }; closeLayer(); toast('No timer', 'No focus session is running.'); }
      else if (e.status !== 403) toast('Not saved', e.message, { kind: 'bad' });
    }
    refresh();
  }
  function checkFocus() {
    const f = focusSession();
    if (!f) { if (S.layer === 'focus' || S.layer === 'checkin') closeLayer(); return; }
    if (focusLeftSec(f) > 0) return;
    const key = `${f.task}|${f.started_at}|${f.ends_at}`;
    if (S.checkinFor === key) return;
    S.checkinFor = key;
    if (!S.layer || S.layer === 'focus') drawCheckin();
    else toast('Time is up', `Your focus session on ${f.title || 'your task'} ended.`, { sticky: true, kind: 'nudge', actions: [{ label: 'Check in', fn: () => { closeLayer(); drawCheckin(); } }] });
    renderAll();
  }

  // ------------------------------------------------------------ shutdown ---
  let SD = null;
  function nextWorkdays() {
    const t = parseLocal(today());
    const opts = [];
    for (let i = 1; opts.length < 3 && i < 15; i++) {
      const d = addDays(t, i);
      if (d.getDay() >= 1 && d.getDay() <= 5) opts.push(d);
    }
    const dow = t.getDay();
    const nextMon = addDays(t, ((8 - dow) % 7) || 7);
    const weekEnd = addDays(t, 7 - (dow || 7));
    const out = opts.map(d => ({ to: ymd(d), label: `Move to ${d <= weekEnd ? WD3[d.getDay()] : `${WD3[d.getDay()]} ${d.getDate()}`}` }));
    if (!out.some(o => o.to === ymd(nextMon))) out.push({ to: ymd(nextMon), label: 'Move to next week' });
    return out;
  }
  function openShutdown() {
    SD = { step: 0, checks: {}, done: [], triage: {}, dump: '', dumpCount: 0, first: '', firstTask: '', firstTouched: false, tonight: 'no', tonightTask: '', tonightEnd: '20:30', busy: false, err: '', result: null };
    drawShutdown();
  }
  function sdKeep() {
    if (!SD) return;
    const g = id => $(id);
    if (g('#sdDump')) SD.dump = g('#sdDump').value;
    if (g('#sdFirst')) SD.first = g('#sdFirst').value;
    if (g('#sdFirstTask')) SD.firstTask = g('#sdFirstTask').value;
    if (g('#sdTask')) SD.tonightTask = g('#sdTask').value;
    if (g('#sdEnd')) SD.tonightEnd = g('#sdEnd').value;
  }
  function drawShutdown() {
    if (!SD) return;
    if (SD.result) return drawShutdownDone();
    const n = nowTask();
    const done = doneToday();
    const planned = [...(n ? [n] : []), ...inList('today')];
    const plannedIds = new Set(planned.map(t => t.id));
    const rows0 = [...planned, ...done.filter(t => !plannedIds.has(t.id))];
    const open = planned.filter(t => t.priority === 'high' && !SD.checks[t.id]);
    const days = nextWorkdays();
    // Pick from Now, Today and This week; Later only when nothing else is open.
    const near = openTasks().filter(t => t.list === 'now' || t.list === 'today' || t.list === 'week');
    const opens = near.length ? near : openTasks();
    if (!opens.some(t => t.id === SD.firstTask)) {
      const top = opens.find(t => !SD.checks[t.id]) || opens[0];
      SD.firstTask = top ? top.id : '';
      if (!SD.firstTouched) { SD.first = top ? (top.next_step || top.first_step || '') : ''; }
    }
    if (!opens.some(t => t.id === SD.tonightTask)) SD.tonightTask = opens.length ? (open[0] || opens[0]).id : '';
    const taskOpts = sel => opens.map(t => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.title)}</option>`).join('');
    const steps = [
      { h: 'What got done today?', lead: 'Finished tasks are already ticked. Tick anything else you finished.',
        body: rows0.map(t => {
          const isDone = t.list === 'done';
          const on = isDone || SD.checks[t.id];
          return `<div class="sd-row"><button class="check${on ? ' on' : ''}" type="button" data-act="sd-check" data-id="${esc(t.id)}" ${isDone ? 'disabled' : ''} aria-pressed="${!!on}" aria-label="Done: ${esc(t.title)}"></button><div>${esc(t.title)}${isDone ? `<small>Finished ${esc(timeOf(t.done_at))}</small>` : ''}</div>${isDone ? `<span class="proof">+${POINTS[t.priority] || 2}</span>` : '<span></span>'}</div>`;
        }).join('') || '<div class="empty">Nothing was planned for today. That is fine.</div>' },
      { h: 'High priority, still open', lead: 'Each one needs a choice: finish it before you stop, or give it a new day.',
        body: open.length ? open.map(t => {
          const est = estOf(t);
          const c = SD.triage[t.id] || '';
          return `<div class="sd-row stack"><div>${esc(t.title)}<small>${t.due === today() ? 'Due today. ' : t.due && t.due < today() ? 'Overdue. ' : ''}${est ? `About ${realMin(est)}m at your usual speed.` : 'No estimate.'}</small></div>
            <div class="choice" role="group" aria-label="Choice for ${esc(t.title)}"><button type="button" data-act="sd-tr" data-id="${esc(t.id)}" data-to="finish" aria-pressed="${c === 'finish'}">Finish today</button>${days.map(d => `<button type="button" data-act="sd-tr" data-id="${esc(t.id)}" data-to="${d.to}" aria-pressed="${c === d.to}">${esc(d.label)}</button>`).join('')}</div></div>`;
        }).join('') : '<div class="empty">Nothing high priority is open. Nice.</div>' },
      { h: 'Empty your head', lead: 'Type anything still rattling around. Each line becomes a task in This week.',
        body: `<label class="sr-only" for="sdDump">Brain dump, one thing per line</label><textarea id="sdDump" placeholder="One thing per line. Words like fri, 15m and !high still work.">${esc(SD.dump)}</textarea>${SD.dumpCount ? `<p class="lead" data-s="margin:8px 0 0">${plural(SD.dumpCount, 'task')} added so far.</p>` : ''}` },
      { h: "Tomorrow's first step", lead: 'One concrete action. The morning brief opens with it.',
        body: `${opens.length ? `<div class="field"><label for="sdFirstTask">For which task</label><select id="sdFirstTask">${taskOpts(SD.firstTask)}</select></div>` : ''}
          <div class="field"><label for="sdFirst">First step</label><input type="text" id="sdFirst" value="${esc(SD.first)}" placeholder="Open the release notes draft and finish the customer section."></div>` },
      { h: 'Working tonight?', lead: 'Night work is fine when you choose it. Pick one task and an end time, and you get a stop toast.',
        body: `<div class="choice" role="group" aria-label="Working tonight" data-s="margin-bottom:12px"><button type="button" data-act="sd-tn" data-to="no" aria-pressed="${SD.tonight === 'no'}">No, the day is done</button><button type="button" data-act="sd-tn" data-to="yes" aria-pressed="${SD.tonight === 'yes'}">Yes, one thing</button></div>
          ${SD.tonight === 'yes' ? (opens.length ? `<div class="field-row"><div class="field"><label for="sdTask">Task</label><select id="sdTask">${taskOpts(SD.tonightTask)}</select></div><div class="field"><label for="sdEnd">Stop at</label><input id="sdEnd" type="time" value="${esc(SD.tonightEnd)}"></div></div>` : '<div class="empty">No open tasks to pick from.</div>') : ''}` },
    ];
    const s = steps[SD.step];
    const last = SD.step === steps.length - 1;
    const html = `<div class="scrim" data-act="sd-cancel"></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="sdHead">
      <div class="label">Shutdown · step ${SD.step + 1} of ${steps.length}</div>
      <div class="steps" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= SD.step ? 'on' : ''}"></i>`).join('')}</div>
      <h2 id="sdHead">${s.h}</h2><p class="lead">${s.lead}</p>${s.body}
      ${SD.err ? `<div class="modal-err" role="alert">${esc(SD.err)}</div>` : ''}
      <div class="modal-foot"><button class="btn ghost" type="button" data-act="sd-back">${SD.step ? 'Back' : 'Cancel'}</button><button class="btn primary" type="button" data-act="sd-next" ${SD.busy ? 'disabled' : ''}>${SD.busy ? '<span class="spin" aria-hidden="true"></span> Saving…' : last ? 'Close the day' : 'Next'}</button></div></div>`;
    const keepFocus = document.activeElement && document.activeElement.closest('#layer') ? document.activeElement.dataset : null;
    const fresh = S.layer !== 'shutdown';
    openLayer('shutdown', html);
    if (keepFocus && keepFocus.act) {
      const t = $$('#layer [data-act]').find(x => x.dataset.act === keepFocus.act && (x.dataset.id || '') === (keepFocus.id || '') && (x.dataset.to || '') === (keepFocus.to || ''));
      if (t) { t.focus(); return; }
    }
    if (fresh || !keepFocus) { const f = $('#layer textarea, #layer input, #layer .modal [data-act="sd-next"]'); if (f) f.focus(); }
  }
  async function shutdownNext() {
    if (!SD || SD.busy) return;
    sdKeep();
    SD.err = '';
    const step = SD.step;
    try {
      if (step === 0) {
        const ids = Object.keys(SD.checks).filter(k => SD.checks[k] && byId(k) && byId(k).list !== 'done');
        if (ids.length) {
          SD.busy = true; drawShutdown();
          for (const id of ids) { await post(`/api/tasks/${enc(id)}/done`); SD.done.push(id); delete SD.checks[id]; }
          await refresh();
        }
      } else if (step === 3) {
        if (!SD.first.trim()) { SD.err = 'Write one first step for tomorrow. Small is fine.'; drawShutdown(); return; }
      } else if (step === 2) {
        const lines = SD.dump.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length) {
          SD.busy = true; drawShutdown();
          const left = [];
          for (let i = 0; i < lines.length; i++) {
            try { await post('/api/tasks', { parse: lines[i], list: 'week' }); SD.dumpCount++; }
            catch (e) { if (e.status === 403) throw e; left.push(lines[i]); SD.err = `Some lines were not added: ${e.message}`; }
          }
          SD.dump = left.join('\n');
          await refresh();
          if (left.length) { SD.busy = false; drawShutdown(); return; }
        }
      } else if (step === 4) {
        SD.busy = true; drawShutdown();
        const moved = Object.entries(SD.triage).filter(([, to]) => to !== 'finish').map(([id, to]) => ({ id, to }));
        const finish = Object.entries(SD.triage).filter(([, to]) => to === 'finish').map(([id]) => id);
        const doneIds = Array.from(new Set([...SD.done, ...doneToday().map(t => t.id)]));
        const payload = {
          date: today(), done: doneIds, moved, finish_today: finish, brain_dump: SD.dumpCount,
          first_step: SD.first.trim(), first_task: SD.firstTask || null,
          tonight: SD.tonight === 'yes' && SD.tonightTask ? { task: SD.tonightTask, until: SD.tonightEnd || '20:30' } : null,
        };
        SD.result = await post('/api/shutdown', payload) || {};
        SD.result.payload = payload;
        SD.busy = false;
        const skipped = Array.isArray(SD.result.skipped) ? SD.result.skipped : [];
        if (skipped.length) toast('Day closed, with skips', `${skipped.length} item${skipped.length > 1 ? 's' : ''} changed on disk and ${skipped.length > 1 ? 'were' : 'was'} left as is: ${skipped.map(x => x.why).join(' ')}`, { kind: 'bad', ms: 12000 });
        await refresh();
        drawShutdown();
        return;
      }
    } catch (e) {
      SD.busy = false;
      if (e.status === 403) return;
      SD.err = e.message;
      drawShutdown();
      return;
    }
    SD.busy = false;
    SD.step++;
    drawShutdown();
  }
  function drawShutdownDone() {
    const r = SD.result || {}, st = r.stats || stats(), p = r.payload || {};
    const doneN = typeof st.done_today === 'number' ? st.done_today : doneToday().length;
    const pts = typeof st.points_today === 'number' ? st.points_today : (+r.points || 0);
    const tn = p.tonight ? byId(p.tonight.task) : null;
    openLayer('shutdown', `<div class="scrim" data-act="close-layer"></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="sdDoneHead">
      <div class="label">Shutdown complete</div><h2 id="sdDoneHead">Day closed.</h2>
      <p class="lead">${plural(doneN, 'task')} done, ${pts} points today. Streak is now ${plural(+st.streak || 0, 'day')}.${r.points ? ` The shutdown itself earned ${+r.points}.` : ''}</p>
      <p class="lead">${p.tonight ? `Tonight: ${esc(tn ? tn.title : 'one task')}, stop at ${esc(p.tonight.until)}.` : 'Nothing planned for tonight.'}</p>
      ${p.first_step ? `<p class="lead">Tomorrow starts with: ${esc(p.first_step)}</p>` : ''}
      ${p.moved && p.moved.length ? `<p class="lead">${plural(p.moved.length, 'task')} moved to a new day.</p>` : ''}
      <div class="modal-foot"><span></span><button class="btn primary" type="button" data-act="close-layer">Close</button></div></div>`);
    $('#layer .modal [data-act="close-layer"]').focus();
  }

  // ------------------------------------------------------------ toasts -----
  function toast(title, text, { actions = [], kind = '', sticky = false, id = null, ms = 6500 } = {}) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast${kind ? ' ' + kind : ''}`;
    if (kind === 'bad') el.setAttribute('role', 'alert');
    const body = document.createElement('div');
    const sm = document.createElement('small');
    sm.textContent = title;
    body.append(sm, document.createTextNode(text));
    const acts = document.createElement('div');
    acts.className = 'toast-acts';
    const remove = () => { el.remove(); if (id) S.nudgeToasts.delete(id); };
    (actions.length ? actions : [{ label: 'OK' }]).forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${i ? ' ghost' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => { remove(); if (a.fn) a.fn(); });
      acts.appendChild(b);
    });
    el.append(body, acts);
    box.appendChild(el);
    const all = $$('.toast', box);
    if (all.length > 4) { const old = all.find(x => !x.dataset.sticky); if (old) old.remove(); }
    if (sticky) el.dataset.sticky = '1';
    else setTimeout(remove, ms);
    if (id) S.nudgeToasts.set(id, el);
    return el;
  }
  function handleNudges() {
    // Reminders that failed to load would otherwise fail silently, and the
    // user counts on them for meetings.
    if (S.state && S.state.nudges_error && !S.nudgesErrorShown) {
      S.nudgesErrorShown = true;
      toast('Reminders are off', `${S.state.nudges_error} Restart with /dashboard restart.`, { kind: 'bad', sticky: true });
    }
    const list = (S.state && Array.isArray(S.state.nudges)) ? S.state.nudges : [];
    const live = new Set(list.map(n => n.id));
    list.forEach(n => {
      if (!n || !n.id || S.seenNudges.has(n.id)) return;
      S.seenNudges.add(n.id);
      toast(n.title || 'Reminder', `${n.text || ''}${n.at ? '' : ''}`, {
        kind: 'nudge', sticky: true, id: n.id,
        actions: [
          { label: 'Dismiss', fn: () => post(`/api/nudges/${encSeg(n.id)}/dismiss`).catch(e => { if (e.status !== 403) toast('Not dismissed', e.message, { kind: 'bad' }); }) },
          { label: 'Later' },
        ],
      });
    });
    // A nudge dismissed elsewhere (a Windows toast, another tab) leaves the page too.
    S.nudgeToasts.forEach((el, id) => { if (!live.has(id)) { el.remove(); S.nudgeToasts.delete(id); } });
  }

  // ------------------------------------------------------------ routing ----
  function go(v) {
    if (S.view === 'notes' && v !== 'notes' && (N.state === 'dirty' || N.saving)) flushNote();
    S.view = v;
    ['today', 'tasks', 'week', 'notes'].forEach(k => { $(`#v-${k}`).hidden = k !== v; });
    $('#main').scrollTop = 0;
    if (v === 'today') S.tlScrolled = false;
    if (v === 'notes') { ensureEditor(); loadNotes(N.q); }
    renderAll();
  }

  // ------------------------------------------------------------ events -----
  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const a = el.dataset.act, id = el.dataset.id;
    switch (a) {
      case 'shutdown': openShutdown(); break;
      case 'chat-toggle': toggleChat(); break;
      case 'chat-ask': sendChat(el.dataset.text); break;
      case 'go-add': go('tasks'); $('#qa').focus(); break;
      case 'done': {
        if (el.classList.contains('check')) el.classList.add('on');
        completeTask(id); break;
      }
      case 'edit': openDrawer(id); break;
      case 'make-now': moveTask(id, 'now'); break;
      case 'breakdown': sendChat(`Break ${id} into a smaller first step`); break;
      case 'park-open': { const t = byId(id); S.parkFor = id; S.parkText = (t && (t.next_step || t.first_step)) || ''; renderToday(); const i = $('#parkNext'); if (i) { i.focus(); i.select(); } break; }
      case 'park-cancel': S.parkFor = null; renderToday(); break;
      case 'resume': act(() => post(`/api/tasks/${enc(id)}/resume`), r => { const d = r && r.demoted ? byId(r.demoted) : null; toast('Back on it', `${(r && r.task && r.task.title) || 'Task'} is your Now task again.${d ? ` ${d.title} moved to Today.` : ''}`); }); break;
      case 'len': S.focusLen = +el.dataset.len || 25; renderToday(); break;
      case 'focus-open': startFocus(id); break;
      case 'checkin': drawCheckin(); break;
      case 'f-end': endFocus(el.dataset.result); break;
      case 'sched-refresh': refreshSchedule(); break;
      case 'answer': { const p = S.pendingList[+el.dataset.i]; if (p) prefillChat(`About "${p.summary}": `); break; }
      case 'fu-task': fuTask(+el.dataset.i); break;
      case 'unfold': S.showLater = true; renderBoard(); break;
      case 'fold': S.showLater = false; renderBoard(); break;
      case 'close-layer': closeLayer(); break;
      case 'd-save': saveDrawer(); break;
      case 'd-reload': if (D.id) loadDrawer(D.id); break;
      case 'd-done': if (D.task) { const tid = D.task.id; closeLayer(); completeTask(tid); } break;
      case 'd-drop': if (D.task) dropTask(D.task); break;
      case 'note-open': openNote(el.dataset.path); break;
      case 'sd-check': SD.checks[id] = !SD.checks[id]; sdKeep(); drawShutdown(); break;
      case 'sd-tr': SD.triage[id] = el.dataset.to; sdKeep(); drawShutdown(); break;
      case 'sd-tn': sdKeep(); SD.tonight = el.dataset.to; drawShutdown(); break;
      case 'sd-back': sdKeep(); SD.err = ''; if (SD.step) { SD.step--; drawShutdown(); } else closeLayer(); break;
      case 'sd-next': shutdownNext(); break;
      case 'sd-cancel': if (!SD || !SD.busy) closeLayer(); break;
      default: break;
    }
  }
  function dropTask(t) {
    const old = t.list, id = t.id, title = t.title;
    closeLayer();
    act(() => post(`/api/tasks/${enc(id)}/drop`), () => toast('Dropped', `"${title}" is dropped. The file stays on disk.`,
      old && old !== 'dropped' && old !== 'done' ? { actions: [{ label: 'Undo', fn: () => moveTask(id, old) }, { label: 'OK' }] } : {}));
  }
  async function fuTask(i) {
    const f = S.fuList[i];
    if (!f) return;
    const body = { title: f.text, tags: ['follow-up'] };
    if (f.due && /^\d{4}-\d{2}-\d{2}$/.test(f.due)) body.due = f.due;
    const u = safeUrl(f.url);
    if (u) body.source = u;
    S.madeFu.add(f.text);
    const r = await act(() => post('/api/tasks', body), res => {
      const t = (res && res.task) || {};
      toast('Task added', `"${f.text}" is in ${LISTNAME[t.list] || 'your list'}.${res && res.note ? ' ' + res.note : ''}`);
    });
    if (!r) S.madeFu.delete(f.text);
  }
  async function refreshSchedule() {
    S.schedPending = true;
    renderAll();
    try {
      await post('/api/schedule/refresh');
      S.schedPollUntil = Date.now() + 180000;
      pollSchedule();
    } catch (e) {
      S.schedPending = false;
      renderAll();
      if (e.status !== 403) toast('Refresh failed', e.message, { kind: 'bad' });
    }
  }
  function pollSchedule() {
    setTimeout(async () => {
      await refresh();
      const busy = sched().refreshing;
      if (busy) S.schedPending = false;
      if ((busy || S.schedPending) && Date.now() < S.schedPollUntil) pollSchedule();
      else if (S.schedPending) { S.schedPending = false; renderAll(); }
    }, 3000);
  }

  function trapTab(e) {
    if (e.key !== 'Tab' || !S.layer) return;
    const box = $('#layer');
    const f = $$('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]', box).filter(x => x.offsetParent !== null || x === document.activeElement);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function onKey(e) {
    if (S.gate) return;
    if (e.key === 'Escape') {
      if (S.layer) {
        if (S.layer === 'shutdown' && SD && SD.busy) return;
        e.preventDefault(); closeLayer(); return;
      }
      if (!$('#nNewForm').hidden && $('#nNewForm').contains(document.activeElement)) { $('#nNewForm').hidden = true; $('#nNewBtn').focus(); return; }
      if (!isWide() && !$('#chat').hidden && $('#chat').contains(document.activeElement)) { toggleChat(false); $('#chatNav').focus(); }
      return;
    }
    if (S.layer) { trapTab(e); return; }
    // Enter or Space opens a task card (cards are draggable divs).
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); return; }
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); toggleChat(true); }
    else if (e.key === 'n') { e.preventDefault(); go('tasks'); $('#qa').focus(); }
  }

  // ------------------------------------------------------------ init -------
  function init() {
    if (!TOKEN) { showGate(); return; }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('submit', e => {
      const f = e.target;
      if (f.id === 'qaForm') { e.preventDefault(); quickAdd(); }
      else if (f.dataset.form === 'park') {
        e.preventDefault();
        const id = f.dataset.id, next = ($('#parkNext').value || '').trim();
        S.parkFor = null;
        document.activeElement.blur();
        act(() => post(`/api/tasks/${enc(id)}/park`, next ? { next } : {}), r => toast('Parked', `Saved your place in "${(r && r.task && r.task.title) || 'the task'}".`));
      }
    });
    document.addEventListener('input', e => {
      if (e.target.id === 'parkNext') S.parkText = e.target.value;
      else if (e.target.id === 'sdFirst' && SD) { SD.firstTouched = true; SD.first = e.target.value; }
    });
    document.addEventListener('change', e => {
      if (e.target.id !== 'sdFirstTask' || !SD) return;
      SD.firstTask = e.target.value;
      if (!SD.firstTouched) {
        const t = byId(SD.firstTask);
        SD.first = (t && (t.next_step || t.first_step)) || '';
        const i = $('#sdFirst');
        if (i) i.value = SD.first;
      }
    });
    document.addEventListener('focusout', () => {
      setTimeout(() => { if (S.pendingRender && !isTyping(document.activeElement)) { S.pendingRender = false; renderAll(); } }, 0);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

    $$('.nav-btn[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
    $('#chatNav').addEventListener('click', () => toggleChat());
    $('#chatClose').addEventListener('click', () => { toggleChat(false); });
    $('#chatNew').addEventListener('click', resetChat);
    $('#composer').addEventListener('submit', e => { e.preventDefault(); const i = $('#chatInput'); const v = i.value; if (!v.trim()) return; if (C.busy) { addMsg({ role: 'note', text: 'The assistant is still answering.' }); return; } i.value = ''; sendChat(v); });
    $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
    $('#chatSugg').innerHTML = SUGGEST.map((s, i) => `<button type="button" data-sugg="${i}">${esc(s)}</button>`).join('');
    $('#chatSugg').addEventListener('click', e => { const b = e.target.closest('[data-sugg]'); if (b) sendChat(SUGGEST[+b.dataset.sugg]); });
    if (!isWide()) { $('#chat').hidden = true; $('#chatNav').setAttribute('aria-pressed', 'false'); }
    else $('#chatNav').setAttribute('aria-pressed', 'true');
    // Dock the chat on wide screens; on narrow ones it is an overlay, closed by default.
    const wide = window.matchMedia('(min-width: 1181px)');
    const onWide = () => { const c = $('#chat'); if (wide.matches === c.hidden) { c.hidden = !wide.matches; $('#chatNav').setAttribute('aria-pressed', String(wide.matches)); } };
    if (wide.addEventListener) wide.addEventListener('change', onWide);

    $('#qa').addEventListener('input', e => previewParse(e.target.value));
    wireBoardDrag();

    const search = debounce(q => { N.q = q.trim(); loadNotes(N.q); }, 250);
    $('#nSearch').addEventListener('input', e => search(e.target.value));
    $('#nNewBtn').addEventListener('click', () => { const f = $('#nNewForm'); f.hidden = !f.hidden; $('#nNewErr').textContent = ''; if (!f.hidden) $('#nNewPath').focus(); });
    $('#nNewCancel').addEventListener('click', () => { $('#nNewForm').hidden = true; $('#nNewBtn').focus(); });
    $('#nNewForm').addEventListener('submit', e => { e.preventDefault(); createNote(); });
    $('#nReload').addEventListener('click', reloadNote);
    $('#nCopy').addEventListener('click', saveCopy);
    $$('#v-notes .seg button').forEach(b => b.addEventListener('click', () => setLive(b.dataset.mode === 'live')));
    try { if (localStorage.getItem('daydesk.live') === '0') N.live = false; } catch (e) { /* storage blocked */ }
    setLive(N.live);
    window.addEventListener('beforeunload', e => { if (N.state === 'dirty' || N.saving || N.conflict) { flushNote(); e.preventDefault(); e.returnValue = ''; } });

    renderAll();
    loadHistory();
    refresh();
    setInterval(refresh, 20000);
    setInterval(() => { if (S.loaded) renderAll(); }, 15000);
    setInterval(() => { if (focusSession()) { updateRings(); checkFocus(); } }, 1000);
  }
  init();
})();
