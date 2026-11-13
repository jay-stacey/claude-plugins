// Control center: the Chief core in the middle, in-view sessions around it, sub-sessions on outer
// rings linked to the session that started them. Moving dots follow `activity` events.
import { $, add, age, clear, cut, glyph, h, reducedMotion, s, stateClass, stateLabel, where } from './util.mjs';

// The drawing uses the panel's real pixel size, so text stays the same size at any width.
let W = 1000;
let H = 700;
let CX = 500;
let CY = 350;
let K = 1;                      // core and node size factor from the panel size
let CORE_EDGE = 92;             // core links start at this ring so they do not cross the core text
const MAX_PACKETS = 40;
const LIVE_MS = 3200;           // a link stays bright this long after traffic

let svg;
let wrap;
let tip;
let layers = {};
let pos = new Map();            // id -> { x, y, a, depth, r }
let links = new Map();          // child id -> { path, kind: 'core' | 'child' }
let nodes = new Map();          // id -> <g>
let byId = new Map();
let signature = '';
let onOpen = () => {};
let onHover = () => {};
const packets = [];
let raf = 0;
let tempSeq = 0;
let lastList = [];
let lastCore = null;

export function initGraph({ open, hover }) {
  svg = $('graph');
  wrap = $('graphWrap');
  tip = $('tip');
  onOpen = open;
  onHover = hover;
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.node');
    if (g) onOpen(g.dataset.id);
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.node');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(g.dataset.id); }
  });
  svg.addEventListener('mouseover', (e) => {
    const g = e.target.closest('.node');
    if (g) showTip(g.dataset.id); else hideTip();
  });
  svg.addEventListener('mouseleave', hideTip);
  svg.addEventListener('focusin', (e) => {
    const g = e.target.closest('.node');
    if (g) showTip(g.dataset.id);
  });
  svg.addEventListener('focusout', hideTip);
  let pending = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const w = wrap.clientWidth;
      const hh = wrap.clientHeight;
      if (!w || !hh || (Math.abs(w - W) < 8 && Math.abs(hh - H) < 8)) return;
      signature = '';
      if (lastCore) renderGraph(lastList, lastCore);
    });
  }).observe(wrap);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { signature = ''; if (lastCore) renderGraph(lastList, lastCore); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      for (const p of packets.splice(0)) p.dot.remove();
    }
  });
}

// ------------------------------------------------------------------ layout

function treeOf(list) {
  byId = new Map(list.map((x) => [x.id, x]));
  const kids = new Map();
  const roots = [];
  for (const x of list) {
    const p = x.parentId && x.parentId !== x.id && byId.has(x.parentId) ? x.parentId : null;
    if (p) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(x);
    } else roots.push(x);
  }
  // A parent loop would leave nodes with no root: treat the first of each loop as a root.
  const seen = new Set();
  const walk = (x) => { if (seen.has(x.id)) return; seen.add(x.id); (kids.get(x.id) || []).forEach(walk); };
  roots.forEach(walk);
  for (const x of list) {
    if (!seen.has(x.id)) {
      roots.push(x);
      for (const arr of kids.values()) {
        const i = arr.indexOf(x);
        if (i >= 0) arr.splice(i, 1);
      }
      walk(x);
    }
  }
  const byAge = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));
  roots.sort(byAge);
  for (const arr of kids.values()) arr.sort(byAge);
  return { roots, kids };
}

// At most three rings: roots, their helpers, and everything deeper on the outer ring. A node on the
// outer ring that has helpers of its own takes its own slot, so a chain never stacks on one spot.
const RINGS = 3;

