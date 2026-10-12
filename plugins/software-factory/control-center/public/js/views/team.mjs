// Team: SVG org chart with live message pulses, recent messages and legend.
import { html, useEffect, useMemo, useRef } from '../html.mjs';
import { onMessage } from '../store.mjs';
import { navigate } from '../router.mjs';
import { ICONS, Icon, roleInfo, goalColorClass } from '../components.mjs';
import { roleStatuses, pulseKind, eventSentence, STATUS_WORD } from '../lib/model.mjs';
import { treeEdgePath, arcPath } from '../lib/svg-charts.mjs';
import { reducedMotion, onActivate } from '../lib/a11y.mjs';
import { fmtClock } from '../lib/format.mjs';

const W = 116;
const H = 56;
const VB_W = 1226;
const VB_H = 424;
const ROW = { user: 34, cto: 130, two: 258, three: 374 };

// Fixed layout (node centres). Unknown roles fall into an overflow row.
const LAYOUT = {
  user: [612, ROW.user],
  cto: [612, ROW.cto],
  'product-manager': [62, ROW.two],
  'ui-ux-designer': [62, ROW.three],
  'project-manager': [200, ROW.two],
  'staff-engineer': [448, ROW.two],
  'data-engineer': [200, ROW.three],
  'backend-engineer': [324, ROW.three],
  'frontend-engineer': [448, ROW.three],
  'devops-release': [572, ROW.three],
  'tech-writer': [696, ROW.three],
  critic: [790, ROW.two],
  'code-reviewer': [914, ROW.two],
  'security-reviewer': [1038, ROW.two],
  'qa-engineer': [1162, ROW.two],
};
const GROUPS = [
  { label: 'Product', x: 62 },
  { label: 'Delivery', x: 200 },
  { label: 'Engineering', x: 448 },
  { label: 'Assurance bench', x: 976 },
];
const STATUS_ICON = { working: 'activity', waiting: 'hourglass', blocked: 'blocked', idle: 'idle' };
const MAX_PULSES = 12;
const SVGNS = 'http://www.w3.org/2000/svg';

function layoutFor(roles) {
  const pos = {};
  let extra = 0;
  for (const r of roles) {
    if (LAYOUT[r.id]) pos[r.id] = { x: LAYOUT[r.id][0], y: LAYOUT[r.id][1] };
    else { pos[r.id] = { x: 820 + extra * 124, y: ROW.three }; extra += 1; }
  }
  const edges = [];
  for (const r of roles) {
    let parent = r.reports_to;
    if (!parent && r.id === 'cto') parent = 'user';
    if (parent && pos[parent] && pos[r.id]) {
      const p = pos[parent];
      const c = pos[r.id];
      edges.push({ id: `edge-${parent}--${r.id}`, parent, child: r.id, d: treeEdgePath({ x: p.x, y: p.y + H / 2 }, { x: c.x, y: c.y - H / 2 }) });
    }
  }
  return { pos, edges };
}

function NodeIcon({ name, x, y }) {
  const ic = ICONS[name] || ICONS.dot;
  return html`<g transform=${`translate(${x},${y}) scale(0.75)`} class="node-icon" aria-hidden="true">
    <path d=${ic.d} fill=${ic.stroke ? 'none' : 'currentColor'} stroke=${ic.stroke ? 'currentColor' : 'none'} stroke-width="2" stroke-linecap="round" fill-rule=${ic.evenodd ? 'evenodd' : 'nonzero'} />
  </g>`;
}

