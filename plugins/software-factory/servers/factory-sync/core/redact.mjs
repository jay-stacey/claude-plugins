// Privacy guard for every outgoing title, body and comment. A hit blocks the op; only kinds and field
// names are reported, never the matched value.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?<![\w/.-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w/-])/;
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const SECRET_PREFIX = /(?:\bghp_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}|\blin_api_[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{10,}|\bxox[bap]-[A-Za-z0-9-]{6,}|\bAKIA[0-9A-Z]{16}\b)/;
const KV_SECRET = /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*\S+/i;

export function luhn(digits) {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function hasCard(text) {
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

function hasVin(text) {
  for (const m of text.matchAll(VIN)) {
    const v = m[0];
    if (/\d/.test(v) && /[A-Z]/.test(v) && !/^[0-9A-F]{17}$/.test(v)) return true; // skip hex runs (hashes)
  }
  return false;
}

/** Returns the list of hit kinds in text (empty = clean). */
export function scan(text, extraPatterns = []) {
  const s = String(text ?? '');
  if (!s) return [];
  const hits = [];
  if (EMAIL.test(s)) hits.push('email');
  if (PHONE.test(s)) hits.push('phone');
  if (hasCard(s)) hits.push('card_number');
  if (hasVin(s)) hits.push('vin');
  if (SECRET_PREFIX.test(s)) hits.push('secret');
  if (KV_SECRET.test(s)) hits.push('key_value_secret');
  for (const p of extraPatterns || []) {
    try { if (new RegExp(p, 'i').test(s)) { hits.push('custom'); break; } } catch { /* bad pattern: ignore */ }
  }
  return hits;
}

const TEXT_FIELDS = ['title', 'body', 'text'];

/** Check a push op. Returns {blocked, field, kinds} for the first offending field, or {blocked:false}. */
export function checkOp(op, extraPatterns = []) {
  const p = op.payload || {};
  for (const f of TEXT_FIELDS) {
    if (p[f] === undefined || p[f] === null) continue;
    const kinds = scan(p[f], extraPatterns);
    if (kinds.length) return { blocked: true, field: f, kinds };
  }
  return { blocked: false };
}