function layout(list) {
  const { roots, kids } = treeOf(list);
  const weight = new Map();     // angular slots a subtree needs
  let maxRing = 0;
  const measure = (x, d) => {
    const ring = Math.min(d, RINGS - 1);
    maxRing = Math.max(maxRing, ring);
    const ch = kids.get(x.id) || [];
    const sub = ch.reduce((sum, c) => sum + measure(c, d + 1), 0);
    const w = ring === RINGS - 1 ? 1 + sub : Math.max(1, sub);
    weight.set(x.id, w);
    return w;
  };
  const total = roots.reduce((sum, r) => sum + measure(r, 0), 0) || 1;
  const n = list.length;
  const scale = K * (n <= 14 ? 1 : Math.max(0.55, 1 - (n - 14) * 0.018));
  const RX = Math.max(140, W / 2 - 70);   // room for labels at the sides
  const RY = Math.max(120, H / 2 - 42);
  const inner = Math.max(0.42, Math.min(0.62, (CORE_EDGE + 30 * scale + 22) / Math.min(RX, RY)));
  const f = (ring) => (maxRing === 0 ? Math.max(inner, 0.66) : inner + ((1 - inner) * ring) / maxRing);
  const stagger = roots.length > 16;
  const out = new Map();

  const put = (x, depth, a, i) => {
    const ring = Math.min(depth, RINGS - 1);
    const jitter = ring === 0 && stagger && i % 2 ? 0.86 : 1;
    out.set(x.id, {
      x: CX + Math.cos(a) * RX * f(ring) * jitter,
      y: CY + Math.sin(a) * RY * f(ring) * jitter,
      a, depth, ring, r: (depth === 0 ? 30 : 21) * scale,
    });
  };
  const place = (x, depth, a0, a1, i) => {
    const ring = Math.min(depth, RINGS - 1);
    const ch = kids.get(x.id) || [];
    const w = weight.get(x.id);
    if (ring === RINGS - 1) {
      // Own slot first, then the helpers after it along the same ring.
      const unit = (a1 - a0) / w;
      put(x, depth, a0 + unit / 2, i);
      let c0 = a0 + unit;
      ch.forEach((c, j) => { const cw = unit * weight.get(c.id); place(c, depth + 1, c0, c0 + cw, j); c0 += cw; });
      return;
    }
    const a = (a0 + a1) / 2;
    put(x, depth, a, i);
    if (!ch.length) return;
    // Small graphs: keep helpers close to their parent instead of spreading over the whole sector.
    const span = Math.min(a1 - a0, 0.44 * w * (maxRing > 1 ? 0.85 : 1));
    let c0 = a - span / 2;
    ch.forEach((c, j) => { const cw = (span * weight.get(c.id)) / w; place(c, depth + 1, c0, c0 + cw, j); c0 += cw; });
  };
  let a = -Math.PI / 2 - (Math.PI * (weight.get(roots[0]?.id) || 1)) / total;
  roots.forEach((r, i) => {
    const w = (Math.PI * 2 * weight.get(r.id)) / total;
    place(r, 0, a, a + w, i);
    a += w;
  });

  // Shrink every node to fit the closest pair, so circles never overlap however many there are.
  const pts = [...out.values()];
  let tight = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) - pts[i].r - pts[j].r;
      if (d < tight) tight = d;
    }
  }
  if (tight < 4) {
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        const need = pts[i].r + pts[j].r + 4;
        if (d < need) {
          const k = Math.max(0.3, d / need);
          pts[i].r = Math.max(7, pts[i].r * k);
          pts[j].r = Math.max(7, pts[j].r * k);
        }
      }
    }
  }
  return { pos: out, scale: Math.min(scale, ...pts.map((p) => p.r / (p.depth ? 21 : 30))), crowd: n > 22 };
}

