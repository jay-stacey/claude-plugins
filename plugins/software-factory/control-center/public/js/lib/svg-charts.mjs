// Pure SVG geometry helpers. No DOM, no vendor imports (unit-testable in Node).

/** "Nice" axis ticks from 0 to >= max. Returns {max, ticks[]}. */
export function niceTicks(max, count = 4) {
  const m = Math.max(1, Number(max) || 0);
  const raw = m / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(m / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks };
}

/** Linear scale factory. */
export function linear(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Stacked vertical bars.
 * rows: [{key, label, values: {seriesKey: n}}]; series: [seriesKey] (bottom to top).
 * Returns {bars: [{key, label, x, w, total, segs: [{series, y, h, value}]}], yMax, ticks}.
 * A 2px surface gap separates segments (dataviz mark spec).
 */
export function stackedBars(rows, series, { width, height, padL = 48, padR = 8, padT = 8, padB = 24, gap = 2 } = {}) {
  const totals = rows.map((r) => series.reduce((s, k) => s + (Number(r.values[k]) || 0), 0));
  const { max, ticks } = niceTicks(Math.max(1, ...totals));
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);
  const n = Math.max(1, rows.length);
  const slot = plotW / n;
  const w = Math.max(2, Math.min(28, slot * 0.7));
  const y = linear(0, max, padT + plotH, padT);
  const bars = rows.map((r, i) => {
    let acc = 0;
    const segs = [];
    for (const s of series) {
      const v = Number(r.values[s]) || 0;
      if (v <= 0) continue;
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const hgt = Math.max(0, y0 - y1 - (segs.length ? gap : 0));
      segs.push({ series: s, y: y1, h: Math.max(hgt, 0.5), value: v });
    }
    return { key: r.key, label: r.label, x: padL + i * slot + (slot - w) / 2, cx: padL + i * slot + slot / 2, w, total: totals[i], segs };
  });
  return { bars, yMax: max, ticks: ticks.map((t) => ({ v: t, y: y(t) })), plot: { x: padL, y: padT, w: plotW, h: plotH } };
}

/** Horizontal bar lengths for a list of values against one shared domain. */
export function hbarScale(values, width) {
  const max = Math.max(1, ...values.map((v) => Number(v) || 0));
  return (v) => Math.max(0, ((Number(v) || 0) / max) * width);
}

/** Cubic edge path from parent (bottom centre) to child (top centre). */
export function treeEdgePath(p, c) {
  const midY = (p.y + c.y) / 2;
  return `M${p.x},${p.y} C${p.x},${midY} ${c.x},${midY} ${c.x},${c.y}`;
}

/** Curved arc between two points, bowing to the side by `bend` (fraction of distance). */
export function arcPath(a, b, bend = 0.25) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const off = len * bend;
  const cx = mx + nx * off;
  const cy = my + ny * off;
  return `M${a.x},${a.y} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x},${b.y}`;
}

/** Budget bar geometry in percent of the track. domain = max(limit*1.2, spent+live). */
export function budgetGeometry(spent, live, limit, warnPct = 80, stopPct = 100) {
  const s = Math.max(0, Number(spent) || 0);
  const l = Math.max(0, Number(live) || 0);
  const lim = Math.max(0, Number(limit) || 0);
  const domain = Math.max(lim * Math.max(1.2, stopPct / 100 + 0.2), s + l, 1);
  const pct = (v) => (v / domain) * 100;
  return {
    spentPct: pct(s),
    livePct: pct(l),
    warnAt: lim ? pct((lim * warnPct) / 100) : null,
    stopAt: lim ? pct((lim * stopPct) / 100) : null,
    usedPct: lim ? (s / lim) * 100 : null,
  };
}
