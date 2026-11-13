// Small, safe markdown renderer for session turns and Chief messages.
// Builds DOM nodes only (never innerHTML), so text from a transcript cannot inject markup.
// Covers what Claude writes: headings, paragraphs, lists (nested), fenced code, inline code,
// bold, italic, strikethrough, links, block quotes, tables and rules.

import { h } from './util.mjs';

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isBlank = (l) => !l.trim();
const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l)
  || (l.includes('|') && next !== undefined && TABLE_SEP.test(next));

/** Render markdown text into a DocumentFragment. */
export function md(text) {
  const frag = document.createDocumentFragment();
  for (const n of blocks(String(text || '').replace(/\r\n?/g, '\n').split('\n'))) frag.appendChild(n);
  return frag;
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i += 1; continue; }
    let m = l.match(FENCE);
    if (m) {
      const fence = m[1];
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of text when it was cut)
      out.push(codeBlock(body.join('\n'), m[2]));
      continue;
    }
    m = l.match(HEADING);
    if (m) {
      out.push(h(`h${Math.min(6, m[1].length + 2)}`, { class: 'md-h' }, inline(m[2])));
      i += 1;
      continue;
    }
    if (RULE.test(l)) { out.push(h('hr')); i += 1; continue; }
    if (QUOTE.test(l)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].match(QUOTE)[1]); i += 1; }
      out.push(h('blockquote', {}, blocks(body)));
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const rows = [l];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(lines[i]); i += 1; }
      out.push(table(rows));
      continue;
    }
    if (ITEM.test(l)) {
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (ITEM.test(cur)) { items.push(cur); i += 1; continue; }
        // A blank line ends the list unless the next line is still part of it.
        if (isBlank(cur) && i + 1 < lines.length && (ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) { i += 1; continue; }
        if (!isBlank(cur) && /^\s{2,}\S/.test(cur)) { items.push(cur); i += 1; continue; }
        break;
      }
      out.push(list(items));
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i], lines[i + 1]))) {
      para.push(lines[i].trim());
      i += 1;
    }
    const p = h('p');
    para.forEach((t, k) => { if (k) p.appendChild(h('br')); appendAll(p, inline(t)); });
    out.push(p);
  }
  return out;
}

function codeBlock(code, lang) {
  return h('div', { class: 'md-code' },
    lang ? h('span', { class: 'md-lang', text: lang }) : null,
    h('pre', {}, h('code', { text: code })));
}

function cells(row) {
  let t = row.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(rows) {
  const [head, ...body] = rows;
  return h('div', { class: 'md-table' }, h('table', {},
    h('thead', {}, h('tr', {}, cells(head).map((c) => h('th', {}, inline(c))))),
    h('tbody', {}, body.map((r) => h('tr', {}, cells(r).map((c) => h('td', {}, inline(c))))))));
}

/** Nested lists from indentation. Continuation lines join the item above. */
function list(lines) {
  const root = { indent: -1, el: null, kids: [] };
  const stack = [root];
  let lastItem = null;
  for (const line of lines) {
    const m = line.match(ITEM);
    if (!m) {
      if (lastItem) { lastItem.text.appendChild(h('br')); appendAll(lastItem.text, inline(line.trim())); }
      continue;
    }
    const indent = m[1].replace(/\t/g, '  ').length;
    const ordered = /\d/.test(m[2]);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let parent = stack[stack.length - 1];
    if (!parent.list || parent.ordered !== ordered) {
      const tag = ordered ? 'ol' : 'ul';
      const el = h(tag, ordered && parseInt(m[2], 10) !== 1 ? { start: parseInt(m[2], 10) } : {});
      if (parent === root) root.kids.push(el); else parent.li.appendChild(el);
      parent.list = el;
      parent.ordered = ordered;
    }
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    const text = h('span');
    appendAll(text, inline(task ? task[2] : m[3]));
    const li = h('li', task ? { class: `md-task${task[1] !== ' ' ? ' done' : ''}` } : {},
      task ? h('span', { class: 'md-box', 'aria-hidden': 'true', text: task[1] !== ' ' ? '☑' : '☐' }) : null, text);
    parent.list.appendChild(li);
    lastItem = { text };
    stack.push({ indent, li, list: null, ordered: null });
  }
  return root.kids.length === 1 ? root.kids[0] : h('div', {}, root.kids);
}

// ------------------------------------------------------------------ inline

const INLINE = [
  { re: /`+/, kind: 'code' },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/, kind: 'strong' },
  { re: /~~(?=\S)([\s\S]*?\S)~~/, kind: 'del' },
  { re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/, kind: 'em' },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, kind: 'link' },
  { re: /\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/, kind: 'auto' },
];

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function link(text, url) {
  const href = safeHref(url);
  if (!href) return document.createTextNode(text);
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, text);
}

/** Inline markdown to an array of nodes. */
export function inline(text) {
  const out = [];
  let rest = String(text || '');
  while (rest) {
    let best = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, kind: p.kind };
    }
    if (!best) { out.push(document.createTextNode(rest)); break; }
    const { m, kind } = best;
    if (m.index) out.push(document.createTextNode(rest.slice(0, m.index)));
    if (kind === 'code') {
      // A code span closes on the same run of backticks.
      const ticks = m[0];
      const end = rest.indexOf(ticks, m.index + ticks.length);
      if (end < 0) { out.push(document.createTextNode(ticks)); rest = rest.slice(m.index + ticks.length); continue; }
      const code = rest.slice(m.index + ticks.length, end);
      out.push(h('code', { class: 'md-ic', text: code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code }));
      rest = rest.slice(end + ticks.length);
      continue;
    }
    const inner = m[1] ?? m[2] ?? '';
    if (kind === 'strong') out.push(h('strong', {}, inline(inner)));
    else if (kind === 'em') out.push(h('em', {}, inline(inner)));
    else if (kind === 'del') out.push(h('del', {}, inline(inner)));
    else if (kind === 'link') out.push(link(m[1], m[2]));
    else if (kind === 'auto') out.push(link(m[0], m[0]));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function appendAll(el, nodes) {
  for (const n of nodes) el.appendChild(n);
}