function curve(a, b, bend = 0.12) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx - dy * bend).toFixed(1)},${(my + dx * bend).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

const coreEdge = (p) => ({ x: CX + Math.cos(p.a) * CORE_EDGE, y: CY + Math.sin(p.a) * CORE_EDGE * 0.95 });

// ------------------------------------------------------------------ render

/** Redraw when the set of sessions, their parents, states or titles change. */
export function renderGraph(list, core) {
  lastList = list;
  lastCore = core;
  const sig = JSON.stringify(list.map((x) => [x.id, x.parentId, x.state, x.title, x.kind]));
  const coreSig = JSON.stringify(core);
  if (sig === signature && layers.core && layers.core.dataset.sig === coreSig) return;
  if (sig !== signature) {
    signature = sig;
    build(list);
  }
  drawCore(core);
  $('graphEmpty').hidden = list.length > 0;
}

function build(list) {
  for (const p of packets.splice(0)) p.dot.remove();
  clear(svg);
  W = Math.max(320, wrap.clientWidth || 1000);
  H = Math.max(300, wrap.clientHeight || 700);
  CX = W / 2;
  CY = H / 2;
  K = Math.max(0.6, Math.min(1.15, Math.min(W, H) / 720));
  CORE_EDGE = 92 * K;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const { pos: P, scale, crowd } = layout(list);
  pos = P;
  links = new Map();
  nodes = new Map();
  layers = {
    rings: s('g', { class: 'core-rings', 'aria-hidden': 'true' }),
    links: s('g', { class: 'links', 'aria-hidden': 'true' }),
    core: s('g', { class: 'core', 'aria-hidden': 'true' }),
    packets: s('g', { class: 'packets', 'aria-hidden': 'true' }),
    nodes: s('g', { class: 'nodes' }),
  };
  svg.append(layers.rings, layers.links, layers.core, layers.packets, layers.nodes);
  layers.rings.append(
    s('circle', { cx: CX, cy: CY, r: 150 * K, class: 'ring-faint' }),
    s('circle', { cx: CX, cy: CY, r: CORE_EDGE, class: 'ring-mid' }),
    s('g', { class: 'core-spin' }, s('circle', { cx: CX, cy: CY, r: 78 * K, class: 'ring-arc' })),
    s('g', { class: 'core-spin rev' }, s('circle', { cx: CX, cy: CY, r: 64 * K, class: 'ring-dash' })),
    s('circle', { cx: CX, cy: CY, r: 46 * K, class: 'ring-core' }),
  );

  for (const x of list) {
    const p = pos.get(x.id);
    const parent = x.parentId && pos.get(x.parentId) && x.parentId !== x.id ? pos.get(x.parentId) : null;
    const isChild = parent && treeParentIs(x);
    const from = isChild ? parent : coreEdge(p);
    const path = s('path', { d: curve(from, p), class: `link${isChild ? '' : ' core'}`, id: `lk-${idSafe(x.id)}` });
    layers.links.appendChild(path);
    links.set(x.id, { path, kind: isChild ? 'child' : 'core' });
  }

  for (const x of list) {
    const p = pos.get(x.id);
    const small = scale < 0.8 * K || K < 0.8;
    const g = s('g', {
      class: `node ${stateClass(x.state)}${p.depth ? ' child' : ''}${small ? ' small' : ''}${x.kind === 'bg' ? ' bg' : ''}${p.r < 11 ? ' tiny' : ''}`,
      'data-id': x.id,
      tabindex: 0,
      role: 'button',
      'aria-label': `${x.title}, ${stateLabel(x.state)}. ${x.stateReason || ''}`,
    });
    g.append(
      s('circle', { cx: p.x, cy: p.y, r: p.r + 7, class: 'halo' }),
      s('circle', { cx: p.x, cy: p.y, r: p.r, class: 'blip' }),
      s('circle', { cx: p.x, cy: p.y, r: p.r, class: 'body' }),
      s('text', { x: p.x, y: p.y, class: 'glyph', text: glyph(x.title, p.depth ? 2 : 3) }),
    );
    g.appendChild(s('text', { class: 'name' }));
    layers.nodes.appendChild(g);
    nodes.set(x.id, g);
  }
  placeLabels(list, scale < 0.8 * K || K < 0.8, crowd);
}

const LABEL_MAX = 18;

/** Label spots to try, best first: outward (away from the parent and the core), below, above, right, left. */
function labelSpots(p) {
  const ca = Math.cos(p.a);
  const sa = Math.sin(p.a);
  const off = p.r + 10;
  const ox = p.x + ca * off;
  const out = ca > 0.38 ? ['start', ox, p.y + sa * off + 4] : ca < -0.38 ? ['end', ox, p.y + sa * off + 4]
    : ['middle', ox, p.y + sa * off + (sa > 0 ? 10 : -2)];
  return [out, ['middle', p.x, p.y + p.r + 16], ['middle', p.x, p.y - p.r - 8],
    ['start', p.x + p.r + 8, p.y + 4], ['end', p.x - p.r - 8, p.y + 4]];
}

function setLabel(t, [anchor, x, y], title, small) {
  const charW = small ? 6.4 : 7.3;
  const room = anchor === 'start' ? W - x - 6 : anchor === 'end' ? x - 6 : Math.min(x, W - x) * 2 - 6;
  const max = Math.max(4, Math.min(small ? 14 : LABEL_MAX, Math.floor(room / charW)));
  t.setAttribute('x', x.toFixed(1));
  t.setAttribute('y', y.toFixed(1));
  t.setAttribute('class', `name ta-${anchor}`);
  t.textContent = cut(title, max);
}

const boxHit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function circleHit(c, b) {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w));
  const ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
  return Math.hypot(c.x - nx, c.y - ny) < c.r;
}