function TeamNode({ snap, role, p, st }) {
  const r = roleInfo(snap, role.id);
  const word = STATUS_WORD[st.status];
  const taskText = st.tasks.length ? `${st.tasks.slice(0, 2).join(' ')}${st.tasks.length > 2 ? ` +${st.tasks.length - 2}` : ''}` : st.detail;
  const label = `${r.name}, ${word}${st.tasks.length ? ` on ${st.tasks.join(', ')}` : ''}${st.detail ? `, ${st.detail}` : ''}. Show activity`;
  const go = () => navigate('activity', role.id === 'user' ? {} : { role: role.id });
  return html`<g class=${`node st-${st.status} rc-${r.ci % 14}`} transform=${`translate(${p.x - W / 2},${p.y - H / 2})`}
    role="button" tabindex="0" aria-label=${label} onClick=${go} onKeyDown=${onActivate(go)}>
    <title>${r.name}: ${word}${taskText ? ` (${taskText})` : ''}</title>
    <rect class="node-box" width=${W} height=${H} rx="6" />
    <circle class=${`node-ring${st.status === 'working' ? ' spin' : ''}`} cx="24" cy=${H / 2} r="18" />
    <circle class="node-avatar" cx="24" cy=${H / 2} r="13.5" />
    <text class="node-mono" x="24" y=${H / 2 + 4} text-anchor="middle">${r.monogram}</text>
    <text class="node-name" x="47" y="17">${r.short}</text>
    <${NodeIcon} name=${STATUS_ICON[st.status]} x=${46} y=${24} />
    <text class="node-status" x="61" y="34">${word}</text>
    ${taskText && html`<text class="node-tasks" x="47" y="49">${taskText}</text>`}
  </g>`;
}

function Legend() {
  const pulses = [
    ['dispatch', 'Dispatch'], ['handoff', 'Handoff'], ['question', 'Question or answer'],
    ['review', 'Review'], ['rework', 'Rework or escalation'], ['approval', 'Approval (goal colour)'],
  ];
  return html`<section class="legend" aria-labelledby="legend-h">
    <h3 id="legend-h" class="small">Legend</h3>
    <ul class="legend-list small">
      ${pulses.map(([k, w]) => html`<li><span class=${`swatch pulse-${k}`} aria-hidden="true"></span>${w}</li>`)}
    </ul>
    <ul class="legend-list small">
      ${['working', 'waiting', 'blocked', 'idle'].map((s) => html`<li class=${`st-${s}`}><span class="st-icon"><${Icon} name=${STATUS_ICON[s]} /></span>${STATUS_WORD[s]}</li>`)}
    </ul>
    <p class="small muted">Click a role to see its activity.</p>
  </section>`;
}

