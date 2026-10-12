// Request security: token, Host/Origin checks, headers, body cap, POST rate limit.
import crypto from 'node:crypto';

export const BODY_LIMIT = 16 * 1024;
export const POSTS_PER_MINUTE = 30;

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "frame-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

// Mockups are untrusted agent output. They run with an opaque origin and cannot fetch anything.
export const MOCKUP_CSP = [
  'sandbox allow-scripts', "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data:', 'font-src data:', "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenEquals(given, token) {
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

export function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function hostOk(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  return allowedHosts(port).has(host);
}

// Origin must be absent (non-browser client) or exactly our own origin.
// requireOrigin: browsers always send Origin on POST, so inbox writes demand it.
export function originOk(req, port, { requireOrigin = false } = {}) {
  const origin = req.headers.origin;
  if (origin === undefined) return !requireOrigin;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function requestToken(req, url, { allowQuery = false } = {}) {
  const h = req.headers['x-factory-token'];
  if (typeof h === 'string' && h) return h;
  if (allowQuery) return url.searchParams.get('k') || '';
  return '';
}

export class RateLimiter {
  constructor(limit = POSTS_PER_MINUTE, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }
  take(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      const e = new Error('body too large');
      e.status = 413;
      req.resume();
      return reject(e);
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        const e = new Error('body too large');
        e.status = 413;
        reject(e);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}
