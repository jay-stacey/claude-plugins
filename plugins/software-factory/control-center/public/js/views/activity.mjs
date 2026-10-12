// Activity: event feed (newest first), filters, paging via /api/events, polite live announcements.
import { html, useEffect, useMemo, useRef, useState } from '../html.mjs';
import { Avatar, Icon, roleInfo } from '../components.mjs';
import { getEvents } from '../api.mjs';
import { setParams } from '../router.mjs';
import { EVENT_CATEGORIES, eventMatches, eventSentence } from '../lib/model.mjs';
import { fmtClock, fmtDateTime } from '../lib/format.mjs';

const ANNOUNCE_GAP_MS = 5000;

function actorRole(e) {
  const a = e.actor || {};
  if (a.role) return a.role;
  if (a.kind === 'human') return 'user';
  const d = e.data || {};
  if (d.from && d.from.role) return d.from.role;
  return 'cto';
}

const cmp = (a, b) => String(b.ts || '').localeCompare(String(a.ts || '')) || String(b.id || '').localeCompare(String(a.id || ''));

export function ActivityView({ snap, params, nowMs }) {
  const cat = EVENT_CATEGORIES.some((c) => c.id === params.type) ? params.type : 'all';
  const filter = { cat, goal: params.goal, role: params.role, task: params.task };
  const fkey = `${cat}|${params.goal || ''}|${params.role || ''}|${params.task || ''}`;
  const [older, setOlder] = useState({ key: null, events: [], hasMore: true, loading: false, error: null });
  const rn = (id) => roleInfo(snap, id).short;

  const apiType = () => {
    const c = EVENT_CATEGORIES.find((x) => x.id === cat);
    return c && c.prefixes && c.prefixes.length === 1 ? c.prefixes[0] : undefined;
  };

  const load = async (before) => {
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const r = await getEvents({ before, limit: 100, role: params.role, goal: params.goal, task: params.task, type: apiType() });
      setOlder((o) => {
        const base = before && o.key === fkey ? o.events : [];
        return { key: fkey, events: [...base, ...(r.events || [])], hasMore: !!r.has_more, loading: false, error: null };
      });
    } catch (e) {
      setOlder((o) => ({ ...o, key: fkey, loading: false, error: e.message || 'Could not load events' }));
    }
  };

  useEffect(() => { load(undefined); }, [fkey]);

  const tail = snap.events_tail || [];
  const list = useMemo(() => {
    const seen = new Set();
    const out = [];
    const src = [...tail.filter((e) => eventMatches(e, filter)), ...(older.key === fkey ? older.events.filter((e) => eventMatches(e, filter)) : [])];
    for (const e of src) {
      const k = e.id || `${e.ts}|${e.type}|${e.msg}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out.sort(cmp);
  }, [tail, older, fkey]);

  // Live region: at most one announcement per 5 s, always the newest item.
  const [announce, setAnnounce] = useState('');
  const ann = useRef({ last: 0, newestId: null, timer: null });
  const newest = list[0];
  useEffect(() => {
    const a = ann.current;
    if (!newest) return;
    if (a.newestId === null) { a.newestId = newest.id; return; } // do not announce the initial page
    if (newest.id === a.newestId) return;
    a.newestId = newest.id;
    const say = () => { a.last = Date.now(); a.timer = null; setAnnounce(eventSentence(newest, rn)); };
    const wait = a.last + ANNOUNCE_GAP_MS - Date.now();
    clearTimeout(a.timer);
    if (wait <= 0) say(); else a.timer = setTimeout(say, wait);
  }, [newest && newest.id]);
  useEffect(() => () => clearTimeout(ann.current.timer), []);

  const oldestId = older.key === fkey && older.events.length ? older.events[older.events.length - 1].id : (list.length ? list[list.length - 1].id : undefined);

  return html`<div class="activity">
    <div class="row wrap activity-filters">
      <label class="field-inline">Type
        <select value=${cat} onChange=${(e) => setParams({ type: e.currentTarget.value === 'all' ? '' : e.currentTarget.value })}>
          ${EVENT_CATEGORIES.map((c) => html`<option value=${c.id}>${c.label}</option>`)}
        </select></label>
      ${params.task && html`<span class="tag tone-info">Task ${params.task}
        <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label=${`Clear task filter ${params.task}`} onClick=${() => setParams({ task: '' })}><${Icon} name="close" /></button></span>`}
      <span class="small muted">Goal and role filters come from the bar above. ${list.length} events shown.</span>
    </div>
    <div class="sr-only" aria-live="polite" aria-atomic="true">${announce}</div>
    ${list.length ? html`<ol class="feed">
      ${list.map((e) => html`<li key=${e.id || `${e.ts}${e.type}`} class="feed-item">
        <time class="feed-time mono small muted" datetime=${e.ts} title=${fmtDateTime(e.ts)}>${fmtClock(e.ts, nowMs)}</time>
        <${Avatar} snap=${snap} role=${actorRole(e)} size="sm" />
        <span class="feed-text">${eventSentence(e, rn)}</span>
        <span class="feed-type small muted mono">${e.type}</span>
      </li>`)}
    </ol>` : html`<p class="muted">${older.loading ? 'Loading events...' : 'No events match these filters.'}</p>`}
    ${older.error && html`<p class="field-error"><${Icon} name="warn" />${older.error}</p>`}
    <div class="row">
      ${older.hasMore && html`<button type="button" class="btn" disabled=${older.loading} onClick=${() => load(oldestId)}>
        ${older.loading ? 'Loading...' : 'Load older'}</button>`}
      ${!older.hasMore && list.length > 0 && html`<span class="small muted">Start of history.</span>`}
    </div>
  </div>`;
}