/** Give each label the first spot that touches no node, no other label and stays inside the panel.
 *  Labels that fit nowhere stay hidden until their node is hovered. "Waiting on you" goes first. */
function placeLabels(list, small, crowd) {
  const circles = [...pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, r: p.r + 4 }));
  circles.push({ id: '__core', x: CX, y: CY, r: 46 * K + 4 });
  const taken = [];
  const rank = (x) => (x.state === 'you' ? 0 : 1) * 10 + (pos.get(x.id).depth ? 1 : 0);
  const order = [...list].sort((a, b) => rank(a) - rank(b));
  for (const x of order) {
    const t = nodes.get(x.id).querySelector('.name');
    const spots = labelSpots(pos.get(x.id));
    let ok = false;
    if (!crowd || x.state === 'you') {
      for (const spot of spots) {
        setLabel(t, spot, x.title, small);
        let b;
        try { b = t.getBBox(); } catch { b = null; }
        if (!b || !b.width) { ok = true; break; } // not rendered (hidden panel): keep the first spot
        const box = { x: b.x - 2, y: b.y - 1, w: b.width + 4, h: b.height + 2 };
        if (box.x < 0 || box.y < 0 || box.x + box.w > W || box.y + box.h > H) continue;
        if (taken.some((o) => boxHit(o, box))) continue;
        if (circles.some((c) => c.id !== x.id && circleHit(c, box))) continue;
        taken.push(box);
        ok = true;
        break;
      }
    }
    if (!ok) setLabel(t, spots[0], x.title, small);
    t.classList.toggle('hid', !ok);
  }
}

// The layout treats a parent as a tree parent unless it was cut to break a loop.
function treeParentIs(x) {
  const p = pos.get(x.id);
  const pp = pos.get(x.parentId);
  return p && pp && p.depth === pp.depth + 1;
}

const idSafe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

function drawCore(core) {
  const g = layers.core;
  if (!g) return;
  g.dataset.sig = JSON.stringify(core);
  clear(g);
  g.setAttribute('class', `core${core.connected ? '' : ' off'} look-${core.look || 'none'}`);
  layers.rings.setAttribute('class', `core-rings${core.connected ? '' : ' off'}`);
  g.append(
    s('text', { x: CX, y: CY - 4, class: 'core-name', text: core.name || 'CHIEF' }),
    s('text', { x: CX, y: CY + 14, class: 'core-sub', text: core.label }),
  );
}

// ------------------------------------------------------------------ hover card

function showTip(id) {
  const x = byId.get(id);
  const g = nodes.get(id);
  if (!x || !g) return;
  onHover(id);
  clear(tip);
  tip.className = `tip ${stateClass(x.state)}`;
  const parent = x.parentId && byId.get(x.parentId);
  const kidCount = (x.childIds || []).length;
  add(tip,
    h('div', { class: 'tt', text: x.title }),
    h('div', { class: 'ts' }, h('i', { class: 'dot' }), `${stateLabel(x.state)} · ${age(x.lastActivityAt)}`),
    x.stateReason ? h('div', { class: 'tr', text: x.stateReason }) : null,
    x.summary ? h('div', { class: 'td', text: cut(x.summary, 240) }) : null,
    x.needsAction && !(x.stateReason || '').includes(x.needsAction.replace(/^.*?:\s*/, ''))
      ? h('div', { class: 'td', text: x.needsAction }) : null,
    parent ? h('div', { class: 'td', text: `Started by: ${parent.title}` }) : null,
    kidCount ? h('div', { class: 'td', text: `${kidCount} helper session${kidCount > 1 ? 's' : ''}` }) : null,
    where(x) ? h('div', { class: 'tw', text: where(x) }) : null,
  );
  tip.hidden = false;
  const b = wrap.getBoundingClientRect();
  const n = g.querySelector('.body').getBoundingClientRect();
  let left = n.right - b.left + 12;
  let top = n.top - b.top - 6;
  if (left + tip.offsetWidth > b.width - 8) left = n.left - b.left - tip.offsetWidth - 12;
  if (left < 8) left = Math.max(8, Math.min(b.width - tip.offsetWidth - 8, n.left - b.left));
  if (top + tip.offsetHeight > b.height - 8) top = b.height - tip.offsetHeight - 8;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
  tip.hidden = true;
  onHover(null);
}

