// Rate limits: vendor headers -> remaining budget and backoff (design C §8). Writes are sequential
// (concurrency 1, under the cap of 4), capped per tick, and GitHub content creation is spaced 1 s apart.

export class SyncHttpError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0, rateLimited = false, requestId = null, code = null } = {}) {
    super(message);
    this.status = status; this.retryAfterMs = retryAfterMs; this.rateLimited = rateLimited;
    this.requestId = requestId; this.code = code;
  }
}

export function header(h, k) {
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(k);
  const f = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase());
  return f ? h[f] : null;
}

/** Retry-After (seconds or HTTP date) or an epoch reset header -> ms from now. */
export function retryAfterMs(headers, now = Date.now()) {
  const ra = header(headers, 'retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.max(0, t - now);
  }
  for (const k of ['x-ratelimit-requests-reset', 'x-ratelimit-reset']) {
    const v = Number(header(headers, k));
    if (Number.isFinite(v) && v > 0) {
      const ms = v > 1e12 ? v : v * 1000; // Linear sends epoch ms, GitHub epoch s
      return Math.max(0, ms - now);
    }
  }
  return 0;
}

/** Remaining budget from headers (kept in state.json and the audit log). */
export function remaining(headers) {
  const out = {};
  for (const [k, name] of [['requests', 'x-ratelimit-requests-remaining'], ['complexity', 'x-ratelimit-complexity-remaining'], ['core', 'x-ratelimit-remaining']]) {
    const v = header(headers, name);
    if (v !== null && v !== undefined && v !== '') out[k] = Number(v);
  }
  return out;
}

/** Per-tick write budget and spacing. */
export class Budget {
  constructor({ maxWrites = 20, spacingMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
    this.maxWrites = maxWrites; this.spacingMs = spacingMs; this.sleep = sleep; this.now = now;
    this.writes = 0; this.lastWriteAt = 0; this.stopped = null;
  }
  canWrite() { return !this.stopped && this.writes < this.maxWrites; }
  async beforeWrite() {
    if (this.spacingMs && this.lastWriteAt) {
      const wait = this.lastWriteAt + this.spacingMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.writes += 1; this.lastWriteAt = this.now();
  }
  stop(untilMs, why) { this.stopped = { until: untilMs, why }; }
}