export function TeamView({ snap, nowMs }) {
  const roles = snap.roles || [];
  const { pos, edges } = useMemo(() => layoutFor(roles), [roles]);
  const statuses = useMemo(() => roleStatuses(snap), [snap.roles, snap.tasks, snap.runs, snap.gates, snap.events_tail]);
  const layerRef = useRef(null);
  const live = useRef({});
  live.current = { pos, edges, snap };
  const fx = useRef({ inflight: 0, seq: 0, badges: new Map() });

  useEffect(() => onMessage((ev) => {
    const layer = layerRef.current;
    if (!layer) return;
    const { pos: P, edges: E, snap: S } = live.current;
    const d = ev.data || {};
    const from = d.from && d.from.role;
    const to = d.to && d.to.role;
    if (!from || !to || from === to || !P[from] || !P[to]) return;
    const kind = pulseKind(ev.type);
    const colorCls = kind === 'approval' ? `pulse-approval ${goalColorClass(S, ev.goal_id)}` : `pulse-${kind}`;
    let edge = E.find((e) => e.parent === from && e.child === to);
    let reverse = false;
    if (!edge) { edge = E.find((e) => e.parent === to && e.child === from); reverse = !!edge; }
    let pathId;
    let pathD;
    const f = fx.current;
    if (edge) { pathId = edge.id; pathD = edge.d; } else {
      f.seq += 1;
      pathId = `tmp-arc-${f.seq}`;
      pathD = arcPath(P[from], P[to], 0.22);
      const tmp = document.createElementNS(SVGNS, 'path');
      tmp.setAttribute('id', pathId);
      tmp.setAttribute('d', pathD);
      tmp.setAttribute('class', 'edge-temp');
      layer.appendChild(tmp);
      setTimeout(() => tmp.remove(), 2000);
    }
    if (reducedMotion()) {
      const flash = document.createElementNS(SVGNS, 'path');
      flash.setAttribute('d', pathD);
      flash.setAttribute('class', `edge-flash ${colorCls}`);
      layer.appendChild(flash);
      setTimeout(() => flash.remove(), 600);
      return;
    }
    if (f.inflight >= MAX_PULSES) {
      const ref = layer.querySelector(`[id="${pathId}"]`) || document.getElementById(pathId);
      let b = f.badges.get(pathId);
      if (!b) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'edge-badge');
        t.setAttribute('text-anchor', 'middle');
        try {
          const pt = ref.getPointAtLength(ref.getTotalLength() / 2);
          t.setAttribute('x', String(pt.x)); t.setAttribute('y', String(pt.y - 6));
        } catch { t.setAttribute('x', String((P[from].x + P[to].x) / 2)); t.setAttribute('y', String((P[from].y + P[to].y) / 2)); }
        layer.appendChild(t);
        b = { el: t, n: 0, timer: null };
        f.badges.set(pathId, b);
      }
      b.n += 1;
      b.el.textContent = `+${b.n}`;
      clearTimeout(b.timer);
      b.timer = setTimeout(() => { b.el.remove(); f.badges.delete(pathId); }, 1500);
      return;
    }
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('r', '5.5');
    c.setAttribute('class', `pulse ${colorCls}`);
    const anim = document.createElementNS(SVGNS, 'animateMotion');
    anim.setAttribute('dur', '1.2s');
    anim.setAttribute('begin', 'indefinite');
    anim.setAttribute('fill', 'freeze');
    anim.setAttribute('calcMode', 'linear');
    if (reverse) { anim.setAttribute('keyPoints', '1;0'); anim.setAttribute('keyTimes', '0;1'); }
    const mp = document.createElementNS(SVGNS, 'mpath');
    mp.setAttribute('href', `#${pathId}`);
    mp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${pathId}`);
    anim.appendChild(mp);
    c.appendChild(anim);
    layer.appendChild(c);
    f.inflight += 1;
    try { anim.beginElement(); } catch { /* SMIL unsupported: the circle just sits at the origin briefly */ }
    setTimeout(() => { c.remove(); f.inflight -= 1; }, 1200);
  }), []);

  const recent = useMemo(() => (snap.events_tail || []).filter((e) => String(e.type).startsWith('msg.')).slice(-10).reverse(), [snap.events_tail]);
  const rn = (id) => roleInfo(snap, id).short;

  return html`<div class="team">
    <section class="team-chart" aria-labelledby="team-h">
      <h2 id="team-h" class="sr-only">Team org chart</h2>
      <svg viewBox=${`0 0 ${VB_W} ${VB_H}`} class="org" role="group" aria-label="Factory roles and live status" preserveAspectRatio="xMidYMid meet">
        <g class="groups" aria-hidden="true">
          <rect class="bench" x="726" y=${ROW.two - H / 2 - 30} width="498" height=${H + 40} rx="8" />
          ${GROUPS.map((g) => html`<text class="group-label" x=${g.x} y=${ROW.two - H / 2 - 12} text-anchor="middle">${g.label}</text>`)}
        </g>
        <g class="edges" aria-hidden="true">
          ${edges.map((e) => html`<path id=${e.id} class="edge" d=${e.d} />`)}
        </g>
        <g class="nodes">
          ${roles.filter((r) => pos[r.id]).map((r) => html`<${TeamNode} key=${r.id} snap=${snap} role=${r} p=${pos[r.id]}
            st=${statuses.get(r.id) || { status: 'idle', tasks: [], detail: '' }} />`)}
        </g>
        <g class="pulses" ref=${layerRef} aria-hidden="true"></g>
      </svg>
    </section>
    <aside class="team-side">
      <section aria-labelledby="recent-h">
        <h3 id="recent-h">Recent messages</h3>
        ${recent.length ? html`<ol class="msg-list small">
          ${recent.map((e) => html`<li key=${e.id}>
            <span class=${`swatch pulse-${pulseKind(e.type)}${pulseKind(e.type) === 'approval' ? ` ${goalColorClass(snap, e.goal_id)}` : ''}`} aria-hidden="true"></span>
            <span class="muted mono">${fmtClock(e.ts, nowMs)}</span>
            <span>${eventSentence(e, rn)}</span>
          </li>`)}
        </ol>` : html`<p class="muted small">No messages yet.</p>`}
      </section>
      <${Legend} />
    </aside>
  </div>`;
}