export function highlightNode(id) {
  for (const [k, g] of nodes) g.classList.toggle('hl', k === id);
}

// ------------------------------------------------------------------ activity

/** activity: { kind: 'pulse', id } | { kind: 'message', from, to } | { kind: 'chief', to } */
export function onActivity(ev) {
  if (!ev || document.hidden || !layers.packets) return;
  if (ev.kind === 'pulse') {
    const x = byId.get(ev.id);
    if (!x) return;
    blip(ev.id);
    const l = links.get(ev.id);
    if (l && l.kind === 'child') send(l.path, true, 'packet');
  } else if (ev.kind === 'message') {
    if (!pos.has(ev.from) || !pos.has(ev.to) || ev.from === ev.to) return;
    const down = links.get(ev.to);
    const up = links.get(ev.from);
    if (down && down.kind === 'child' && byId.get(ev.to).parentId === ev.from) send(down.path, false, 'packet');
    else if (up && up.kind === 'child' && byId.get(ev.from).parentId === ev.to) send(up.path, true, 'packet');
    else send(tempPath(pos.get(ev.from), pos.get(ev.to)), false, 'packet', true);
    blip(ev.to);
  } else if (ev.kind === 'chief') {
    const p = pos.get(ev.to);
    if (!p) return;
    const l = links.get(ev.to);
    if (l && l.kind === 'core') send(l.path, false, 'packet chief');
    else send(tempPath(coreEdge(p), p), false, 'packet chief', true);
  }
}

function tempPath(a, b) {
  tempSeq += 1;
  const p = s('path', { d: curve(a, b, 0.22), class: 'link temp', id: `tmp-${tempSeq}` });
  layers.links.appendChild(p);
  return p;
}

function blip(id) {
  const g = nodes.get(id);
  if (!g || reducedMotion()) return;
  const c = g.querySelector('.blip');
  c.classList.remove('go');
  void c.getBoundingClientRect();
  c.classList.add('go');
}

function markLive(path) {
  path.classList.add('live');
  clearTimeout(path._liveT);
  path._liveT = setTimeout(() => path.classList.remove('live'), LIVE_MS);
}

function send(path, reverse, cls, temp = false) {
  markLive(path);
  if (reducedMotion()) {
    path.classList.add('flash');
    setTimeout(() => { path.classList.remove('flash'); if (temp) path.remove(); }, 700);
    return;
  }
  if (packets.length >= MAX_PACKETS) { if (temp) path.remove(); return; }
  const dot = s('circle', { r: cls.includes('chief') ? 3.4 : 2.8, class: cls });
  layers.packets.appendChild(dot);
  let len = 0;
  try { len = path.getTotalLength(); } catch { len = 0; }
  packets.push({ path, dot, len, reverse, temp, start: performance.now(), dur: Math.min(2400, 900 + len * 2.2) });
  if (!raf) raf = requestAnimationFrame(tick);
}

function tick(t) {
  for (let i = packets.length - 1; i >= 0; i -= 1) {
    const p = packets[i];
    const k = (t - p.start) / p.dur;
    if (k >= 1 || !p.path.isConnected) {
      p.dot.remove();
      if (p.temp) setTimeout(() => p.path.remove(), 400);
      packets.splice(i, 1);
      continue;
    }
    const e = k < 0 ? 0 : k;
    const pt = p.path.getPointAtLength((p.reverse ? 1 - e : e) * p.len);
    p.dot.setAttribute('cx', pt.x.toFixed(1));
    p.dot.setAttribute('cy', pt.y.toFixed(1));
  }
  raf = packets.length ? requestAnimationFrame(tick) : 0;
}
