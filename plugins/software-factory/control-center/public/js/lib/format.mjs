// Pure formatting helpers. No DOM, no vendor imports (unit-testable in Node).

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** 3.1M / 640k / 1.2B / 950. Keeps one decimal below 10 of a unit. */
export function fmtTokens(n) {
  const v = num(n);
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const unit = (d, s) => {
    const x = a / d;
    const t = x < 10 ? x.toFixed(1) : Math.round(x).toString();
    return sign + t.replace(/\.0$/, '') + s;
  };
  if (a >= 1e9) return unit(1e9, 'B');
  if (a >= 1e6) return unit(1e6, 'M');
  if (a >= 1e3) return unit(1e3, 'k');
  return sign + Math.round(a).toString();
}

/** 1234567 -> "1,234,567" (title attributes, tables). */
export function fmtInt(n) {
  return Math.round(num(n)).toLocaleString('en-US');
}

export function fmtPct(p, digits = 0) {
  return `${num(p).toFixed(digits)}%`;
}

/** Seconds -> "45s", "18m", "2h 5m", "3d 4h". */
export function fmtDuration(s) {
  let v = Math.max(0, Math.round(num(s)));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function toMs(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** ISO -> "just now" / "14m ago" / "in 3m". `now` may be ISO or ms. */
export function timeAgo(iso, now = Date.now()) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const n = typeof now === 'number' ? now : toMs(now);
  const diff = Math.round((n - t) / 1000);
  if (Math.abs(diff) < 30) return 'just now';
  return diff > 0 ? `${fmtDuration(diff)} ago` : `in ${fmtDuration(-diff)}`;
}

/** ISO -> "14:32" local time, or "Oct 11 14:32" when not today. */
export function fmtClock(iso, now = Date.now()) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = new Date(typeof now === 'number' ? now : toMs(now));
  if (d.toDateString() === n.toDateString()) return hm;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${hm}`;
}

export function fmtDateTime(iso) {
  const t = toMs(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString();
}

/** next_tick_in_s -> minutes, at least 1 (for "applies at next tick (~N min)"). */
export function nextTickMinutes(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return null;
  return Math.max(1, Math.ceil(s / 60));
}

/** Header text: "next tick ~2 min", "tick overdue 3 min", "" when unknown. */
export function nextTickText(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '';
  if (s < 0) {
    const m = Math.max(1, Math.round(-s / 60));
    return `tick overdue ${m} min`;
  }
  if (s < 60) return 'next tick in under 1 min';
  return `next tick ~${Math.round(s / 60)} min`;
}

/** "claude-sonnet-5-5" -> "Sonnet 5.5"; "claude-opus-4-1-20250805" -> "Opus 4.1". */
export function modelFamily(id) {
  if (!id || typeof id !== 'string') return 'Unknown';
  const m = /claude-(?:(\d+)-(\d+)-)?([a-z]+)(?:-(\d+)(?:-(\d{1,2}))?)?/i.exec(id);
  if (!m) return id;
  const fam = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  if (m[1]) return `${fam} ${m[1]}.${m[2]}`;
  if (m[4]) return m[5] ? `${fam} ${m[4]}.${m[5]}` : `${fam} ${m[4]}`;
  return fam;
}

/** Human status word from a snake_case status. */
export function statusWord(s) {
  if (!s) return '';
  const map = {
    in_progress: 'In progress', in_review: 'In review', changes_requested: 'Changes requested',
    awaiting_approval: 'Awaiting approval', awaiting_g1: 'Awaiting G1', budget_blocked: 'Budget blocked',
    pr_open: 'PR open', checking: 'Checks running',
  };
  if (map[s]) return map[s];
  const w = String(s).replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
