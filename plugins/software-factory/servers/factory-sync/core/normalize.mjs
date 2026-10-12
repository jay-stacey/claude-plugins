// Normalization for echo hashes: markdown or Jira ADF -> plain text; markdown -> ADF for Jira writes.
import { createHash } from 'node:crypto';

export function sha(s) { return createHash('sha256').update(String(s)).digest('hex'); }

/** Markdown (or plain) text -> plain text with collapsed whitespace. */
export function mdToPlain(md) {
  let s = String(md ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/```[^\n]*\n?/g, '');                       // code fence markers
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1');          // images
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');        // links -> text url
  s = s.replace(/<(https?:[^>\s]+)>/g, '$1');                // autolinks
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');                  // headings
  s = s.replace(/^\s{0,3}>\s?/gm, '');                       // quotes
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, ''); // list markers and checkboxes
  s = s.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');     // rules
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2'); // emphasis
  s = s.replace(/~~(.*?)~~/g, '$1').replace(/`([^`]*)`/g, '$1');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');          // markdown escapes (Linear adds them)
  return s.replace(/\s+/g, ' ').trim();
}

/** Jira ADF document -> plain text. */
export function adfToPlain(adf) {
  if (adf == null) return '';
  if (typeof adf === 'string') return mdToPlain(adf);
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    if (n.type === 'hardBreak') out.push(' ');
    if (n.type === 'inlineCard' && n.attrs && n.attrs.url) out.push(n.attrs.url);
    if (Array.isArray(n.content)) {
      for (const c of n.content) walk(c);
      if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type)) out.push(' ');
    }
  };
  walk(adf);
  return mdToPlain(out.join(''));
}

/** Markdown -> a simple ADF document (paragraphs, bullet lists, code blocks). */
export function mdToAdf(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const content = [];
  let para = []; let list = null; let code = null;
  const text = (t) => (t ? [{ type: 'text', text: t }] : []);
  const flushPara = () => { if (para.length) content.push({ type: 'paragraph', content: text(para.join(' ')) }); para = []; };
  const flushList = () => { if (list) content.push({ type: 'bulletList', content: list }); list = null; };
  for (const raw of lines) {
    if (code) {
      if (/^```/.test(raw)) { content.push({ type: 'codeBlock', content: text(code.join('\n')) }); code = null; } else code.push(raw);
      continue;
    }
    if (/^```/.test(raw)) { flushPara(); flushList(); code = []; continue; }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) { flushPara(); list = list || []; list.push({ type: 'listItem', content: [{ type: 'paragraph', content: text(li[1]) }] }); continue; }
    if (!raw.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(raw.trim());
  }
  if (code) content.push({ type: 'codeBlock', content: text(code.join('\n')) });
  flushPara(); flushList();
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

/** Hash of a normalized value. kind: text (default) | labels | id. */
export function hashValue(value, kind = 'text') {
  let norm;
  if (kind === 'labels') norm = [...new Set((value || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort().join('\n');
  else if (kind === 'id') norm = value == null ? '' : String(value);
  else if (value && typeof value === 'object') norm = adfToPlain(value);
  else norm = mdToPlain(value);
  return 'h:' + sha(norm).slice(0, 32);
}

/** Body text without the sf-id footer line (so a footer edit is not a scope change). */
export function stripFooter(text) {
  return String(text ?? '').replace(/\n?[^\n]*sf-id:\s*[GT]-\d+[^\n]*\s*$/i, '').trimEnd();
}

export function footer(localId) { return `sf-id: ${localId} · managed by software-factory`; }

export function findSfId(text) {
  const m = /sf-id:\s*([GT]-\d{3,})/i.exec(String(text ?? ''));
  return m ? m[1].toUpperCase() : null;
}
