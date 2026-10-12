// Read-only artifact access with realpath containment and a deny list.
// Mockup HTML is never returned as data: the client gets a one-use ticket URL that serves the
// file with a CSP sandbox, so it runs with an opaque origin inside a sandboxed iframe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_TEXT = 512 * 1024;
const TICKET_TTL_MS = 60000;
const TEXT_EXT = new Set(['.txt', '.json', '.jsonl', '.yml', '.yaml', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.scss',
  '.diff', '.patch', '.csv', '.cs', '.py', '.sql', '.xml', '.svg', '.sh', '.ps1', '.toml', '.ini', '.go', '.rs', '.java', '.rb', '.php']);

export class ArtifactError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function real(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function deniedName(abs) {
  const parts = abs.split(/[\\/]+/);
  if (parts.some((s) => s.toLowerCase() === '.git')) return true;
  const base = parts.at(-1).toLowerCase();
  return /^\.env/.test(base) || base.endsWith('.pem') || base.endsWith('.key') || /^id_/.test(base) || base.endsWith('.p12') || base.endsWith('.pfx');
}

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.log') return 'log';
  if (TEXT_EXT.has(ext) || ext === '') return 'text';
  return null;
}

export class Artifacts {
  constructor({ home, projectDir, referenced }) {
    this.home = home;
    this.projectDir = projectDir;
    this.referenced = referenced; // () => Set of normalized paths
    this.tickets = new Map();
  }

  // Returns the real absolute path or throws ArtifactError.
  resolve(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw.includes('\0')) throw new ArtifactError(400, 'bad path');
    const p = norm(raw.trim());
    if (/^[a-z]+:\/\//i.test(p)) throw new ArtifactError(400, 'bad path');
    const homeReal = real(this.home);
    const rootReal = real(this.projectDir) || homeReal;
    if (!homeReal) throw new ArtifactError(404, 'no factory');
    const candidates = path.isAbsolute(p) || /^[a-z]:\//i.test(p) ? [p] : [path.join(this.home, p), path.join(this.projectDir, p)];
    let abs = null;
    for (const c of candidates) {
      const r = real(c);
      if (r) { abs = r; break; }
    }
    if (!abs) throw new ArtifactError(404, 'not found');
    if (!(inside(abs, rootReal) || inside(abs, homeReal))) throw new ArtifactError(403, 'outside the project');
    if (deniedName(abs)) throw new ArtifactError(403, 'denied');
    const relHome = norm(path.relative(homeReal, abs));
    if (inside(abs, homeReal) && /^(run|inbox|state|setup)(\/|$)/.test(relHome)) throw new ArtifactError(403, 'denied');
    // Only paths a record references (or anything under a referenced folder, or factory docs).
    const refs = this.referenced();
    const relRoot = norm(path.relative(rootReal, abs));
    const keys = [relHome, relRoot, norm(abs)];
    let ok = inside(abs, homeReal) && relHome.startsWith('docs/');
    for (const ref of refs) {
      if (ok) break;
      const r = path.isAbsolute(ref) ? norm(real(ref) || ref) : ref;
      if (keys.includes(r)) ok = true;
      else if (r.endsWith('/') && keys.some((k) => k.startsWith(r))) ok = true;
    }
    if (!ok) throw new ArtifactError(403, 'not referenced by any record');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new ArtifactError(400, 'not a file');
    return { abs, rel: relHome.startsWith('..') ? relRoot : relHome, size: st.size };
  }

  read(raw) {
    const { abs, size } = this.resolve(raw);
    const kind = kindOf(abs);
    if (!kind) throw new ArtifactError(415, 'unsupported file type');
    if (kind === 'html') {
      return { path: norm(raw), kind, size, ticket_url: `/api/mockup/${this.ticket(abs)}` };
    }
    const fd = fs.openSync(abs, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(size, MAX_TEXT));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      buf = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.subarray(0, 8192).includes(0)) throw new ArtifactError(415, 'binary file');
    return { path: norm(raw), kind, size, truncated: size > MAX_TEXT, text: buf.toString('utf8') };
  }

  ticket(abs) {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
    const t = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(t, { abs, expires: now + TICKET_TTL_MS });
    return t;
  }

  // One use only: the ticket is deleted when redeemed.
  redeem(ticket) {
    const v = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!v || v.expires < Date.now()) return null;
    try {
      const st = fs.statSync(v.abs);
      if (st.size > 4 * MAX_TEXT) return null;
      return fs.readFileSync(v.abs);
    } catch {
      return null;
    }
  }
}
