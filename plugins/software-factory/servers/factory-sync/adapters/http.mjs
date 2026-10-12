// JSON over fetch with rate-limit detection. `fetchFn` is injected (tests pass a fake).
import { SyncHttpError, header, remaining, retryAfterMs } from '../core/ratelimit.mjs';

export async function httpJson(fetchFn, url, { method = 'GET', headers = {}, body, now = Date.now(), timeoutMs = 20000 } = {}) {
  let res;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    res = await fetchFn(url, {
      method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
  } catch (e) {
    throw new SyncHttpError(`network error: ${String(e.message || e).slice(0, 120)}`, { status: 0 });
  } finally { if (timer) clearTimeout(timer); }
  const text = typeof res.text === 'function' ? await res.text() : '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const requestId = header(res.headers, 'x-request-id') || header(res.headers, 'x-arequestid') || header(res.headers, 'x-github-request-id') || null;
  const rate = remaining(res.headers);
  const gqlLimited = json && Array.isArray(json.errors) && json.errors.some((e) => e && e.extensions && e.extensions.code === 'RATELIMITED');
  if (res.status === 429 || gqlLimited) {
    throw new SyncHttpError(`rate limited (${res.status})`, { status: res.status, rateLimited: true, retryAfterMs: retryAfterMs(res.headers, now) || 60000, requestId });
  }
  if (res.status >= 400) {
    const msg = (json && (json.errorMessages || []).join('; ')) || (json && json.message) || (json && Array.isArray(json.errors) && json.errors.map((e) => e.message).join('; ')) || `HTTP ${res.status}`;
    throw new SyncHttpError(String(msg).slice(0, 200), { status: res.status, requestId });
  }
  return { status: res.status, json, rate, requestId };
}
